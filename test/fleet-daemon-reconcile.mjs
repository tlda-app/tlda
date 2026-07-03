#!/usr/bin/env node
/**
 * Fleet daemon Claude JSONL ownership test.
 *
 * Proves the hard ownership rule: Claude activity ownership comes only from the
 * FLEET_ID embedded in the JSONL ("Registered fleet:<id>"). A tmux pane/session
 * may be used for terminal I/O and liveness, but it must not rewrite agent
 * identity or session ownership.
 *
 * Two cases, both required:
 *
 *   A. LIVE AGENT WITH STALE ROSTER SESSION — an agent registered with a STALE
 *      session_id while the owned JSONL is a different session. Assert: the
 *      daemon does NOT reconcile/mutate the registry, but it still watches the
 *      owned JSONL and emits an activity card.
 *
 *   B. STALE PID METADATA IS IGNORED — even with an unrelated sessions file
 *      sitting on disk, the daemon must NOT reconcile another agent to it.
 *
 * Run: node test/fleet-daemon-reconcile.mjs
 */
import { spawn, execSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'fs'
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
const CONFIG_DIR = path.join(FAKE_HOME, '.config', 'tlda')
const SESSIONS_DIR = path.join(FAKE_HOME, '.claude', 'sessions')
const CLAUDE_PROJECTS = path.join(FAKE_HOME, '.claude', 'projects')
const PORT = 5810 + Math.floor(Math.random() * 80)
const SERVER = `http://localhost:${PORT}`
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
mkdirSync(CONFIG_DIR, { recursive: true })
mkdirSync(SESSIONS_DIR, { recursive: true })
mkdirSync(jsonlDir, { recursive: true })
mkdirSync(SRC_DIR, { recursive: true })
writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify({
  defaultConfig: 'test',
  configs: {
    test: {
      database: SERVER,
      store: SERVER,
      licenseKey: '',
    },
  },
}, null, 2))

let serverProc = null, daemonProc = null
function cleanup() {
  try { daemonProc?.kill('SIGTERM') } catch {}
  try { serverProc?.kill('SIGTERM') } catch {}
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

  // ---- AGENT A: registered with the WRONG (stale) roster session ----
  // No live pane/PID metadata is needed for ownership. The JSONL's embedded
  // owner is sufficient and authoritative.
  // The live JSONL the process is "writing". Its embedded fleet id, not tmux
  // pane state and not the stale roster session_id, is the ownership source.
  const liveJsonl = path.join(jsonlDir, `${LIVE_SESSION}.jsonl`)
  writeFileSync(liveJsonl, JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text: 'Registered fleet:reconA' }] },
  }) + '\n')
  await registerAgent({ id: 'fleet:reconA', name: 'recon-A', tmux: TMUX_A, sessionId: STALE_SESSION })

  // ---- AGENT B: stale PID metadata exists but must not affect ownership ----
  writeFileSync(path.join(SESSIONS_DIR, '999999.json'),
    JSON.stringify({ pid: 999999, sessionId: LIVE_SESSION, cwd: SRC_DIR, updatedAt: Date.now() }))
  await registerAgent({ id: 'fleet:reconB', name: 'recon-B', tmux: 'fleet-nonexistent-dead', sessionId: DEAD_SESSION })

  // confirm both registered with machine_id + their original sessions
  const reg = await http('GET', '/api/state')
  check('agent A registered (stale session)', agentFromState(reg, 'fleet:reconA')?.session_id === STALE_SESSION,
    `got ${agentFromState(reg, 'fleet:reconA')?.session_id}`)
  check('agent B registered (dead session)', agentFromState(reg, 'fleet:reconB')?.session_id === DEAD_SESSION,
    `got ${agentFromState(reg, 'fleet:reconB')?.session_id}`)

  // The isolated test server starts its own fleet daemon supervisor under the
  // fake HOME. Do not start or touch the machine's launchd daemon here.

  // ===== CASE A: owned JSONL watched without reconciling roster identity =====
  await waitFor(async () => {
    try {
      const cursors = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'daemon-cursors.json'), 'utf8'))
      return cursors[LIVE_SESSION]?.owners?.includes('fleet:reconA')
    } catch {
      return false
    }
  }, { timeout: 25000, name: 'live JSONL classified to embedded fleet owner' })
  const aAfter = agentFromState(await http('GET', '/api/state'), 'fleet:reconA')
  check('A.session_id is NOT reconciled from tmux/pid metadata', aAfter?.session_id === STALE_SESSION, `got ${aAfter?.session_id}`)
  check('A.session_ids does not adopt the live session from tmux/pid metadata', !(aAfter?.session_ids || []).includes(LIVE_SESSION),
    `got ${JSON.stringify(aAfter?.session_ids)}`)

  // Attribution resumes because the live JSONL itself embeds the fleet owner.
  appendFileSync(liveJsonl, JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', name: 'Edit', id: 't1', input: { file_path: 'x.tex' } }] },
  }) + '\n')
  await waitFor(async () => {
    const r = await http('GET', `/api/store/events?agent=fleet:reconA&limit=20`)
    return (r.body?.events || []).some(e => e.type === 'activity' && (e.text === 'Edit' || JSON.stringify(e.metadata || '').includes('Edit')))
  }, { timeout: 8000, name: 'activity card for the owned live JSONL' })
  check('activity card appears for the owned live JSONL without reconciliation', true)

  // ===== CASE B: stale PID metadata does not mutate another agent =====
  const bAfter = agentFromState(await http('GET', '/api/state'), 'fleet:reconB')
  check('B.session_id NOT reconciled from stale pid metadata', bAfter?.session_id === DEAD_SESSION, `got ${bAfter?.session_id}`)
  check('B did not adopt the live session sitting on disk', !(bAfter?.session_ids || []).includes(LIVE_SESSION),
    `got ${JSON.stringify(bAfter?.session_ids)}`)

  console.log(`\n[recon] === ${pass} pass / ${fail} fail ===`)
  if (failures.length) for (const f of failures) console.log('  - ' + f)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('[recon] CRASH:', e.stack || e.message); cleanup(); process.exit(2) })
