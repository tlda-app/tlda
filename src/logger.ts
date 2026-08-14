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
type LogEntry = { ts: string; level: Level; ns: string; msg: string; data?: any; session?: string }
type InFlightBatch = { deliveryId: string; entries: LogEntry[] }
const _queue: LogEntry[] = []
let _inFlight: InFlightBatch | null = null
let _sending = false
let _batchSequence = 0
let _flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_DELAY_MS = 250
const MAX_QUEUE = 200
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

function retry() {
  _retryDelayMs = Math.min(_retryDelayMs * 2, MAX_RETRY_DELAY_MS)
  scheduleFlush(_retryDelayMs)
}

async function post(batch: InFlightBatch) {
  _sending = true
  try {
    const response = await fetch(logBase() + '/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      keepalive: true,
    })
    if (!response.ok) return retry()
    if (_inFlight?.deliveryId === batch.deliveryId) _inFlight = null
    _retryDelayMs = FLUSH_DELAY_MS
    if (_queue.length) scheduleFlush(FLUSH_DELAY_MS)
  } catch {
    retry()
  } finally {
    _sending = false
  }
}

function flush() {
  _flushTimer = null
  if (_sending) return
  if (typeof navigator !== 'undefined' && !navigator.onLine) return
  if (!_inFlight && _queue.length) {
    _inFlight = {
      deliveryId: `${_session}:${++_batchSequence}`,
      entries: _queue.splice(0, _queue.length),
    }
  }
  if (_inFlight) void post(_inFlight)
}

if (typeof window !== 'undefined') {
  // Best-effort flush on tab close so the last events make it to the file.
  window.addEventListener('beforeunload', flush)
  window.addEventListener('pagehide', flush)
  window.addEventListener('online', () => scheduleFlush(0))
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
