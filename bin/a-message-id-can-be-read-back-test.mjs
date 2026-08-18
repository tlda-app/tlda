// A message id is handed out everywhere and, until this landed, accepted
// nowhere on the read surface. `inbox()` prints `id:2923649`, `chat()` returns
// one, `approval_id` and `amend_id` both take one -- and no read tool would
// turn one back into the message it names. Skip, 2026-08-17: "apparently you
// can't ook uo chat messages given id ... if that's what we give you ... you
// hvae to be able to fucking look them up."
//
// This exercises the WIRE, which is the only part that can be missing. The MCP
// `thread(message_id:)` branch sends the ephemeral operation `event-by-id`; the
// server's dispatchFleetWsMessage answers it out of fleetStore.getEventById.
// Calling those two functions from one process would prove both ends and
// nothing about whether they are connected -- and an unhandled type on this
// dispatcher is dropped with the sender none the wiser, which is how
// `agent-route` spent eleven days being announced into a server that had
// dropped its handler.
//
// So: boot the real server, open a real socket, send a real chat through it,
// and ask for that message back by the id the server itself assigned.
import WebSocket from 'ws'
import { spawn } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PORT = Number(process.env.PORT || (5290 + (process.pid % 900)))
const DB = `/tmp/message-id-readback-test-${process.pid}.db`
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
  // Best-effort teardown on a path that already knows the verdict. A server
  // that died on its own, or a temp DB the kernel already reclaimed, must not
  // turn a passing run into a failing one or mask the real failure below.
  try { srv?.kill('SIGKILL') } catch { /* already gone; nothing to kill */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(`${DB}${suffix}`, { force: true }) } catch { /* temp file, already gone */ }
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
    } catch { /* not listening yet — that is what we are waiting for */ }
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

// One request/response over the socket, the way the MCP transport does it.
let reqSeq = 0
function request(ws, message, timeoutMs = 8000) {
  const id = `readback-${++reqSeq}`
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

async function run() {
  if (!await waitHealth()) fail(`server never became healthy.\n${serverLog}`)
  const ws = await openFleet()

  for (const [agentId, name] of [['fleet:readback-sender', 'readbacksender'], ['fleet:readback-recipient', 'readbackrecipient']]) {
    ws.send(JSON.stringify({ type: 'reserve-shell', agent_id: agentId, name, machine_id: 'testbox', env_name: ENV_NAME }))
    ws.send(JSON.stringify({ type: 'login', agent_id: agentId, machine_id: 'testbox', env_name: ENV_NAME }))
  }
  await sleep(800)

  const TEXT = 'the message an id has to be able to name'
  const sent = await request(ws, {
    type: 'chat',
    from: 'fleet:readback-sender',
    to: 'fleet:readback-recipient',
    message: TEXT,
  })
  const messageId = sent.result?.event_ids?.[0]
  if (!messageId) fail(`chat did not return an id to look up. reply: ${JSON.stringify(sent)}`)
  console.log(`  (server assigned id ${messageId})`)

  // The claim: that id, sent back over the same socket, returns that message.
  const found = await request(ws, { type: 'event-by-id', event_id: messageId })
  check('the id the server handed out reads back as an event', !!found.result?.event,
    `reply was ${JSON.stringify(found)}`)
  check('and it is the same message, not merely some row',
    found.result?.event?.text === TEXT,
    `text was ${JSON.stringify(found.result?.event?.text)}`)
  check('carrying the sender, so a reader knows whose message it is',
    found.result?.event?.from === 'fleet:readback-sender',
    `from was ${JSON.stringify(found.result?.event?.from)}`)
  check('and the type, which is what the canonical chat#<id> form asserts',
    found.result?.event?.type === 'chat',
    `type was ${JSON.stringify(found.result?.event?.type)}`)

  // A missing message must read as missing. If this came back as an event, the
  // lookup would confirm any id an agent invented.
  // `event: null` explicitly, not merely falsy: with the handler removed this
  // dispatcher answers {ok:false, error:'unknown type'}, whose `event` is also
  // undefined. A falsy check passes in both worlds and so proves nothing.
  const absent = await request(ws, { type: 'event-by-id', event_id: 99999999 })
  check('an id nothing answers to returns no event rather than something',
    absent.result?.event === null && absent.result?.error === undefined,
    `reply was ${JSON.stringify(absent)}`)

  // A non-id is an error, not an empty answer — the two mean different things
  // to the caller and only one of them is worth retrying.
  const bad = await request(ws, { type: 'event-by-id', event_id: 'not-a-number' })
  check('a malformed id is refused as an error, not answered as absent',
    !!bad.error,
    `reply was ${JSON.stringify(bad)}`)

  ws.close()
  console.log(failures === 0
    ? 'PASS a message id can be read back'
    : `FAIL a message id can be read back (${failures})`)
  cleanup(failures === 0 ? 0 : 1)
}

run().catch(e => fail(`${e.message}\n${serverLog.slice(-2000)}`))
