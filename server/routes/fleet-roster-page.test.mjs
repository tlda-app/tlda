import assert from 'node:assert/strict'
import test from 'node:test'

import { filteredFleetRosterPage, filterMentionsDead } from './fleet.mjs'
import { parseFilter, labelsForAgent } from '../../shared/fleet-labels.mjs'

const rowNameLabels = (row) => [row.friendly_name, row.id, ...(row.labels || [])].filter(Boolean)

test('roster name match ignores case like the store resolver', () => {
  const rows = [{ id: 'fleet:skip', friendly_name: 'skip', labels: [] }]
  for (const token of ['skip', 'Skip', 'SKIP']) {
    const page = filteredFleetRosterPage(rows, { filterAst: parseFilter(token), labelsForRow: rowNameLabels, limit: 50 })
    assert.equal(page.matched, 1, `filter ${token} should match the skip row`)
    assert.equal(page.rows[0].id, 'fleet:skip')
  }
})

test('roster id and label match ignore case', () => {
  const rows = [{ id: 'fleet:skip', friendly_name: 'skip', labels: ['Reviewers'] }]
  for (const token of ['fleet:skip', 'FLEET:SKIP', 'reviewers', 'REVIEWERS']) {
    const page = filteredFleetRosterPage(rows, { filterAst: parseFilter(token), labelsForRow: rowNameLabels, limit: 50 })
    assert.equal(page.matched, 1, `filter ${token} should match`)
  }
})

test('roster negation and composition survive case folding', () => {
  const rows = [
    { id: 'fleet:skip', friendly_name: 'skip', labels: [] },
    { id: 'fleet:todd', friendly_name: 'todd', labels: [] },
  ]
  const excluded = filteredFleetRosterPage(rows, { filterAst: parseFilter('!SKIP'), labelsForRow: rowNameLabels, limit: 50 })
  assert.deepEqual(excluded.rows.map(row => row.id), ['fleet:todd'])
  const either = filteredFleetRosterPage(rows, { filterAst: parseFilter('SKIP | TODD'), labelsForRow: rowNameLabels, limit: 50 })
  assert.equal(either.matched, 2)
})

test('fleet roster computes runtime and timestamp sort keys once per row', () => {
  let runtimeReads = 0
  let lastSeenReads = 0
  const rows = Array.from({ length: 2_000 }, (_, index) => {
    const row = { id: `fleet:${String(index).padStart(4, '0')}` }
    Object.defineProperty(row, 'runtime_status', {
      enumerable: true,
      get() {
        runtimeReads += 1
        return { kind: 'ai', status: index % 3 === 0 ? 'awake' : 'hibernating', activity: 'unknown' }
      },
    })
    Object.defineProperty(row, 'last_seen', {
      enumerable: true,
      get() {
        lastSeenReads += 1
        return new Date(Date.parse('2026-08-01T00:00:00.000Z') + index * 1_000).toISOString()
      },
    })
    return row
  })

  const page = filteredFleetRosterPage(rows, { limit: 50, labelsForRow: () => [] })

  assert.equal(page.matched, 2_000)
  assert.equal(page.rows.length, 50)
  assert.equal(runtimeReads, 2_000)
  assert.ok(lastSeenReads <= 2_002, `last_seen read ${lastSeenReads} times`)
})

// Dead discovery (tail-11): the roster routes union dead rows into the
// candidate set exactly when the caller's filter can match one — a `dead`
// literal under an even number of negations. Anything else must not pay for
// the dead-table read.
test('filterMentionsDead fires only when the filter can match a dead row', () => {
  assert.equal(filterMentionsDead(null), false)
  assert.equal(filterMentionsDead(parseFilter('dead')), true)
  assert.equal(filterMentionsDead(parseFilter('DEAD')), true)
  assert.equal(filterMentionsDead(parseFilter('awake | dead')), true)
  assert.equal(filterMentionsDead(parseFilter('dead & waffles')), true)
  assert.equal(filterMentionsDead(parseFilter('!!dead')), true)
  assert.equal(filterMentionsDead(parseFilter('!dead')), false)
  assert.equal(filterMentionsDead(parseFilter('awake')), false)
  assert.equal(filterMentionsDead(parseFilter('!(dead | waffles)')), false)
  assert.equal(filterMentionsDead(parseFilter('waffles')), false)
})

test('filter=dead over a mixed roster matches only the dead row', () => {
  const rows = [
    { id: 'fleet:live', friendly_name: 'live', labels: [], dead: false, human: false, last_seen: '2026-09-27T20:00:00.000Z', runtime_status: { kind: 'ai', status: 'awake', activity: 'unknown' } },
    { id: 'fleet:gone', friendly_name: 'gone', labels: [], dead: true, human: false, last_seen: '2026-09-27T19:00:00.000Z', runtime_status: { kind: 'ai', status: 'dead', activity: 'unknown' } },
  ]
  const page = filteredFleetRosterPage(rows, { filterAst: parseFilter('dead'), labelsForRow: labelsForAgent, limit: 50 })
  assert.equal(page.matched, 1)
  assert.equal(page.rows[0].id, 'fleet:gone')
  const alive = filteredFleetRosterPage(rows, { filterAst: parseFilter('awake'), labelsForRow: labelsForAgent, limit: 50 })
  assert.equal(alive.matched, 1)
  assert.equal(alive.rows[0].id, 'fleet:live')
})
