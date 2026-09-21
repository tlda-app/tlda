import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createClientLogHandler } from '../server/lib/client-log-sink.mjs'

test('the client-log endpoint forwards doc-fault and doc-capability entries to the runtime-card fan-in', async () => {
  const received = []
  const app = express()
  app.use(express.json())
  app.post('/api/log', createClientLogHandler({
    clientLogFile: '/unused/client.log',
    append: async () => {},
    recordRuntimeError: entry => received.push(entry),
  }))
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/log`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { ns: 'doc-fault', msg: 'boom', data: { url: '/docs/book/ch1.html' } },
        { ns: 'doc-capability', msg: 'failed math', data: { broken: ['math'], url: '/docs/book/ch1.html' } },
      ]),
    })
    assert.equal(response.ok, true)
    assert.deepEqual(received.map(entry => entry.ns), ['doc-fault', 'doc-capability'])
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
