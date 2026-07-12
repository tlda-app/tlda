import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { ResilientWS } from '../shared/resilient-ws.mjs'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

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

test('heartbeat reconnect runs close cleanup once for one socket loss', async () => {
  const server = new WebSocketServer({ port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const port = server.address().port
  let closeCount = 0
  const ws = new ResilientWS({
    url: () => `ws://127.0.0.1:${port}`,
    label: 'heartbeat-test',
    heartbeatTimeoutMs: 30,
    initialBackoffMs: 1000,
    maxBackoffMs: 1000,
    random: () => 0,
    onMessage: () => {},
    onClose: () => { closeCount++ },
    log: () => {},
  })

  ws.connect()
  while (!ws.connected) await sleep(5)
  await sleep(120)

  assert.equal(closeCount, 1)
  ws.close()
  await new Promise(resolve => server.close(resolve))
})
