#!/usr/bin/env node
/**
 * Peek window-size E2E test.
 *
 * Verifies the terminal-peek grid-sizing fix: the daemon reports each agent's
 * REAL tmux window width to the viewer (so the peek grid matches it and the
 * absolute-positioned stream doesn't garble), and follows window-size changes.
 *
 *   1. On a peek (browser /ws/terminal connect), the server delivers a
 *      {type:'size', cols, rows} that matches the session's tmux window width.
 *   2. When the tmux window is resized, a fresh {type:'size'} follows (poller).
 *   3. The live stream still flows ({type:'output'} frames arrive).
 *
 * Isolated stack (own server port, own fleet DB, own daemon config dir) — does
 * not touch the live server/daemon. Mirrors test/fleet-daemon-integration.mjs.
 */
import { spawn, execFileSync, execSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { WebSocket } from 'ws'

// Local isolated stack uses the machine's mkcert TLS cert (server is https-only
// when certs exist). Accept the self-signed cert for this test process.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const WS_OPTS = { rejectUnauthorized: false }

let pass = 0, fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const TMP = path.join(tmpdir(), 'peek-size-' + Date.now())
const FLEET_DB = path.join(TMP, 'fleet.db')
const PROJECTS = path.join(TMP, 'projects')
const FAKE_HOME = path.join(TMP, 'home')
const DAEMON_CFG = path.join(TMP, 'daemon-cfg')
const PORT = 5900 + Math.floor(Math.random() * 90)
const SERVER = `https://localhost:${PORT}`
const WS = `wss://localhost:${PORT}`
const TEST_TMUX = `peek-size-itest-${Date.now()}`
const MACHINE_ID = (process.env.HOSTNAME || execSync('hostname -s', { encoding: 'utf8' }).trim()).split('.')[0]
const WIN_W = 135, WIN_H = 40

mkdirSync(TMP, { recursive: true })
mkdirSync(PROJECTS, { recursive: true })
mkdirSync(FAKE_HOME, { recursive: true })
mkdirSync(DAEMON_CFG, { recursive: true })

let serverProc = null, daemonProc = null, tmuxCreated = false
function cleanup() {
  try { daemonProc?.kill('SIGTERM') } catch {}
  try { serverProc?.kill('SIGTERM') } catch {}
  if (tmuxCreated) { try { execFileSync('tmux', ['kill-session', '-t', TEST_TMUX], { stdio: 'pipe' }) } catch {} }
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })

async function http(method, urlPath, body) {
  const r = await fetch(`${SERVER}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: r.status, body: json }
}
async function waitFor(predicate, { timeout = 5000, interval = 100, name = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await predicate()) return true } catch {}
    await new Promise(r => setTimeout(r, interval))
  }
  throw new Error(`waitFor timeout: ${name}`)
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function spawnLogged(label, cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`))
  p.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`))
  return p
}

async function registerAgent(agentId) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/ws/fleet`, WS_OPTS)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'register', id: agentId, name: 'peek-size-agent',
        tmux_session: TEST_TMUX, cwd: PROJECTS, machine_id: MACHINE_ID,
      }))
      setTimeout(() => { try { ws.close() } catch {}; resolve() }, 600)
    })
    ws.on('error', reject)
  })
}

// Open a browser-style terminal WS and collect every message, exposing helpers
// to wait for a specific message type.
function openTerminalWs(agentId) {
  const msgs = []
  const ws = new WebSocket(`${WS}/ws/terminal?agent=${encodeURIComponent(agentId)}`, WS_OPTS)
  ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())) } catch {} })
  const waitMsg = (pred, { timeout = 6000, name = 'message' } = {}) => waitFor(
    () => msgs.some(pred), { timeout, name })
  const last = (pred) => [...msgs].reverse().find(pred)
  return { ws, msgs, waitMsg, last }
}

async function main() {
  console.log(`[peek-itest] tmp=${TMP} port=${PORT} machine_id=${MACHINE_ID}`)

  const serverEnv = { ...process.env }
  delete serverEnv.TLDA_TOKEN_RW
  delete serverEnv.TLDA_TOKEN_READ
  Object.assign(serverEnv, {
    PORT: String(PORT), HOST: '127.0.0.1', PROJECTS_DIR: PROJECTS,
    TLDA_FLEET_DB: FLEET_DB, TLDA_NO_AUTH: '1',
  })
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'unified-server.mjs'), '--i-am-tlda-cli'], {
    env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', d => process.stdout.write(`[server] ${d}`))
  serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`))
  await waitFor(async () => (await fetch(`${SERVER}/health`).then(r => r.ok).catch(() => false)),
    { timeout: 8000, name: 'server /health' })

  const agentId = 'fleet:peeksize1'
  await registerAgent(agentId)

  // Detached tmux session at a NON-120 window width — the exact case the old
  // fixed-120 peek garbled.
  execFileSync('tmux', ['new-session', '-d', '-s', TEST_TMUX, '-x', String(WIN_W), '-y', String(WIN_H)], { stdio: 'pipe' })
  tmuxCreated = true

  daemonProc = spawnLogged('daemon', process.execPath, [path.join(ROOT, 'bin', 'fleet-daemon.mjs')], {
    HOME: FAKE_HOME, TLDA_SERVER: SERVER, TLDA_DAEMON_CONFIG_DIR: DAEMON_CFG,
  })
  await waitFor(async () => {
    const res = await http('POST', '/api/send-key', { agent: agentId, key: 'Enter' })
    return res.status !== 503
  }, { timeout: 8000, name: 'daemon connected (no more 503)' })

  // ---- 1. peek delivers the real window size ----
  const t = openTerminalWs(agentId)
  await t.waitMsg(m => m.type === 'size', { timeout: 8000, name: 'size message' })
  const size = t.last(m => m.type === 'size')
  check('size message reports real tmux window width',
    size && size.cols === WIN_W && size.rows === WIN_H,
    `got ${JSON.stringify(size)} expected cols=${WIN_W} rows=${WIN_H}`)

  // ---- 3. live stream flows ----
  await t.waitMsg(m => m.type === 'output' && m.data, { timeout: 8000, name: 'output frame' })
  check('live output frames arrive', !!t.last(m => m.type === 'output' && m.data))

  // ---- 2. window resize is followed by a fresh size message ----
  const NEW_W = 100, NEW_H = 30
  const before = t.msgs.filter(m => m.type === 'size').length
  execFileSync('tmux', ['resize-window', '-t', TEST_TMUX, '-x', String(NEW_W), '-y', String(NEW_H)], { stdio: 'pipe' })
  let followed = false
  try {
    await t.waitMsg(m => m.type === 'size' && m.cols === NEW_W, { timeout: 6000, name: 'resized size message' })
    followed = true
  } catch {}
  const resizedSize = t.last(m => m.type === 'size')
  check('window resize is followed by a fresh size message',
    followed && resizedSize.cols === NEW_W,
    `before=${before} last=${JSON.stringify(resizedSize)} expected cols=${NEW_W}`)

  try { t.ws.close() } catch {}
  await sleep(300)

  console.log(`\n[peek-itest] === ${pass} pass / ${fail} fail ===`)
  if (failures.length) for (const f of failures) console.log('  - ' + f)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('[peek-itest] CRASH:', e.stack || e.message); cleanup(); process.exit(2) })
