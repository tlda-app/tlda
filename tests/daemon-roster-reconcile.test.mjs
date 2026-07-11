import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileDaemonRoster } from '../daemon/roster-reconcile.mjs'

test('a delta-only roster arrival invokes the watcher reconciliation boundary', () => {
  const calls = []
  const agents = [{ id: 'delta-agent', session_id: 'session-1' }]
  const next = reconcileDaemonRoster({
    agents, signature: 'before', reason: 'agent-status-event',
    syncIdentityNames: roster => calls.push(['identities', roster]),
    syncIfRosterChanged: ({ agents: roster, signature, reason, onChanged }) => {
      calls.push(['watchers', roster, signature, reason])
      onChanged()
      return 'after'
    },
    onChanged: () => calls.push(['activity-extraction']),
  })
  assert.equal(next, 'after')
  assert.deepEqual(calls.map(([name]) => name), ['identities', 'watchers', 'activity-extraction'])
  assert.equal(calls[1][3], 'agent-status-event')
  assert.equal(calls[1][1][0].id, 'delta-agent')
})
