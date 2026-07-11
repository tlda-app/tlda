import assert from 'node:assert/strict'
import test from 'node:test'
import { ResilientWS } from '../shared/resilient-ws.mjs'

test('reconnect ramp is exponential, capped, and jittered', () => {
  const logs = []
  const ws = new ResilientWS({
    url: () => 'ws://127.0.0.1:1', label: 'test', onMessage: () => {},
    initialBackoffMs: 1000, maxBackoffMs: 8000, random: () => 0,
    log: line => logs.push(line),
  })
  ws._scheduleRetry(); ws._retryTimer && clearTimeout(ws._retryTimer); ws._retryTimer = null
  ws._scheduleRetry(); ws._retryTimer && clearTimeout(ws._retryTimer); ws._retryTimer = null
  ws._scheduleRetry(); ws._retryTimer && clearTimeout(ws._retryTimer); ws._retryTimer = null
  assert.deepEqual(logs, [
    '[test] reconnecting in 500ms',
    '[test] reconnecting in 1000ms',
    '[test] reconnecting in 2000ms',
  ])
  assert.equal(ws._backoff, 8000)
  ws.close()
})
