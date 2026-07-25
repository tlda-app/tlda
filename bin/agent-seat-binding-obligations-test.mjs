import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'

import {
  AgentSeatBindingObligations,
  isRetirableStaleAgentSeatBindingObligation,
} from '../server/lib/agent-seat-binding-obligations.mjs'

test('binding obligation parse trusts indexed row authority over stale payload fields', () => {
  const db = new Database(':memory:')
  const obligations = new AgentSeatBindingObligations(db)
  obligations.put({
    obligation_id: 'obligation-1',
    agent_id: 'fleet:agent',
    daemon_key: 'mini:default',
    local_agent_id: 'local:old',
    cwd: '/tmp',
    kind: 'codex',
    model: 'gpt-test',
    friendly_name: 'agent',
  })

  db.prepare(`
    UPDATE agent_seat_binding_obligations
    SET daemon_key = ?, local_agent_id = ?
    WHERE id = ?
  `).run('mini:testing', 'local:new', 'obligation-1')

  const parsed = obligations.get('obligation-1')
  assert.equal(parsed.daemon_key, 'mini:testing')
  assert.equal(parsed.local_agent_id, 'local:new')
  assert.equal(parsed.agent_id, 'fleet:agent')
})

test('binding obligation reaping is limited to dead agents with no current seat', () => {
  const obligation = { obligation_id: 'obligation-1', agent_id: 'fleet:agent' }

  assert.equal(isRetirableStaleAgentSeatBindingObligation({
    obligation,
    agent: { id: 'fleet:agent', dead: 0 },
    currentSeat: null,
  }), false)

  assert.equal(isRetirableStaleAgentSeatBindingObligation({
    obligation,
    agent: { id: 'fleet:agent', dead: 1 },
    currentSeat: { agent_id: 'fleet:agent', session_id: 'session-live' },
  }), false)

  assert.equal(isRetirableStaleAgentSeatBindingObligation({
    obligation,
    agent: { id: 'fleet:agent', dead: 1 },
    currentSeat: null,
  }), true)
})
