#!/usr/bin/env node
/**
 * lint-bot — a user-preference bot (todd family) that watches fleet chat for
 * math/markdown render problems and nudges the author to fix the message in
 * place via amend. It is SELF-CONTAINED: the lint logic lives here + in the
 * existing shared render-validity check; nothing new is added to the server.
 *
 * What it checks per agent chat message:
 *   1. checkChatRender() from shared/chat-render-check.mjs — the SAME render
 *      validity/style check outgoing chat() already runs (unclosed $$, KaTeX
 *      parse errors, undefined macros, LaTeX-in-codeblock, glued $ delimiters).
 *      This is existing shared code, not a server addition.
 *   2. A house-style delimiter check implemented HERE (not in the shared file):
 *      backslash-paren \(...\) or backslash-bracket \[...\] used for math.
 *      tlda chat uses $...$ / $$...$$; the backslash forms are a house-style
 *      nudge. Code fences and inline code are stripped before the check.
 *
 * On a finding it nudges the message AUTHOR to amend. Bots talk to authors, not
 * to Skip — Skip observes the nudge in fleet chat; the bot never DMs him.
 *
 * Identity is env-driven exactly like todd (TLDA_BOT_NAME, TLDA_BOT_PIDFILE, …).
 *
 * NOTE ON MARKDOWN SHARES: the chat fleet-event a bot receives carries
 * { from_id, to_id, text, metadata }. Markdown shared BY REFERENCE
 * (chat({ file, section })) is resolved server-side and arrives in `text`, so
 * checkChatRender(text) already lints it. Markdown shared as an ATTACHMENT chip
 * appears only as a path/URL reference under metadata.attachments — the file
 * BODY is not in the event. So when a .md attachment is present we lint the
 * message text and note the share; we do not fetch the file body.
 */
import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getServerUrl, CONFIG_DIR } from '../shared/config.mjs'
import { startWsRequest } from '../shared/ws-request-policy.mjs'
import { checkChatRender } from '../shared/chat-render-check.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

// --- identity (env-driven, like todd) ---
const BOT_KEY = (process.env.TLDA_BOT_NAME || 'lint').toLowerCase()
const AGENT_NAME = BOT_KEY
const PID_FILE = process.env.TLDA_BOT_PIDFILE || path.join(CONFIG_DIR, `${BOT_KEY}.pid`)
const HEARTBEAT_FILE = process.env.TLDA_BOT_HEARTBEAT || path.join(CONFIG_DIR, `${BOT_KEY}.heartbeat`)
const ID_FILE = process.env.TLDA_BOT_IDFILE || path.join(CONFIG_DIR, `${BOT_KEY}.fleet-id`)
const OWNER_ID = 'fleet:skip'
const SERVER = getServerUrl()
const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws/fleet'

// Only run the (KaTeX-backed) render check when a message could plausibly have a
// finding: math, code fences, backslash math delimiters. Plain chatter is skipped.
const RELEVANT_RE = /\$|```|\\\(|\\\)|\\\[|\\\]/

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
// Lint checks (self-contained: shared render check + house-style delimiter)
// ---------------------------------------------------------------------------

/** Strip fenced (```) and inline (`) code so we don't flag code samples. */
function stripCode(message) {
  return String(message)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
}

/**
 * House-style delimiter check — done IN THE BOT (not in chat-render-check.mjs).
 * Flags \(...\) or \[...\] math delimiters used outside code. tlda chat uses
 * $...$ and $$...$$.
 */
function checkDelimiters(message) {
  const bare = stripCode(message)
  const hasParen = /\\\((?:[\s\S]*?)\\\)/.test(bare) || /\\\(/.test(bare)
  const hasBracket = /\\\[(?:[\s\S]*?)\\\]/.test(bare) || /\\\[/.test(bare)
  const findings = []
  if (hasParen) {
    findings.push('Backslash-paren `\\(...\\)` math delimiters — tlda chat uses `$...$` for inline math. Switch the delimiters.')
  }
  if (hasBracket) {
    findings.push('Backslash-bracket `\\[...\\]` math delimiters — tlda chat uses `$$...$$` for display math. Switch the delimiters.')
  }
  return findings
}

/** Run every check on a piece of text; returns a flat list of issue strings. */
function runLint(text) {
  const issues = []
  try {
    const { validity, style } = checkChatRender(text)
    for (const v of validity) issues.push(v)
    for (const s of style) issues.push(s)
  } catch { /* render check should never throw; degrade to delimiter-only */ }
  for (const d of checkDelimiters(text)) issues.push(d)
  return issues
}

// ---------------------------------------------------------------------------
// Nudge + dedupe
// ---------------------------------------------------------------------------
function firstLine(issue) {
  return String(issue).split('\n')[0].replace(/\s+/g, ' ').trim()
}

function authorNudge(issues, sharedMd) {
  const head = firstLine(issues[0])
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : ''
  const md = sharedMd ? ' Linted the message text; the shared `.md` body is not in the chat event.' : ''
  return `⚠ **lint**: ${head}${more}.${md} Fix in place by **amending** the message (\`chat({ amend_id })\`), no need to repost.`
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

/** Detect a shared .md attachment referenced in the event metadata. */
function hasMarkdownShare(meta) {
  if (!meta || typeof meta !== 'object') return false
  const lists = [meta.attachments, meta.inline_attachments].filter(Array.isArray)
  for (const list of lists) {
    for (const a of list) {
      const mime = String(a?.mimeType || a?.contentType || '').toLowerCase()
      if (mime === 'text/markdown' || mime === 'text/x-markdown') return true
      const name = String(a?.name || a?.path || a?.url || '').toLowerCase()
      if (name.endsWith('.md') || name.endsWith('.markdown')) return true
    }
  }
  return false
}

function handleMessage(raw) {
  let msg
  try { msg = JSON.parse(raw.toString()) } catch { return }
  if (handleWsReply(msg)) return
  if (msg.event !== 'fleet-event' || !msg.data) return
  const d = msg.data
  const from = d.from_id ?? d.from
  const text = d.text ?? d.message
  if (d.type !== 'chat' || !text) return
  writeHeartbeat('chat')
  // Lint AGENT messages. Skip the human owner (voice input), the system sender,
  // and ourselves.
  if (!from || from === AGENT_ID || from === OWNER_ID || from === 'fleet:tlda') return
  if (!RELEVANT_RE.test(text)) return
  const issues = runLint(text)
  if (!issues.length) return
  const key = `${from}:${d.id ?? text.slice(0, 40)}`
  if (alreadyNudged(key)) return
  const sharedMd = hasMarkdownShare(d.metadata)
  // Bots talk to the AUTHOR, never to Skip. Skip observes the nudge in fleet
  // chat; he does not have a chat WITH the bot.
  sendChat(from, authorNudge(issues, sharedMd))
  writeHeartbeat('nudge')
}

function connect() {
  ws = new WebSocket(WS_URL, { rejectUnauthorized: false })
  ws.on('open', async () => {
    try { await loginFleet(); writeHeartbeat('ws-open') }
    catch (e) { /* reconnect loop retries on close */ console.error('[lint-bot] login failed', e?.message) }
  })
  ws.on('message', (raw) => { try { handleMessage(raw) } catch { /* never crash on a bad frame */ } })
  ws.on('close', () => { setTimeout(connect, 1000) })
  ws.on('error', (e) => { console.error('[lint-bot] ws error', e?.message) })
}

// ---------------------------------------------------------------------------
// Startup (pidfile guard like todd)
// ---------------------------------------------------------------------------
try {
  const prev = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
  if (prev && prev !== process.pid) {
    try { process.kill(prev, 0); console.error(`[lint-bot] already running pid=${prev}`); process.exit(0) } catch { /* prev pid is dead — safe to take over */ }
  }
} catch { /* no readable pidfile — first run */ }
try { fs.writeFileSync(PID_FILE, String(process.pid)) } catch { /* best-effort pidfile write */ }
writeHeartbeat('startup')
connect()
setInterval(() => writeHeartbeat('tick'), 30_000)
process.on('SIGINT', () => { try { fs.unlinkSync(PID_FILE) } catch { /* best-effort cleanup */ }; process.exit(0) })
process.on('exit', () => { try { fs.unlinkSync(PID_FILE) } catch { /* best-effort cleanup */ } })
