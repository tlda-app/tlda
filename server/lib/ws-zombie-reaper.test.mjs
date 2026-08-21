import test from 'node:test'
import assert from 'node:assert/strict'
import { reapZombieSockets } from './ws-zombie-reaper.mjs'

function socket({ idle = true } = {}) {
  return {
    readyState: 1,
    _wsLastInputAt: idle ? 0 : 10_000,
    _wsRemoteAddr: '127.0.0.1',
    _wsRemotePort: 1234,
    terminated: 0,
    terminate() { this.terminated++ },
  }
}

test('an absent zombie process is dropped once and not retried', async () => {
  const stale = socket()
  const live = socket({ idle: false })
  const trackedWs = new Set([stale, live])
  let kills = 0
  const sweep = () => reapZombieSockets({
    trackedWs,
    now: 10_001,
    thresholdMs: 1_000,
    findMachine: () => 'daemon',
    killOrphan: async () => { kills++; return { killed: false, reason: 'no process holds port 1234' } },
  })

  assert.deepEqual(await sweep(), { activeCount: 1, zombieCount: 1 })
  assert.deepEqual(await sweep(), { activeCount: 1, zombieCount: 0 })
  assert.equal(kills, 1)
  assert.equal(stale.terminated, 1)
  assert.equal(live.terminated, 0)
  assert.equal(trackedWs.has(live), true)
})

test('a large sweep yields to request work and bounds kill concurrency', async () => {
  const trackedWs = new Set(Array.from({ length: 100 }, () => socket()))
  let inFlight = 0
  let maxInFlight = 0
  let routeRan = false
  const route = new Promise(resolve => setImmediate(() => { routeRan = true; resolve() }))
  const sweep = reapZombieSockets({
    trackedWs,
    now: 10_001,
    thresholdMs: 1_000,
    concurrency: 4,
    findMachine: () => 'daemon',
    killOrphan: async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setImmediate(resolve))
      inFlight--
      return { killed: false, reason: 'no process holds port 1234' }
    },
  })

  await route
  assert.equal(routeRan, true)
  assert.equal(trackedWs.size, 100)
  await sweep
  assert.equal(maxInFlight, 4)
  assert.equal(trackedWs.size, 0)
})
