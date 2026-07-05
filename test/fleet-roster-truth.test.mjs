import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeFleetRosterTruth } from '../server/lib/fleet-roster-truth.mjs'

test('fleet roster truth separates registry liveness from stale tmux panes', () => {
  const roster = [
    { id: 'fleet:a1', friendly_name: 'alpha', status: 'awake', dead: false, human: false, machine_id: 'mini', tmux_session: 'fleet-alpha', last_seen: '2026-06-26T12:00:00.000Z', metadata: { inboxStatus: 'busy', inboxStatusTag: 'RC' } },
    { id: 'fleet:a2', friendly_name: 'bravo', status: 'hibernating', dead: false, human: false, machine_id: 'mini', tmux_session: 'fleet-bravo', last_seen: '2026-06-26T12:00:00.000Z', metadata: { inboxStatus: 'dnd' } },
    { id: 'fleet:a3', friendly_name: 'charlie', status: 'dead', dead: true, human: false, machine_id: 'mini', tmux_session: 'fleet-charlie', last_seen: '2026-06-26T12:00:00.000Z' },
    { id: 'fleet:a4', friendly_name: 'delta', status: 'hibernating', dead: false, human: false, machine_id: 'mini', tmux_session: 'fleet-delta', last_seen: '2026-06-26T12:00:00.000Z' },
    { id: 'fleet:skip', friendly_name: 'skip', status: 'human', dead: false, human: true, machine_id: 'mini', tmux_session: null, last_seen: '2026-06-26T12:00:00.000Z' },
  ]

  const summary = summarizeFleetRosterTruth({
    roster,
    machineSessions: {
      mini: ['fleet-alpha', 'fleet-bravo', 'fleet-charlie', 'fleet-orphan', 'not-fleet'],
    },
    now: Date.parse('2026-06-26T12:01:00.000Z'),
  })

  assert.deepEqual(summary.totals, { awake: 1, hibernating: 2, dead: 1, total: 4 })
  assert.deepEqual(summary.panes, { fleet: 4, stale: 3, registry_without_pane: 1 })
  assert.equal(summary.agents.find(a => a.name === 'alpha').inbox_status, 'busy')
  assert.equal(summary.agents.find(a => a.name === 'alpha').inbox_status_tag, 'RC')
  assert.deepEqual(summary.summary.inbox_statuses, [
    { value: 'busy', count: 1 },
    { value: 'dnd', count: 1 },
  ])
  assert.equal(summary.machines.length, 1)
  assert.equal(summary.machines[0].panes.stale, 3)
  assert.deepEqual(summary.machines[0].stale_panes.map(p => p.tmux_session), ['fleet-bravo', 'fleet-charlie', 'fleet-orphan'])
  assert.deepEqual(summary.machines[0].registry_without_pane_rows.map(r => r.name), ['delta'])
})
