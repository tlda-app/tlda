// `from:chief` over a real socket against a real server.
//
// The store answers correctly on its own — `fleet-store-lexical-name-search`
// holds that — but the `fleet-search` handler is where a name is resolved and
// where the post-filter decides what survives, and it is assembled field by
// field: a span that the handler resolves and then does not pass on is dropped
// in silence, with both ends still reading correctly on their own. So this is
// the whole path, from the query string to the rows.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from './fleet-store.mjs'
import { removeTempDir } from './test-support/remove-temp-dir.mjs'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', c => { output += c })
  child.stderr.on('data', c => { output += c })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

function request(ws, id, type, payload) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error)); else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type, ...payload }))
  })
}

const HOUR = 60 * 60 * 1000

function insertEvent(store, { timestamp, from, to, text }) {
  const info = store.db.prepare(
    "INSERT INTO events (type, timestamp, from_id, text) VALUES ('chat', ?, ?, ?)",
  ).run(timestamp, from, text)
  for (const agentId of (Array.isArray(to) ? to : [to]).filter(Boolean)) {
    store.db.prepare(
      'INSERT OR IGNORE INTO recipients (event_id, agent_id, timestamp, read) VALUES (?, ?, ?, 0)',
    ).run(info.lastInsertRowid, agentId, timestamp)
  }
}

function shift(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString()
}

// Two agents hold `chief` in turn, and each says one thing while it holds the
// name and one thing while it does not. Four messages, of which `from:chief`
// means exactly two.
async function seedHandoff(store) {
  await store.upsertAgent({ id: 'fleet:first', friendly_name: 'chief', registered_at: '2026-08-18T00:00:00.000Z' })
  await store.upsertAgent({ id: 'fleet:first', friendly_name: 'retired-chief' })
  await store.upsertAgent({ id: 'fleet:second', friendly_name: 'chief' })
  await store.upsertAgent({ id: 'fleet:reader', friendly_name: 'reader', registered_at: '2026-08-18T00:00:00.000Z' })

  const spanOf = (id) => store.db.prepare(
    "SELECT from_ts, to_ts FROM name_history WHERE fleet_id = ? AND friendly_name = 'chief'",
  ).get(id)
  const first = spanOf('fleet:first')
  const second = spanOf('fleet:second')

  insertEvent(store, { timestamp: shift(first.to_ts, -HOUR), from: 'fleet:first', to: 'fleet:reader', text: 'ruling while chief' })
  insertEvent(store, { timestamp: shift(first.to_ts, HOUR), from: 'fleet:first', to: 'fleet:reader', text: 'ruling after standing down' })
  insertEvent(store, { timestamp: shift(second.from_ts, HOUR), from: 'fleet:second', to: 'fleet:reader', text: 'ruling as the new chief' })
  insertEvent(store, { timestamp: shift(second.from_ts, -2 * HOUR), from: 'fleet:second', to: 'fleet:reader', text: 'ruling before taking the seat' })
}

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-lexical-name-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  await seedHandoff(store)
  await store.close()
  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), PROJECTS_DIR: join(dir, 'projects'),
      TLDA_FLEET_DB: dbPath, TLDA_DEV_SERVER: '1', TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let ws
  try {
    await waitForServer(child)
    ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    await fn(ws)
  } finally {
    ws?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    removeTempDir(dir)
  }
}

function textsOf(result) {
  return (result?.results || []).map(row => row.text).sort()
}

test('`from:chief` over the wire returns each holder from its own period', async () => {
  await withServer(async ws => {
    const result = await request(ws, 's1', 'fleet-search', {
      me: 'fleet:reader',
      query: '',
      filterExpression: 'from: chief',
      eventTypes: ['chat'],
      eventOnly: true,
      historyOnly: true,
      limit: 50,
    })
    assert.deepEqual(
      textsOf(result),
      ['ruling as the new chief', 'ruling while chief'],
      'the name is bound at each message\'s own timestamp, so neither holder answers for the other\'s period',
    )
  })
})

test('an id over the wire reaches its agent at every instant', async () => {
  await withServer(async ws => {
    const result = await request(ws, 's2', 'fleet-search', {
      me: 'fleet:reader',
      query: '',
      filterExpression: 'from: fleet:first',
      eventTypes: ['chat'],
      eventOnly: true,
      historyOnly: true,
      limit: 50,
    })
    assert.deepEqual(
      textsOf(result),
      ['ruling after standing down', 'ruling while chief'],
      'an id is unconditional — both of that agent\'s messages, whatever it was called',
    )
  })
})

// The path with no filter expression: a bare name in the box. It resolves
// through `agentQuery`/`naturalAgentQuery` rather than through the compiled
// predicate, and it has to answer the same question the same way — otherwise
// which answer you get depends on how you phrased it.
test('a bare name over the wire is lexical too', async () => {
  await withServer(async ws => {
    const result = await request(ws, 's3', 'fleet-search', {
      me: 'fleet:reader',
      query: '',
      agentQuery: 'chief',
      eventTypes: ['chat'],
      eventOnly: true,
      historyOnly: true,
      limit: 50,
    })
    assert.deepEqual(
      textsOf(result),
      ['ruling as the new chief', 'ruling while chief'],
      'the bare-name path must bind at the row\'s timestamp like `from:` does',
    )
  })
})

test('a name nobody has held is reported, not answered with an empty world', async () => {
  await withServer(async ws => {
    const result = await request(ws, 's4', 'fleet-search', {
      me: 'fleet:reader',
      query: '',
      filterExpression: 'from: nobody-at-all',
      eventTypes: ['chat'],
      eventOnly: true,
      historyOnly: true,
      limit: 50,
    })
    assert.deepEqual(textsOf(result), [])
    assert.deepEqual(result.unresolvedNames, ['nobody-at-all'])
  })
})
