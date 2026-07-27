// Goose activity-card source — emit the same activity events for DeepSeek/goose
// agents that the Claude-JSONL path emits for claude agents.
//
// Claude agents write ~/.claude/projects/*.jsonl, which the daemon watches and
// turns into activity cards. Goose agents write their turns to a sqlite db
// (~/.local/share/goose/sessions/sessions.db) instead, so without this source a
// goose agent shows awake/thinking (pane-based) but produces NO activity cards.
//
// This taps the SAME sqlite the kick uses (via goose-kick's gooseDb +
// gooseSessionId session map) and maps each new message's content blocks to the
// `{ tool, arg, ts, id, input }` activity-event shape, then hands them to the
// daemon's existing bufferActivity() so they flow through the same throttle +
// `activity-event` WS message — no new card pipeline, no pane-scraping.

import { gooseDb, gooseSessionId } from './goose-kick.mjs'
import { parseApplyPatchFiles } from './codex-activity.mjs'
import { normalizePrettyResult, truncatePrettyResult } from '../shared/activity-pretty-result.mjs'
import { humanToolName, isPrettyPrintTool, toolBaseName } from '../shared/activity-tool-classification.mjs'
import { isObservableDaemonProcessBinding } from './daemon-process-binding.mjs'

const pendingPrettyPrint = new Map()

function toolResponseId(block) {
  return block.id || block.toolCallId || block.tool_call_id || block.toolRequestId ||
    block.tool_request_id || block.requestId || block.request_id || block.callId ||
    block.call_id || block.toolCall?.id || block.toolCall?.value?.id || ''
}

function textFromToolResponse(value) {
  return normalizePrettyResult(value)
}

function toolResponseText(block) {
  return textFromToolResponse(
    block.toolResult?.value ?? block.toolResult ?? block.result ??
    block.output ?? block.content ?? block.value ?? block.text
  )
}

function gooseApplyPatchEvents(input, blockId, ts) {
  const patch = typeof input === 'string'
    ? input
    : (input?.input || input?.patch || input?.arguments || input?._raw || '')
  const files = parseApplyPatchFiles(patch)
  if (!files.length) {
    return [{
      tool: 'Edit',
      arg: '',
      ts,
      id: blockId,
      input: { _raw: patch },
    }]
  }
  return files.map((f, i) => ({
    tool: 'Edit',
    arg: f.path,
    ts,
    id: `${blockId || 'patch'}#${i}`,
    input: {
      file_path: f.path,
      op: f.op,
      diff: f.diff,
      ...(f.movedTo ? { movedTo: f.movedTo } : {}),
    },
  }))
}

// Map one goose message row (content_json = array of blocks) to activity events
// matching extractActivityEvents in fleet-daemon.mjs:
//   toolRequest block        → { tool, arg, ts, id, input }
//   assistant text            → { tool: '_text', arg: text, ts }
// reasoning (r1 thinking) and user-role text are skipped — the claude path
// likewise skips tool results except pretty-print and user text.
// `isNoise(baseName)` filters chat/inbox/login/etc. (the daemon's
// ACTIVITY_NOISE), keyed on the tool's base name after the `tlda__` prefix.
export function gooseMessageEvents(row, isNoise) {
  const events = []
  let blocks
  try { blocks = JSON.parse(row.content_json) } catch { return events }
  if (!Array.isArray(blocks)) return events
  const ts = new Date((row.created_timestamp || 0) * 1000).toISOString()
  const responsesInRow = new Map()
  for (const b of blocks) {
    if (!b || b.type !== 'toolResponse') continue
    const id = toolResponseId(b)
    if (!id) continue
    const raw = toolResponseText(b)
    if (raw) responsesInRow.set(id, raw)
  }
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'toolRequest') {
      const name = b.toolCall?.value?.name || ''
      if (!name) continue
      const input = b.toolCall?.value?.arguments || {}
      if (name === 'apply_patch') {
        events.push(...gooseApplyPatchEvents(input, b.id, ts))
        continue
      }
      const base = toolBaseName(name)
      if (isNoise && isNoise(base)) continue
      const humanName = humanToolName(name)  // tlda__read_project → tlda/read_project
      const arg = input.file_path || input.path || input.command || input.cat || input.pattern ||
        input.message || input.query || input.description || input.reason ||
        input.doc || input.ref || input.text || ''
      const evt = { tool: humanName, arg: String(arg), ts, id: b.id }
      if (input && Object.keys(input).length > 0) evt.input = input
      if (isPrettyPrintTool(name) && b.id) {
        if (responsesInRow.has(b.id)) {
          evt.prettyResult = truncatePrettyResult(responsesInRow.get(b.id), name)
          events.push(evt)
          continue
        }
        pendingPrettyPrint.set(b.id, { evt: { ...evt }, name, expiresAt: Date.now() + 30000 })
      }
      events.push(evt)
    } else if (b.type === 'toolResponse') {
      const id = toolResponseId(b)
      if (!id || !pendingPrettyPrint.has(id)) continue
      const pending = pendingPrettyPrint.get(id)
      pendingPrettyPrint.delete(id)
      const raw = toolResponseText(b)
      if (!raw) continue
      const prettyResult = truncatePrettyResult(raw, pending.name)
      events.push({
        ...pending.evt,
        origTool: pending.evt.tool,
        tool: '_prettyResult',
        prettyResult,
        ts: pending.evt.ts,
      })
    } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
      if (row.role === 'user') continue   // inbound nudges / terminal input — not activity
      events.push({ tool: '_text', arg: b.text, ts })
    }
    // reasoning (r1) intentionally skipped
  }
  const now = Date.now()
  for (const [id, entry] of pendingPrettyPrint) {
    if (now > entry.expiresAt) pendingPrettyPrint.delete(id)
  }
  return events
}

// One activity tick: for each awake goose agent, read messages newer than what
// we've seen and emit their events. On first sight of an agent we record its
// current max id WITHOUT backfilling (cards start from "now", like the claude
// path starting a fresh JSONL watch at EOF). `lastSeen` is a Map(agentId → id)
// the caller owns and persists across ticks.
//   deps: { bufferActivity, log, lastSeen, isNoise }
export function gooseActivityTick(agents, deps) {
  const { bufferActivity, log = console, lastSeen, isNoise } = deps
  const db = gooseDb(log)
  if (!db) return
  for (const agent of agents) {
    const kind = agent?.metadata?.kind
    if (!agent || kind !== 'goose' || !isObservableDaemonProcessBinding(agent)) continue
    const sid = gooseSessionId(agent.id, log)
    if (!sid) continue
    try {
      if (!lastSeen.has(agent.id)) {
        const m = db.prepare('SELECT MAX(id) AS m FROM messages WHERE session_id = ?').get(sid)
        lastSeen.set(agent.id, (m && m.m) || 0)
        continue
      }
      const since = lastSeen.get(agent.id)
      const rows = db.prepare(
        'SELECT id, role, content_json, created_timestamp FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC'
      ).all(sid, since)
      if (!rows.length) continue
      const events = []
      for (const r of rows) events.push(...gooseMessageEvents(r, isNoise))
      if (events.length) bufferActivity(agent.id, events)
      lastSeen.set(agent.id, rows[rows.length - 1].id)
    } catch (e) {
      log.warn?.(`goose activity tick failed for ${agent.id}: ${e.message}`)
    }
  }
}
