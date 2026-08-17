import test from 'node:test'
import assert from 'node:assert/strict'
import { coalesceInflight } from './inflight-coalesce.mjs'

// Regression for the 2026-08-17 spawn-duplication bug: a spawn request whose
// client-side wait timed out got retried under the SAME operation_id by the
// client's durable-send outbox while the first spawn was still running.
// Nothing marked "in flight", so the retry ran a second, independent spawn
// for the same name, which collided and got name-rotated into a spurious
// duplicate agent.

test('two concurrent calls with the same key run the underlying work once', async () => {
  let runs = 0
  const map = new Map()
  const run = () => {
    runs += 1
    return new Promise(resolve => setTimeout(() => resolve({ runs }), 20))
  }

  const [a, b] = await Promise.all([
    coalesceInflight(map, 'op-1', run),
    coalesceInflight(map, 'op-1', run),
  ])

  assert.equal(runs, 1)
  assert.equal(a, b)
  assert.deepEqual(a, { runs: 1 })
})

test('calls with different keys run independently', async () => {
  let runs = 0
  const map = new Map()
  const run = () => { runs += 1; return Promise.resolve(runs) }

  const [a, b] = await Promise.all([
    coalesceInflight(map, 'op-1', run),
    coalesceInflight(map, 'op-2', run),
  ])

  assert.equal(runs, 2)
  assert.notEqual(a, b)
})

test('the map entry clears after settling, so a later retry for the same key runs fresh work', async () => {
  let runs = 0
  const map = new Map()
  const run = () => { runs += 1; return Promise.resolve(runs) }

  const first = await coalesceInflight(map, 'op-1', run)
  // The map's cleanup runs in a .finally() chained onto the same settled
  // promise this awaited, so it may not have run yet on this exact tick --
  // give it one to land before relying on the map being clear.
  await Promise.resolve()
  assert.equal(map.has('op-1'), false)
  const second = await coalesceInflight(map, 'op-1', run)

  assert.equal(first, 1)
  assert.equal(second, 2)
  assert.equal(runs, 2)
})

test('a falsy key bypasses coalescing entirely (matches spawn calls with no operation_id)', async () => {
  let runs = 0
  const map = new Map()
  const run = () => { runs += 1; return Promise.resolve(runs) }

  const [a, b] = await Promise.all([
    coalesceInflight(map, null, run),
    coalesceInflight(map, null, run),
  ])

  assert.equal(runs, 2)
  assert.equal(map.size, 0)
})

test('the map entry clears even when the underlying work rejects', async () => {
  const map = new Map()
  const run = () => Promise.reject(new Error('spawn failed'))

  await assert.rejects(() => coalesceInflight(map, 'op-1', run), /spawn failed/)
  assert.equal(map.has('op-1'), false)
})
