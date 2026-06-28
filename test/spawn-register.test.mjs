import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { markAgentDead } from '../bin/lib/spawn/register.mjs'

test('markAgentDead posts to the server dead-marker route', async () => {
  let seen = null
  const server = http.createServer((req, res) => {
    seen = { method: req.method, url: req.url }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const result = await markAgentDead('fleet:test/dead', { api: `http://127.0.0.1:${port}` })
    assert.deepEqual(result, { ok: true })
    assert.equal(seen.method, 'POST')
    assert.equal(seen.url, '/api/agents/fleet%3Atest%2Fdead/mark-dead')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
