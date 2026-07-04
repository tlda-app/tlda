#!/usr/bin/env node
// Niced child of the fleet daemon. Owns JSONL tail IO, parsing, and extraction
// so the daemon's main loop stays available for WS heartbeats, RPC, and
// presence. The parent remains the single owner of daemon state, delivery, and
// cursor persistence.
import os from 'os'
import path from 'path'
import fs from 'fs'
import { createInterface } from 'readline'
import TailFile from '@logdna/tail-file'
import { parser as jsonlParser } from 'stream-json/jsonl/parser.js'
import { parseCodexRecord } from './lib/codex-activity.mjs'
import {
  decideSessionBackfill,
  extractIdentityFromRecord,
  extractOwnersFromText,
  scanFileIdentitySync,
} from './lib/daemon-jsonl-hot-path.mjs'
import {
  defaultActivityExtractor,
  parseSessionRecord,
} from './lib/jsonl-event-extract.mjs'

try { os.setPriority(process.pid, 10) } catch { /* priority is advisory */ }

const MAX_CONTEXT = 200_000
const watchers = new Map()
const pendingJobAcks = new Map()
const activeJobs = new Map()

function send(msg) {
  process.send?.(msg)
}

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
      /^Call register\([^)]*\) with the fleet MCP server\b/.test(text)) return null
  const ts = parsed.timestamp || null
  if (!ts) return null
  return { text, ts }
}

export function searchEntriesFromRecord(agentId, sessionId, parsed) {
  if (parsed.type !== 'user' && parsed.type !== 'assistant') return []
  const ts = parsed.timestamp || parsed.message?.timestamp || parsed.snapshot?.timestamp || null
  if (!ts) return []
  const content = parsed.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) text = content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
  if (!text || text.length < 3) return []
  return [{ agent_id: agentId, session_id: sessionId, role: parsed.type, timestamp: ts, text }]
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
    const entries = searchEntriesFromRecord(agentId, sessionId, record)
    if (entries.length > 0) outputs.push({ type: 'searchIndex', entries })
  }
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
  await readJsonlLines(job.jsonlPath, async (parsed, line) => {
    const identity = extractIdentityFromRecord(parsed)
    if (identity) identities.push({ ...identityBase, ...identity })
    else if (line.includes('Registered fleet:')) {
      const owners = extractOwnersFromText(line)
      for (const owner of owners) identities.push({ ...identityBase, fleet_id: owner })
    }
    const searchEntries = searchEntriesFromRecord(job.agentId, job.sessionId, parsed)
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

function listJsonlFiles(projectsDir) {
  const out = []
  let dirs
  try { dirs = fs.readdirSync(projectsDir) } catch (e) {
    if (e?.code === 'ENOENT') return out
    throw e
  }
  for (const dir of dirs) {
    const dirPath = path.join(projectsDir, dir)
    let files
    try { files = fs.readdirSync(dirPath) } catch (e) {
      if (e?.code === 'ENOTDIR' || e?.code === 'ENOENT') continue
      throw e
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      out.push({ sessionId: file.slice(0, -6), filePath: path.join(dirPath, file) })
    }
  }
  return out
}

async function runPriorBackfillJob(job) {
  let found = 0
  const identities = []
  for (const item of listJsonlFiles(job.projectsDir)) {
    if (job.cursors?.[item.sessionId]?.searchBackfilled) continue
    let decision
    let scanned = null
    try {
      decision = decideSessionBackfill(job.cursors?.[item.sessionId], job.fleetId, () => {
        scanned = scanFileIdentitySync(item.filePath)
        return { owners: scanned.owners || [] }
      })
    } catch (e) {
      send({ type: 'warn', jobId: job.jobId, warning: `prior backfill scan failed for ${item.filePath}: ${e?.message || e}` })
      continue
    }
    if (scanned?.identity) {
      identities.push({
        session_id: item.sessionId,
        harness_kind: 'claude',
        jsonl_path: item.filePath,
        ...scanned.identity,
        classified: true,
      })
    } else if (decision.didScan) {
      for (const owner of decision.owners || []) {
        identities.push({
          session_id: item.sessionId,
          harness_kind: 'claude',
          jsonl_path: item.filePath,
          fleet_id: owner,
          classified: true,
        })
      }
    }
    if (!decision.shouldBackfill) continue
    await runSearchBackfillJob({
      ...job,
      sessionId: item.sessionId,
      harnessKind: 'claude',
      jsonlPath: item.filePath,
    })
    send({ type: 'job-session-complete', jobId: job.jobId, sessionId: item.sessionId, jsonlPath: item.filePath })
    found++
  }
  return { found, identities }
}

async function startJob(msg) {
  const job = { ...msg, nextSeq: 0 }
  activeJobs.set(job.jobId, job)
  try {
    let result
    if (job.jobKind === 'search') {
      result = await runSearchBackfillJob(job)
    } else if (job.jobKind === 'prior') {
      result = await runPriorBackfillJob(job)
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

function sendNext(w) {
  if (w.inFlightSeq || w.queue.length === 0) {
    maybeSendFlush(w)
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
  const outputs = extractRecordOutputs(w, record)
  if (outputs.length === 0) return
  w.queue.push({ seq: ++w.nextSeq, outputs })
  sendNext(w)
}

function startWatch(msg) {
  stopWatch(msg.watchId, 'replace')
  const parser = jsonlParser.asStream({ ignoreErrors: true })
  const tail = new TailFile(msg.jsonlPath, {
    startPos: msg.startOffset,
    pollFileIntervalMs: Number(process.env.TLDA_JSONL_TAIL_POLL_MS || 1000),
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
  tail.on('tail_error', e => send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `tail-file error: ${e?.message || e}` }))
  tail.on('error', e => send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `tail stream error: ${e?.message || e}` }))
  tail.on('renamed', () => send({ type: 'renamed', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath }))
  tail.on('truncated', () => send({ type: 'truncated', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath }))
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
    send({ type: 'warn', watchId: w.watchId, sessionId: w.sessionId, jsonlPath: w.jsonlPath, warning: `tail-file quit failed (${reason}): ${e?.message || e}` })
  })
}

function shutdown() {
  for (const watchId of [...watchers.keys()]) stopWatch(watchId, 'shutdown')
  process.exit(0)
}

process.on('message', (msg) => {
  if (msg?.type === 'watch') startWatch(msg)
  else if (msg?.type === 'update') updateWatch(msg)
  else if (msg?.type === 'ack') ackBatch(msg)
  else if (msg?.type === 'job') void startJob(msg)
  else if (msg?.type === 'job-ack') ackJobBatch(msg)
  else if (msg?.type === 'stop') stopWatch(msg.watchId)
  else if (msg?.type === 'shutdown') shutdown()
})

process.on('disconnect', shutdown)

send({ type: 'ready' })
