import assert from 'node:assert/strict'
import test from 'node:test'
import { projectActivityEventsPage, projectAgentActivityPage } from '../server/lib/activity-dashboard-projection.mjs'

test('dashboard roster projection stays nonempty and strips full seat metadata', () => {
  const page = projectAgentActivityPage({
    agents: [{
      id: 'fleet:abc',
      friendly_name: 'reader',
      metadata: { permissionSet: { large: true } },
      runtime_status: {
        status: 'awake', activity: 'tool', route_state: 'reachable', updated_at: '2026-07-18T05:00:00Z',
        evidence: { activity_tool: 'Read' },
      },
    }],
    totals: { awake: 1, hibernating: 0, total: 1 },
    nextCursor: null,
  })

  assert.deepEqual(page.agents, [{
    friendly_name: 'reader', status: 'awake', activity: 'tool', activity_tool: 'Read',
    updated_at: '2026-07-18T05:00:00Z', route_state: 'reachable',
  }])
  assert.deepEqual(page.totals, [{ awake: 1, hibernating: 0, total: 1 }])
  assert.deepEqual(page.pagination, [{ next_cursor: 'all current agents shown' }])
  assert.equal(JSON.stringify(page).includes('permissionSet'), false)
})

test('dashboard activity projection exposes the canonical tool from stored metadata', () => {
  const page = projectActivityEventsPage({
    events: [{ id: 7, timestamp: '2026-07-18T05:00:00Z', from: 'fleet:abc', text: 'Read', metadata: '{"tool":"Read"}' }],
    lastId: 7,
  })

  assert.deepEqual(page.events, [{ id: 7, timestamp: '2026-07-18T05:00:00Z', from: 'fleet:abc', tool: 'Read', text: 'Read' }])
  assert.equal(page.lastId, 7)
})

test('dashboard activity projection is byte-bounded per row and tolerates malformed metadata', () => {
  const page = projectActivityEventsPage({
    events: [{ id: 8, timestamp: '2026-07-18T05:00:00Z', from: 'fleet:abc', text: 'x'.repeat(800), metadata: 'null' }],
  })

  assert.equal(page.events[0].text.length, 500)
  assert.equal(page.events[0].tool, '')
})
