// `model:` over a real socket against a real server.
//
// The filter resolves NOW — the author's present `metadata.model` — while the
// name beside it binds at each message's timestamp, so `from:X & model:muse`
// means X is muse today. That split is the whole hazard of this token: the
// tests pin which side each half reads.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { parseSearchQuery } from '../../shared/fleet-search-query.mjs'
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

function insertSessionEntry(store, { agentId, timestamp, text }) {
  store.db.prepare(
    'INSERT INTO session_entries (agent_id, session_id, role, timestamp, text) VALUES (?, ?, ?, ?, ?)',
  ).run(agentId, `session-${agentId}`, 'assistant', timestamp, text)
}

// Two writers on different models, one message each, plus a cross message
// whose RECIPIENT is the muse agent — the row that proves `model:` reads the
// sender and not the room.
async function seedModels(store) {
  await store.upsertAgent({ id: 'fleet:musewriter', friendly_name: 'musewriter', registered_at: '2026-09-20T00:00:00.000Z', metadata: { model: 'muse' } })
  await store.upsertAgent({ id: 'fleet:opuswriter', friendly_name: 'opuswriter', registered_at: '2026-09-20T00:00:00.000Z', metadata: { model: 'opus' } })
  await store.upsertAgent({ id: 'fleet:reader', friendly_name: 'reader', registered_at: '2026-09-20T00:00:00.000Z', metadata: { model: 'muse' } })
  // Each upsert above also writes a `register` event from the agent to
  // itself. Those are seed scaffolding, not fixture data — and they would
  // legitimately match `model:` by their sender — so the mixed-corpus test
  // below deletes them to keep its expected set about chat and sessions.
  store.db.prepare("DELETE FROM events WHERE type = 'register'").run()
  insertEvent(store, { timestamp: '2026-09-21T01:00:00.000Z', from: 'fleet:musewriter', to: 'fleet:reader', text: 'written on muse' })
  insertEvent(store, { timestamp: '2026-09-21T02:00:00.000Z', from: 'fleet:opuswriter', to: 'fleet:reader', text: 'written on opus' })
  insertEvent(store, { timestamp: '2026-09-21T03:00:00.000Z', from: 'fleet:opuswriter', to: 'fleet:musewriter', text: 'opus to muse' })
  insertSessionEntry(store, { agentId: 'fleet:musewriter', timestamp: '2026-09-21T04:00:00.000Z', text: 'muse session work' })
  insertSessionEntry(store, { agentId: 'fleet:opuswriter', timestamp: '2026-09-21T05:00:00.000Z', text: 'opus session work' })
}

// The spawned server serves TLS iff it can READ a cert pair — the
// TLDA_TLS_CERT/KEY env pair or ~/.config/tlda/localhost+2*.pem — and plain
// HTTP otherwise (see the TLS setup in unified-server). The socket scheme
// must agree with that decision: a wss:// client against a plain-HTTP
// server dies in EPROTO, which is what a hardcoded scheme does on a box
// with no pair.
function serverUsesTls() {
  try {
    readFileSync(process.env.TLDA_TLS_CERT || join(homedir(), '.config/tlda/localhost+2.pem'))
    readFileSync(process.env.TLDA_TLS_KEY || join(homedir(), '.config/tlda/localhost+2-key.pem'))
    return true
  } catch {
    return false
  }
}

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-model-filter-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  await seedModels(store)
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
    const scheme = serverUsesTls() ? 'wss' : 'ws'
    ws = new WebSocket(`${scheme}://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
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

// The query string travels the same path a caller sends it: through the
// shared parser into a filter expression, then over the socket.
function expressionOf(query) {
  const parsed = parseSearchQuery(query, {})
  assert.equal(parsed.query, '', `"${query}" must parse as a pure filter, not free text`)
  return parsed.filters.filterExpression
}

const EVENT_PAGE = { me: 'fleet:reader', query: '', eventTypes: ['chat'], eventOnly: true, historyOnly: true, limit: 50 }

test('`model:muse` over the wire returns the muse sender, not the muse recipient', async () => {
  await withServer(async ws => {
    const result = await request(ws, 'm1', 'fleet-search', { ...EVENT_PAGE, filterExpression: expressionOf('model:muse') })
    assert.deepEqual(textsOf(result), ['written on muse'])
    assert.deepEqual(result.unresolvedNames, [], 'a model value is not a name and must not be reported as an unresolved one')
  })
})

test('a model nobody runs returns nothing', async () => {
  await withServer(async ws => {
    const result = await request(ws, 'm2', 'fleet-search', { ...EVENT_PAGE, filterExpression: 'model:no-such-model' })
    assert.deepEqual(textsOf(result), [])
  })
})

test('`from:` and `model:` compose across their two moments', async () => {
  await withServer(async ws => {
    const match = await request(ws, 'm3', 'fleet-search', { ...EVENT_PAGE, filterExpression: 'from:opuswriter & model:opus' })
    assert.deepEqual(textsOf(match), ['opus to muse', 'written on opus'])
    const mismatch = await request(ws, 'm4', 'fleet-search', { ...EVENT_PAGE, filterExpression: 'from:opuswriter & model:muse' })
    assert.deepEqual(textsOf(mismatch), [], 'the sender is opus today, so the muse half excludes both rows')
  })
})

test('CONTROL: `from:` with `project:` is unchanged by the new token', async () => {
  await withServer(async ws => {
    // `project:tlda` rides the expression as `involving:project:tlda` and
    // names no agent here, so the conjunction is empty — the point is the
    // shape answers exactly as before, not the rows.
    const expr = parseSearchQuery('from:opuswriter & project:tlda', {}).filters.filterExpression
    assert.equal(expr, 'from: opuswriter & involving:project:tlda')
    const result = await request(ws, 'm5b', 'fleet-search', { ...EVENT_PAGE, filterExpression: expr })
    assert.deepEqual(textsOf(result), [])
  })
})

test('CONTROL: `from:` alone is unchanged by the new token', async () => {
  await withServer(async ws => {
    const result = await request(ws, 'm5', 'fleet-search', { ...EVENT_PAGE, filterExpression: 'from:opuswriter' })
    assert.deepEqual(textsOf(result), ['opus to muse', 'written on opus'])
  })
})

test('the value is exact and case-insensitive, like the roster token', async () => {
  await withServer(async ws => {
    const folded = await request(ws, 'm6', 'fleet-search', { ...EVENT_PAGE, filterExpression: 'model:MUSE' })
    assert.deepEqual(textsOf(folded), ['written on muse'])
    const prefix = await request(ws, 'm7', 'fleet-search', { ...EVENT_PAGE, filterExpression: 'model:mus' })
    assert.deepEqual(textsOf(prefix), [], 'a prefix is not the value')
  })
})

test('a session row matches by its owner, which is its author', async () => {
  await withServer(async ws => {
    const result = await request(ws, 'm8', 'fleet-search', {
      me: 'fleet:reader', query: '', historyOnly: true, limit: 50,
      filterExpression: 'model:muse',
    })
    assert.deepEqual(textsOf(result), ['muse session work', 'written on muse'])
  })
})
