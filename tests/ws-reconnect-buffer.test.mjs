import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { ResilientWS, startWsRequest, WsReconnectBuffer } from '../shared/fleet-transport.mjs'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error('timed out waiting for condition')
}

async function listen(port = 0, received = []) {
  const server = new WebSocketServer({ port })
  await new Promise(resolve => server.once('listening', resolve))
  server.on('connection', ws => {
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString())
      received.push(msg)
      ws.send(JSON.stringify({ id: msg.id, result: { ok: true, echo: msg.type } }))
    })
  })
  return server
}

async function closeServer(server) {
  for (const client of server.clients) {
    try { client.close() } catch {}
  }
  await new Promise(resolve => server.close(resolve))
}

test('buffers an unsent request through a real close and delivers on reconnect', async () => {
  const received = []
  let server = await listen(0, received)
  const port = server.address().port
  const logs = []
  const pending = new Map()
  let rws
  const buffer = new WsReconnectBuffer({ isConnected: () => !!rws?.connected })

  rws = new ResilientWS({
    url: () => `ws://127.0.0.1:${port}`,
    label: 'buffer-test',
    initialBackoffMs: 50,
    maxBackoffMs: 50,
    log: s => logs.push(s),
    onOpen: () => buffer.resolveConnected(),
    onMessage: msg => {
      const p = pending.get(msg.id)
      if (!p) return
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result)
    },
  })
  rws.connect()
  await waitFor(() => rws.connected)

  await closeServer(server)
  await waitFor(() => !rws.connected)

  async function sendBuffered(type, params = {}, deadlineMs = 2000) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < deadlineMs) {
      if (rws.connected) {
        const id = crypto.randomUUID()
        return startWsRequest({
          pending,
          id,
          type,
          deadlineMs,
          send: () => rws.send({ id, type, ...params }),
        })
      }
      const remaining = deadlineMs - (Date.now() - startedAt)
      const connected = await buffer.waitForConnection(Math.min(remaining, 500))
      if (!connected && !rws.connected) break
    }
    return null
  }

  const promise = sendBuffered('chat', { message: 'held during drop' })
  await sleep(150)
  assert.equal(received.length, 0, 'request is not lost or sent while disconnected')

  server = await listen(port, received)
  const result = await promise

  assert.deepEqual(result, { ok: true, echo: 'chat' })
  assert.equal(received.length, 1)
  assert.equal(received[0].message, 'held during drop')

  rws.close()
  await closeServer(server)
})
