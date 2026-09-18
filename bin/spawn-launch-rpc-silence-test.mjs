// The three silences that let a mint be requested, recorded as pending, and never
// appear anywhere: hw3-writer on 2026-09-18 had a server roster row, no row in the
// daemon's mint store, and no line in any log.
//
// Each test below fails against the code as it stood before the repair. Run with:
//   node --test bin/spawn-launch-rpc-silence-test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDaemonRpcSender,
  isAgentLaunchOp,
  launchRpcOptions,
  spawnMailboxExpiryLine,
} from '../server/lib/spawn-launch-rpc.mjs'

// A socket the server still believes is open: readyState 1, send() succeeds, and no
// reply ever comes back. This is the stale-but-open case -- the bytes go nowhere and
// nothing errors.
function deadButOpenSocket() {
  const sent = []
  return {
    readyState: 1,
    send(payload) { sent.push(JSON.parse(payload)) },
    sent,
  }
}

function harness({ socket = deadButOpenSocket(), welcomeSeen = true, createSender = createDaemonRpcSender } = {}) {
  const key = 'mini:testing'
  const daemonConnections = new Map()
  if (socket) daemonConnections.set(key, socket)
  const daemonWelcomeSeenAt = new Map()
  if (welcomeSeen) daemonWelcomeSeenAt.set(key, Date.now())
  const misses = []
  const readyWaits = []
  const sender = createSender({
    daemonConnections,
    daemonWelcomeSeenAt,
    pendingRpcs: new Map(),
    // Never reconnects, so a transient failure cannot be rescued that way; the
    // question under test is only whether the attempt ENDS.
    waitForDaemonReady: (k, deadlineMs) => {
      readyWaits.push({ key: k, deadlineMs })
      return new Promise((_resolve, reject) => {
        if (deadlineMs === null || deadlineMs === undefined) return // waits forever
        setTimeout(() => reject(new Error(`daemon ${k} did not reconnect within ${deadlineMs}ms`)), deadlineMs).unref?.()
      })
    },
    isTransientRpcError: e => e?.code === 'NO_DAEMON'
      || e?.code === 'RPC_DEADLINE'
      || /RPC timeout after|daemon disconnected|not connected|did not reconnect/i.test(e?.message || ''),
    logSpawnDaemonMiss: (k, context, detail) => misses.push({ key: k, context, detail }),
    reconnectGraceMs: 20,
  })
  return { sender, socket, misses, readyWaits, daemonConnections, key }
}

// ── 1. The repair: the launch RPC's attempt has to END ────────────────────────
// Before the fix, performSpawnRelay called sendDaemonDurable with no rpcOptions, so
// attemptTimeoutMs and totalDeadlineMs were both null. A single envelope written
// into a stale-but-open socket waited forever: the retry loop never ran a second
// iteration, the spawn promise never settled, and every downstream recovery
// (failServerMintShell, the mailbox verdict) lives inside that promise.
// Driven through launchRpcOptions() -- the options the spawn relay actually ships --
// rather than through hand-written numbers, so this fails if the call site is left
// un-deadlined again. The env overrides only make the shipped budget fast enough to
// test; the module reads them at load, hence the separate import.
test('a launch RPC whose reply never comes settles instead of hanging forever', { timeout: 5_000 }, async () => {
  process.env.TLDA_DAEMON_LAUNCH_RPC_ATTEMPT_MS = '25'
  process.env.TLDA_DAEMON_LAUNCH_RPC_TOTAL_MS = '120'
  const fast = await import('../server/lib/spawn-launch-rpc.mjs?budget=fast')
  const { sender, socket } = harness({ createSender: fast.createDaemonRpcSender })
  const settled = await sender.durable('mini', 'mint', { daemon_env_name: 'testing' }, fast.launchRpcOptions())
    .then(() => ({ ok: true }), e => ({ ok: false, error: e }))

  assert.equal(settled.ok, false, 'the mint must not resolve as a success it never got')
  // Whichever layer ends the wait -- the attempt's own deadline, the reconnect wait
  // it falls back to, or the exhausted total budget -- the point is that one of them
  // does, and says which. Before the repair none of them could be reached.
  assert.match(
    settled.error.message,
    /RPC timeout after|gave no response within|did not reconnect/,
    'it must settle with a transport verdict naming what ran out',
  )
  assert.ok(socket.sent.length >= 1, 'the envelope was written to the socket')
  assert.equal(socket.sent[0].op, 'mint')
})

// The same call with the defect's arguments -- no deadlines at all -- is the
// positive control: it must NOT settle. Without this, the test above could pass for
// a reason other than the one it claims (an unrelated rejection), and it would keep
// passing if someone removed the deadlines again.
test('CONTROL: with no deadlines the same call never settles, which is the defect', async () => {
  const { sender } = harness()
  const race = await Promise.race([
    sender.durable('mini', 'mint', { daemon_env_name: 'testing' }, {}).then(() => 'settled', () => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('still-hanging'), 150).unref?.() || setTimeout(() => resolve('still-hanging'), 150)),
  ])
  assert.equal(race, 'still-hanging', 'an un-deadlined launch RPC hangs — this is what the repair removes')
})

test('the shipped launch options carry both deadlines, ordered attempt < total', () => {
  const opts = launchRpcOptions()
  assert.ok(Number.isFinite(opts.attemptTimeoutMs) && opts.attemptTimeoutMs > 0, 'attempt deadline must be finite')
  assert.ok(Number.isFinite(opts.totalDeadlineMs) && opts.totalDeadlineMs > 0, 'total deadline must be finite')
  assert.ok(opts.attemptTimeoutMs < opts.totalDeadlineMs, 'an attempt must not outlast the total budget')
  // The daemon gives up at mintRegistrationDeadlineSeconds (300s, shared/config.mjs)
  // and replies. The server has to outlast that or it abandons the verdict the
  // daemon is about to send.
  assert.ok(opts.totalDeadlineMs > 300_000, 'the total budget must outlast the daemon rpcMint deadline')
})

// ── 2. The gates that read 'spawn' and meant 'the launch path' ────────────────
test('mint and wake are launch ops, not just spawn', () => {
  assert.equal(isAgentLaunchOp('spawn'), true)
  assert.equal(isAgentLaunchOp('mint'), true, 'a fresh agent is sent as op=mint')
  assert.equal(isAgentLaunchOp('wake'), true, 'a respawn is sent as op=wake')
  assert.equal(isAgentLaunchOp('send-text'), false, 'ordinary control ops keep the old behaviour')
  assert.equal(isAgentLaunchOp('capture-pane'), false)
})

for (const op of ['mint', 'wake']) {
  test(`a ${op} against a disconnected daemon waits out the reconnect grace and logs the miss`, async () => {
    const { sender, misses, readyWaits } = harness({ socket: null })
    const error = await sender.attempt('mini', op, { daemon_env_name: 'testing' }).then(
      () => null,
      e => e,
    )
    assert.equal(error?.code, 'NO_DAEMON')
    assert.ok(
      readyWaits.some(w => w.deadlineMs === 20),
      `a ${op} must wait out the reconnect grace, as spawn already did`,
    )
    assert.equal(misses.length, 1, `a ${op} that finds no routable daemon must leave a log line`)
    assert.match(misses[0].context, new RegExp(op), 'the line must name the op that missed')
  })
}

test('a non-launch control op still neither waits nor logs', async () => {
  const { sender, misses, readyWaits } = harness({ socket: null })
  const error = await sender.attempt('mini', 'send-text', { daemon_env_name: 'testing' }).then(() => null, e => e)
  assert.equal(error?.code, 'NO_DAEMON')
  assert.equal(readyWaits.length, 0, 'unchanged behaviour for ops that are not bringing an agent up')
  assert.equal(misses.length, 0)
})

// ── 3. The expiry that knew everything and said nothing ───────────────────────
test('the spawn mailbox expiry line carries the state the server still holds', () => {
  const startedAt = Date.parse('2026-09-18T02:10:00.000Z')
  const line = spawnMailboxExpiryLine({
    id: 'mailbox:abc123',
    ownerId: 'fleet:55539f03',
    startedAt,
    meta: { name: 'hw3-writer', agentId: 'fleet:deadbeef', machineId: 'mini:testing', fresh: true, respawn: false },
  }, startedAt + 300_000)

  for (const fragment of [
    'hw3-writer',            // which spawn
    'fleet:deadbeef',        // the reserved shell row, so it can be found
    'mini:testing',          // the daemon that was asked
    'waited_ms=300000',      // how long, rather than "a timeout happened"
    'mailbox:abc123',
    'fleet:55539f03',        // who asked
    'observed_at=2026-09-18T02:15:00.000Z',
  ]) {
    assert.ok(line.includes(fragment), `the expiry line must name ${fragment}; got: ${line}`)
  }
  // Skip's ruling of 7/22 stands: this records, it does not convict.
  assert.match(line, /not a failure verdict/)
})
