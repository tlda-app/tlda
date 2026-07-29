import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from './fleet-store.mjs'
import { FleetStoreClient } from './fleet-store-client.mjs'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function fleetSearchOverWebSocket(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const result = new Promise((resolve, reject) => {
    ws.on('message', raw => {
      const message = JSON.parse(String(raw))
      if (message.id !== 1) return
      if (message.error) reject(new Error(message.error))
      else resolve(message.result)
    })
  })
  ws.send(JSON.stringify({
    id: 1,
    type: 'fleet-search',
    query: 'common search corpus',
    limit: 50,
    me: 'fleet:test',
  }))
  return { ws, result }
}

async function fetchHealth(port) {
  return new Promise((resolve, reject) => {
    const request = httpsGet({
      hostname: '127.0.0.1',
      port,
      path: '/health',
      rejectUnauthorized: false,
    }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    request.once('error', reject)
  })
}

test('getAllAgents applies the same runtime projection as getAgent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-store-runtime-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  await store.upsertAgent({
    id: 'fleet:test',
    friendly_name: 'runtime-projection-test',
    dead: false,
    human: false,
  })
  store.close()

  const client = new FleetStoreClient(dbPath, { taskDoc: false })
  try {
    await client.ready()
    client.setRuntimeProjector(() => ({ kind: 'ai', status: 'awake' }))
    const one = await client.getAgent('fleet:test')
    const all = await client.getAllAgents()
    assert.deepEqual(one.runtime_status, { kind: 'ai', status: 'awake' })
    assert.deepEqual(all.find(agent => agent.id === 'fleet:test')?.runtime_status, { kind: 'ai', status: 'awake' })
  } finally {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a deliberately slow FTS query does not block the server event loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-store-worker-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  const insert = store.db.prepare(`
    INSERT INTO events (type, timestamp, from_id, to_id, text)
    VALUES ('chat', ?, 'fleet:test', 'fleet:owner', ?)
  `)
  const commonText = `needle ${'common search corpus '.repeat(20)}`
  store.db.transaction(() => {
    for (let i = 0; i < 50; i += 1) {
      insert.run(new Date(1_700_000_000_000 + i).toISOString(), `${commonText} row-${i}`)
    }
  })()
  store.close()

  const client = new FleetStoreClient(dbPath, { taskDoc: false })
  await client.ready()
  let ticks = 0
  let maxGapMs = 0
  let lastTick = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    maxGapMs = Math.max(maxGapMs, now - lastTick)
    lastTick = now
    ticks += 1
  }, 5)

  const started = performance.now()
  const results = await client.searchAll('common search corpus', { limit: 50 })
  const queryMs = performance.now() - started
  clearInterval(timer)
  await client.close()

  assert.equal(results.length, 50)
  assert.ok(queryMs >= 5, `query must overlap multiple server-loop turns; observed ${queryMs.toFixed(1)}ms`)
  assert.ok(ticks >= 3, `server loop did not keep ticking during ${queryMs.toFixed(1)}ms query`)
  assert.ok(maxGapMs < queryMs / 2, `server loop gap ${maxGapMs.toFixed(1)}ms approached query duration ${queryMs.toFixed(1)}ms`)

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: join(dir, 'projects'),
      TLDA_FLEET_DB: dbPath,
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForServer(child)
    const search = await fleetSearchOverWebSocket(port)
    await new Promise(resolve => setTimeout(resolve, 20))
    const httpStarted = performance.now()
    const httpStatus = await fetchHealth(port)
    const httpMs = performance.now() - httpStarted
    const wsResult = await search.result
    search.ws.close()
    assert.equal(httpStatus, 200)
    assert.equal(wsResult.results.length, 50)
    assert.ok(httpMs < 1_000, `unrelated HTTP took ${httpMs.toFixed(1)}ms during FTS query`)
    console.log(`off-loop proof: client-query=${queryMs.toFixed(1)}ms ticks=${ticks} max-gap=${maxGapMs.toFixed(1)}ms http-during-ws-search=${httpMs.toFixed(1)}ms`)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
