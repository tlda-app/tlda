// A reconnect whose route facts changed must still re-login on the new socket.
//
// This is the silent-and-destructive class AGENTS.md reserves tests for:
// dropped communication. The failure leaves an OPEN socket that the server has
// never seen a `login` on, so `_tldaAgentId` is unset, `openMcpSocketsForAgent`
// finds nothing, and every notification for that agent is reported to its daemon
// as `no-open-mcp-socket` → `no-channel` while the agent sits there awake. It
// produced 42 such symptoms for one agent on 2026-08-27 with nothing in any log
// naming a cause. See docs/notifications-and-liveness.md §"Errata: an MCP can
// hold an open socket it never logged in on".
//
// It crosses the wire on purpose. Calling the sender and the receiver from one
// process would prove both functions and nothing about whether a login frame
// reaches a server, and the frame not arriving IS the defect — so this drives
// the real ResilientWS over a real socket into a real WebSocketServer, and
// counts what that server received.
import assert from 'node:assert/strict'
import test from 'node:test'

import { WebSocketServer } from 'ws'

import { channelLoginCoalesceKey } from '../mcp-server/fleet-tools.mjs'
import { createFleetOperationTransport } from '../shared/fleet-operation-transport.mjs'
import { ResilientWS } from '../shared/resilient-ws.mjs'

const AGENT = 'fleet:relogin-proof'

// What `loginRouteFields()` returns across two calls. It is not constant: `cwd`
// and `project` follow the agent's working directory, and `detectedTmux` is an
// `execSync` with a 3s timeout that answers null when it loses the race.
const ROUTE = [
  { cwd: '/Users/skip/work/tlda', tmux_session: 'fleet-relogin' },
  { cwd: '/Users/skip/worktrees/moved', tmux_session: 'fleet-relogin' },
]

async function until(pred, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return false
}

/**
 * Drive one connect + one forced reconnect with changed route facts.
 * @param keyFor how the call site builds its coalesce key
 * @returns logins the server received before and after the reconnect
 */
async function reconnectTrial(keyFor) {
  const wss = new WebSocketServer({ port: 0 })
  const port = await new Promise(r => wss.on('listening', () => r(wss.address().port)))
  let loginsSeen = 0
  const live = new Set()
  wss.on('connection', ws => {
    live.add(ws)
    ws.on('close', () => live.delete(ws))
    ws.on('message', raw => { if (JSON.parse(String(raw)).type === 'login') loginsSeen += 1 })
  })

  let generation = 0
  let rws = null
  const transport = createFleetOperationTransport({
    name: 'relogin-proof',
    sendEphemeral: () => ({ ok: true }),
    // Mirrors `sendDurableFleet`: it enqueues, misses its deadline, and reports
    // `queued` — which is what makes the coalesce entry be RETAINED.
    sendDurable: (type, params) => {
      rws.send({ type, ...params })
      return Promise.resolve({ ok: true, queued: true })
    },
  })

  // `durable()` resolves its coalesce entry synchronously, so this throws INTO
  // ResilientWS's 'open' listener. The call site now catches it there — before
  // that it escaped as an uncaughtException and the stderr line after it never
  // ran, which is why nothing in any log named a cause. Recorded rather than
  // rethrown so the counterfactual arm below can assert on it.
  const onOpenErrors = []
  try {
    rws = new ResilientWS({
      url: () => `ws://127.0.0.1:${port}/ws/fleet?agent=${AGENT}`,
      label: 'relogin-proof',
      log: () => {},
      initialBackoffMs: 50,
      onMessage: () => {},
      // The body of startChannelWS's onOpen.
      onOpen: () => {
        const loginBody = {
          agent_id: AGENT,
          ...ROUTE[Math.min(generation, ROUTE.length - 1)],
          metadata: { kind: 'claude' },
        }
        try {
          transport.durable('login', loginBody, { coalesceKey: keyFor(AGENT, loginBody) })
        } catch (e) {
          onOpenErrors.push(e.message)
        }
      },
    })
    rws.connect()
    assert.ok(await until(() => loginsSeen >= 1), 'rig is broken: no login on the first connect')
    const afterFirst = loginsSeen

    generation = 1
    for (const ws of live) ws.terminate()
    assert.ok(await until(() => rws.connected && live.size === 1), 'rig is broken: never reconnected')
    // The defect is an ABSENCE, so this window has to be generous enough that
    // "nothing arrived" is a fact about the code and not about the clock.
    await until(() => loginsSeen > afterFirst, 1500)

    return { afterFirst, afterReconnect: loginsSeen, socketOpen: rws.connected, onOpenErrors }
  } finally {
    rws?.close()
    wss.close()
  }
}

test('a reconnect with changed route facts re-logs-in on the new socket', async () => {
  const { afterFirst, afterReconnect, socketOpen, onOpenErrors } =
    await reconnectTrial(channelLoginCoalesceKey)

  assert.equal(socketOpen, true, 'the socket should be open after the reconnect')
  assert.deepEqual(onOpenErrors, [], 'the login send must not throw into the open handler')
  assert.ok(
    afterReconnect > afterFirst,
    `the reconnected socket must carry a login: server saw ${afterFirst} then ${afterReconnect}`,
  )
})

// The counterfactual. Without it the test above passes against a key that has
// never worked, because "a login arrived" is also what a rig that never
// reconnects reports. This pins the defect the key exists to remove: an open
// socket the server never sees a login on.
test('keying on the agent id alone leaves an open socket the server never sees a login on', async () => {
  const { afterFirst, afterReconnect, socketOpen, onOpenErrors } =
    await reconnectTrial(agentId => `channel-login:${agentId}`)

  assert.equal(socketOpen, true)
  assert.match(
    onOpenErrors[0] || '', /payload changed/,
    'the agent-id-only key should refuse the changed payload',
  )
  assert.equal(
    afterReconnect, afterFirst,
    'this is the defect: the reconnect must produce no login under an agent-id-only key',
  )
})

test('identical route facts still coalesce rather than duplicating the login', async () => {
  const sent = []
  const transport = createFleetOperationTransport({
    name: 'coalesce-control',
    sendEphemeral: () => assert.fail('ephemeral send not expected'),
    sendDurable: (_type, params) => { sent.push(params); return Promise.resolve({ ok: true, queued: true }) },
  })
  const body = { agent_id: AGENT, cwd: '/Users/skip/work/tlda' }
  const key = channelLoginCoalesceKey(AGENT, body)

  await Promise.all([
    transport.durable('login', body, { coalesceKey: key }),
    transport.durable('login', body, { coalesceKey: key }),
  ])

  assert.equal(sent.length, 1, 'two concurrent identical logins are one operation')
})
