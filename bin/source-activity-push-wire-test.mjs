#!/usr/bin/env node
// Does a real source edit produce a real signal on the doc room?
//
// The unit tests in server/lib/source-activity-push.test.mjs prove the sender
// announces and the payload has the right fields. Calling both ends from one
// process proves both ends and nothing about whether they are connected, and
// the connection is the only part that can be missing -- so this crosses the
// boundary the feature crosses: a daemon WebSocket in, an SSE subscriber out,
// a real server process in between, none of them sharing memory.
//
// It exists because the poll is what currently hides a dead subscription. A
// subscription that renders nothing looks exactly like a working subscription
// on a file nobody is editing.
//
// Not covered here, and deliberately: the last hop from the sync room to a
// browser over the @tldraw/sync protocol. signal:build-progress already rides
// it unchanged and this commit does not touch it.
import { spawn as spawnProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import assert from 'node:assert'
import WebSocket from 'ws'

const PORT = Number(process.env.PORT || (6900 + (process.pid % 900)))
// The dev server serves TLS whenever the local mkcert pair exists, so the
// scheme is a property of the machine rather than a choice.
const useTls = existsSync(`${process.env.HOME}/.config/tlda/localhost+2.pem`)
if (useTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const wsProto = useTls ? 'wss' : 'ws'
const wsOpts = useTls ? { rejectUnauthorized: false } : {}
const base = `${useTls ? 'https' : 'http'}://localhost:${PORT}`
const PROJECT = 'wire-proof-paper'
const AGENT = 'fleet:wire-proof-writer'
const SOURCE_FILE = 'chapter-one.md'

const ROOT = mkdtempSync(join(tmpdir(), 'source-activity-wire-'))
const PROJECTS_DIR = join(ROOT, 'projects')
const DB = join(ROOT, 'fleet.db')
const CONFIG_DIR = join(ROOT, 'config')
const ENV_NAME = 'source-activity-wire-test'
const MACHINE_ID = 'wire-proof-machine'

// Its own environment, its own store, its own database. The environment has to
// be declared in a daemon.yaml the server can find, or config resolution
// refuses the name -- which is the strict-environment check doing its job.
function seedConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(join(CONFIG_DIR, 'server.yaml'), '')
  writeFileSync(join(CONFIG_DIR, 'daemon.yaml'), `machineId: ${MACHINE_ID}
environments:
  default: ${ENV_NAME}
  values:
    ${ENV_NAME}:
      database: ${base}
      store: ${base}
      licenseKey: ""
regions:
  machine: ["**"]
profiles:
  ops:
    read: { allow: [machine], deny: [] }
    write: { allow: [machine], deny: [] }
grants:
  localhost: ops
default: ops
terminalInputAllowed: false
`)
}

let srv = null
let serverLog = ''

function cleanup() {
  try { srv?.kill('SIGKILL') } catch { /* the process is already gone, which is the goal */ }
  try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* a temp dir that outlives the run is harmless */ }
}
process.on('exit', cleanup)

function seedProject() {
  const dir = join(PROJECTS_DIR, PROJECT)
  mkdirSync(join(dir, 'source'), { recursive: true })
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: PROJECT, format: 'markdown' }))
  writeFileSync(join(dir, 'source', SOURCE_FILE), '# Chapter One\n')
}

async function waitHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return
    } catch { /* server not listening yet; that is what the loop is for */ }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`server never became healthy on ${PORT}\n${serverLog}`)
}

// Read the SSE stream until a signal with this key arrives, or time out. The
// stream is a separate HTTP connection to a separate process, which is the
// point: nothing here can see the server's memory.
async function waitForSignal(key, timeoutMs = 20_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const response = await fetch(`${base}/api/projects/${PROJECT}/signal/stream`, { signal: controller.signal })
  assert.equal(response.ok, true, 'signal stream should open')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new Error('signal stream closed before the signal arrived')
      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = JSON.parse(line.slice(6))
        if (payload.key === key) return payload
      }
    }
  } finally {
    clearTimeout(timer)
    try { await reader.cancel() } catch { /* stream teardown; the assertion already ran */ }
  }
}

function daemonSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsProto}://localhost:${PORT}/ws/fleet-daemon`, wsOpts)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

async function main() {
  seedConfig()
  seedProject()
  srv = spawnProcess(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      TLDA_FLEET_DB: DB,
      PROJECTS_DIR,
      TLDA_CONFIG_DIR: CONFIG_DIR,
      TLDA_DAEMON_CONFIG_DIR: CONFIG_DIR,
      TLDA_ENV: ENV_NAME,
      TLDA_MACHINE_ID: MACHINE_ID,
      TLDA_DEV_SERVER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stdout.on('data', d => { serverLog += d })
  srv.stderr.on('data', d => { serverLog += d })
  await waitHealth()

  const ws = await daemonSocket()

  // Say hello before sending anything else. A daemon that skips this stays
  // connected and every message it sends is dropped in silence -- no error, no
  // log line. That silence looked exactly like a broken feature while this test
  // was being written, so it is worth being explicit: the handshake is the rig,
  // not the thing under test.
  ws.send(JSON.stringify({
    type: 'daemon-hello',
    machine_id: MACHINE_ID,
    env_name: ENV_NAME,
    user: 'wire-proof',
    hostname: 'wire-proof',
    version: '0',
    boot_id: Date.now(),
    install_path: process.cwd(),
  }))
  await new Promise(r => setTimeout(r, 1500))

  // Subscribe first, then edit. The other order is the classic false pass: the
  // signal fires before anyone is listening and the test waits for a second one.
  const arrival = waitForSignal('signal:source-activity')
  await new Promise(r => setTimeout(r, 500))

  ws.send(JSON.stringify({
    type: 'activity-event',
    agent_id: AGENT,
    tool: 'Edit',
    project: PROJECT,
    sourceFile: SOURCE_FILE,
    correlationId: 'wire-proof-1',
    ts: new Date().toISOString(),
  }))

  const signal = await arrival

  assert.equal(signal.file, SOURCE_FILE, 'the signal names the file that was edited')
  assert.deepEqual(signal.editors.map(e => e.id), [AGENT],
    'the editing agent is on the signal -- this is the field the pill renders as "is editing"')
  assert.ok('lastChangedAt' in signal && 'lastChangedBy' in signal,
    'the signal carries the last-changed fields too, so the pill has everything the route would have given it')

  // And the editor going away is announced as well, which is the half a poll
  // used to cover for free: without this the pill shows somebody editing forever.
  // A turn ends on the thinking → idle edge, which is what the daemon actually
  // sends; there is no turn-ended message to fake.
  ws.send(JSON.stringify({ type: 'agent-thinking', agentId: AGENT, thinking: true }))
  await new Promise(r => setTimeout(r, 250))
  const cleared = waitForSignal('signal:source-activity')
  await new Promise(r => setTimeout(r, 500))
  ws.send(JSON.stringify({ type: 'agent-thinking', agentId: AGENT, thinking: false }))
  const empty = await cleared
  assert.deepEqual(empty.editors, [], 'ending the turn announces an empty editor set')

  ws.close()
  console.log(`PASS: a real edit produced signal:source-activity on doc-${PROJECT}, over the wire, and ending the turn cleared it`)
}

main().then(() => { cleanup(); process.exit(0) }).catch(e => {
  console.error(`FAIL: ${e.message}`)
  console.error(serverLog.slice(-4000))
  cleanup()
  process.exit(1)
})
