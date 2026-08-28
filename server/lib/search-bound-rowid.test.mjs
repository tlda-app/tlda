import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

// A `since`/`before` bound on a text search now also goes to the FTS match side
// as a rowid range, because the timestamp predicate alone cannot stop the FTS
// walk — SQLite reads the term's whole posting list to find the few rows in the
// window, which is what made a bounded search on the live store take tens of
// seconds and, on the store's single worker thread, stall every other caller
// behind it.
//
// The rowid bound is min()/max() of id over exactly the rows the timestamp bound
// admits, which is a bound on every row the query can return. The cheap-looking
// alternative — the id of the window's earliest row — is NOT such a bound: id is
// assigned at insert and timestamp is not, so a row ingested late carries a high
// id with an old timestamp, and its neighbours in the window can carry ids below
// the earliest row's. On the live store that drops in-window rows in 15 of 60
// day-windows, 2016 rows in the worst.
//
// So these tests are about rows going missing silently, which is the only way
// this can fail: a wrong bound returns fewer results and nothing anywhere says so.

function storeWith(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'search-bound-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  const insert = store.db.prepare(
    "INSERT INTO events (id, type, timestamp, from_id, text) VALUES (?, 'chat', ?, 'fleet:a', ?)"
  )
  for (const [id, timestamp, text] of rows) insert.run(id, timestamp, text)
  return { store, cleanup: () => { store.close?.(); rmSync(dir, { recursive: true, force: true }) } }
}

const IN = '2026-08-20T00:00:00.000Z'   // inside the window
const OUT = '2026-08-01T00:00:00.000Z'  // before it
const SINCE = '2026-08-10T00:00:00.000Z'

test('a bounded search keeps an in-window row whose id sorts below the window', async () => {
  // id 5000 is in the window and is the LOWEST id there; ids 5001+ are older
  // rows ingested afterwards. The window's earliest-timestamped row is 9000,
  // so a floor taken from it would sit above 5000 and lose it.
  const rows = [[5000, IN, 'needle alpha']]
  for (let i = 1; i <= 40; i++) rows.push([5000 + i, OUT, 'needle filler'])
  rows.push([9000, IN, 'needle omega'])
  const { store, cleanup } = storeWith(rows)
  try {
    const got = await store.searchAll('needle', { limit: 50, since: SINCE })
    const ids = got.map(r => r.id).sort((a, b) => a - b)
    assert.deepEqual(ids, [5000, 9000], 'both in-window rows must come back')
  } finally { cleanup() }
})

test('a bounded search returns exactly the rows the same search returns unbounded', async () => {
  const rows = []
  for (let i = 0; i < 60; i++) {
    // Timestamps deliberately unrelated to id order.
    const ts = i % 3 === 0 ? IN : OUT
    rows.push([7000 + ((i * 17) % 60), ts, `needle row${i}`])
  }
  const seen = new Set()
  const unique = rows.filter(([id]) => !seen.has(id) && seen.add(id))
  const { store, cleanup } = storeWith(unique)
  try {
    const all = await store.searchAll('needle', { limit: 200 })
    const expected = all.filter(r => r.timestamp >= SINCE).map(r => r.id).sort((a, b) => a - b)
    const bounded = (await store.searchAll('needle', { limit: 200, since: SINCE })).map(r => r.id).sort((a, b) => a - b)
    assert.ok(expected.length > 0, 'the fixture must put something in the window')
    assert.deepEqual(bounded, expected)
  } finally { cleanup() }
})

test('a before bound keeps an in-window row whose id sorts above the window', async () => {
  // The mirror case: id 9000 is old but was ingested last, so a ceiling taken
  // from the window's latest-timestamped row would sit below it.
  const rows = [[9000, OUT, 'needle alpha']]
  for (let i = 1; i <= 40; i++) rows.push([8000 + i, IN, 'needle filler'])
  rows.push([8000, OUT, 'needle omega'])
  const { store, cleanup } = storeWith(rows)
  try {
    const got = await store.searchAll('needle', { limit: 50, before: SINCE })
    const ids = got.map(r => r.id).sort((a, b) => a - b)
    assert.deepEqual(ids, [8000, 9000], 'both rows before the bound must come back')
  } finally { cleanup() }
})
