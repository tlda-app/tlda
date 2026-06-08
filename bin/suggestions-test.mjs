// Integration test for the generic suggestions channel + the Todd example bot.
// Boots the worktree server isolated (temp DB, test port, supervisors off), then:
//   1. exercises POST/GET /api/suggestions + the 'suggestions' WS broadcast,
//      including per-agent replace semantics and multi-agent flattening;
//   2. spawns bin/todd.mjs the way the supervisor does (TLDA_BOT_NAME +
//      TLDA_BOT_PIDFILE env) and asserts it registers as fleet:todd / "Todd"
//      and writes its pidfile.
import WebSocket from 'ws'
import { spawn } from 'child_process'
import { existsSync, rmSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PORT = 5194
const DB = `/tmp/suggestions-test-${process.pid}.db`
const TODD_PID = `/tmp/suggestions-test-todd-${process.pid}.pid`
const useTls = existsSync(`${process.env.HOME}/.config/tlda/localhost+2.pem`)
const proto = useTls ? 'https' : 'http'
const wsProto = useTls ? 'wss' : 'ws'
const wsOpts = useTls ? { rejectUnauthorized: false } : {}
const base = `${proto}://localhost:${PORT}`

let srv, todd
function cleanup(code) {
  try { todd?.kill('SIGKILL') } catch {}
  try { srv?.kill('SIGKILL') } catch {}
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, TODD_PID]) { try { rmSync(f, { force: true }) } catch {} }
  process.exit(code)
}
const fail = (m) => { console.error('FAIL:', m); cleanup(1) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

srv = spawn('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TLDA_FLEET_DB: DB, TLDA_DEV_SERVER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
srv.stdout.on('data', d => { log += d }); srv.stderr.on('data', d => { log += d })

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return true } catch {}
    await sleep(500)
  }
  return false
}
const post = (agentId, suggestions) => fetch(`${base}/api/suggestions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId, suggestions }),
}).then(r => r.json())
const getAll = () => fetch(`${base}/api/suggestions`).then(r => r.json()).then(j => j.suggestions || [])

async function run() {
  if (!await waitHealth()) fail(`server never healthy.\n${log}`)

  // WS client to capture the 'suggestions' broadcast.
  let lastBroadcast = null
  const ws = new WebSocket(`${wsProto}://localhost:${PORT}/ws/fleet`, wsOpts)
  ws.on('message', (raw) => {
    try { const m = JSON.parse(raw); if (m.event === 'suggestions') lastBroadcast = m.data?.suggestions || [] } catch {}
  })
  await new Promise(r => ws.on('open', r))
  await sleep(200)

  // 1. Post a chip for agent A.
  await post('fleet:a', [{ id: 'a:0', label: 'decide X', command: 'todd do-x', kind: 'action' }])
  await sleep(300)
  let all = await getAll()
  if (all.length !== 1) fail(`expected 1 suggestion, got ${all.length}: ${JSON.stringify(all)}`)
  if (all[0].from !== 'fleet:a') fail(`expected from=fleet:a, got ${all[0].from}`)
  if (!lastBroadcast || lastBroadcast.length !== 1) fail(`WS broadcast missing/wrong: ${JSON.stringify(lastBroadcast)}`)
  console.log('PASS: post + GET + WS broadcast for one agent')

  // 2. Second agent posts — flatten to 2.
  await post('fleet:b', [{ id: 'b:0', label: 'review Y' }])
  await sleep(200)
  all = await getAll()
  if (all.length !== 2) fail(`expected 2 after second agent, got ${all.length}`)
  console.log('PASS: multi-agent flattening')

  // 3. Agent A clears (empty array) — only B remains.
  await post('fleet:a', [])
  await sleep(200)
  all = await getAll()
  if (all.length !== 1 || all[0].from !== 'fleet:b') fail(`clear failed, got ${JSON.stringify(all)}`)
  console.log('PASS: per-agent clear leaves other agents intact')

  // 4. Spawn the Todd bot the way the supervisor does.
  todd = spawn('node', ['bin/todd.mjs'], {
    cwd: ROOT,
    env: { ...process.env, TLDA_SERVER: base, TLDA_BOT_NAME: 'todd', TLDA_BOT_PIDFILE: TODD_PID,
           NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let toddLog = ''
  todd.stdout.on('data', d => { toddLog += d }); todd.stderr.on('data', d => { toddLog += d })
  // Wait for it to register.
  let registered = null
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    const st = await fetch(`${base}/api/state`).then(r => r.json()).catch(() => ({}))
    registered = (st.agents || []).find(a => a.id === 'fleet:todd')
    if (registered) break
  }
  if (!registered) fail(`Todd never registered as fleet:todd.\nTodd log:\n${toddLog}`)
  if (registered.friendly_name !== 'Todd') fail(`Todd friendly_name should be "Todd", got "${registered.friendly_name}"`)
  if (!existsSync(TODD_PID)) fail('Todd did not write its pidfile at TLDA_BOT_PIDFILE')
  const pid = readFileSync(TODD_PID, 'utf8').trim()
  if (!pid || isNaN(parseInt(pid, 10))) fail(`Todd pidfile content invalid: "${pid}"`)
  console.log(`PASS: Todd registered as fleet:todd ("Todd"), wrote pidfile (pid ${pid})`)

  console.log('\nALL CHECKS PASSED')
  cleanup(0)
}
run().catch(e => fail(`exception: ${e.stack}`))
setTimeout(() => fail('overall timeout'), 90000)
