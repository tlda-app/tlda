// A singleton label is a label at most one living agent may hold. Skip,
// 2026-09-01 03:55 EDT: "labels should be, at creation time, marked singleton
// or not … perhaps we don't want multiple on-call agents … so if you try to
// apply on-call and someone has it, you get an error telling you that like, if
// you really mean it, strip it and then apply it."
//
// The store enforces it and server/lib/fleet-store-singleton-labels.test.mjs
// proves that. This exercises the WIRE, which is the part that can be missing:
// `singleton` is a new field on the `label` message, and a field the dispatcher
// drops travels no further than the sender's optimism. Calling
// mutateAgentLabels directly would prove the sender and the receiver and
// nothing about whether they are connected.
//
// So: boot the real server, open a real fleet socket, and do it the way an
// agent does — declare, collide, strip, re-apply.
import WebSocket from 'ws'
import { spawn } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PORT = Number(process.env.PORT || (5290 + (process.pid % 900)))
const DB = `/tmp/singleton-label-wire-test-${process.pid}.db`
const ENV_NAME = 'default'
const useTls = existsSync(`${process.env.HOME}/.config/tlda/localhost+2.pem`)
if (useTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const proto = useTls ? 'https' : 'http'
const wsProto = useTls ? 'wss' : 'ws'
const wsOpts = useTls ? { rejectUnauthorized: false } : {}

let srv
let failures = 0
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function cleanup(code) {
  try { srv?.kill('SIGKILL') } catch { /* already gone */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(`${DB}${suffix}`, { force: true }) } catch { /* already gone */ }
  }
  process.exit(code)
}
const fail = (m) => { console.error('FAIL:', m); cleanup(1) }
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`) }
  else { failures++; console.error(`  FAIL ${label}${detail ? `: ${detail}` : ''}`) }
}

srv = spawn('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TLDA_FLEET_DB: DB, TLDA_DEV_SERVER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
srv.stdout.on('data', d => { serverLog += d })
srv.stderr.on('data', d => { serverLog += d })

async function waitHealth() {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${proto}://localhost:${PORT}/api/health`)
      if (r.ok) return true
    } catch { /* not listening yet */ }
    await sleep(500)
  }
  return false
}

function openFleet() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsProto}://localhost:${PORT}/ws/fleet`, wsOpts)
    ws.on('open', () => setTimeout(() => resolve(ws), 200))
    ws.on('error', (e) => fail(`fleet WS error: ${e.message}`))
  })
}

let reqSeq = 0
function request(ws, message, timeoutMs = 8000) {
  const id = `singleton-${++reqSeq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`no reply to "${message.type}" within ${timeoutMs}ms`))
    }, timeoutMs)
    function onMessage(raw) {
      let frame
      try { frame = JSON.parse(raw) } catch { return }
      if (frame.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(frame)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ ...message, id }))
  })
}

// `error` comes back as a string on some replies and an object carrying a
// message on others. Flatten it: a check that reads only one shape reports the
// other as "no error", which is the answer it exists to distinguish.
const errorText = (frame) => {
  const raw = frame.error ?? frame.result?.error ?? ''
  if (!raw) return ''
  if (typeof raw === 'string') return raw
  return raw.message || raw.error || JSON.stringify(raw)
}

async function run() {
  if (!await waitHealth()) fail(`server never became healthy.\n${serverLog}`)
  const ws = await openFleet()

  const A = 'fleet:singleton-holder'
  const B = 'fleet:singleton-claimant'
  for (const [agentId, name] of [[A, 'singletonholder'], [B, 'singletonclaimant']]) {
    ws.send(JSON.stringify({ type: 'reserve-shell', agent_id: agentId, name, machine_id: 'testbox', env_name: ENV_NAME }))
    ws.send(JSON.stringify({ type: 'login', agent_id: agentId, machine_id: 'testbox', env_name: ENV_NAME }))
  }
  await sleep(800)

  // An ordinary label repeats. This is the control: without it, a rejection
  // below could be any label write failing rather than the singleton rule.
  const plainA = await request(ws, { type: 'label', agent: A, operation: 'add', labels: 'reviewers' })
  const plainB = await request(ws, { type: 'label', agent: B, operation: 'add', labels: 'reviewers' })
  check('an ordinary label applies to two agents over the wire',
    plainA.result?.ok === true && plainB.result?.ok === true,
    `replies were ${JSON.stringify(plainA)} / ${JSON.stringify(plainB)}`)

  // The field has to cross the boundary. If the dispatcher drops `singleton`,
  // this call still succeeds — an ordinary label is created — and the collision
  // below is what reports it.
  const declared = await request(ws, { type: 'label', agent: A, operation: 'add', labels: 'siren', singleton: true })
  check('declaring a singleton label succeeds', declared.result?.ok === true,
    `reply was ${JSON.stringify(declared)}`)

  const collided = await request(ws, { type: 'label', agent: B, operation: 'add', labels: 'siren' })
  check('a second agent applying it is refused', !!errorText(collided),
    `reply was ${JSON.stringify(collided)}`)
  check('and the refusal names the holder and the remedy',
    errorText(collided).includes(A) && /remove it from/.test(errorText(collided)),
    `error was ${JSON.stringify(errorText(collided))}`)

  const rosterAfterCollision = await request(ws, { type: 'resolve-agent', agent: B })
  const bLabels = rosterAfterCollision.result?.agent?.labels || []
  check('the refused label did not land anyway', !bLabels.includes('siren'),
    `labels were ${JSON.stringify(bLabels)}`)

  // Skip's remedy, over the wire, in the order he gave it.
  const stripped = await request(ws, { type: 'label', agent: A, operation: 'remove', labels: 'siren' })
  check('the holder can strip it', stripped.result?.ok === true, `reply was ${JSON.stringify(stripped)}`)
  const reapplied = await request(ws, { type: 'label', agent: B, operation: 'add', labels: 'siren' })
  check('and then the claimant can apply it', reapplied.result?.ok === true,
    `reply was ${JSON.stringify(reapplied)}`)

  // Names and singleton labels are one namespace, which is the whole reason a
  // friendly name is describable as a singleton label. B holds `siren`; nobody
  // may take it as a name.
  const renamed = await request(ws, { type: 'rename', agent: A, name: 'siren' })
  check('a friendly name may not take a label a living agent holds', !!errorText(renamed),
    `reply was ${JSON.stringify(renamed)}`)

  // And on-call arrived singleton through the migration, on a database created
  // by this run — not by anything this test wrote.
  const onCallA = await request(ws, { type: 'label', agent: A, operation: 'add', labels: 'on-call' })
  const onCallB = await request(ws, { type: 'label', agent: B, operation: 'add', labels: 'on-call' })
  check('on-call is singleton without anyone declaring it',
    onCallA.result?.ok === true && !!errorText(onCallB),
    `replies were ${JSON.stringify(onCallA)} / ${JSON.stringify(onCallB)}`)

  ws.close()
  if (failures) fail(`${failures} check(s) failed`)
  console.log('\nPASS: singleton labels hold across the fleet socket.')
  cleanup(0)
}

run().catch(e => fail(`${e.message}\n${serverLog.slice(-4000)}`))
