import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldSkipHeartbeatSweepForLag, shouldTerminateForMissedPong, socketCanAcceptMore } from '../shared/fleet-ws-flow.mjs'

test('lagged-but-alive pong is not terminated until strictly after two intervals', () => {
  const interval = 30_000
  const pongAt = 1_000_000
  // A lagged server sweep does not manufacture a missed pong: the real pong
  // timestamp remains within the two-interval deadline.
  assert.equal(shouldTerminateForMissedPong(pongAt, pongAt + interval * 2, interval), false)
  assert.equal(shouldTerminateForMissedPong(pongAt, pongAt + interval * 2 + 1, interval), true)
})

test('heartbeat sweep tolerates ordinary Fly event-loop lag', () => {
  assert.equal(shouldSkipHeartbeatSweepForLag(750), false)
  assert.equal(shouldSkipHeartbeatSweepForLag(4999), false)
  assert.equal(shouldSkipHeartbeatSweepForLag(5000), true)
})

test('backpressure defers queued sends until the socket buffer drains', () => {
  const ws = { readyState: 1, bufferedAmount: 512 * 1024 }
  assert.equal(socketCanAcceptMore(ws), false)
  ws.bufferedAmount = 0
  assert.equal(socketCanAcceptMore(ws), true)
  ws.readyState = 3
  assert.equal(socketCanAcceptMore(ws), false)
})
