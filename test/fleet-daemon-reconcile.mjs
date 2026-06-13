#!/usr/bin/env node
/**
 * Fleet daemon session-reconciliation test (bug #35).
 *
 * Proves the fix for "alive agent, dead activity cards": the daemon now reads
 * each alive agent's TRUE live Claude session from the PID-keyed
 * ~/.claude/sessions/<pid>.json (the same authoritative source the MCP uses),
 * and if it diverges from the registered session_id, heals the registry so
 * JSONL→agent attribution resumes.
 *
 * Two cases, both required:
 *
 *   A. LIVE AGENT RECONCILED — an agent registered with a STALE session_id but
 *      whose live process is actually writing a DIFFERENT (unregistered) JSONL.
 *      Assert: the daemon reconciles the registry to the true session AND an
 *      activity card appears for a write to the true JSONL (attribution healed).
 *
 *   B. GENUINELY-DEAD STILL REAPS — an agent with NO live claude process. Even
 *      with a sessions file sitting on disk, the daemon must NOT reconcile it
 *      (reconciliation is gated on liveness) and must leave it hibernating with
 *      its session_id untouched. This is the guarantee that protects legit reaping.
 *
 * Run: node test/fleet-daemon-reconcile.mjs
 */
import { spawn, execFileSync, execSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { WebSocket } from 'ws'

let pass = 0, fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const TMP = path.join(tmpdir(), 'fleet-recon-' + Date.now())
const FLEET_DB = path.join(TMP, 'fleet.db')
const PROJECTS = path.join(TMP, 'projects')
const FAKE_HOME = path.join(TMP, 'home')
const SRC_DIR = path.join(TMP, 'docsrc')
const DAEMON_CFG = path.join(TMP, 'daemoncfg')   // isolate the daemon PID file / log from the live daemon
const SESSIONS_DIR = path.join(FAKE_HOME, '.claude', 'sessions')
const CLAUDE_PROJECTS = path.join(FAKE_HOME, '.claude', 'projects')
const PORT = 5810 + Math.floor(Math.random() * 80)
const SERVER = `http://localhost:${PORT}`
const STUB = path.join(TMP, 'claude-stub.mjs')         // path contains "claude" → counts as a claude proc
const TMUX_A = `fleet-recon-A-${Date.now()}`
const MACHINE_ID = (process.env.HOSTNAME || execSync('hostname -s', { encoding: 'utf8' }).trim()).split('.')[0]

// The divergence at the heart of #35.
const STALE_SESSION = '11111111-1111-1111-1111-111111111111'   // what the agent registered
const LIVE_SESSION  = '22222222-2222-2222-2222-222222222222'   // what its process actually writes
const DEAD_SESSION  = '33333333-3333-3333-3333-333333333333'   // a dead agent's registered session

// projectHash exactly as the daemon computes it (syncSessionWatchers).
const projectHash = SRC_DIR.replace(/[/.]/g, '-')
const jsonlDir = path.join(CLAUDE_PROJECTS, projectHash)

mkdirSync(TMP, { recursive: true })
mkdirSync(PROJECTS, { recursive: true })
mkdirSync(DAEMON_CFG, { recursive: true })
mkdirSync(SESSIONS_DIR, { recursive: true })
mkdirSync(jsonlDir, { recursive: true })
mkdirSync(SRC_DIR, { recursive: true })

let serverProc = null, daemonProc = null, tmuxCreated = false
function cleanup() {
  try { daemonProc?.kill('SIGTERM') } catch {}
  try { serverProc?.kill('SIGTERM') } catch {}
  if (tmuxCreated) { try { execFileSync('tmux', ['kill-session', '-t', TMUX_A], { stdio: 'pipe' }) } catch {} }
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
async function waitFor(predicate, { timeout = 5000, interval = 150, name = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await predicate()) return true } catch {}
    await new Promise(r => setTimeout(r, interval))
  }
  throw new Error(`waitFor timeout: ${name}`)
}
function findStubPid() {
  const out = execSync('ps -eo pid,args', { encoding: 'utf8' })
  const line = out.split('\n').find(l => l.includes('claude-stub.mjs'))
  return line ? parseInt(line.trim().split(/\s+/)[0], 10) : null
}
function spawnLogged(label, cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`))
  p.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`))
  return p
}
async function registerAgent({ id, name, tmux, sessionId }) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/fleet`)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'register', id, name,
        tmux_session: tmux, cwd: SRC_DIR,
        session_id: sessionId, machine_id: MACHINE_ID,
      }))
      setTimeout(() => { try { ws.close() } catch {}; resolve() }, 500)
    })
    ws.on('error', reject)
  })
}
function agentFromState(state, id) { return (state.body?.agents || []).find(a => a.id === id) }

async function main() {
  console.log(`[recon] tmp=${TMP} port=${PORT} machine_id=${MACHINE_ID}`)

  // ---- claude-stub: a long-lived process whose argv contains "claude" ----
  writeFileSync(STUB, 'setInterval(() => {}, 1 << 30)\n')

  // ---- start the server ----
  const serverEnv = { ...process.env }
  delete serverEnv.TLDA_TOKEN_RW; delete serverEnv.TLDA_TOKEN_READ
  // HOME=fake so the server doesn't find the machine's mkcert certs and stays HTTP.
  Object.assign(serverEnv, { HOME: FAKE_HOME, PORT: String(PORT), HOST: '127.0.0.1', PROJECTS_DIR: PROJECTS, TLDA_FLEET_DB: FLEET_DB, TLDA_NO_AUTH: '1' })
  serverProc = spawnLogged('server', process.execPath, [path.join(ROOT, 'server', 'unified-server.mjs'), '--i-am-tlda-cli'], serverEnv)
  await waitFor(async () => fetch(`${SERVER}/health`).then(r => r.ok).catch(() => false), { timeout: 8000, name: 'server /health' })

  // ---- project the daemon will watch ----
  writeFileSync(path.join(SRC_DIR, 'main.md'), '# recon\n')
  const create = await http('POST', '/api/projects', { name: 'recon', title: 'recon', format: 'markdown', sourceDir: SRC_DIR })
  check('create project', create.status === 201, `status=${create.status}`)

  // ---- AGENT A: live, but registered with the WRONG (stale) session ----
  execFileSync('tmux', ['new-session', '-d', '-s', TMUX_A, `node ${STUB} --resume ${LIVE_SESSION}`], { stdio: 'pipe' })
  tmuxCreated = true
  await waitFor(async () => findStubPid() != null, { timeout: 4000, name: 'stub process up' })
  const stubPid = findStubPid()
  console.log(`[recon] stub pid=${stubPid}`)
  // Authoritative PID-keyed live session (what the MCP would also read).
  writeFileSync(path.join(SESSIONS_DIR, `${stubPid}.json`),
    JSON.stringify({ pid: stubPid, sessionId: LIVE_SESSION, cwd: SRC_DIR, updatedAt: Date.now() }))
  // The live JSONL the process is "writing" — initially unregistered.
  const liveJsonl = path.join(jsonlDir, `${LIVE_SESSION}.jsonl`)
  writeFileSync(liveJsonl, '')
  await registerAgent({ id: 'fleet:reconA', name: 'recon-A', tmux: TMUX_A, sessionId: STALE_SESSION })

  // ---- AGENT B: genuinely dead (no tmux/claude), yet a sessions file exists ----
  // If reconciliation wrongly ignored liveness it would adopt LIVE_SESSION here too.
  writeFileSync(path.join(SESSIONS_DIR, '999999.json'),
    JSON.stringify({ pid: 999999, sessionId: LIVE_SESSION, cwd: SRC_DIR, updatedAt: Date.now() }))
  await registerAgent({ id: 'fleet:reconB', name: 'recon-B', tmux: 'fleet-nonexistent-dead', sessionId: DEAD_SESSION })

  // confirm both registered with machine_id + their original sessions
  const reg = await http('GET', '/api/state')
  check('agent A registered (stale session)', agentFromState(reg, 'fleet:reconA')?.session_id === STALE_SESSION,
    `got ${agentFromState(reg, 'fleet:reconA')?.session_id}`)
  check('agent B registered (dead session)', agentFromState(reg, 'fleet:reconB')?.session_id === DEAD_SESSION,
    `got ${agentFromState(reg, 'fleet:reconB')?.session_id}`)

  // ---- start the daemon (HOME=fake so it reads our sessions + JSONLs) ----
  daemonProc = spawnLogged('daemon', process.execPath, [path.join(ROOT, 'bin', 'fleet-daemon.mjs')], { HOME: FAKE_HOME, TLDA_SERVER: SERVER, TLDA_DAEMON_CONFIG_DIR: DAEMON_CFG })

  // ===== CASE A: live agent reconciled to its true session =====
  await waitFor(async () => {
    const a = agentFromState(await http('GET', '/api/state'), 'fleet:reconA')
    return a?.session_id === LIVE_SESSION
  }, { timeout: 25000, name: 'agent A reconciled to live session' })
  const aAfter = agentFromState(await http('GET', '/api/state'), 'fleet:reconA')
  check('A.session_id healed to the true live session', aAfter?.session_id === LIVE_SESSION, `got ${aAfter?.session_id}`)
  check('A.session_ids retains the prior stale id too', (aAfter?.session_ids || []).includes(STALE_SESSION) && (aAfter?.session_ids || []).includes(LIVE_SESSION),
    `got ${JSON.stringify(aAfter?.session_ids)}`)

  // attribution actually resumed: a write to the (now-registered) live JSONL becomes an activity card
  appendFileSync(liveJsonl, JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', name: 'Edit', id: 't1', input: { file_path: 'x.tex' } }] },
  }) + '\n')
  await waitFor(async () => {
    const r = await http('GET', `/api/store/events?agent=fleet:reconA&limit=20`)
    return (r.body?.events || []).some(e => e.type === 'activity' && (e.text === 'Edit' || JSON.stringify(e.metadata || '').includes('Edit')))
  }, { timeout: 8000, name: 'activity card for the reconciled session' })
  check('activity card appears for the previously-orphaned live JSONL', true)

  // ===== CASE B: genuinely dead agent still reaps, session untouched =====
  const bAfter = agentFromState(await http('GET', '/api/state'), 'fleet:reconB')
  check('B.session_id NOT reconciled (dead → no PID → no-op)', bAfter?.session_id === DEAD_SESSION, `got ${bAfter?.session_id}`)
  check('B did not adopt the live session sitting on disk', !(bAfter?.session_ids || []).includes(LIVE_SESSION),
    `got ${JSON.stringify(bAfter?.session_ids)}`)
  check('B is not in the alive set (still hibernating)', bAfter?.status !== 'awake', `status=${bAfter?.status}`)

  console.log(`\n[recon] === ${pass} pass / ${fail} fail ===`)
  if (failures.length) for (const f of failures) console.log('  - ' + f)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('[recon] CRASH:', e.stack || e.message); cleanup(); process.exit(2) })
