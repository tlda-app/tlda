#!/usr/bin/env node
/**
 * disposition-bot — a turn-end INTROSPECTION POKE.
 *
 * NOT a detector. It does not read the turn, match a regex, or judge anything.
 * The mechanism is a countdown gated on Skip's ABSENCE:
 *
 *   turn_ended(agent) → start a ~30s countdown for that agent ("wait a beat")
 *   Skip messages that agent → cancel that agent's countdown (he's in the room)
 *   countdown expires → if Skip is AWAY, send the agent the introspection poke
 *                       (bots/self-check/poke.mjs); if he's active, stay quiet
 *
 * The poke fires only when Skip is away and presumably expecting progress — when
 * he's active in the fleet he'll self-direct, so the bot shuts up (his standing
 * "when I'm in the room you shut the fuck up" rule). Presence is global: any
 * recent chat from fleet:skip (UI or terminal) marks him present for ~2 min.
 *
 * The poke goes to the AGENT, never to Skip, and is SHORT + LANE-AWARE (a math
 * agent gets a proof-flavored nudge, a code/app agent a build-flavored one — by
 * the poked agent's cwd). A "wrong" poke is cheap, so we err toward prompting.
 *
 * Plus a MANUAL KICK: Skip chats this bot ("poke <agent>" / "kick <agent>") to
 * fire an immediate poke at any agent on demand.
 *
 * The countdown logic is pure and unit-tested (bots/self-check/scheduler.mjs,
 * .test.mjs). This file is the I/O shell: it rides the same `/ws/fleet` socket
 * todd uses, subscribes to the server's synthetic `turn_ended` events (see
 * emitTurnEnded in server/unified-server.mjs), and reads its tunables (enabled,
 * countdown seconds) live from the fleet_prefs store the settings menu writes.
 *
 * Start: TLDA_BOT_NAME=disposition node bin/bots/disposition.mjs
 *   (or just `node bin/bots/disposition.mjs` — defaults to the name "disposition")
 */

import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'

import { getServerUrl, CONFIG_DIR } from '../shared/config.mjs'
import { startWsRequest } from '../shared/ws-request-policy.mjs'
import { DispositionScheduler } from './self-check/scheduler.mjs'
import { createDispositionWiring } from './self-check/wiring.mjs'
import { pokeFor } from './self-check/poke.mjs'

const BOT_KEY = (process.env.TLDA_BOT_NAME || 'disposition').toLowerCase()
const AGENT_ID = 'fleet:' + BOT_KEY
const AGENT_NAME = BOT_KEY
const PID_FILE = process.env.TLDA_BOT_PIDFILE || path.join(CONFIG_DIR, `${BOT_KEY}.pid`)
const SERVER = getServerUrl()
const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws/fleet'
const OWNER_ID = 'fleet:skip'

const DECISIONS_LOG = path.join(CONFIG_DIR, `${BOT_KEY}-decisions.jsonl`)

// Don't poke these — bots/pseudo-agents, not real workers. (The server already
// excludes humans from turn_ended, so this is a belt-and-suspenders guard.)
const IGNORE_IDS = new Set([OWNER_ID, AGENT_ID, 'fleet:todd', 'fleet:tlda', 'fleet:teacher', 'fleet:eliza'])

// ---- Tunables (config-driven; live from the settings menu via fleet_prefs) ----
// These are the two preferences surfaced in Skip's settings menu (src/panels/
// PrefsTab.tsx → "Bots"). The bot polls them so a change feeds the running bot
// without a restart. Env vars are the fallback before the first prefs fetch.
const DEFAULT_COUNTDOWN_SEC = parseInt(process.env.DISPO_COUNTDOWN_SEC || '', 10) || 30
const DEFAULT_ENABLED = process.env.DISPO_ENABLED !== '0'
const PREFS_POLL_MS = 20_000
const PREF_ENABLED_KEY = 'disposition-bot-enabled'
const PREF_COUNTDOWN_KEY = 'disposition-countdown-sec'
const PREF_BOT_ENABLED_KEY = 'bot-self-check-enabled'
const PREF_BOT_COUNTDOWN_KEY = 'bot-self-check-countdown-sec'

// Skip-presence window. He's "present" if he's chatted — UI OR terminal, both
// arrive as a fleet chat from fleet:skip — within this window. SHORT on purpose
// (~2 min): a long window would stall agents waiting to be poked the whole time
// he's away (a 10-min job dragging into hours). Poking is cheap, so err toward
// poking sooner — stay quiet only while he's *actively* bursting (gaps < ~2 min).
const PRESENCE_WINDOW_MS = (parseInt(process.env.DISPO_PRESENCE_SEC || '', 10) || 120) * 1000

const _cmdCache = new Map() // dedupe manual-kick acks per command

// ─────────────────────────────────────────────────────────────────────────
// The scheduler (pure countdown logic) + the wiring (presence + cwd state and
// fleet-event dispatch). The bot is the I/O shell around both. They reference
// each other, so the scheduler is built first with closures over `wiring`
// (resolved at call time), then the wiring is built with the scheduler.
// ─────────────────────────────────────────────────────────────────────────

let wiring
const scheduler = new DispositionScheduler({
  countdownMs: DEFAULT_COUNTDOWN_SEC * 1000,
  enabled: DEFAULT_ENABLED,
  // notePoked first so a post-poke turn is recognized as bot-triggered (the
  // poke-loop gate) even if the bot never sees its own outgoing chat echoed.
  sendPoke: (agentId) => { wiring.notePoked(agentId); sendChat(agentId, pokeFor(wiring.cwdOf(agentId))) },
  isSkipPresent: (agentId) => wiring.isSkipPresent(agentId),
  log: logDecision,
})
wiring = createDispositionWiring({
  scheduler,
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  ignoreIds: IGNORE_IDS,
  presenceWindowMs: PRESENCE_WINDOW_MS,
  onKickCommand: (text) =>
    handleManualKick(text).catch(e => console.error(`[${BOT_KEY}] manual kick error:`, e.message)),
  log: logDecision,
})

function logDecision(event, agentId, detail) {
  const record = { ts: new Date().toISOString(), event, agent: agentId || null, detail: detail || null }
  try { fs.appendFileSync(DECISIONS_LOG, JSON.stringify(record) + '\n') }
  catch (e) { console.error(`[${BOT_KEY}] log write failed: ${e.message}`) }
}

// ─────────────────────────────────────────────────────────────────────────
// Live preferences — poll the fleet_prefs the settings menu writes.
// ─────────────────────────────────────────────────────────────────────────

async function refreshPrefs() {
  const prefs = await getJson(`/api/fleet/prefs?user=${encodeURIComponent(OWNER_ID)}`, null)
  if (!prefs || typeof prefs !== 'object') return
  const perBotEnabled = prefs[PREF_BOT_ENABLED_KEY]?.[AGENT_ID]
  if (perBotEnabled !== undefined) scheduler.setEnabled(perBotEnabled !== false)
  else if (PREF_ENABLED_KEY in prefs) scheduler.setEnabled(prefs[PREF_ENABLED_KEY] !== false)

  const sec = Number(prefs[PREF_BOT_COUNTDOWN_KEY]?.[AGENT_ID] ?? prefs[PREF_COUNTDOWN_KEY])
  if (Number.isFinite(sec) && sec > 0) scheduler.setCountdownMs(sec * 1000)
}

// Refresh the per-agent cwd cache from the live alive-roster so wiring.cwdOf can
// pick the lane-specific poke. cwd rarely changes, so polling alongside prefs
// (20s) is plenty fresh. Best-effort: a failed request leaves the prior cache intact.
async function refreshRoster() {
  const agents = await wsRequest('store-agents', {}).catch(() => null)
  wiring.updateRoster(agents)
}

// ─────────────────────────────────────────────────────────────────────────
// Manual kick — Skip chats this bot "poke <agent>" / "kick <agent>".
// ─────────────────────────────────────────────────────────────────────────

const KICK_RE = /^\s*(?:poke|kick|check|nudge)\s+(.+?)\s*$/i

async function handleManualKick(text) {
  const m = text.match(KICK_RE)
  if (!m) return
  const targetRaw = m[1].trim()
  const targetId = await resolveAgent(targetRaw)
  if (!targetId) {
    sendChat(OWNER_ID, `Couldn't find an agent matching "${targetRaw}" to poke.`)
    return
  }
  scheduler.kick(targetId)
  // Brief confirmation to Skip — this is HIS command, not the poke itself
  // (which goes only to the agent). Deduped so a replayed command can't spam.
  const key = `kick\0${targetId}`
  if (Date.now() - (_cmdCache.get(key) || 0) > 5000) {
    _cmdCache.set(key, Date.now())
    sendChat(OWNER_ID, `Poked **${targetRaw}** to self-check.`)
  }
}

// Resolve a friendly name or id to a fleet id via the live alive-roster WS
// request (store-agents). `fleet:` ids pass straight through.
async function resolveAgent(query) {
  if (/^fleet:/.test(query)) return query
  const agents = await wsRequest('store-agents', {}).catch(() => null)
  if (!Array.isArray(agents)) return null
  const q = query.toLowerCase()
  const hit = agents.find(a =>
    (a.friendly_name && a.friendly_name.toLowerCase() === q) ||
    (a.name && a.name.toLowerCase() === q) ||
    (a.id && a.id.toLowerCase() === q))
  return hit ? hit.id : null
}

// ─────────────────────────────────────────────────────────────────────────
// WebSocket plumbing (modeled on bots/todd.mjs)
// ─────────────────────────────────────────────────────────────────────────

let ws = null
let msgId = 1
let reconnectTimer = null
let reconnectDelay = 500
const _pendingWs = new Map()

function connect() {
  ws = new WebSocket(WS_URL)
  ws.on('open', () => {
    console.log(`[${BOT_KEY}] connected to ${WS_URL}`)
    reconnectDelay = 500
    loginFleet()
    refreshPrefs().catch(e => console.error(`[${BOT_KEY}] prefs refresh failed:`, e.message))
    refreshRoster().catch(e => console.error(`[${BOT_KEY}] roster refresh failed:`, e.message))
  })
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return } // ignore non-JSON frames
    try { handleMessage(msg) } catch (e) { console.error(`[${BOT_KEY}] handleMessage error:`, e.message) }
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

// Request/response over the fleet WS (store-agents etc.): correlate by id.
function wsRequest(type, extra = {}) {
  const id = msgId++
  return startWsRequest({
    pending: _pendingWs,
    id,
    type,
    deadlineMs: 10_000,
    makeDeadlineError: () => new Error('ws request timeout'),
    makeSendError: () => new Error('ws not open'),
    send: () => {
      if (ws?.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify({ id, type, ...extra }))
      return true
    },
  })
}

function loginFleet() {
  const payload = { agent_id: AGENT_ID, name: AGENT_NAME, cwd: process.cwd(), labels: ['bot', BOT_KEY] }
  send({ ...payload, type: 'reserve-shell' })
  send({ ...payload, type: 'login' })
}

// Per-recipient dedupe so a reconnect-replay or rapid double turn can't double-send.
const recentChatSends = new Map()
const CHAT_DEDUPE_MS = 60_000
function sendChat(to, text) {
  const now = Date.now()
  const key = `${to}\0${text}`
  if (now - (recentChatSends.get(key) || 0) < CHAT_DEDUPE_MS) return
  recentChatSends.set(key, now)
  for (const [k, ts] of recentChatSends) if (now - ts > CHAT_DEDUPE_MS) recentChatSends.delete(k)
  send({ type: 'chat', from: AGENT_ID, to, message: text })
}

function handleMessage(msg) {
  // Correlated WS replies (store-agents, …).
  if (msg.id !== undefined && _pendingWs.has(msg.id)) {
    const pending = _pendingWs.get(msg.id)
    if (msg.error) pending.reject(new Error(typeof msg.error === 'string' ? msg.error : (msg.error.message || JSON.stringify(msg.error))))
    else pending.resolve(msg.result)
    return
  }

  if (msg.event !== 'fleet-event') return
  // Presence tracking, Skip-in-the-room cancel, manual kick, and turn_ended →
  // countdown all live in the wiring (unit-tested in disposition-wiring.test.mjs).
  wiring.handleFleetEvent(msg.data || {})
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

console.log(`[${BOT_KEY}] starting (pid ${process.pid}) — turn-end introspection poke`)
connect()
const _prefsTimer = setInterval(() => {
  refreshPrefs().catch(e => console.error(`[${BOT_KEY}] prefs refresh failed:`, e.message))
  refreshRoster().catch(e => console.error(`[${BOT_KEY}] roster refresh failed:`, e.message))
}, PREFS_POLL_MS)

// Best-effort PID cleanup on exit: the file being already gone (ENOENT) is the
// one expected failure; surface anything else (e.g. a permissions problem).
function removePidFile() {
  try { fs.unlinkSync(PID_FILE) }
  catch (e) { if (e.code !== 'ENOENT') console.error(`[${BOT_KEY}] pid cleanup failed: ${e.message}`) }
}
process.on('SIGINT', () => { clearInterval(_prefsTimer); removePidFile(); ws?.close(); process.exit(0) })
process.on('exit', removePidFile)
