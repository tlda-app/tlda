// Step 3 of the notification proposal: the server reports the symptom to the
// agent's daemon, and chooses no remedy.
//
// This is a new server→daemon message type, which is the single most
// failure-prone thing to add in this system: an unrecognised type is
// acknowledged normally, so a severed wire reports health. So it is asserted by
// standing up a real fleet-daemon socket against a real server and reading what
// actually arrives on it — the op name and the symptom, not that a function was
// called.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { removeTempDir } from './test-support/remove-temp-dir.mjs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from './fleet-store.mjs'

const ARRIVAL_CEILING_MS = 60_000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', c => { output += c })
  child.stderr.on('data', c => { output += c })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await sleep(25)
  }
}

async function openFleetWs(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return ws
}

function request(ws, id, type, payload) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error)); else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type, ...payload }))
  })
}

// Every RPC the server sends this daemon, in order, with its op and params.
async function openDaemon(port, rpcs) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet-daemon`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.on('message', raw => {
    const message = JSON.parse(String(raw))
    if (message.type !== 'rpc') return
    rpcs.push({ op: message.op, params: message })
    ws.send(JSON.stringify({ type: 'rpc-reply', id: message.id, result: { ok: true } }))
  })
  const welcome = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('daemon welcome timed out')), 20_000)
    const onMessage = raw => {
      if (JSON.parse(String(raw)).type !== 'daemon-welcome') return
      clearTimeout(timeout); ws.off('message', onMessage); resolve()
    }
    ws.on('message', onMessage)
  })
  ws.send(JSON.stringify({
    type: 'daemon-hello', machine_id: 'mini', env_name: 'testing',
    boot_id: 1, install_path: import.meta.dirname, hostname: 'mini.local', version: 'test',
  }))
  await welcome
  return ws
}

async function waitForSymptom(rpcs) {
  const deadline = Date.now() + ARRIVAL_CEILING_MS
  while (Date.now() < deadline) {
    const hit = rpcs.find(r => r.op === 'notification-symptom')
    if (hit) return hit
    await sleep(25)
  }
  return null
}

// `recipient` decides whether the agent has an MCP socket and what it does.
async function withFleet({ withRecipientSocket = true, loginKind = 'claude', responder = () => {}, subscriptionQuery = 'to:me', extraSubscriptions = [] }, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-notification-symptom-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  await store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: now, last_seen: now })
  await store.upsertAgent({ id: 'fleet:recipient', friendly_name: 'recipient', labels: [], registered_at: now, last_seen: now })
  await store.ensureSubscription({ owner: 'fleet:recipient', query: subscriptionQuery, notificationPolicy: 'immediate' })
  for (const subscription of extraSubscriptions) {
    await store.ensureSubscription({ owner: 'fleet:recipient', ...subscription })
  }
  store.setAgentDaemonRoute('fleet:recipient', 'mini:testing')
  await store.close()

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), PROJECTS_DIR: join(dir, 'projects'),
      TLDA_FLEET_DB: dbPath, TLDA_DEV_SERVER: '1', TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const rpcs = []
  let daemonWs, recipientWs, senderWs
  try {
    await waitForServer(child)
    daemonWs = await openDaemon(port, rpcs)
    if (withRecipientSocket) {
      recipientWs = await openFleetWs(port)
      // `kind` is what marks this socket as an MCP, and it is sent NESTED under
      // `metadata` because that is where the real MCP puts it — `loginBody` in
      // mcp-server/fleet-tools.mjs carries `metadata: { kind }` and no top-level
      // `kind` at all. An earlier version of this harness sent it top-level,
      // which the server also accepts, so the test passed while exercising a path
      // production never takes.
      await request(recipientWs, 'r-login', 'login', {
        operation_id: 'symptom-login', agent_id: 'fleet:recipient',
        machine_id: 'mini', env_name: 'testing',
        ...(loginKind ? { metadata: { kind: loginKind } } : {}),
      })
      recipientWs.on('message', raw => {
        const frame = JSON.parse(String(raw))
        const ackId = frame.data?.metadata?.wake_ack_id
        if (frame.event !== 'channel-notification' || !ackId) return
        responder(recipientWs, ackId)
      })
    }
    senderWs = await openFleetWs(port)
    await fn(senderWs, rpcs, port)
  } finally {
    daemonWs?.close(); recipientWs?.close(); senderWs?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    removeTempDir(dir)
  }
}

const sendChat = (ws, id, tempId) => request(ws, id, 'chat', {
  from: 'fleet:sender', to: 'recipient', message: 'a notice that will not be acked', _tempId: tempId,
})

test('a persisted between-thread subscription crosses the notification channel', async () => {
  let received = false
  await withFleet({
    subscriptionQuery: 'fleet:sender <> recipient',
    responder: (ws, ackId) => {
      received = true
      ws.send(JSON.stringify({
        id: 100, type: 'channel-notification-ack', agent: 'fleet:recipient', ack_id: ackId,
      }))
    },
  }, async senderWs => {
    await sendChat(senderWs, 2, 'between-subscription-channel-proof')
    const deadline = Date.now() + 10_000
    while (!received && Date.now() < deadline) await sleep(25)
    assert.equal(received, true)
  })
})

test('an immediate personal subscription is not overwritten by a matching batch subscription', async () => {
  let receivedAt = null
  await withFleet({
    extraSubscriptions: [{ query: 'to:my_labels', notificationPolicy: 'batch(15s)' }],
    responder: (ws, ackId) => {
      receivedAt = Date.now()
      ws.send(JSON.stringify({
        id: 100, type: 'channel-notification-ack', agent: 'fleet:recipient', ack_id: ackId,
      }))
    },
  }, async senderWs => {
    const startedAt = Date.now()
    const result = await sendChat(senderWs, 2, 'overlapping-subscription-channel-proof')
    const deadline = startedAt + 5000
    while (!receivedAt && Date.now() < deadline) await sleep(25)
    assert.ok(receivedAt, `notification did not arrive; receipt: ${JSON.stringify(result)}`)
    assert.ok(receivedAt - startedAt < 5000, `notification arrived after ${receivedAt - startedAt}ms`)
    assert.equal(result.receipts[0].delivery, 'notified')
  })
})

test('an MCP that says nothing is reported to the daemon as channel-silent', async () => {
  await withFleet({ responder: () => {} }, async (senderWs, rpcs) => {
    await sendChat(senderWs, 2, 'symptom-silent')
    const hit = await waitForSymptom(rpcs)
    assert.ok(hit, `the daemon must receive a notification-symptom. Ops seen: ${JSON.stringify(rpcs.map(r => r.op))}`)
    assert.equal(hit.params.symptom, 'channel-silent')
    assert.equal(hit.params.agent_id, 'fleet:recipient')
    assert.ok(hit.params.observed_at, 'the symptom carries when it was observed')
    // The whole point of the message: no remedy, no text to deliver.
    assert.equal(hit.params.notify_text, undefined, 'a symptom report must not carry a notification to deliver')
  })
})

// Step 2 made this state reachable. A refusal is not a liveness fault, and the
// daemon has to be able to tell — otherwise it turns a healthy agent off and on
// again for declining a notice.
test('an explicit nack is reported as channel-refused, not as silence', async () => {
  await withFleet({
    responder: (ws, ackId) => ws.send(JSON.stringify({
      id: 100, type: 'channel-notification-ack', agent: 'fleet:recipient',
      ack_id: ackId, acknowledged: false, reason: 'sender-is-recipient',
    })),
  }, async (senderWs, rpcs) => {
    await sendChat(senderWs, 2, 'symptom-refused')
    const hit = await waitForSymptom(rpcs)
    assert.ok(hit, `expected a symptom. Ops seen: ${JSON.stringify(rpcs.map(r => r.op))}`)
    assert.equal(hit.params.symptom, 'channel-refused')
  })
})

test('an agent with no MCP socket at all is reported as no-channel', async () => {
  await withFleet({ withRecipientSocket: false }, async (senderWs, rpcs) => {
    await sendChat(senderWs, 2, 'symptom-no-channel')
    const hit = await waitForSymptom(rpcs)
    assert.ok(hit, `expected a symptom. Ops seen: ${JSON.stringify(rpcs.map(r => r.op))}`)
    assert.equal(hit.params.symptom, 'no-channel')
  })
})

// The control. An acknowledged notice is not a symptom, and reporting one would
// be worse than reporting none — it would put every healthy agent in front of
// its daemon as a problem.
test('an acknowledged notice reports no symptom at all', async () => {
  await withFleet({
    responder: (ws, ackId) => ws.send(JSON.stringify({
      id: 100, type: 'channel-notification-ack', agent: 'fleet:recipient', ack_id: ackId,
    })),
  }, async (senderWs, rpcs) => {
    await sendChat(senderWs, 2, 'symptom-none')
    await sleep(3000)
    assert.equal(
      rpcs.filter(r => r.op === 'notification-symptom').length,
      0,
      `a delivered notice is not a symptom. Ops seen: ${JSON.stringify(rpcs.map(r => r.op))}`,
    )
  })
})

// A bot holds a /ws/fleet socket and logs in on it exactly as an MCP does, but
// has no code that could ever acknowledge a notice — `dev-bot.mjs` contains zero
// occurrences of `channel-notification`, `wake_ack_id` or
// `channel-notification-ack`. Before this, one such bot produced 207 of 234 ack
// timeouts in six hours.
//
// It stopped being merely untidy when the symptom started reaching the daemon:
// `channel-silent` means restart, so an unanswerable notice every ~100 seconds
// is a restart every ~100 seconds — of the bot that reclaims disk on this box.
//
// The honest symptom is `no-channel`, and it is also the accurate one: there is
// no open MCP socket. `ensure-process` on a bot that is running is a no-op.
test('a socket that is not an MCP is not notified, and reports no-channel', async () => {
  await withFleet({ loginKind: null, responder: () => {} }, async (ws, rpcs) => {
    await sendChat(ws, 2, 'bot-shaped-recipient')
    const hit = await waitForSymptom(rpcs)
    assert.ok(hit, `expected a symptom. Ops seen: ${JSON.stringify(rpcs.map(r => r.op))}`)
    assert.equal(hit.params.symptom, 'no-channel',
      'a logged-in socket that never declared an MCP kind must not be treated as a channel')
  })
})

// The control for the test above. Same fixture, same flow, the only difference
// being that this login declares a kind — so a `no-channel` result there cannot
// be the harness simply failing to deliver anything.
test('the same fixture with an MCP kind does reach the channel', async () => {
  await withFleet({ loginKind: 'claude', responder: () => {} }, async (ws, rpcs) => {
    await sendChat(ws, 2, 'mcp-shaped-recipient')
    const hit = await waitForSymptom(rpcs)
    assert.ok(hit, `expected a symptom. Ops seen: ${JSON.stringify(rpcs.map(r => r.op))}`)
    assert.equal(hit.params.symptom, 'channel-silent',
      'a declared MCP socket must be notified and then time out, not be skipped')
  })
})

// `dev` does not log in with no kind — it logs in with `kind: "bot"`, read from
// its live agent row on 2026-08-22. So this is the actual production value, not
// a stand-in for one, and it is excluded because the gate is an allow-list over
// the harness table rather than a list of things to skip.
test('the kind a bot really sends is not a notification target', async () => {
  await withFleet({ loginKind: 'bot', responder: () => {} }, async (ws, rpcs) => {
    await sendChat(ws, 2, 'kind-bot-recipient')
    const hit = await waitForSymptom(rpcs)
    assert.ok(hit, `expected a symptom. Ops seen: ${JSON.stringify(rpcs.map(r => r.op))}`)
    assert.equal(hit.params.symptom, 'no-channel',
      'kind "bot" is not in the harness table, so it is not an MCP and must not be notified')
  })
})

// The gate is derived from `shared/harness.ts` rather than a literal list, and
// this is what that buys: a harness added there is eligible without anyone
// remembering to update the server. The failure direction if it fell behind is
// SILENCE — no notification and no error — so it is worth a test that fails when
// the two drift apart.
test('every declared harness is a notification target', async () => {
  const { HARNESS } = await import('../../shared/harness.ts')
  const kinds = Object.keys(HARNESS)
  assert.ok(kinds.length >= 3, `expected the harness table to be populated, got ${JSON.stringify(kinds)}`)
  assert.ok(!kinds.includes('bot'), 'a bot is not a harness with an MCP; if this fails the gate stops excluding bots')
  for (const kind of kinds) {
    await withFleet({ loginKind: kind, responder: () => {} }, async (ws, rpcs) => {
      await sendChat(ws, 2, `harness-${kind}`)
      const hit = await waitForSymptom(rpcs)
      assert.ok(hit, `${kind}: expected a symptom. Ops seen: ${JSON.stringify(rpcs.map(r => r.op))}`)
      assert.equal(hit.params.symptom, 'channel-silent',
        `${kind} is a declared harness, so its socket must be notified rather than skipped`)
    })
  }
})

// ─── THE GATE: a delegate to a hibernating agent still reaches a remedy ──────
//
// The server no longer wakes anyone. Its wake queue, the drain that respawned,
// and the circuit breaker that paced them are deleted, because §"What this
// design rules out" says "No remedy selection by the server."
//
// So the path that used to end in the server respawning has to end in the daemon
// making a process instead, and this is the link that would strand the fleet if
// it were missing: a delegate arrives for an agent with no MCP socket, and what
// must come out the other side is `no-channel` at that agent's daemon — job one
// of the daemon's two in §"Liveness: what the daemon is for".
//
// `withRecipientSocket: false` IS the hibernating agent: a live row, a daemon
// route, and no MCP connection. That is what hibernating means here.
test('THE GATE: a delegate to a hibernating agent reaches its daemon as no-channel', async () => {
  await withFleet({ withRecipientSocket: false }, async (senderWs, rpcs) => {
    await request(senderWs, 2, 'delegate', {
      agent: 'recipient',
      from: 'fleet:sender',
      message: 'work for a hibernating agent',
      description: 'the gate',
    })
    const hit = await waitForSymptom(rpcs)
    assert.ok(hit, `a delegate must still reach the daemon. Ops seen: ${JSON.stringify(rpcs.map(r => r.op))}`)
    assert.equal(hit.params.symptom, 'no-channel',
      'a hibernating agent has no MCP socket, so the symptom is no-channel and the daemon makes a process')
    assert.equal(hit.params.agent_id, 'fleet:recipient')
    // The report carries no remedy and nothing to deliver. If either appeared
    // here the server would be choosing again.
    assert.equal(hit.params.notify_text, undefined, 'a symptom report must not carry a notification to deliver')
    assert.equal(hit.params.action, undefined, 'a symptom report must not carry a remedy')
  })
})

// A REPLAYED login must claim the new socket as an MCP, not merely as an agent.
//
// Two commits a day apart, both correct alone. `b940c4c9e` taught the server that
// a durable login arriving again after an ACK-loss reconnect must claim the new
// socket -- at the time, `_tldaAgentId` was the whole identity a socket had.
// `6a430a9b5` then added `_tldaClientKind` and made notification eligibility
// depend on it, setting it on the fresh-login path only.
//
// So a replayed login produced a half-identified socket: `openFleetSocketsForAgent`
// finds it, `isMcpChannelSocket` rejects it, and the server reports
// `no-open-mcp-socket` about an MCP that is connected and idle. The agent can
// still SEND -- sending needs only the agent id -- so it looks healthy from the
// inside while every notification addressed to it is dropped. The daemon's remedy
// for `no-channel` is `ensure-process`, which no-ops on a live process, so nothing
// recovers it and nothing logs it.
//
// The replay is reached the way production reaches it: the same `operation_id` on
// a second socket, which is what the MCP's coalesced durable login re-sends after
// its first attempt was queued rather than acked.
test('a login replayed onto a new socket is still a notification target', async () => {
  await withFleet({ withRecipientSocket: false }, async (senderWs, rpcs, port) => {
    const login = {
      operation_id: 'replay-login', agent_id: 'fleet:recipient',
      machine_id: 'mini', env_name: 'testing', metadata: { kind: 'claude' },
    }

    // First login: completes normally and records the operation result.
    const first = await openFleetWs(port)
    await request(first, 'login-1', 'login', login)
    await new Promise(resolve => { first.once('close', resolve); first.close() })

    // The ACK-loss reconnect: same operation_id, new socket. The server takes the
    // `previous?.kind === 'result'` branch and never runs the login handler.
    const second = await openFleetWs(port)
    const notified = new Promise(resolve => {
      second.on('message', raw => {
        const frame = JSON.parse(String(raw))
        if (frame.event === 'channel-notification') resolve(frame)
      })
    })
    await request(second, 'login-2', 'login', login)

    await sendChat(senderWs, 2, 'replay-login-notice')

    // Assert on the ARRIVAL, not on the absence of a symptom: a notice that
    // reaches this socket is the whole point, and an absent symptom would also be
    // satisfied by a server that did nothing at all.
    const frame = await Promise.race([notified, sleep(20_000).then(() => null)])
    assert.ok(frame, 'a replayed login must leave the socket eligible for notification; '
      + `instead the server sent nothing to it. Daemon ops seen: ${JSON.stringify(rpcs.map(r => r.op))}`)
    assert.equal(frame.data.recipient, 'fleet:recipient')
    second.close()
  })
})
