import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import express from 'express'
import livekitRoutes from '../server/routes/livekit.mjs'

function withEnv(env, fn) {
  const previous = {}
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key]
    if (env[key] == null) delete process.env[key]
    else process.env[key] = env[key]
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key]
        else process.env[key] = value
      }
    })
}

async function withApp(fn) {
  const app = express()
  app.use(express.json())
  app.use('/api/livekit', livekitRoutes)
  const server = createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
    await once(server, 'close')
  }
}

test('LiveKit config and token route report missing server configuration', async () => {
  await withEnv({
    LIVEKIT_URL: null,
    LIVEKIT_WS_URL: null,
    LIVEKIT_API_KEY: null,
    LIVEKIT_API_SECRET: null,
  }, () => withApp(async (base) => {
    const config = await fetch(`${base}/api/livekit/config`).then(r => r.json())
    assert.deepEqual(config, { configured: false, url: '' })

    const resp = await fetch(`${base}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: 'Doc With Spaces', session: 'Main Session' }),
    })
    assert.equal(resp.status, 503)
    const body = await resp.json()
    assert.equal(body.error, 'LiveKit is not configured')
    assert.deepEqual(body.required, ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'])
  }))
})

test('LiveKit token route scopes a signed token to sanitized doc/session room', async () => {
  await withEnv({
    LIVEKIT_URL: 'wss://livekit.example.test',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecret',
  }, () => withApp(async (base) => {
    const config = await fetch(`${base}/api/livekit/config`).then(r => r.json())
    assert.deepEqual(config, { configured: true, url: 'wss://livekit.example.test' })

    const resp = await fetch(`${base}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc: 'LiveKit Room Audio Test',
        session: 'Doc Live',
        identity: 'Agent @ Device',
        name: 'Agent Name',
      }),
    })
    assert.equal(resp.status, 200)
    const body = await resp.json()
    assert.equal(body.url, 'wss://livekit.example.test')
    assert.equal(body.room, 'tlda-livekit-room-audio-test-doc-live')
    assert.equal(typeof body.token, 'string')
    assert.equal(body.token.split('.').length, 3)
  }))
})
