#!/usr/bin/env node
/**
 * Fleet daemon end-to-end integration test (Phase 5).
 *
 * Boots a real unified-server.mjs against an isolated SQLite DB and
 * an empty projects dir, spawns the fleet-daemon against it, and
 * verifies every Phase 5 success criterion:
 *
 *   1. Agent registration with machine_id round-trips through the WS
 *      register handler.
 *   2. Activity card appears after a JSONL write (daemon parses the
 *      new line, ships activity-event, server stores type='activity').
 *   3. Terminal-user chat from a JSONL user message lands as a chat
 *      event (server dedups duplicates).
 *   4. send-key / send-text RPC routing roundtrips successfully when
 *      the daemon is up. Uses a real local tmux session.
 *   5. Daemon-down: tearing down the daemon makes the same RPC return
 *      503 (no silent inline fallback).
 *   6. Source change: writing a watched file pushes source-change to
 *      the server which writes the file into the project's source dir.
 *
 * Cleanup: kills the daemon, the server, removes tmux test session,
 * scrubs the temp dir. Idempotent.
 */
import { spawn, execFileSync, execSync } from 'child_process'
import {
  mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync,
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { WebSocket } from 'ws'

let pass = 0, fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ---- env / paths ----
const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const TMP = path.join(tmpdir(), 'fleet-int-' + Date.now())
const FLEET_DB = path.join(TMP, 'fleet.db')
const PROJECTS = path.join(TMP, 'projects')
const DATA_DIR = path.join(TMP, 'data')
const FAKE_HOME = path.join(TMP, 'home')
const SRC_DIR = path.join(TMP, 'docsrc')
const FAKE_CLAUDE_PROJECTS = path.join(FAKE_HOME, '.claude', 'projects')
const PORT = 5800 + Math.floor(Math.random() * 100)
const SERVER = `http://localhost:${PORT}`
const TEST_TMUX_SESSION = `fleet-itest-${Date.now()}`
const MACHINE_ID = (process.env.HOSTNAME || execSync('hostname -s', { encoding: 'utf8' }).trim()).split('.')[0]

mkdirSync(TMP, { recursive: true })
mkdirSync(PROJECTS, { recursive: true })
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(FAKE_HOME, { recursive: true })
mkdirSync(FAKE_CLAUDE_PROJECTS, { recursive: true })
mkdirSync(SRC_DIR, { recursive: true })

// ---- handles to clean up at the end ----
let serverProc = null
let daemonProc = null
let tmuxCreated = false

function cleanup() {
  try { daemonProc?.kill('SIGTERM') } catch {}
  try { serverProc?.kill('SIGTERM') } catch {}
  if (tmuxCreated) { try { execFileSync('tmux', ['kill-session', '-t', TEST_TMUX_SESSION], { stdio: 'pipe' }) } catch {} }
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })

// ---- helpers ----
async function http(method, urlPath, body) {
  const r = await fetch(`${SERVER}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
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

async function main() {
  console.log(`[itest] tmp=${TMP}`)
  console.log(`[itest] server port=${PORT}`)
  console.log(`[itest] machine_id=${MACHINE_ID}`)

  const configDir = path.join(FAKE_HOME, '.config', 'tlda')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    defaultConfig: 'itest',
    configs: {
      itest: {
        database: SERVER,
        store: SERVER,
        licenseKey: 'itest',
      },
    },
    machineId: MACHINE_ID,
    bots: [],
  }, null, 2))

  // ---- start the server ----
  // Spawn the server with a clean env: no inherited tokens, auth off.
  const serverEnv = { ...process.env }
  delete serverEnv.TLDA_TOKEN_RW
  delete serverEnv.TLDA_TOKEN_READ
  Object.assign(serverEnv, {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    HOME: FAKE_HOME,
    DATA_DIR,
    PROJECTS_DIR: PROJECTS,
    TLDA_FLEET_DB: FLEET_DB,
    TLDA_NO_AUTH: '1',
    TLDA_DEV_SERVER: '1',
  })
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'unified-server.mjs'), '--i-am-tlda-cli'], {
    env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', d => process.stdout.write(`[server] ${d}`))
  serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`))
  await waitFor(async () => (await fetch(`${SERVER}/health`).then(r => r.ok).catch(() => false)),
    { timeout: 8000, name: 'server /health' })

  // ---- create a project that the daemon will source-watch ----
  writeFileSync(path.join(SRC_DIR, 'main.md'), '# itest\nhello\n')
  const create = await http('POST', '/api/projects', {
    name: 'itest', title: 'itest', format: 'markdown', sourceDir: SRC_DIR, mainFile: 'main.md',
  })
  check('create project', create.status === 201, `status=${create.status}`)

  // ---- register an agent that lives on this machine ----
  // This is the gating bit: an agent has to have machine_id set for the
  // daemon to see it via daemon-welcome and for RPCs to route correctly.
  // We mimic the fleet MCP's WS register flow by hand.
  const agentId = 'fleet:itest1'
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/fleet`)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'register', id: 'reg1',
        id_field: agentId, // legacy compat
        // server destructures `id` as agentId; we hand-roll the field set
      }))
      // The server reads `id` not `id_field` — re-send with the right field name.
      ws.send(JSON.stringify({
        type: 'register',
        id: agentId,
        name: 'itest-agent',
        tmux_session: TEST_TMUX_SESSION,
        cwd: SRC_DIR,
        machine_id: MACHINE_ID,
      }))
    })
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.id === 'reg1' || (m.result && m.result.agent)) { ws.close(); resolve() }
    })
    ws.on('error', reject)
    setTimeout(() => { try { ws.close() } catch {}; resolve() }, 1500)
  })

  // Confirm the registration landed and machine_id stuck.
  const stateAfterReg = await http('GET', '/api/state')
  const registeredAgent = (stateAfterReg.body?.agents || []).find(a => a.id === agentId)
  check('agent registered with machine_id',
    registeredAgent?.machine_id === MACHINE_ID,
    `got ${registeredAgent?.machine_id}`)

  // ---- create a fake JSONL for the agent ----
  // The daemon scans ~/.claude/projects/<projectHash>/<sessionId>.jsonl
  // where projectHash = cwd.replace(/\//g, '-').
  const sessionId = 'sess-itest-' + Date.now()
  const projectHash = SRC_DIR.replace(/\//g, '-')
  const jsonlDir = path.join(FAKE_CLAUDE_PROJECTS, projectHash)
  mkdirSync(jsonlDir, { recursive: true })
  const jsonlPath = path.join(jsonlDir, sessionId + '.jsonl')
  writeFileSync(jsonlPath, `Registered ${agentId}\n`) // owner evidence so the daemon can claim the JSONL.

  // Re-register the agent with this session_id so the daemon picks it up.
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/fleet`)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'register',
        id: agentId, name: 'itest-agent',
        tmux_session: TEST_TMUX_SESSION, cwd: SRC_DIR,
        session_id: sessionId,
        machine_id: MACHINE_ID,
      }))
      setTimeout(() => { try { ws.close() } catch {}; resolve() }, 500)
    })
    ws.on('error', reject)
  })

  // ---- start the daemon with HOME=$FAKE_HOME so it watches our fake JSONLs ----
  daemonProc = spawnLogged('daemon', process.execPath, [path.join(ROOT, 'bin', 'fleet-daemon.mjs')], {
    HOME: FAKE_HOME, TLDA_SERVER: SERVER,
  })

  // Wait for the daemon to connect (visible by the server registering it).
  await waitFor(async () => {
    // Hit the agents-by-machine helper indirectly: trigger an RPC call
    // and see if it succeeds. Use list-sessions via interrupt? Better:
    // wait for the daemon to log "connected". We poll by sending an
    // /api/send-key — once it stops returning 503 the daemon is up.
    const res = await http('POST', '/api/send-key', { agent: agentId, key: 'Enter' })
    // Either 200 (works) or 502 with a tmux error (session doesn't exist
    // yet) — both mean the daemon is connected. 503 means it isn't.
    return res.status !== 503
  }, { timeout: 6000, name: 'daemon connected (no more 503)' })

  // Create a real tmux session for the agent so RPCs can target it.
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', TEST_TMUX_SESSION], { stdio: 'pipe' })
    tmuxCreated = true
  } catch (e) {
    console.error(`[itest] could not create tmux session: ${e.message}`)
    process.exit(2)
  }

  // ---- 4. send-key / send-text RPC roundtrip ----
  const sk = await http('POST', '/api/send-key', { agent: agentId, key: 'Enter' })
  check('send-key roundtrip', sk.status === 200 && sk.body?.ok === true,
    `status=${sk.status} body=${JSON.stringify(sk.body)}`)
  const st = await http('POST', '/api/send-text', { agent: agentId, text: 'echo hi', enter: false })
  check('send-text roundtrip', st.status === 200 && st.body?.ok === true,
    `status=${st.status} body=${JSON.stringify(st.body)}`)

  // ---- interrupt RPC ----
  const intr = await http('POST', '/api/interrupt', { agent: agentId })
  check('interrupt roundtrip', intr.status === 200 && intr.body?.ok === true,
    `status=${intr.status} body=${JSON.stringify(intr.body)}`)

  // ---- 2. activity card via JSONL write ----
  // Append a fake assistant tool_use line to the JSONL and verify the
  // server stores an `activity` event for the agent.
  const activityLine = JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', name: 'Edit', id: 'tool1', input: { file_path: 'foo.tex' } }] },
  }) + '\n'
  appendFileSync(jsonlPath, activityLine)

  await waitFor(async () => {
    const r = await http('GET', `/api/store/events?agent=${agentId}&limit=20`)
    return (r.body?.events || []).some(e => e.type === 'activity' && (e.text === 'Edit' || JSON.stringify(e.metadata || '').includes('Edit')))
  }, { timeout: 6000, name: 'activity event stored' })
  check('activity card appears after JSONL write', true)

  // ---- 3. terminal-user chat from JSONL ----
  const termText = 'integration test terminal line ' + Date.now()
  const termLine = JSON.stringify({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: termText },
  }) + '\n'
  appendFileSync(jsonlPath, termLine)
  await waitFor(async () => {
    const r = await http('GET', `/api/store/events?agent=${agentId}&limit=20`)
    return (r.body?.events || []).some(e => e.type === 'chat' && e.text === termText)
  }, { timeout: 6000, name: 'terminal-chat stored' })
  check('terminal-user chat lands as chat event', true)

  // ---- 6. source change → server ----
  writeFileSync(path.join(SRC_DIR, 'main.md'), '# itest\nhello world updated\n')
  await waitFor(async () => {
    const filePath = path.join(PROJECTS, 'itest', 'source', 'main.md')
    if (!existsSync(filePath)) return false
    return readFileSync(filePath, 'utf8').includes('hello world updated')
  }, { timeout: 6000, name: 'source change applied to project' })
  check('source change pushed via daemon', true)

  // ---- 5. daemon down → 503 ----
  daemonProc.kill('SIGTERM')
  daemonProc = null
  await waitFor(async () => {
    const r = await http('POST', '/api/send-key', { agent: agentId, key: 'Enter' })
    return r.status === 503
  }, { timeout: 4000, name: '/api/send-key returns 503 after daemon down' })
  check('daemon-down returns 503 (no silent inline fallback)', true)

  // ---- summary ----
  console.log(`\n[itest] === ${pass} pass / ${fail} fail ===`)
  if (failures.length) for (const f of failures) console.log('  - ' + f)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => {
  console.error('[itest] CRASH:', e.stack || e.message)
  cleanup()
  process.exit(2)
})
