// A very common term costs what it matches, not what it returns: ranking scores
// every match before picking a page. `the` measured 9,919ms through the real
// search surface where a rare term is under a second.
//
// `searchAll` now probes for a dense term and tries a recent window first,
// because a `since` bound becomes a rowid range on the match side. These tests
// are about the two properties that make that safe rather than about the speed,
// which no fixture can show:
//
//   - a term that is NOT dense must take exactly the path it took before, so
//     the common case cannot be slowed or altered by the probe;
//   - a windowed pass that comes back short must fall back to the unbounded
//     query, so narrowing can never lose a result.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'

const NOW = '2026-09-19T12:00:00.000Z'

async function withStore(testFn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-dense-term-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    store.upsertAgent({ id: 'fleet:a', friendly_name: 'a', labels: [], registered_at: NOW, last_seen: NOW })
    await testFn(store)
  } finally {
    store.close?.()
    await rm(dir, { recursive: true, force: true })
  }
}

// Record what the wrapper asked for, without changing what it returns.
function traceWindows(store) {
  const calls = []
  const real = store._searchAllOnce.bind(store)
  store._searchAllOnce = (query, options = {}) => {
    calls.push(options.since ?? null)
    return real(query, options)
  }
  return calls
}

test('a term that is not dense runs the query unchanged, once', () => withStore(async (store) => {
  const calls = traceWindows(store)
  store.searchAll('anchoredViewportGeometry', { limit: 5 })

  assert.equal(calls.length, 1, 'one pass, no windowing')
  assert.equal(calls[0], null, 'and no window was imposed on it')
}))

test('an explicit since is left alone — the caller already chose a window', () => withStore(async (store) => {
  const calls = traceWindows(store)
  store.searchAll('anything', { limit: 5, since: '2026-09-01T00:00:00.000Z' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0], '2026-09-01T00:00:00.000Z', 'the caller\'s window, not ours')
}))

test('a dense term tries a window and falls back when the page is short', () => withStore(async (store) => {
  // Force the dense verdict rather than seeding 20,001 rows: what is under test
  // is what the wrapper DOES when a term is dense, not how it decides.
  store._termIsDense = () => true
  const calls = traceWindows(store)
  const rows = store.searchAll('sparse-term-with-no-matches', { limit: 5 })

  // Windows are tried newest-first, then the unbounded query runs because no
  // window filled the page. The last call carries no window at all.
  assert.ok(calls.length >= 2, `expected a widening sequence, got ${calls.length} call(s)`)
  assert.equal(calls.at(-1), null, 'the final pass must be unbounded, or narrowing could lose rows')
  assert.ok(calls.slice(0, -1).every(Boolean), 'every earlier pass carried a window')
  assert.deepEqual(rows, [], 'and the answer is the unbounded query\'s answer')
}))

test('a dense term that fills the page early does not widen further', () => withStore(async (store) => {
  store._termIsDense = () => true
  const calls = traceWindows(store)
  // One row is enough to fill a page of one.
  store.recordEvent?.({ type: 'chat', from_id: 'fleet:a', text: 'dense filler text', timestamp: NOW })
  const real = store._searchAllOnce
  store._searchAllOnce = (query, options = {}) => {
    calls.push(options.since ?? null)
    return [{ id: 1, source: 'fleet' }]
  }
  const rows = store.searchAll('whatever', { limit: 1 })

  assert.equal(calls.length, 1, 'stopped at the first window that filled the page')
  assert.ok(calls[0], 'and that pass was windowed')
  assert.equal(rows.length, 1)
  store._searchAllOnce = real
}))

// The density DECISION was untested on purpose — the tests above force the
// verdict so they measure what the wrapper does with it. That left the decision
// itself unguarded, and its failure mode is silent: a term that should be
// windowed runs unbounded and simply looks like the slow search this replaced.
// These cover it by shrinking the probe rather than seeding 20,001 rows.
test('the density probe classifies by match count, not by luck', () => withStore(async (store) => {
  const realProbe = FleetStore.SEARCH_DENSE_TERM_PROBE
  FleetStore.SEARCH_DENSE_TERM_PROBE = 3
  try {
    // insertEventRecord, not chat(): chat schedules deferred writes that land
    // after the store closes, and the failure surfaces in whichever test runs
    // next rather than this one.
    const at = n => new Date(Date.parse(NOW) + n * 1000).toISOString()
    for (let i = 0; i < 5; i++) {
      store.insertEventRecord({ type: 'chat', from_id: 'fleet:a', text: `widespread filler token qqzz ${i}`, timestamp: at(i) })
    }
    store.insertEventRecord({ type: 'chat', from_id: 'fleet:a', text: 'singular needle wwxx', timestamp: at(99) })

    assert.equal(store._termIsDense('qqzz'), true, '5 matches against a probe of 3 is dense')
    assert.equal(store._termIsDense('wwxx'), false, '1 match against a probe of 3 is not')
    assert.equal(store._termIsDense('termthatappearsnowhere'), false, 'no matches is not dense')
  } finally {
    FleetStore.SEARCH_DENSE_TERM_PROBE = realProbe
  }
}))

test('a probe that cannot parse the query declines rather than throwing', () => withStore(async (store) => {
  // A malformed query is the real search's business to report; the probe must
  // not turn it into a 500 on the way past.
  assert.equal(store._termIsDense('"unclosed quote'), false)
  assert.equal(store._termIsDense(''), false)
}))
