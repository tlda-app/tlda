// agy activity-card source — emit the same activity events for agy agents
// that the Claude-JSONL path emits for claude agents.
//
// agy agents write their turns to sqlite
// (~/.gemini/antigravity-cli/conversations/<id>.db, `steps` table) instead
// of JSONL, so without this source an agy agent shows awake/thinking
// (pane-based) but produces NO activity cards. Step payloads are protobuf
// blobs; the walk below is schema-less (wire format only, no .proto) and
// collects printable string fields, which is where the text, tool names,
// call ids, and JSON args all live (reversed 2026-09-16 against live
// sessions: 14=user, 15=assistant, 132=tool call, 101=system notice).
//
// New rows flow to the daemon's existing bufferActivity() so they ride the
// same throttle + `activity-event` WS message — no new card pipeline.
// Tool RESULT bodies are not mapped (v1): cards show the tool and its args,
// and result-built pretty cards do not fire for agy.

import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { humanToolName, toolBaseName } from '../shared/activity-tool-classification.mjs'
import { isObservableDaemonProcessBinding } from './daemon-process-binding.mjs'

export const AGY_STEP_USER = 14
export const AGY_STEP_ASSISTANT = 15
export const AGY_STEP_TOOL = 132

function readVarint(buf, offset) {
  let value = 0n
  let shift = 0n
  let i = offset
  for (;;) {
    if (i >= buf.length) throw new Error('truncated varint')
    const byte = buf[i++]
    value |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) break
    shift += 7n
    if (shift > 63n) throw new Error('oversized varint')
  }
  return [value, i]
}

const PRINTABLE_RE = /^[\x20-\x7e\xa0-\u{10ffff}\s]*$/u

// Collect every printable length-delimited field, recursing into nested
// messages. Strict: a sub-blob that does not parse cleanly as protobuf is
// a terminal string, never a message — without that, walking INTO a string
// mints junk fields out of its own bytes (measured: "RESUMED42" yielded a
// phantom f10="SUMED42").
export function protoStrings(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || [])
  const out = []
  const walk = (b) => {
    let o = 0
    while (o < b.length) {
      const [tag, o1] = readVarint(b, o)
      o = o1
      const field = Number(tag >> 3n)
      const wire = Number(tag & 7n)
      if (field === 0 || field > 536870911 || !Number.isSafeInteger(field)) throw new Error('bad tag')
      if (wire === 0) {
        const [, o2] = readVarint(b, o)
        o = o2
      } else if (wire === 1) {
        o += 8
        if (o > b.length) throw new Error('truncated fixed64')
      } else if (wire === 5) {
        o += 4
        if (o > b.length) throw new Error('truncated fixed32')
      } else if (wire === 2) {
        const [len, o2] = readVarint(b, o)
        o = o2
        const n = Number(len)
        if (!Number.isSafeInteger(n) || o + n > b.length) throw new Error('truncated bytes')
        const sub = b.subarray(o, o + n)
        o += n
        const s = sub.toString('utf8')
        if (sub.length >= 2 && PRINTABLE_RE.test(s)) out.push(s)
        if (sub.length > 6) {
          try { walk(sub) } catch { /* terminal string, not a message */ }
        }
      } else {
        throw new Error(`bad wire type ${wire}`)
      }
    }
  }
  try { walk(buf) } catch { /* best effort: keep what was collected */ }
  return [...new Set(out)]
}

const AGY_ID_RES = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^bot-[0-9a-f-]{30,}$/i,
  /^t-[0-9a-f-]{30,}$/i,
  /^call_\d+$/,
  /^sessionID$/i,
  /^-?\d+$/,
]
const AGY_TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/

function isIdString(s) {
  return AGY_ID_RES.some((re) => re.test(s))
}

function parseToolArgs(strings) {
  for (const s of strings) {
    const t = s.trim()
    if (!t.startsWith('{')) continue
    try {
      const parsed = JSON.parse(t)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* not JSON; keep looking */ }
  }
  return null
}

// Map one agy step row to activity events matching extractActivityEvents:
//   assistant text → { tool: '_text', arg: text, ts }
//   tool call      → { tool, arg, ts, id, input }
// User-role text is skipped — the claude path likewise skips user text —
// and uninterpretable steps (no tool name, unknown type) emit nothing:
// fail safe, never a garbage card.
export function agyStepEvents(step, isNoise, now = () => new Date().toISOString()) {
  const events = []
  const payload = step?.step_payload
  if (!payload || payload.length === 0) return events
  const ts = now()
  if (step.step_type === AGY_STEP_ASSISTANT) {
    const text = protoStrings(payload).filter((s) => !isIdString(s)).join('\n').trim()
    if (text) events.push({ tool: '_text', arg: text, ts })
    return events
  }
  if (step.step_type !== AGY_STEP_TOOL) return events
  const strings = protoStrings(payload)
  const id = strings.find((s) => /^call_\d+$/.test(s)) || `agy-step-${step.idx ?? '?'}`
  const args = parseToolArgs(strings)
  // MCP calls record as tool `call_mcp_tool` with the real address in the
  // args (measured: {"ServerName":"tlda","ToolName":"login",...}).
  let rawName = strings.find((s) => AGY_TOOL_NAME_RE.test(s) && !/^call_\d+$/.test(s)) || null
  if (rawName === 'call_mcp_tool' && args?.ServerName && args?.ToolName) {
    rawName = `${args.ServerName}__${args.ToolName}`
  }
  if (!rawName) return events
  const base = toolBaseName(rawName)
  if (isNoise && isNoise(base)) return events
  const tool = humanToolName(rawName)
  const arg = args
    ? (args.toolSummary || args.toolAction || args.AbsolutePath || args.DirectoryPath || args.command || args.pattern || args.query || args.text || '')
    : ''
  const evt = { tool, arg: String(arg), ts, id }
  if (args && Object.keys(args).length > 0) evt.input = args
  events.push(evt)
  return events
}

// cwd → conversation id via the pointer agy itself maintains. Last writer
// wins across concurrent agents sharing one workspace (the same race the
// identity resolver documents); fleet seats normally have distinct
// checkouts. No pointer, no crash: the tick skips the agent.
export function agyConversationIdForCwd(cwd, home = os.homedir()) {
  if (!cwd) return null
  let parsed
  try {
    const text = fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json'), 'utf8')
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  // agy keys this pointer by the cwd as given (measured: '/tmp/...' stored
  // unresolved on macOS), while callers may hand over either form; try raw
  // first, then resolved.
  const direct = parsed[cwd]
  if (typeof direct === 'string' && direct) return direct
  try {
    const resolved = parsed[fs.realpathSync(cwd)]
    return typeof resolved === 'string' && resolved ? resolved : null
  } catch {
    return null
  }
}

function agyConversationsDir(home = os.homedir()) {
  return path.join(home, '.gemini', 'antigravity-cli', 'conversations')
}

// One activity tick: for each agy agent, read steps newer than what we've
// seen and emit their events. On first sight of an agent we record its
// current max idx WITHOUT backfilling (cards start from "now", the goose
// rule). `lastSeen` is a Map(agentId → idx) the caller owns and persists
// across ticks.
//   deps: { bufferActivity, log, lastSeen, isNoise, home }
export function agyActivityTick(agents, deps) {
  const { bufferActivity, log = console, lastSeen, isNoise, home = os.homedir() } = deps
  for (const agent of agents || []) {
    const kind = agent?.metadata?.kind
    if (!agent || kind !== 'agy' || !isObservableDaemonProcessBinding(agent)) continue
    const convId = agyConversationIdForCwd(agent.cwd, home)
    if (!convId) continue
    const dbPath = path.join(agyConversationsDir(home), `${convId}.db`)
    let db = null
    try {
      db = new Database(dbPath, { readonly: true })
      if (!lastSeen.has(agent.id)) {
        const m = db.prepare('SELECT MAX(idx) AS m FROM steps').get()
        lastSeen.set(agent.id, (m && Number.isInteger(m.m)) ? m.m : -1)
        continue
      }
      const since = lastSeen.get(agent.id)
      const rows = db.prepare(
        'SELECT idx, step_type, step_payload FROM steps WHERE idx > ? ORDER BY idx ASC'
      ).all(since)
      if (!rows.length) continue
      const events = []
      for (const r of rows) events.push(...agyStepEvents(r, isNoise))
      if (events.length) bufferActivity(agent.id, events)
      lastSeen.set(agent.id, rows[rows.length - 1].idx)
    } catch (e) {
      log.warn?.(`agy activity tick failed for ${agent.id}: ${e.message}`)
    } finally {
      try { db?.close() } catch { /* already closed */ }
    }
  }
}