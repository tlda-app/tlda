import assert from 'node:assert/strict'
import test from 'node:test'

import { filteredFleetRosterPage } from './fleet.mjs'

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
