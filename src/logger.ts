/**
 * Logger — permanent, leveled logging. Never delete log lines.
 *
 * Usage:
 *   import { log } from './logger'
 *   log.debug('fleet', 'checkSelection', { state, hasSelected })
 *   log.info('fleet', 'layout mode entered')
 *   log.warn('fleet', 'stuck brush detected', { state })
 *
 * Output: a call goes to BOTH (1) the browser console and (2) the server log
 * sink at POST /api/log (appended to ~/.config/tlda/client.log) — but only when
 * its level beats the namespace threshold. The level gates both; below it, the
 * call is a no-op (no console, no POST). This keeps a chatty debug/diagnostic
 * namespace from flooding the file + pegging the renderer with a POST per event.
 *
 * Control levels via URL param or localStorage (applies to file + console):
 *   ?log=debug            — all namespaces at debug
 *   ?log=fleet:debug      — fleet namespace at debug, others at warn
 *   ?log=fleet:debug,hud:info  — per-namespace levels
 *   localStorage.setItem('tlda-log', 'fleet:debug')
 *
 * Levels: debug < info < warn < error < off
 * Default threshold: warn — only warn/error are captured (console + file).
 * Turn a namespace up to debug/info to capture its diagnostics when you need them.
 */

type Level = 'debug' | 'info' | 'warn' | 'error' | 'off'

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3, off: 4 }

let _globalLevel: Level = 'warn'
const _nsLevels: Record<string, Level> = {}

function parseConfig(config: string) {
  if (!config) return
  for (const part of config.split(',')) {
    const [nsOrLevel, level] = part.split(':')
    if (level) {
      _nsLevels[nsOrLevel] = level as Level
    } else {
      _globalLevel = nsOrLevel as Level
    }
  }
}

// Initialize from URL param or localStorage
if (typeof window !== 'undefined') {
  const urlParam = new URLSearchParams(window.location.search).get('log')
  const stored = localStorage.getItem('tlda-log')
  parseConfig(urlParam || stored || '')
}

function shouldLog(ns: string, level: Level): boolean {
  const threshold = _nsLevels[ns] || _globalLevel
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold]
}

// --- Server sink: batched POST to /api/log ---
// Every log() call (regardless of console threshold) is queued and flushed
// to ~/.config/tlda/client.log via the server. Batched so a chatty namespace
// doesn't fire N requests per frame.
// `attempts` is local bookkeeping for the retry below and is stripped before the
// POST, so the wire format is unchanged.
type LogEntry = { ts: string; level: Level; ns: string; msg: string; data?: any; session?: string; attempts?: number }
const _queue: LogEntry[] = []
let _flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_DELAY_MS = 250
const MAX_QUEUE = 200
// A send that fails goes back on the queue instead of being destroyed — see
// flush(). Bounded on both axes so a permanent outage degrades rather than
// accumulates: at most MAX_SEND_ATTEMPTS tries per line, and the queue cap
// still drops oldest-first, so the retried lines are the first to go.
const MAX_SEND_ATTEMPTS = 5
const MAX_RETRY_DELAY_MS = 15_000
let _retryDelayMs = FLUSH_DELAY_MS

// Stable per-tab session id so the log shows which window said what.
const _session = (() => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as any).randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
})()

// Logs go to the server that served this SPA (same-origin, relative). That's the
// instance you're actually debugging, and every tlda server has /api/log — so
// this is a deterministic fact, not a guess. (Empty string = same-origin.)
function logBase(): string {
  return ''
}

// Drop oldest if the queue grows unbounded (e.g. server unreachable for a long
// time). This cap is the backpressure and applies to retried lines too.
function trimQueue() {
  if (_queue.length > MAX_QUEUE) _queue.splice(0, _queue.length - MAX_QUEUE)
}

function scheduleFlush(delayMs: number) {
  if (_flushTimer) return
  _flushTimer = setTimeout(flush, delayMs)
}

function enqueue(entry: LogEntry) {
  if (typeof window === 'undefined') return
  _queue.push(entry)
  trimQueue()
  scheduleFlush(FLUSH_DELAY_MS)
}

/** A send that failed. The lines are older than anything enqueued since, so they
 *  go back on the front; the file is appended in arrival order and each line
 *  carries its own `ts` (the server writes `ts: e.ts` verbatim), so a re-sent
 *  batch landing after newer lines is still reconstructable by sorting on it. */
function requeue(batch: LogEntry[]) {
  const retryable: LogEntry[] = []
  for (const entry of batch) {
    const attempts = (entry.attempts ?? 0) + 1
    if (attempts < MAX_SEND_ATTEMPTS) retryable.push({ ...entry, attempts })
  }
  if (retryable.length) {
    _queue.unshift(...retryable)
    trimQueue()
  }
  _retryDelayMs = Math.min(_retryDelayMs * 2, MAX_RETRY_DELAY_MS)
  scheduleFlush(_retryDelayMs)
}

function post(url: string, body: string, batch: LogEntry[]) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
    .then(res => { if (res.ok) _retryDelayMs = FLUSH_DELAY_MS; else requeue(batch) })
    .catch(() => requeue(batch))
}

function flush() {
  _flushTimer = null
  if (_queue.length === 0) return
  const batch = _queue.splice(0, _queue.length)
  try {
    const body = JSON.stringify(batch.map(({ attempts: _attempts, ...wire }) => wire))
    // Hosted (GitHub Pages → Fly): the SPA origin has no /api/log, so derive the
    // HTTP base from VITE_SYNC_SERVER and POST there. Cross-origin MUST use fetch
    // (not sendBeacon) so the authToken fetch-patch can inject the Authorization
    // header — sendBeacon can't set headers. Same-origin (local) keeps sendBeacon
    // for page-unload survival.
    const base = logBase()
    const url = base + '/api/log'
    if (!base && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' })
      // sendBeacon only reports whether the send was queued, so a queued beacon
      // is as far as this path can see. A refused one falls through to fetch,
      // which can tell us it failed.
      if (navigator.sendBeacon(url, blob)) { _retryDelayMs = FLUSH_DELAY_MS; return }
      void post(url, body, batch)
    } else {
      void post(url, body, batch)
    }
  } catch { requeue(batch) /* never let logging crash the app */ }
}

if (typeof window !== 'undefined') {
  // Best-effort flush on tab close so the last events make it to the file.
  window.addEventListener('beforeunload', flush)
  window.addEventListener('pagehide', flush)
}

function makeLogger(level: Level, consoleFn: (...args: any[]) => void) {
  return (ns: string, msg: string, data?: any) => {
    // Level gates BOTH the server sink AND the console (default threshold: warn).
    // Previously the sink captured every call regardless of level, so a chatty
    // debug/diagnostic namespace flooded ~/.config/tlda/client.log + fired a
    // POST per event and pegged the renderer. Now a namespace must be turned up
    // (e.g. ?log=chat-scroll:debug) to be captured — same control for file + console.
    if (!shouldLog(ns, level)) return
    enqueue({ ts: new Date().toISOString(), level, ns, msg, data, session: _session })
    const prefix = `[${ns}]`
    if (data !== undefined) {
      consoleFn(prefix, msg, data)
    } else {
      consoleFn(prefix, msg)
    }
  }
}

export const log = {
  debug: makeLogger('debug', console.debug),
  info: makeLogger('info', console.info),
  warn: makeLogger('warn', console.warn),
  error: makeLogger('error', console.error),

  /** True when a namespace would emit at this level; use to guard expensive diagnostics. */
  isEnabled(ns: string, level: Level = 'debug') {
    return shouldLog(ns, level)
  },

  /** Change console level at runtime: log.setLevel('debug') or log.setLevel('fleet', 'debug') */
  setLevel(nsOrLevel: string, level?: Level) {
    if (level) {
      _nsLevels[nsOrLevel] = level
    } else {
      _globalLevel = nsOrLevel as Level
    }
  },

  /** Server-sink-only metric: ALWAYS captured to ~/.config/tlda/client.log (no
   *  console, no level gate). For low-volume telemetry (e.g. pan frame-health)
   *  that we want on disk by default without turning a namespace up or spamming
   *  the console. Still batched + queue-capped, so it can't flood the renderer. */
  metric(ns: string, msg: string, data?: any) {
    enqueue({ ts: new Date().toISOString(), level: 'info', ns, msg, data, session: _session })
  },

  /** Flush queued entries to the server sink immediately. */
  flush,
}

// Expose on window for console access: log.setLevel('debug') / log.flush()
if (typeof window !== 'undefined') {
  (window as any).__log = log
}
