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

async function searchWire(port, rawQuery, { limit = 50, as = {}, me = 'fleet:caller' } = {}) {
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
      limit,
      me,
      // `as` is how the caller says which VIEW it is. `search` sends nothing
      // extra; `thread` sends historyOnly/eventOnly. Skip's rule is that the
      // two are renderings of one query, so the difference has to stop at
      // presentation — which is only checkable by sending both.
      ...as,
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

test('a one-sided filter spends its limit on matching rows, not on the traffic around them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-search-limit-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  try {
    for (const [id, friendlyName] of [
      ['fleet:chief', 'chiefsoso'],
      ['fleet:skip', 'skip'],
    ]) {
      await store.upsertAgent({ id, friendly_name: friendlyName, dead: false, human: id === 'fleet:skip' })
    }
    // Skip says one thing, then the agent answers thirty times. Every row here
    // involves Skip, so the id prefilter keeps all of them; only the first is
    // FROM him. Ask for ten and the newest ten are all replies — which is the
    // shape of the real failure: `search(query: "from:skip", since: "1d",
    // limit: 100)` came back with 75 rows out of one 28-minute conversation and
    // nothing he had said to anyone else that day.
    insertEvent(store, { type: 'chat', timestamp: '2026-08-14T10:00:00.000Z', from: 'fleet:skip', to: 'fleet:chief', text: 'the thing skip said' })
    for (let i = 1; i <= 30; i++) {
      insertEvent(store, {
        type: 'chat',
        timestamp: `2026-08-14T10:${String(i).padStart(2, '0')}:00.000Z`,
        from: 'fleet:chief',
        to: 'fleet:skip',
        text: `reply ${i}`,
      })
    }
    // `search` reads session transcript rows too and `thread` does not, so
    // these are what made the two views disagree: newer than the conversation,
    // owned by a participant, and discarded by the filter after the page had
    // already been spent on them. Measured live at limit 20, `me <>
    // chief-night` returned 1 of the 2 messages in it.
    const session = store.db.prepare(`
      INSERT INTO session_entries (agent_id, session_id, role, timestamp, text)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (let i = 1; i <= 30; i++) {
      session.run('fleet:chief', 'session-1', 'assistant', `2026-08-14T11:${String(i).padStart(2, '0')}:00.000Z`, `transcript line ${i}`)
    }
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
    const result = await searchWire(port, 'from:skip', { limit: 10 })
    const texts = result.results.map(row => row.text)
    assert.ok(texts.includes('the thing skip said'), `page of 10 lost the one message from him: ${JSON.stringify(texts)}`)
    assert.deepEqual(texts.filter(t => t.startsWith('reply ')), [], 'replies are not from him and must not occupy the page')

    // "thread filter is supposed to be like another view on search results;
    // same query." One expression, one page size, the two views' parameters —
    // the same event ids or they have come apart again.
    const ids = (rows) => rows.map(row => row.id).sort((a, b) => a - b)
    const asSearch = await searchWire(port, 'me <> chiefsoso', { limit: 5, me: 'fleet:skip' })
    const asThread = await searchWire(port, 'me <> chiefsoso', {
      limit: 5,
      me: 'fleet:skip',
      as: { historyOnly: true, eventOnly: true },
    })
    assert.deepEqual(ids(asThread.results), ids(asSearch.results))
    assert.equal(asSearch.results.length, 5)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
