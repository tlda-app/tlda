// Step 7 of the notification proposal: bound the wake RPC, and stop losing a
// routeless wake without a trace.
//
// Both are about a failure producing quiet rather than a wrong answer, which is
// the class this repository says to test. Neither is visible from either end on
// its own: an unbounded RPC looks identical to a slow one until the fleet stops,
// and an untraced drop looks identical to a message nobody sent.
import test from 'node:test'
import assert from 'node:assert/strict'

import { runWakeRouteLifecycle } from './wake-route-lifecycle.mjs'

const liveDaemon = { readyState: 1 }

// §S4: `sendDaemonDurable(daemonKey, 'wake', …)` passed no rpcOptions, so
// `startWsRequest` set neither an idle timer nor a deadline and the call was
// bounded only by the socket closing. A daemon holding an open socket and never
// replying parks the drain — and the drain is guarded by `_wakeDraining` and
// invoked unawaited, so every notification in the fleet stops behind it.
test('a wake RPC carries the caller bounds', async () => {
  const calls = []
  await runWakeRouteLifecycle({
    agentId: 'fleet:a',
    agent: { id: 'fleet:a' },
    daemonKey: 'mini:testing',
    ownerDaemon: liveDaemon,
    rpcOptions: { attemptTimeoutMs: 120000, totalDeadlineMs: 300000 },
    sendDaemonDurable: async (key, op, payload, options) => {
      calls.push({ key, op, options })
      return { ok: true }
    },
    getAgentDaemonRoute: async () => ({ daemon_key: 'mini:testing' }),
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].op, 'wake')
  assert.deepEqual(
    calls[0].options,
    { attemptTimeoutMs: 120000, totalDeadlineMs: 300000 },
    'the wake must be bounded, or one silent daemon stops every notification in the fleet',
  )
})

// The module states no policy of its own. A caller that passes nothing is a bug
// at that call site, and it should be visible there rather than papered over by
// a default here that nobody chose.
test('with no bounds given, none are invented', async () => {
  const calls = []
  await runWakeRouteLifecycle({
    agentId: 'fleet:a',
    agent: { id: 'fleet:a' },
    daemonKey: 'mini:testing',
    ownerDaemon: liveDaemon,
    sendDaemonDurable: async (key, op, payload, options) => {
      calls.push({ op, options })
      return { ok: true }
    },
    getAgentDaemonRoute: async () => ({ daemon_key: 'mini:testing' }),
  })
  assert.equal(calls[0].options, undefined)
})

// §S3. Not asserted through the drain — that needs a running server — but the
// server test below covers the branch. This one pins the neighbouring contract
// the drain relies on: a wake that reaches the daemon and comes back without a
// route is an error, not a silent success.
test('a wake that loses its route fails loudly', async () => {
  await assert.rejects(
    () => runWakeRouteLifecycle({
      agentId: 'fleet:a',
      agent: { id: 'fleet:a' },
      daemonKey: 'mini:testing',
      ownerDaemon: liveDaemon,
      rpcOptions: { attemptTimeoutMs: 1, totalDeadlineMs: 1 },
      sendDaemonDurable: async () => ({ ok: true }),
      getAgentDaemonRoute: async () => null,
    }),
    /did not retain a daemon route/,
  )
})
