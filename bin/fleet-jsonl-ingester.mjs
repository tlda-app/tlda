#!/usr/bin/env node
// Niced child of the fleet daemon. Owns JSONL tail IO, parsing, and extraction
// so the daemon's main loop stays available for WS heartbeats, RPC, and
// presence. The parent remains the single owner of daemon state, delivery, and
// cursor persistence.
import os from 'os'
import path from 'path'
import fs from 'fs'
import { PassThrough } from 'stream'
import { createInterface } from 'readline'
import { pathToFileURL } from 'url'
import chokidar from 'chokidar'
import { parser as jsonlParser } from 'stream-json/jsonl/parser.js'
import { parseCodexRecord } from '../agent-runtime/codex-activity.mjs'
import {
  extractIdentityFromRecord,
} from '../agent-runtime/daemon-jsonl-hot-path.mjs'
import {
  defaultActivityExtractor,
  parseSessionRecord,
} from '../agent-runtime/jsonl-event-extract.mjs'
import {
  createNativeTaskState,
  extractNativeTaskEvents,
} from '../agent-runtime/native-task-events.mjs'

const MAX_CONTEXT = 200_000
const watchers = new Map()
const pendingJobAcks = new Map()
const activeJobs = new Map()

export class WatchReadTailFile extends PassThrough {
  constructor(filename, {
    startPos = null,
    watch = chokidar.watch,
    readStream = fs.createReadStream,
    stat = fs.promises.stat,
    ...superOpts
  } = {}) {
    super(superOpts)
    if (typeof filename !== 'string' || !filename.length) {
      const err = new TypeError('filename must be a non-empty string')
      err.code = 'EFILENAME'
      throw err
    }
    if (startPos !== null && startPos !== undefined) {
      if (!Number.isInteger(startPos) || startPos < 0) {
        const err = new RangeError('startPos must be an integer >= 0')
        err.code = 'ESTARTPOS'
        throw err
      }
    }
    this.filename = filename
    this.offset = startPos >= 0 ? startPos : null
    this.watch = watch
    this.readStream = readStream
    this.stat = stat
    this.watcher = null
    this.currentStream = null
    this.quitting = false
    this.reading = false
    this.pendingRead = false
  }

  async start() {
    this.watcher = this.watch(this.filename, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false,
      usePolling: false,
      alwaysStat: false,
    })
      .on('add', () => this.requestRead())
      .on('change', () => this.requestRead())
      .on('error', e => this.emit('tail_error', e))
    await this.readAvailable()
  }

  requestRead() {
    if (this.quitting) return
    if (this.reading) {
      this.pendingRead = true
      return
    }
    this.readAvailable().catch(e => {
      if (!this.quitting) this.emit('tail_error', e)
    })
  }

  async readAvailable() {
    if (this.reading) {
      this.pendingRead = true
      return
    }
    this.reading = true
    try {
      do {
        this.pendingRead = false
        await this.readOnce()
      } while (this.pendingRead && !this.quitting)
    } finally {
      this.reading = false
    }
  }

  async readOnce() {
    let stats
    try {
      stats = await this.stat(this.filename)
    } catch (e) {
      if (e?.code === 'ENOENT') return
      throw e
    }

    if (this.offset === null) this.offset = stats.size
    if (stats.size <= this.offset) {
      this.emitFlush()
      return
    }

    await this.streamRange(this.offset, stats.size)
    this.emitFlush()
  }

  async streamRange(start, end) {
    const stream = this.readStream(this.filename, { start, end: end - 1 })
    this.currentStream = stream
    try {
      const iterator = stream.iterator ? stream.iterator({ destroyOnReturn: false }) : stream
      for await (const chunk of iterator) {
        this.offset += chunk.length
        if (!this.write(chunk)) await new Promise(resolve => this.once('drain', resolve))
      }
    } finally {
      if (this.currentStream === stream) this.currentStream = null
    }
  }

  emitFlush() {
    setImmediate(this.emit.bind(this), 'flush', { lastReadPosition: this.offset || 0 })
  }

  async quit() {
    this.quitting = true
    if (this.watcher) {
      try { await this.watcher.close() } catch (e) { this.emit('tail_error', e) }
    }
    if (this.currentStream) this.currentStream.destroy()
    this.end()
  }
}

export function createSafeIpcSender(processLike = process, {
  onClosed = () => {},
} = {}) {
  let ipcOpen = !!processLike.send
  let warnedClosed = false
  function markClosed(e) {
    ipcOpen = false
    if (!warnedClosed) {
      warnedClosed = true
      onClosed(e)
    }
  }
  return function safeSend(msg) {
    if (!ipcOpen || !processLike.connected || !processLike.send) {
      const e = new Error('IPC channel closed')
      e.code = 'ERR_IPC_CHANNEL_CLOSED'
      markClosed(e)
      return false
    }
    try {
      processLike.send(msg)
      return true
    } catch (e) {
      if (e?.code === 'EPIPE' || e?.code === 'ERR_IPC_CHANNEL_CLOSED') {
        markClosed(e)
        return false
      }
      throw e
    }
  }
}

const send = createSafeIpcSender(process, {
  onClosed: (e) => {
    // A closed IPC channel leaves this child tailing files with no way to
    // deliver activity or terminal-chat records. Exit so the parent can
    // recreate the child and resync every live watcher.
    try { process.stderr.write(`[fleet-jsonl-ingester] parent IPC closed: ${e.code}; exiting for resync\n`) } catch {
      // Best-effort diagnostic after parent IPC closure; do not crash while exiting.
    }
    process.exit(1)
  },
})

function parseRecordForHarness(harnessKind, record) {
  if (harnessKind === 'claude') return parseSessionRecord(record)
  if (harnessKind === 'codex') return parseCodexRecord(record)
  return null
}

export function terminalChatFromRecord(parsed) {
  if (parsed.type !== 'user') return null
  if (parsed.isMeta) return null
  const content = parsed.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) text = content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
  if (!text || text.length < 3) return null
  if (text.length > 2000) text = text.substring(0, 2000)
  if (text.startsWith('<task-notification') || text.startsWith('<system-reminder') ||
      text.startsWith('<channel') || text.startsWith('📬') ||
      /^Call (?:login|register)\([^)]*\) with the (?:tlda|fleet) MCP server\b/.test(text)) return null
  const ts = parsed.timestamp || null
  if (!ts) return null
  return { text, ts }
}

export function searchEntriesFromRecord(agentId, sessionId, parsed) {
  return searchEntriesFromEvent(agentId, sessionId, parsed)
}

function searchTextFromEvent(event) {
  const blocks = Array.isArray(event?.blocks) ? event.blocks : []
  return blocks
    .filter(block => block?.type === 'text' || block?.type === 'tool_result')
    .map(block => block.text || '')
    .filter(Boolean)
    .join('\n')
}

export function searchEntriesFromEvent(agentId, sessionId, event) {
  if (event?.type !== 'user' && event?.type !== 'assistant') return []
  const ts = event.timestamp || event.message?.timestamp || event.snapshot?.timestamp || null
  if (!ts) return []
  let text = searchTextFromEvent(event)
  if (!text) {
    const content = event.message?.content
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) text = content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
  }
  if (!text || text.length < 3) return []
  return [{ agent_id: agentId, session_id: sessionId, role: event.type, timestamp: ts, text }]
}

export function searchEntriesFromHarnessRecord(agentId, sessionId, harnessKind, record) {
  const event = parseRecordForHarness(harnessKind, record)
  if (event) return searchEntriesFromEvent(agentId, sessionId, event)
  if (record?.type !== 'user' && record?.type !== 'assistant') return []
  const ts = record.timestamp || record.message?.timestamp || record.snapshot?.timestamp || null
  if (!ts) return []
  const content = record.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) text = content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
  if (!text || text.length < 3) return []
  return [{ agent_id: agentId, session_id: sessionId, role: record.type, timestamp: ts, text }]
}

export function extractRecordOutputs({ agentId, sessionId, harnessKind, terminalChat, backfillSearch }, record) {
  const outputs = []
  const identity = extractIdentityFromRecord(record)
  if (identity) outputs.push({ type: 'identity', identity })
  const ev = parseRecordForHarness(harnessKind, record)
  if (ev) {
    const activity = defaultActivityExtractor.extractActivityEvents([ev])
    if (activity.length > 0) outputs.push({ type: 'activity', events: activity })
    if (ev.usage) {
      const used = ev.usage.input
      const pct = Math.max(0, Math.round((1 - used / MAX_CONTEXT) * 100))
      outputs.push({ type: 'context', contextPercent: pct, inputTokens: used })
    }
    outputs.push({ type: 'qualification', event: ev })
  }

  if (terminalChat) {
    const chat = terminalChatFromRecord(record)
    if (chat) outputs.push({ type: 'terminalChat', ...chat })
  }
  if (backfillSearch) {
    const entries = searchEntriesFromHarnessRecord(agentId, sessionId, harnessKind, record)
    if (entries.length > 0) outputs.push({ type: 'searchIndex', entries })
  }
  return outputs
}

export function extractRecordOutputsWithState(opts, record, nativeTaskState) {
  const outputs = extractRecordOutputs(opts, record)
  const nativeTasks = extractNativeTaskEvents({
    harnessKind: opts.harnessKind,
    record,
    state: nativeTaskState,
  })
  if (nativeTasks.length > 0) outputs.push({ type: 'nativeTask', events: nativeTasks })
  return outputs
}

async function sendJobBatch(job, payload) {
  const seq = ++job.nextSeq
  return new Promise((resolve, reject) => {
    pendingJobAcks.set(`${job.jobId}:${seq}`, { resolve, reject })
    send({ type: 'job-batch', jobId: job.jobId, seq, ...payload })
  })
}

function ackJobBatch(msg) {
  const key = `${msg.jobId}:${msg.seq}`
  const waiter = pendingJobAcks.get(key)
  if (!waiter) return
  pendingJobAcks.delete(key)
  if (msg.ok) waiter.resolve()
  else waiter.reject(new Error(msg.error || 'parent rejected job batch'))
}

async function readJsonlLines(filePath, onRecord) {
  const rl = createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    if (!line.trim()) continue
    let parsed
    try { parsed = JSON.parse(line) } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
      continue
    }
    await onRecord(parsed, line)
  }
}

export async function runSearchBackfillJob(job) {
  const entries = []
  const identities = []
  let sentEntries = 0
  const identityBase = {
    session_id: job.sessionId,
    harness_kind: job.harnessKind || null,
    jsonl_path: job.jsonlPath,
  }
  let ownerPushed = false
  await readJsonlLines(job.jsonlPath, async (parsed, line) => {
    const identity = extractIdentityFromRecord(parsed)
    if (identity) {
      // FIRST-REGISTERED-WINS: only the first genuine hex `Registered fleet:<id>` line
      // supplies the session's fleet_id (the login handshake). Later ones are the agent
      // quoting other agents' logs — keep any cwd/name but strip the polluted fleet_id,
      // else a log-reader writes its session id onto every agent it ever grepped.
      if (identity.fleet_id && !ownerPushed && /Registered fleet:[0-9a-f]{8}\b/.test(line)) {
        identities.push({ ...identityBase, ...identity })
        ownerPushed = true
      } else {
        const { fleet_id, ...rest } = identity
        if (Object.keys(rest).length) identities.push({ ...identityBase, ...rest })
      }
    } else if (!ownerPushed && line.includes('Registered fleet:')) {
      const m = /Registered fleet:([0-9a-f]{8})\b/.exec(line)
      if (m) {
        identities.push({ ...identityBase, fleet_id: 'fleet:' + m[1] })
        ownerPushed = true
      }
    }
    const searchEntries = searchEntriesFromHarnessRecord(job.agentId, job.sessionId, job.harnessKind, parsed)
    for (const entry of searchEntries) entries.push(entry)
    while (entries.length >= 200) {
      const batch = entries.splice(0, 200)
      sentEntries += batch.length
      await sendJobBatch(job, { entries: batch })
    }
  })
  if (entries.length > 0) {
    const batch = entries.splice(0)
    sentEntries += batch.length
    await sendJobBatch(job, { entries: batch })
  }
  return { entries: sentEntries, identities }
}

async function startJob(msg) {
  const job = { ...msg, nextSeq: 0 }
  activeJobs.set(job.jobId, job)
  try {
    let result
    if (job.jobKind === 'search') {
      result = await runSearchBackfillJob(job)
    } else {
      throw new Error(`unknown job kind: ${job.jobKind}`)
    }
    send({ type: 'job-complete', jobId: job.jobId, jobKind: job.jobKind, result })
  } catch (e) {
    send({ type: 'job-failed', jobId: job.jobId, jobKind: job.jobKind, error: e?.message || String(e) })
  } finally {
    activeJobs.delete(job.jobId)
  }
}

function pauseWatcher(w) {
  if (w.paused) return
  w.paused = true
  try { w.parser?.pause?.() } catch (e) {
    send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `parser pause failed: ${e?.message || e}` })
  }
  try { w.tail?.pause?.() } catch (e) {
    send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `tail pause failed: ${e?.message || e}` })
  }
}

function resumeWatcher(w) {
  if (!w.paused || w.inFlightSeq || w.queue.length > 0) return
  w.paused = false
  try { w.tail?.resume?.() } catch (e) {
    send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `tail resume failed: ${e?.message || e}` })
  }
  try { w.parser?.resume?.() } catch (e) {
    send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `parser resume failed: ${e?.message || e}` })
  }
}

function maybeSendFlush(w) {
  if (w.pendingFlushOffset == null) return
  if (w.inFlightSeq || w.queue.length > 0) return
  const offset = w.pendingFlushOffset
  w.pendingFlushOffset = null
  send({ type: 'flush', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, offset })
}

function watcherIdle(w) {
  return !w.inFlightSeq && w.queue.length === 0 && w.pendingFlushOffset == null
}

function completeDrainRequests(w) {
  if (!w.drainRequests?.length || !watcherIdle(w)) return
  const requests = w.drainRequests.splice(0)
  for (const req of requests) {
    clearTimeout(req.timer)
    send({
      type: 'drained',
      requestId: req.requestId,
      watchId: w.watchId,
      sessionId: w.sessionId,
      jsonlPath: w.jsonlPath,
      ok: true,
      active: true,
    })
  }
}

function sendNext(w) {
  if (w.inFlightSeq || w.queue.length === 0) {
    maybeSendFlush(w)
    completeDrainRequests(w)
    resumeWatcher(w)
    return
  }
  pauseWatcher(w)
  const batch = w.queue.shift()
  w.inFlightSeq = batch.seq
  send({
    type: 'batch',
    watchId: w.watchId,
    sessionId: w.sessionId,
    jsonlPath: w.jsonlPath,
    seq: batch.seq,
    outputs: batch.outputs,
  })
}

function enqueueRecord(w, record) {
  const daemonReceivedAtMs = Date.now()
  const outputs = extractRecordOutputsWithState(w, record, w.nativeTaskState)
  for (const output of outputs) {
    if (output.type !== 'activity') continue
    for (const event of output.events || []) {
      event.daemonReceivedAtMs = daemonReceivedAtMs
      event.daemonReceivedAt = new Date(daemonReceivedAtMs).toISOString()
    }
  }
  if (outputs.length === 0) return
  w.queue.push({ seq: ++w.nextSeq, outputs })
  sendNext(w)
}

function startWatch(msg) {
  stopWatch(msg.watchId, 'replace')
  const parser = jsonlParser.asStream({ ignoreErrors: true })
  const tail = new WatchReadTailFile(msg.jsonlPath, {
    startPos: msg.startOffset,
  })
  const w = {
    watchId: msg.watchId,
    jsonlPath: msg.jsonlPath,
    sessionId: msg.sessionId,
    agentId: msg.agentId,
    harnessKind: msg.harnessKind,
    terminalChat: !!msg.terminalChat,
    backfillSearch: !!msg.backfillSearch,
    tail,
    parser,
    queue: [],
    nextSeq: 0,
    inFlightSeq: null,
    pendingFlushOffset: null,
    nativeTaskState: createNativeTaskState(),
    drainRequests: [],
    paused: false,
    stopped: false,
  }
  parser.on('data', item => {
    if (w.stopped || !item || item.value === undefined) return
    try {
      enqueueRecord(w, item.value)
    } catch (e) {
      send({ type: 'error', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, error: e?.message || String(e) })
    }
  })
  parser.on('error', e => {
    send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `JSONL parser error: ${e?.message || e}` })
  })
  tail.on('flush', ({ lastReadPosition }) => {
    if (w.stopped) return
    w.pendingFlushOffset = lastReadPosition
    maybeSendFlush(w)
  })
  tail.on('tail_error', e => send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `watch-read tail error: ${e?.message || e}` }))
  tail.on('error', e => send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `tail stream error: ${e?.message || e}` }))
  tail.pipe(parser)
  watchers.set(w.watchId, w)
  tail.start()
    .then(() => send({ type: 'started', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath }))
    .catch(e => {
      if (!w.stopped) {
        send({ type: 'start-failed', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, error: e?.message || String(e) })
        stopWatch(w.watchId, 'start failed')
      }
    })
}

function ackBatch(msg) {
  const w = watchers.get(msg.watchId)
  if (!w || w.inFlightSeq !== msg.seq) return
  w.inFlightSeq = null
  if (!msg.ok) {
    stopWatch(w.watchId, 'parent rejected batch')
    return
  }
  sendNext(w)
}

function drainOnce(msg) {
  const w = watchers.get(msg.watchId)
  if (!w) {
    send({ type: 'drained', requestId: msg.requestId, watchId: msg.watchId, ok: false, active: false, reason: 'no-live-tail' })
    return
  }
  const requestId = msg.requestId || `${msg.watchId}:${Date.now()}`
  const timeoutMs = Number(msg.timeoutMs || 2000)
  const minWaitMs = Number(msg.minWaitMs || 0)
  const req = {
    requestId,
    timer: setTimeout(() => {
      const idx = w.drainRequests.findIndex(item => item.requestId === requestId)
      if (idx !== -1) w.drainRequests.splice(idx, 1)
      send({
        type: 'drained',
        requestId,
        watchId: w.watchId,
        sessionId: w.sessionId,
        jsonlPath: w.jsonlPath,
        ok: false,
        active: true,
        reason: 'timeout',
      })
    }, timeoutMs),
  }
  w.drainRequests.push(req)
  setTimeout(() => {
    maybeSendFlush(w)
    completeDrainRequests(w)
  }, minWaitMs)
}

function updateWatch(msg) {
  const w = watchers.get(msg.watchId)
  if (!w) return
  if (msg.agentId) w.agentId = msg.agentId
  if (msg.harnessKind) w.harnessKind = msg.harnessKind
  if (typeof msg.terminalChat === 'boolean') w.terminalChat = msg.terminalChat
  if (typeof msg.backfillSearch === 'boolean') w.backfillSearch = msg.backfillSearch
}

function stopWatch(watchId, reason = 'stop') {
  const w = watchers.get(watchId)
  if (!w) return
  watchers.delete(watchId)
  w.stopped = true
  try { w.tail?.unpipe?.(w.parser) } catch (e) {
    send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `tail unpipe failed (${reason}): ${e?.message || e}` })
  }
  try { w.parser?.destroy?.() } catch (e) {
    send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `parser destroy failed (${reason}): ${e?.message || e}` })
  }
  Promise.resolve(w.tail?.quit?.()).catch(e => {
    send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `watch-read tail quit failed (${reason}): ${e?.message || e}` })
  })
}

function shutdown() {
  for (const watchId of [...watchers.keys()]) stopWatch(watchId, 'shutdown')
  process.exit(0)
}

function runMain() {
  try { os.setPriority(process.pid, 10) } catch { /* priority is advisory */ }
  process.on('message', (msg) => {
    if (msg?.type === 'watch') startWatch(msg)
    else if (msg?.type === 'update') updateWatch(msg)
    else if (msg?.type === 'ack') ackBatch(msg)
    else if (msg?.type === 'drain-once') drainOnce(msg)
    else if (msg?.type === 'job') void startJob(msg)
    else if (msg?.type === 'job-ack') ackJobBatch(msg)
    else if (msg?.type === 'stop') stopWatch(msg.watchId)
    else if (msg?.type === 'shutdown') shutdown()
  })

  process.on('disconnect', () => {
    shutdown()
  })

  send({ type: 'ready' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain()
}
