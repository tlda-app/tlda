import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeFleetRosterTruth } from './fleet-roster-truth.mjs'

test('fleet table rows retain labels used by roster consumers', () => {
  const result = summarizeFleetRosterTruth({
    roster: [{
      id: 'fleet:todd',
      friendly_name: 'todd',
      labels: ['bot', 'todd'],
      last_seen: '2026-08-06T19:00:00.000Z',
      metadata: { model: 'todd', kind: 'bot' },
      runtime_status: { kind: 'ai', status: 'awake' },
    }],
    now: new Date('2026-08-06T19:01:00.000Z').getTime(),
  })

  assert.deepEqual(result.agents[0].labels, ['bot', 'todd'])
})

test('fleet table rows retain human identity used by automation consumers', () => {
  const result = summarizeFleetRosterTruth({
    roster: [{
      id: 'fleet:skip',
      friendly_name: 'skip',
      human: true,
      runtime_status: { kind: 'human', status: 'here' },
    }],
  })

  assert.equal(result.agents[0].human, true)
})

test('fleet table rows retain native subagent parent identity used by lifecycle automation', () => {
  const result = summarizeFleetRosterTruth({
    roster: [{
      id: 'fleet:child',
      friendly_name: 'chief:child',
      parent_agent_id: 'fleet:chief',
      runtime_status: { kind: 'ai', status: 'awake' },
    }],
  })

  assert.equal(result.agents[0].parent_agent_id, 'fleet:chief')
})
