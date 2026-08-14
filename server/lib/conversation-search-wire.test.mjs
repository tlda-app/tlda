import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { buildFleetSearchFilters, parseSearchQuery } from '../../shared/fleet-search-query.mjs'
import { FleetStore } from './fleet-store.mjs'

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

function insertEvent(store, { type, timestamp, from = null, to, text, agentId = null }) {
  const event = store.db.prepare(`
    INSERT INTO events (type, timestamp, from_id, text, agent_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(type, timestamp, from, text, agentId)
  for (const recipient of (Array.isArray(to) ? to : [to]).filter(Boolean)) {
    store.db.prepare(`
      INSERT INTO recipients (event_id, agent_id, timestamp, read)
      VALUES (?, ?, ?, 0)
    `).run(event.lastInsertRowid, recipient, timestamp)
  }
}

async function searchWire(port, rawQuery) {
  const parsed = parseSearchQuery(rawQuery)
  const filters = buildFleetSearchFilters(parsed.filters)
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  try {
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
      query: parsed.query,
      filterExpression: filters.filterExpression,
      limit: 50,
      me: 'fleet:caller',
    }))
    return await result
  } finally {
    ws.close()
  }
}

test('A <> B search wire returns only messages actually sent between A and B', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-conversation-search-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  try {
    for (const [id, friendlyName] of [
      ['fleet:chief', 'chiefsoso'],
      ['fleet:skip', 'skip'],
      ['fleet:worker', 'unrelated-worker'],
    ]) {
      await store.upsertAgent({ id, friendly_name: friendlyName, dead: false, human: id === 'fleet:skip' })
    }
    insertEvent(store, { type: 'chat', timestamp: '2026-08-14T10:00:00.000Z', from: 'fleet:chief', to: 'fleet:skip', text: 'chief to skip' })
    insertEvent(store, { type: 'chat', timestamp: '2026-08-14T10:01:00.000Z', from: 'fleet:skip', to: 'fleet:chief', text: 'skip to chief' })
    insertEvent(store, {
      type: 'report',
      timestamp: '2026-08-14T10:02:00.000Z',
      from: null,
      to: 'fleet:skip',
      agentId: 'fleet:chief',
      text: 'unrelated worker task report attributed to the task owner',
    })
  } finally {
    store.close()
  }

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
    const result = await searchWire(port, 'chiefsoso <> skip')
    assert.deepEqual(result.results.map(row => row.text).sort(), ['chief to skip', 'skip to chief'])
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
