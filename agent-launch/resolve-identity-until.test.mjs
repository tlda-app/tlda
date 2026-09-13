import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveIdentityUntil } from './resolve-identity-until.mjs'

// A deterministic clock: `sleep` advances it, so the deadline arithmetic is
// exercised without the test taking any real time.
function clock() {
  const sleeps = []
  let time = 0
  return {
    sleeps,
    now: () => time,
    sleep: async ms => { sleeps.push(ms); time += ms },
  }
}

test('it returns the identity as soon as one appears', async () => {
  const { now, sleep, sleeps } = clock()
  let calls = 0
  const found = { sessionId: 'session-a', jsonlPath: '/s/a.jsonl' }
  const live = await resolveIdentityUntil({
    resolve: async () => (++calls < 3 ? null : found),
    deadlineMs: 500, intervalMs: 100, now, sleep,
  })
  assert.deepEqual(live, found)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [100, 100])
})

// The daemon passes `processOwnedOnly`, `agent`, `tmuxSession` and friends.
// They must reach the adapter untouched -- codex honours processOwnedOnly, the
// others ignore the extra keys.
test('everything that is not a control option is handed to the resolver', async () => {
  let seen = null
  await resolveIdentityUntil({
    resolve: async options => { seen = options; return { sessionId: 'x' } },
    deadlineMs: 100,
    agent: { id: 'fleet:1' },
    tmuxSession: 'fleet-a',
    processOwnedOnly: true,
  })
  assert.deepEqual(seen, { agent: { id: 'fleet:1' }, tmuxSession: 'fleet-a', processOwnedOnly: true })
  assert.equal('deadlineMs' in seen, false, 'control options must not leak into the resolver call')
  assert.equal('resolve' in seen, false)
})

// SEMANTIC 1. Without this the daemon polls a dead process for the whole
// deadline while holding the mint's commit.
test('a dead process stops the poll before the resolver is called again', async () => {
  const { now, sleep } = clock()
  let calls = 0
  let alive = true
  const live = await resolveIdentityUntil({
    resolve: async () => { calls++; alive = false; return null },
    isProcessAlive: async () => alive,
    deadlineMs: 10_000, intervalMs: 100, now, sleep,
  })
  assert.equal(live, null)
  assert.equal(calls, 1, 'the liveness check runs before each attempt, so the second never happens')
})

test('a process already dead is never polled at all', async () => {
  let calls = 0
  const live = await resolveIdentityUntil({
    resolve: async () => { calls++; return { sessionId: 'x' } },
    isProcessAlive: async () => false,
    deadlineMs: 10_000,
  })
  assert.equal(live, null)
  assert.equal(calls, 0)
})

// SEMANTIC 2. The last sleep is clamped to what remains, so the final attempt
// lands at the deadline rather than past it.
test('it gives up at the deadline, and the last wait does not overshoot it', async () => {
  const { now, sleep, sleeps } = clock()
  let calls = 0
  const live = await resolveIdentityUntil({
    resolve: async () => { calls++; return null },
    deadlineMs: 250, intervalMs: 100, now, sleep,
  })
  assert.equal(live, null)
  assert.deepEqual(sleeps, [100, 100, 50], 'the third wait is clamped from 100 to the remaining 50')
  assert.equal(calls, 4)
  assert.equal(now(), 250, 'and it stops exactly at the deadline, never beyond')
})

test('a zero deadline still gets one attempt', async () => {
  let calls = 0
  const live = await resolveIdentityUntil({ resolve: async () => { calls++; return null }, deadlineMs: 0 })
  assert.equal(live, null)
  assert.equal(calls, 1, 'one attempt, then the remaining time is <= 0')
})

test('a missing resolver is an error, not a silent null', async () => {
  // The failure this whole change exists to prevent is a resolver that never
  // runs and looks identical to one that found nothing. Returning null for a
  // missing resolver would rebuild exactly that.
  await assert.rejects(() => resolveIdentityUntil({ deadlineMs: 10 }), /requires a resolver function/)
})
