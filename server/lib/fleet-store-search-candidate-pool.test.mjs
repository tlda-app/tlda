// Candidate-pool cut + deferred snippet (search small-tier fix 1).
//
// Text search used to hydrate limit*100 rows per branch with an inline
// snippet() per row, then keep `limit`. It now ranks a limit*10 pool and
// attaches snippets to the surviving page only. These tests pin what that
// change must not alter: snippets still highlight the match, pages still fill,
// expression narrowing still applies, and both text return sites (eventOnly
// and the unified return) carry snippets.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

function storeWith(events, sessions = []) {
  const dir = mkdtempSync(join(tmpdir(), 'search-pool-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  const insertEvent = store.db.prepare(
    "INSERT INTO events (id, type, timestamp, from_id, text) VALUES (?, 'chat', ?, ?, ?)"
  )
  events.forEach(([id, timestamp, from, text], i) =>
    insertEvent.run(id ?? 1000 + i, timestamp, from, text))
  const insertSession = store.db.prepare(
    'INSERT INTO session_entries (agent_id, session_id, role, timestamp, text) VALUES (?, ?, ?, ?, ?)'
  )
  for (const [agent, session, role, timestamp, text] of sessions) {
    insertSession.run(agent, session, role, timestamp, text)
  }
  return { store, cleanup: () => { store.close?.(); rmSync(dir, { recursive: true, force: true }) } }
}

const T = n => `2026-08-20T00:00:${String(n).padStart(2, '0')}.000Z`

test('a text page carries snippets that highlight the matched term', async () => {
  const events = []
  for (let i = 0; i < 25; i++) events.push([null, T(i), 'fleet:a', `quarry stone sample number ${i}`])
  const { store, cleanup } = storeWith(events)
  try {
    const rows = await store.searchAll('quarry', { limit: 20 })
    assert.equal(rows.length, 20, 'the page must fill, not starve under the smaller pool')
    for (const row of rows) {
      assert.ok(row.snippet && row.snippet.includes('⟨⟨quarry⟩⟩'),
        `each survivor carries a highlighted snippet, got: ${row.snippet}`)
    }
  } finally { cleanup() }
})

test('session rows on the page carry snippets too', async () => {
  const sessions = []
  for (let i = 0; i < 8; i++) {
    sessions.push(['fleet:a', 'sess-1', i % 2 ? 'user' : 'assistant', T(i), `transcript quarry line ${i}`])
  }
  const { store, cleanup } = storeWith([], sessions)
  try {
    const rows = await store.searchAll('quarry', { limit: 20 })
    assert.ok(rows.length >= 8, `all session matches come back, got ${rows.length}`)
    assert.ok(rows.every(r => r.source === 'session'))
    for (const row of rows) {
      assert.ok(row.snippet && row.snippet.includes('⟨⟨quarry⟩⟩'),
        `session survivors carry highlighted snippets, got: ${row.snippet}`)
    }
  } finally { cleanup() }
})

test('expression narrowing still applies with the snippet deferred', async () => {
  const { store, cleanup } = storeWith([
    [null, T(1), 'fleet:a', 'alpha first row'],
    [null, T(2), 'fleet:a', 'beta second row'],
    [null, T(3), 'fleet:a', 'gamma third row'],
  ])
  try {
    const rows = await store.searchAll('alpha | beta', { limit: 20 })
    const texts = rows.map(r => r.text)
    assert.ok(texts.some(t => t.includes('alpha')), 'alpha row matches the OR')
    assert.ok(texts.some(t => t.includes('beta')), 'beta row matches the OR')
    assert.ok(!texts.some(t => t.includes('gamma')), 'gamma row is narrowed out')
    const negated = await store.searchAll('row & !gamma', { limit: 20 })
    assert.ok(!negated.map(r => r.text).some(t => t.includes('gamma')), 'negation still excludes')
    assert.ok(negated.length >= 2, 'the unnegated rows survive')
  } finally { cleanup() }
})

test('an agent-prefiltered text search fills its page with snippets', async () => {
  const events = []
  for (let i = 0; i < 12; i++) events.push([null, T(i), 'fleet:a', `quarry holder row ${i}`])
  for (let i = 0; i < 12; i++) events.push([null, T(i), 'fleet:b', `quarry other row ${i}`])
  const { store, cleanup } = storeWith(events)
  try {
    const rows = await store.searchAll('quarry', { limit: 10, agent: ['fleet:a'] })
    assert.equal(rows.length, 10)
    assert.ok(rows.every(r => r.from === 'fleet:a'), 'only the prefiltered agent comes back')
    assert.ok(rows.every(r => r.snippet && r.snippet.includes('⟨⟨quarry⟩⟩')))
  } finally { cleanup() }
})

test('exact-phrase rows rank first even past the pool cut', async () => {
  // 240 short rows matching both terms but never the phrase, outranking 10
  // long exact-phrase rows by bm25; the pool floor is 200, so the phrase rows
  // fall below the rank cut and only the phrase top-up brings them back.
  const events = []
  for (let i = 0; i < 240; i++) events.push([null, T(i % 60), 'fleet:a', `chip drag inverted ${i}`])
  for (let i = 0; i < 10; i++) {
    events.push([null, T(i), 'fleet:a',
      `a much longer document that happens to mention drag chip once among many other filler words number ${i} padding padding padding`])
  }
  const { store, cleanup } = storeWith(events)
  try {
    const rows = await store.searchAll('drag chip', { limit: 10 })
    assert.equal(rows.length, 10)
    const exact = rows.filter(r => r.text.toLowerCase().includes('drag chip'))
    assert.ok(exact.length >= 8, `phrase rows must dominate the page, got ${exact.length}/10`)
    assert.ok(rows[0].text.toLowerCase().includes('drag chip'), 'the top row is an exact-phrase match')
  } finally { cleanup() }
})

test('the phrase top-up obeys the time window', async () => {
  const { store, cleanup } = storeWith([
    [null, '2026-08-20T00:00:00.000Z', 'fleet:a', 'drag chip inside the window'],
    [null, '2026-08-01T00:00:00.000Z', 'fleet:a', 'drag chip before the window'],
  ])
  try {
    const rows = await store.searchAll('drag chip', { limit: 20, since: '2026-08-10T00:00:00.000Z' })
    assert.ok(rows.length >= 1, 'the in-window phrase row comes back')
    assert.ok(rows.every(r => r.timestamp >= '2026-08-10T00:00:00.000Z'),
      'no out-of-window phrase row leaks in through the top-up')
  } finally { cleanup() }
})

test('chat rows survive the pool cut past better-ranked task rows', async () => {
  // The ranker's +90 chat bonus over +55 task_done dwarfs bm25 gaps, so a
  // rank-cut pool drops chat rows the ranker would place top of page
  // (measured: a JS-#2 chat row cut from a live limit-20 page). The pool is
  // bonus-ordered, so the cut keeps the ranker's rows instead.
  const dir = mkdtempSync(join(tmpdir(), 'search-pool-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    const insert = store.db.prepare(
      'INSERT INTO events (type, timestamp, from_id, text) VALUES (?, ?, ?, ?)'
    )
    for (let i = 0; i < 250; i++) insert.run('task_done', T(i % 60), 'fleet:a', `quarry dense ${i}`)
    for (let i = 0; i < 5; i++) {
      insert.run('chat', T(i), 'fleet:a',
        `a much longer chat document that mentions quarry once among many other padding words chat ${i} padding padding padding`)
    }
    const rows = await store.searchAll('quarry', { limit: 5 })
    assert.equal(rows.length, 5)
    assert.ok(rows.every(r => r.type === 'chat'),
      `the page must be the bonus-winning chat rows, got: ${rows.map(r => r.type).join(',')}`)
  } finally { store.close?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('a one-row page carries its own highlighted snippet', async () => {
  // A lone survivor means a single-element rowid IN + MATCH, which FTS5
  // ignores (measured: all 33,028 matches instead of one row) unless padded
  // to a pair. Small fixtures cannot show the slowdown, so this pins the
  // path's answer; the serving-store probe pins its cost.
  const events = []
  for (let i = 0; i < 5; i++) events.push([null, T(i), 'fleet:a', `quarry solitary ${i}`])
  const { store, cleanup } = storeWith(events)
  try {
    const rows = await store.searchAll('quarry', { limit: 1 })
    assert.equal(rows.length, 1)
    assert.ok(rows[0].snippet && rows[0].snippet.includes('⟨⟨quarry⟩⟩'),
      `the lone survivor carries its highlighted snippet, got: ${rows[0].snippet}`)
    assert.ok(rows[0].text.includes('quarry solitary'))
  } finally { cleanup() }
})

test('the eventOnly text path attaches snippets', async () => {
  const { store, cleanup } = storeWith([[null, T(1), 'fleet:a', 'quarry event only']])
  try {
    const rows = await store.searchAll('quarry', { limit: 10, eventOnly: true })
    assert.equal(rows.length, 1)
    assert.ok(rows[0].snippet && rows[0].snippet.includes('⟨⟨quarry⟩⟩'),
      `eventOnly survivors carry snippets, got: ${rows[0].snippet}`)
  } finally { cleanup() }
})
