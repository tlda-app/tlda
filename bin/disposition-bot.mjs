#!/usr/bin/env node
/**
 * disposition-bot — a turn-end self-check bot.
 *
 * Where todd watches Skip's CHAT for frustration signals and nudges, this bot
 * watches TURN BOUNDARIES. When an agent's turn ends, the server writes a
 * synthetic `turn_ended` event to the events DB (see emitTurnEnded in
 * server/unified-server.mjs); every such event is auto-broadcast as a
 * fleet-event, so this bot SUBSCRIBES to it over the same `/ws/fleet` socket
 * todd uses. On each turn end it looks at the turn that just finished and, IF
 * (and only if) the turn shows a likely disposition failure from
 * scratch/disposition-mine/TAXONOMY.md, it signals that agent the specific
 * self-check to run.
 *
 * SELECTIVITY is the whole game. todd's failure mode — firing on every match
 * until agents tune it out (the "wallpaper" trap) — is the thing to avoid. So
 * this bot fires on a *correlation* a per-message watcher can't see: a turn
 * that ends with a done-claim to Skip but contains NO verification activity.
 * That conjunction is naturally rare, which is what keeps it quiet. Turns that
 * end with no Skip-facing message fire nothing at all.
 *
 * Additive: this is a NEW bot. It does not touch todd, the daemon, or any
 * existing handler. Run it alongside todd.
 *
 * Start: TLDA_BOT_NAME=disposition node bin/disposition-bot.mjs
 *   (or just `node bin/disposition-bot.mjs` — defaults to the name "disposition")
 */

import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'

import { getServerUrl, CONFIG_DIR } from '../shared/config.mjs'
import { runChecks } from './lib/disposition-checks.mjs'

const BOT_KEY = (process.env.TLDA_BOT_NAME || 'disposition').toLowerCase()
const AGENT_ID = 'fleet:' + BOT_KEY
const AGENT_NAME = BOT_KEY
const PID_FILE = process.env.TLDA_BOT_PIDFILE || path.join(CONFIG_DIR, `${BOT_KEY}.pid`)
const SERVER = getServerUrl()
const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws/fleet'
const OWNER_ID = 'fleet:skip'

const DECISIONS_LOG = path.join(CONFIG_DIR, `${BOT_KEY}-decisions.jsonl`)

// Don't judge these — bots/pseudo-agents, not real workers. (The server already
// excludes humans from turn_ended, so this is a belt-and-suspenders guard.)
const IGNORE_IDS = new Set([OWNER_ID, AGENT_ID, 'fleet:todd', 'fleet:tlda', 'fleet:teacher', 'fleet:eliza'])

// ---- Tunables ----
const PER_AGENT_COOLDOWN_MS = parseInt(process.env.DISPO_COOLDOWN_MS || '', 10) || 10 * 60_000
// Skip is "in the room" with an agent he messaged in this window → stand down,
// exactly like todd's proactive watchdogs. ("when I am in the room, you shut
// the fuck up." — Skip 6/19.)
const SKIP_LIVE_WINDOW_MS = parseInt(process.env.DISPO_SKIP_LIVE_MS || '', 10) || 5 * 60_000
// Fallback lookback the first time we see an agent (before we've recorded a
// previous turn boundary to scope from).
const DEFAULT_TURN_WINDOW_MS = 8 * 60_000
// Let the agent's final writes (its last chat, last tool result) settle into the
// events DB before we read the turn back.
const SETTLE_MS = 1500

const _lastFired = new Map()       // agentId → ts of last self-check we sent
const _lastSkipInbound = new Map() // agentId → ts Skip last messaged them
const _lastTurnEndTs = new Map()   // agentId → ISO ts of the previous turn end we processed

// ─────────────────────────────────────────────────────────────────────────
// Turn handling
// (The selective checks live in ./lib/disposition-checks.mjs — pure + tested.)
// ─────────────────────────────────────────────────────────────────────────

function logDecision(agentId, fired, label, detail) {
  const record = {
    ts: new Date().toISOString(),
    agent: agentId,
    fired,                 // true = sent a self-check; false = inspected, stayed quiet
    label: label || null,  // which check fired (or the reason it didn't)
    detail: detail || null,
  }
  try { fs.appendFileSync(DECISIONS_LOG, JSON.stringify(record) + '\n') }
  catch (e) { console.error(`[${BOT_KEY}] log write failed: ${e.message}`) }
}

function skipIsLive(agentId) {
  return Date.now() - (_lastSkipInbound.get(agentId) || 0) < SKIP_LIVE_WINDOW_MS
}

async function handleTurnEnd(agentId) {
  if (!agentId || IGNORE_IDS.has(agentId)) return

  // 1. Skip-in-the-room: stand down.
  if (skipIsLive(agentId)) { logDecision(agentId, false, 'skip-live'); return }

  // 2. Cooldown: one self-check per agent per window — never a wall.
  const last = _lastFired.get(agentId) || 0
  if (Date.now() - last < PER_AGENT_COOLDOWN_MS) { logDecision(agentId, false, 'cooldown'); return }

  // 3. Scope the just-ended turn: [previous turn end, now]. First time we see an
  //    agent, fall back to a fixed lookback.
  const since = _lastTurnEndTs.get(agentId)
    || new Date(Date.now() - DEFAULT_TURN_WINDOW_MS).toISOString()
  _lastTurnEndTs.set(agentId, new Date().toISOString())

  const events = await getJson(
    `/api/store/events?agent=${encodeURIComponent(agentId)}&since=${encodeURIComponent(since)}&limit=400`,
    { events: [] },
  )
  const list = events.events || []

  // The agent's last message TO Skip in this turn (what it claimed), and the
  // tool activity in the turn (what it actually did).
  let lastMsg = null
  const activityChunks = []
  for (const e of list) {
    if (e.type === 'chat' && e.from === agentId && e.to === OWNER_ID) lastMsg = e.text || ''
    if (e.type === 'activity' && e.from === agentId) {
      const m = typeof e.metadata === 'string' ? safeJson(e.metadata) : (e.metadata || {})
      activityChunks.push([
        m.tool, m.arg, m.description,
        m.input?.command, m.input?.description, e.text,
      ].filter(Boolean).join(' '))
    }
  }
  const activityText = activityChunks.join(' \n ')

  // No Skip-facing message this turn → nothing to judge. (This is most turns —
  // the source of the bot's quietness.)
  if (!lastMsg) { logDecision(agentId, false, 'no-skip-facing-message'); return }

  // 4. Run checks; fire at most one.
  const hit = runChecks(lastMsg, activityText)
  if (hit) {
    sendChat(agentId, hit.message)
    _lastFired.set(agentId, Date.now())
    logDecision(agentId, true, hit.label, { msg: lastMsg.slice(0, 160) })
    console.log(`[${BOT_KEY}] self-check "${hit.label}" → ${agentId}`)
    return
  }
  logDecision(agentId, false, 'no-trigger-matched')
}

function safeJson(s) { try { return JSON.parse(s) } catch { return {} } }

// ─────────────────────────────────────────────────────────────────────────
// WebSocket plumbing (modeled on bin/todd.mjs)
// ─────────────────────────────────────────────────────────────────────────

let ws = null
let msgId = 1
let reconnectTimer = null
let reconnectDelay = 500

function connect() {
  ws = new WebSocket(WS_URL)
  ws.on('open', () => {
    console.log(`[${BOT_KEY}] connected to ${WS_URL}`)
    reconnectDelay = 500
    register()
  })
  ws.on('message', (raw) => {
    try { handleMessage(JSON.parse(raw.toString())) } catch {}
  })
  ws.on('close', () => { console.log(`[${BOT_KEY}] disconnected, reconnecting in ${reconnectDelay}ms`); scheduleReconnect() })
  ws.on('error', (err) => console.error(`[${BOT_KEY}] ws error:`, err.message))
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, 5000)
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msgId++, ...msg }))
}

function register() {
  send({ type: 'register', id: AGENT_ID, name: AGENT_NAME, cwd: process.cwd(), labels: ['bot', BOT_KEY], human: true })
}

// Per-recipient dedupe so a reconnect-replay or rapid double turn can't double-send.
const recentChatSends = new Map()
const CHAT_DEDUPE_MS = 10 * 60_000
function sendChat(to, text) {
  const now = Date.now()
  const key = `${to}\0${text}`
  if (now - (recentChatSends.get(key) || 0) < CHAT_DEDUPE_MS) return
  recentChatSends.set(key, now)
  for (const [k, ts] of recentChatSends) if (now - ts > CHAT_DEDUPE_MS) recentChatSends.delete(k)
  send({ type: 'chat', from: AGENT_ID, to, message: text })
}

function handleMessage(msg) {
  if (msg.event !== 'fleet-event') return
  const d = msg.data || {}

  // Track Skip-in-the-room from his chats to agents (for skip-live suppression).
  if (d.type === 'chat' && d.from_id === OWNER_ID && d.to_id && d.to_id !== AGENT_ID) {
    _lastSkipInbound.set(d.to_id, Date.now())
  }

  // The turn-end signal: a synthetic `turn_ended` event from the server.
  if (d.type === 'turn_ended') {
    const agentId = d.agent_id || d.from_id
    setTimeout(() => {
      handleTurnEnd(agentId).catch(e => console.error(`[${BOT_KEY}] handleTurnEnd error:`, e.message))
    }, SETTLE_MS)
  }
}

// RESILIENT GET — always resolves (parsed JSON or `fallback`); never hangs.
function getJson(urlPath, fallback = null) {
  const url = `${SERVER}${urlPath}`
  const mod = url.startsWith('https') ? https : http
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const req = mod.get(url, res => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => { try { finish(JSON.parse(buf)) } catch { finish(fallback) } })
    })
    req.setTimeout(15_000, () => { req.destroy(); finish(fallback) })
    req.on('error', () => finish(fallback))
  })
}

// ---- Start ----
if (fs.existsSync(PID_FILE)) {
  const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
  try { process.kill(existingPid, 0); console.log(`[${BOT_KEY}] already running (pid ${existingPid}) — exiting`); process.exit(0) } catch {}
}
try { fs.writeFileSync(PID_FILE, String(process.pid)) } catch {}

console.log(`[${BOT_KEY}] starting (pid ${process.pid}) — watching turn_ended events`)
connect()

process.on('SIGINT', () => { try { fs.unlinkSync(PID_FILE) } catch {}; ws?.close(); process.exit(0) })
process.on('exit', () => { try { fs.unlinkSync(PID_FILE) } catch {} })
