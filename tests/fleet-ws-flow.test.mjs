import assert from 'node:assert/strict'
import test from 'node:test'
import { clearTrustedHeartbeatProbes, shouldSkipHeartbeatSweepForLag, shouldTerminateForMissedPong, socketCanAcceptMore } from '../shared/fleet-ws-flow.mjs'

test('missed-pong termination requires an unanswered trusted ping', () => {
  const interval = 30_000
  const pingAt = 1_000_000
  assert.equal(shouldTerminateForMissedPong(pingAt - 1, 0, pingAt + interval * 10, interval), false)
  assert.equal(shouldTerminateForMissedPong(pingAt, pingAt, pingAt + interval, interval), false)
  assert.equal(shouldTerminateForMissedPong(pingAt - 1, pingAt, pingAt + interval - 1, interval), false)
  assert.equal(shouldTerminateForMissedPong(pingAt - 1, pingAt, pingAt + interval, interval), true)
})

test('heartbeat sweep tolerates ordinary Fly event-loop lag', () => {
  assert.equal(shouldSkipHeartbeatSweepForLag(750), false)
  assert.equal(shouldSkipHeartbeatSweepForLag(999), false)
  assert.equal(shouldSkipHeartbeatSweepForLag(1000), true)
  assert.equal(shouldSkipHeartbeatSweepForLag(4700), true)
})

test('heartbeat sweep skips briefly after a lag spike', () => {
  const now = 1_000_000
  assert.equal(shouldSkipHeartbeatSweepForLag(0, 1000, now - 59_000, now, 60_000), true)
  assert.equal(shouldSkipHeartbeatSweepForLag(0, 1000, now - 61_000, now, 60_000), false)
})

test('heartbeat sweep treats timer delay as server lag', () => {
  const now = 1_000_000
  assert.equal(shouldSkipHeartbeatSweepForLag(0, 1000, 0, now, 60_000, 999), false)
  assert.equal(shouldSkipHeartbeatSweepForLag(0, 1000, 0, now, 60_000, 1000), true)
  assert.equal(shouldSkipHeartbeatSweepForLag(0, 1000, 0, now, 60_000, 2701), true)
})

test('lagged sweep clears stale probes instead of mass-terminating sockets', () => {
  const interval = 30_000
  const now = 1_000_000
  const sockets = Array.from({ length: 25 }, () => ({
    _wsLastPongAt: now - interval * 3,
    _wsLastPingAt: now - interval * 2,
  }))

  assert.equal(
    sockets.filter(ws => shouldTerminateForMissedPong(ws._wsLastPongAt, ws._wsLastPingAt, now, interval)).length,
    25,
  )
  clearTrustedHeartbeatProbes(sockets)
  assert.equal(
    sockets.filter(ws => shouldTerminateForMissedPong(ws._wsLastPongAt, ws._wsLastPingAt, now, interval)).length,
    0,
  )
})

test('backpressure defers queued sends until the socket buffer drains', () => {
  const ws = { readyState: 1, bufferedAmount: 512 * 1024 }
  assert.equal(socketCanAcceptMore(ws), false)
  ws.bufferedAmount = 0
  assert.equal(socketCanAcceptMore(ws), true)
  ws.readyState = 3
  assert.equal(socketCanAcceptMore(ws), false)
})
