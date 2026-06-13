// Goose turn-end auto-kick — the logic for nudging a stalled DeepSeek/goose
// fleet agent to continue.
//
// deepseek-chat is weak at chaining multi-step work: a goose agent often ends
// its turn before it has actually delivered, leaving its assignment half done.
// This module decides when an idle-at-turn-end goose agent with undelivered work
// should be nudged to continue — and when it should be left alone (it already
// reported, has nothing owed, made no progress N times in a row, or a real wake
// is in flight).
//
// The decision (`decideKick`) is a PURE function so every branch is table-
// testable without a live agent. The sqlite reads + the orchestrator live here
// too; the daemon supplies the side-effecting deps (sendText, log).
//
// Turn-end is read from goose's TUI, NOT the claude regexes: goose shows
// `Enter to send` at the idle prompt and `Ctrl+C to interrupt` mid-turn (the
// `⏱ Nm Ns` line is a lingering last-turn duration stamp, not a live signal —
// verified on a live probe). The done-signal + progress come from goose's own
// sqlite, mapped to the agent by the `fleet-<hex>` session name fleet-spawn
// stamps via `--name`. If we can't read the sqlite or can't map the session, we
// DON'T kick (fail safe — never nag on missing data).

import fs from 'fs'
import path from 'path'
import os from 'os'
import Database from 'better-sqlite3'

export const GOOSE_IDLE_RE = /Enter to send/
export const GOOSE_WORKING_RE = /Ctrl\+C to interrupt/
export const GOOSE_KICK_SCAN_LINES = 40
export const GOOSE_KICK_CAP = 4   // consecutive NO-PROGRESS kicks before we give up
export const GOOSE_KICK_TEXT = 'Continue — your assignment is not finished. Work through the remaining steps, and when you are fully done deliver your result to the requester with chat(). If you are genuinely blocked, say so via chat().'
export const GOOSE_SESSIONS_DB = path.join(os.homedir(), '.local', 'share', 'goose', 'sessions', 'sessions.db')

let _gooseDb = null
export function gooseDb(log = console) {
  if (_gooseDb) return _gooseDb
  try {
    if (!fs.existsSync(GOOSE_SESSIONS_DB)) return null
    _gooseDb = new Database(GOOSE_SESSIONS_DB, { readonly: true, fileMustExist: true })
    _gooseDb.pragma('busy_timeout = 2000')
    return _gooseDb
  } catch (e) {
    log.warn?.(`goose sqlite open failed: ${e.message}`)
    _gooseDb = null
    return null
  }
}

// Map a fleet agent to its goose sqlite session id via the `fleet-<hex>` name
// stamped at spawn (build_goose_cmd `--name`). Exact match only — an unstamped
// (pre-rename) goose agent returns null and is simply never kicked, which is
// fine: existing goose agents need a fresh spawn to pick up MCP changes anyway.
export function gooseSessionId(agentId, log = console) {
  const db = gooseDb(log)
  if (!db) return null
  const hex = String(agentId || '').split(':').pop()
  if (!hex) return null
  try {
    const row = db.prepare(
      'SELECT id FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1'
    ).get('fleet-' + hex)
    return row ? row.id : null
  } catch (e) {
    log.warn?.(`goose session lookup failed: ${e.message}`)
    return null
  }
}

// Read the turn state for a goose session from its sqlite:
//   lastInboundId   — id of the most recent inbound fleet message (the agent
//                     was asked to do something); 0 = nothing owed.
//   chatAfterInbound— did the agent emit a tlda__chat tool-call after that
//                     inbound? (= it reported → done).
//   lastToolReqId   — id of the most recent assistant tool-call (any tool); used
//                     to tell a productive continuation from a no-progress stall.
// Returns null on any read error (caller treats as "don't kick").
export function gooseTurnInfo(sessionId, log = console) {
  const db = gooseDb(log)
  if (!db || !sessionId) return null
  try {
    const inb = db.prepare(
      "SELECT MAX(id) AS id FROM messages WHERE session_id = ? AND role = 'user' AND content_json LIKE '%\u{1F4EC} Message from%'"
    ).get(sessionId)
    const lastInboundId = inb && inb.id ? inb.id : 0
    let chatAfterInbound = false
    if (lastInboundId) {
      const chatRow = db.prepare(
        "SELECT 1 FROM messages WHERE session_id = ? AND id > ? AND role = 'assistant' AND content_json LIKE '%\"name\":\"tlda__chat\"%' LIMIT 1"
      ).get(sessionId, lastInboundId)
      chatAfterInbound = !!chatRow
    }
    const tr = db.prepare(
      "SELECT MAX(id) AS id FROM messages WHERE session_id = ? AND role = 'assistant' AND content_json LIKE '%\"toolRequest\"%'"
    ).get(sessionId)
    const lastToolReqId = tr && tr.id ? tr.id : 0
    return { lastInboundId, chatAfterInbound, lastToolReqId }
  } catch (e) {
    log.warn?.(`goose turn-info query failed: ${e.message}`)
    return null
  }
}

// Fresh per-agent kick state.
export function newKickState() {
  return { lastInboundId: 0, deadKicks: 0, lastKickToolReqId: null }
}

// PURE decision function. Given the pane tail, the sqlite turn-info, and the
// agent's prior kick state, decide whether to kick and return the next state.
// No I/O — fully table-testable.
//
//   paneTail : string  — bottom of the goose pane
//   info     : { lastInboundId, chatAfterInbound, lastToolReqId } | null
//   state    : prior kick state (from newKickState / a previous decision)
// Returns { kick: bool, state: nextState, reason: string }.
export function decideKick(paneTail, info, state) {
  const k = { ...state }
  const working = GOOSE_WORKING_RE.test(paneTail)
  const idle = !working && GOOSE_IDLE_RE.test(paneTail)
  if (!idle) {
    // mid-turn (working) or an indeterminate boot frame: making progress, so
    // reset the no-progress run. Never kick anything that isn't idle.
    if (working) k.deadKicks = 0
    return { kick: false, state: k, reason: working ? 'working' : 'not-idle' }
  }
  if (!info || info.lastInboundId === 0) {
    return { kick: false, state: k, reason: 'nothing-owed' }   // unreadable or no inbound
  }
  // A new inbound since we last looked = fresh assignment → reset kick state.
  if (info.lastInboundId > k.lastInboundId) {
    k.lastInboundId = info.lastInboundId
    k.deadKicks = 0
    k.lastKickToolReqId = null
  }
  if (info.chatAfterInbound) {
    k.deadKicks = 0
    return { kick: false, state: k, reason: 'delivered' }   // reported → done
  }
  // Stalled with undelivered work. Did the last kick produce a real tool-call?
  const progressed = (k.lastKickToolReqId != null && info.lastToolReqId > k.lastKickToolReqId)
  if (progressed) k.deadKicks = 0
  if (k.deadKicks >= GOOSE_KICK_CAP) {
    return { kick: false, state: k, reason: 'capped' }   // truly stuck — stop nagging
  }
  // KICK.
  if (!progressed && k.lastKickToolReqId != null) k.deadKicks += 1
  k.lastKickToolReqId = info.lastToolReqId
  return { kick: true, state: k, reason: progressed ? 'kick-after-progress' : 'kick' }
}

// Is a fleet-spawn wake/respawn in flight for this tmux session? fleet-spawn
// holds a non-blocking fcntl flock at <tmpdir>/fleet-spawn-locks/<safe>.lock for
// the whole respawn. We check the SAME lock with the SAME fcntl semantics (via a
// tiny python probe) so a kick can't double-inject into a booting pane. In
// practice this is belt-and-suspenders: respawn only fires on a HIBERNATING
// (dead-pane) agent while the kick only fires on an AWAKE+idle one, so the two
// are nearly mutually exclusive — but the check is cheap and correct.
// `execFileP` is injected so the daemon's promisified execFile is reused.
export async function gooseWakeInFlight(tmuxSession, execFileP) {
  const safe = String(tmuxSession).replace(/[^A-Za-z0-9_.-]/g, '_')
  const lockFile = path.join(os.tmpdir(), 'fleet-spawn-locks', `${safe}.lock`)
  try { if (!fs.existsSync(lockFile)) return false } catch { return false }
  try {
    const { stdout } = await execFileP('python3', ['-c',
      'import fcntl,sys\nf=open(sys.argv[1],"w")\ntry:\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n print("free")\nexcept BlockingIOError:\n print("held")',
      lockFile], { timeout: 2000, encoding: 'utf8' })
    return String(stdout).trim() === 'held'
  } catch {
    return false  // can't probe → rely on the idle guard, proceed
  }
}

// Orchestrator: read turn-info, decide, and (if kicking) deliver the nudge.
// `deps`:
//   sendText({ tmux_session, text }) — deliver the nudge (daemon's rpcSendText)
//   execFileP                        — promisified execFile (for the wake probe)
//   log                              — logger
//   stateMap                         — Map(agent_id → kick state) the caller owns
export async function maybeKickGoose(agent, paneTail, deps) {
  const { sendText, execFileP, log = console, stateMap } = deps
  const prev = stateMap.get(agent.id) || newKickState()
  const sessionId = gooseSessionId(agent.id, log)
  const info = gooseTurnInfo(sessionId, log)
  const { kick, state, reason } = decideKick(paneTail, info, prev)
  if (!kick) {
    stateMap.set(agent.id, state)
    return { kicked: false, reason }
  }
  // A real wake/respawn in flight would double-inject — defer this cycle. We do
  // NOT advance state here, so we re-evaluate cleanly next sweep.
  if (await gooseWakeInFlight(agent.tmux_session, execFileP)) {
    stateMap.set(agent.id, prev)
    return { kicked: false, reason: 'wake-in-flight' }
  }
  try {
    await sendText({ tmux_session: agent.tmux_session, text: GOOSE_KICK_TEXT })
  } catch (e) {
    log.warn?.(`goose-kick send failed for ${agent.tmux_session}: ${e.message}`)
    stateMap.set(agent.id, prev)   // didn't actually kick — don't burn a cap slot
    return { kicked: false, reason: 'send-failed' }
  }
  stateMap.set(agent.id, state)
  log.info?.(`goose-kick ${agent.friendly_name || agent.id} (deadKicks=${state.deadKicks}, inbound=${state.lastInboundId}, reason=${reason})`)
  return { kicked: true, reason }
}
