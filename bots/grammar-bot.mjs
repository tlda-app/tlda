#!/usr/bin/env node
/**
 * grammar-bot — a user-preference bot (todd family) that watches fleet chat for
 * math and nudges the author when a message contains a comma splice (a comma
 * standing in for a connective word). It keeps a warm spaCy lint-server resident
 * so each check is ~15ms, and delivers an async nudge encouraging the author to
 * fix the message in place via amend.
 *
 * Identity is env-driven exactly like todd (TLDA_BOT_NAME, TLDA_BOT_PIDFILE, …).
 * Detection is the SAME implementation as the paper linter (server/lib/
 * lint-server.py -> lint-typography.check_comma_splice) — one linter, both surfaces.
 *
 * NOTE: tex/md file-edit events do not reach a /ws/fleet bot today (only chat/
 * activity/turn_ended). Watching source edits on save is a follow-up that needs a
 * server source-change fleet-event or the bot's own chokidar. This bot does chat.
 */
import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import readline from 'readline'
import { getFleetServerUrl, getManagedBots, CONFIG_DIR } from '../shared/config.mjs'
import { startWsRequest } from '../shared/ws-request-policy.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

// --- identity (env-driven, like todd) ---
const BOT_KEY = (process.env.TLDA_BOT_NAME || 'grammar').toLowerCase()
const AGENT_NAME = BOT_KEY
const PID_FILE = process.env.TLDA_BOT_PIDFILE || path.join(CONFIG_DIR, `${BOT_KEY}.pid`)
const HEARTBEAT_FILE = process.env.TLDA_BOT_HEARTBEAT || path.join(CONFIG_DIR, `${BOT_KEY}.heartbeat`)
const ID_FILE = process.env.TLDA_BOT_IDFILE || path.join(CONFIG_DIR, `${BOT_KEY}.fleet-id`)
const OWNER_ID = 'fleet:skip'
// Bots connect to the FLEET/database axis (chat + registry live there), not the
// store. A bot's declared `server:` in bots.yaml routes it to that named
// daemon.yaml server; omit for the machine default.
const MY_BOT = getManagedBots().find(b => String(b.name || '').toLowerCase() === BOT_KEY) || {}
const SERVER = getFleetServerUrl(MY_BOT.server)
const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws/fleet'

// --- warm lint-server config ---
const VENV_PY = process.env.TLDA_LINT_PY
  || path.join(process.env.HOME || '', '.config/tlda/lint-venv/bin/python')
const LINT_SERVER = path.join(REPO_ROOT, 'server/lib/lint-server.py')

// Only bother the lint-server when a message actually contains math.
const MATH_RE = /\$[^$]+\$|\\\[|\\\(|\\begin\{(?:equation|align|gather|multline)/

function loadOrCreateFleetId() {
  try {
    const existing = fs.readFileSync(ID_FILE, 'utf8').trim()
    if (existing) return existing
  } catch { /* no id file yet — fall through and create one */ }
  const id = `fleet:${BOT_KEY}`
  try { fs.writeFileSync(ID_FILE, id) } catch { /* best-effort persist; deterministic id works regardless */ }
  return id
}
const AGENT_ID = loadOrCreateFleetId()

function writeHeartbeat(reason) {
  try {
    fs.appendFileSync(HEARTBEAT_FILE,
      JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, bot: BOT_KEY, reason }) + '\n')
  } catch { /* heartbeat is best-effort telemetry — never crash the bot over it */ }
}

// ---------------------------------------------------------------------------
// Warm lint-server child (keeps spaCy resident)
// ---------------------------------------------------------------------------
let lintProc = null
let lintReady = false
let lintReqId = 1
const lintPending = new Map()

function startLintServer() {
  if (!fs.existsSync(VENV_PY) || !fs.existsSync(LINT_SERVER)) {
    console.error(`[grammar-bot] lint server unavailable (py=${VENV_PY} script=${LINT_SERVER})`)
    return
  }
  lintProc = spawn(VENV_PY, [LINT_SERVER], { cwd: REPO_ROOT })
  lintReady = false
  const rl = readline.createInterface({ input: lintProc.stdout })
  rl.on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.ready) { lintReady = true; writeHeartbeat('lint-ready'); return }
    if (msg.id != null && lintPending.has(msg.id)) {
      const { resolve } = lintPending.get(msg.id)
      lintPending.delete(msg.id)
      resolve(Array.isArray(msg.findings) ? msg.findings : [])
    }
  })
  lintProc.stderr.on('data', (d) => console.error(`[lint-server] ${d}`.trim()))
  lintProc.on('exit', (code) => {
    console.error(`[grammar-bot] lint server exited code=${code}; restarting in 2s`)
    lintReady = false
    for (const { resolve } of lintPending.values()) resolve([])
    lintPending.clear()
    setTimeout(startLintServer, 2000)
  })
}

function lint(text, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!lintProc || !lintReady) return resolve([])
    const id = lintReqId++
    const timer = setTimeout(() => {
      if (lintPending.has(id)) { lintPending.delete(id); resolve([]) }
    }, timeoutMs)
    lintPending.set(id, { resolve: (f) => { clearTimeout(timer); resolve(f) } })
    try { lintProc.stdin.write(JSON.stringify({ id, text }) + '\n') }
    catch { /* child pipe broke — degrade to no findings, restart handled on exit */ lintPending.delete(id); clearTimeout(timer); resolve([]) }
  })
}

// ---------------------------------------------------------------------------
// Nudge
// ---------------------------------------------------------------------------
function nudgeText(findings) {
  const n = findings.length
  const which = '"where", "so", "we have", "which gives"'
  return `⚠ **Possible comma splice** in your math${n > 1 ? ` (${n} spots)` : ''}: a comma is joining two statements as if it were a word. Which word did you mean — ${which}? Write it out; a comma isn't a connective. You can fix it in place by **amending** the message (\`chat({ amend_id })\`), no need to repost.`
}

const nudgedRecently = new Map()   // messageKey -> ts, dedupe
const NUDGE_DEDUPE_MS = 60_000

function alreadyNudged(key) {
  const now = Date.now()
  for (const [k, ts] of nudgedRecently) if (now - ts > NUDGE_DEDUPE_MS) nudgedRecently.delete(k)
  if (nudgedRecently.has(key)) return true
  nudgedRecently.set(key, now)
  return false
}

// ---------------------------------------------------------------------------
// WebSocket to /ws/fleet
// ---------------------------------------------------------------------------
let ws = null
let msgId = 1
const _pendingRequests = new Map()

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msgId++, ...msg }))
}
function sendRequest(msg, timeoutMs = 10_000) {
  const id = msgId++
  return startWsRequest({
    pending: _pendingRequests, id, type: msg?.type || 'unknown', deadlineMs: timeoutMs,
    makeDeadlineError: () => new Error('ws request timeout'),
    makeSendError: () => new Error('ws not connected'),
    send: () => {
      if (ws?.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify({ id, ...msg })); return true
    },
  })
}
function handleWsReply(msg) {
  if (msg.id == null || !_pendingRequests.has(msg.id)) return false
  const p = _pendingRequests.get(msg.id)
  _pendingRequests.delete(msg.id)
  if (msg.error) p.reject(new Error(String(msg.error)))
  else p.resolve(msg.result)
  return true
}
function sendChat(to, text) { send({ type: 'chat', from: AGENT_ID, to, message: text }) }

async function loginFleet() {
  const payload = {
    agent_id: AGENT_ID, name: AGENT_NAME, cwd: REPO_ROOT,
    labels: ['bot', BOT_KEY], metadata: { bot: BOT_KEY, pid: process.pid },
  }
  try { await sendRequest({ ...payload, type: 'reserve-shell' }) } catch { /* reserve is best-effort; login below is what matters */ }
  return sendRequest({ ...payload, type: 'login' })
}

async function handleMessage(raw) {
  let msg
  try { msg = JSON.parse(raw.toString()) } catch { return }
  if (handleWsReply(msg)) return
  if (msg.event !== 'fleet-event' || !msg.data) return
  const d = msg.data
  const from = d.from_id ?? d.from
  const text = d.text ?? d.message
  if (d.type !== 'chat' || !text) return
  writeHeartbeat('chat')
  // Lint AGENT messages containing math. Skip the human owner (voice input),
  // system sender, and ourselves.
  if (!from || from === AGENT_ID || from === OWNER_ID || from === 'fleet:tlda') return
  if (!MATH_RE.test(text)) return
  const findings = await lint(text)
  if (!findings.length) return
  const key = `${from}:${d.id ?? text.slice(0, 40)}`
  if (alreadyNudged(key)) return
  sendChat(from, nudgeText(findings))
  writeHeartbeat('nudge')
}

function connect() {
  ws = new WebSocket(WS_URL, { rejectUnauthorized: false })
  ws.on('open', async () => {
    try { await loginFleet(); writeHeartbeat('ws-open') }
    catch (e) { /* reconnect loop retries on close */ console.error('[grammar-bot] login failed', e?.message) }
  })
  ws.on('message', (raw) => { handleMessage(raw).catch(() => {}) })
  ws.on('close', () => { setTimeout(connect, 1000) })
  ws.on('error', (e) => { console.error('[grammar-bot] ws error', e?.message) })
}

// ---------------------------------------------------------------------------
// Startup (pidfile guard like todd)
// ---------------------------------------------------------------------------
try {
  const prev = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
  if (prev && prev !== process.pid) {
    try { process.kill(prev, 0); console.error(`[grammar-bot] already running pid=${prev}`); process.exit(0) } catch { /* prev pid is dead — safe to take over */ }
  }
} catch { /* no readable pidfile — first run */ }
try { fs.writeFileSync(PID_FILE, String(process.pid)) } catch { /* best-effort pidfile write */ }
writeHeartbeat('startup')
startLintServer()
connect()
setInterval(() => writeHeartbeat('tick'), 30_000)
process.on('SIGINT', () => { try { fs.unlinkSync(PID_FILE) } catch { /* best-effort cleanup */ }; process.exit(0) })
process.on('exit', () => { try { fs.unlinkSync(PID_FILE) } catch { /* best-effort cleanup */ } })
