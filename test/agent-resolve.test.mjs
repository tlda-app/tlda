import assert from 'node:assert/strict'
import test from 'node:test'

import { agentMatchesQuery, resolveAgentQuery } from '../cli/lib/agent-resolve.mjs'

test('resolves exact fleet id', () => {
  const agents = [
    { id: 'fleet:a', friendly_name: 'alpha', tmux_session: 'fleet-alpha' },
    { id: 'fleet:b', friendly_name: 'beta', tmux_session: 'fleet-beta' },
  ]

  assert.equal(resolveAgentQuery(agents, 'fleet:b').id, 'fleet:b')
})

test('resolves exact friendly name without tmux alias fallback', () => {
  const agents = [
    { id: 'fleet:current-chief', friendly_name: 'chief', tmux_session: 'fleet-chief-incoming', status: 'awake' },
    { id: 'fleet:dusk-chief', friendly_name: 'chief:dusk', tmux_session: 'fleet-chief', status: 'hibernating' },
  ]

  assert.equal(resolveAgentQuery(agents, 'chief').id, 'fleet:current-chief')
  assert.equal(resolveAgentQuery(agents, 'fleet-chief'), null)
  assert.equal(agentMatchesQuery(agents[1], 'fleet-chief'), false)
})

test('duplicate live exact friendly names are ambiguous', () => {
  const agents = [
    { id: 'fleet:a', friendly_name: 'chief', status: 'awake' },
    { id: 'fleet:b', friendly_name: 'chief', status: 'hibernating' },
  ]

  assert.throws(
    () => resolveAgentQuery(agents, 'chief'),
    /Multiple friendly-name agents matched "chief".*fleet:a.*fleet:b/,
  )
})

test('dead historical duplicate does not block current exact holder', () => {
  const agents = [
    { id: 'fleet:current', friendly_name: 'chief', status: 'awake' },
    { id: 'fleet:dead', friendly_name: 'chief', status: 'dead', dead: true },
  ]

  assert.equal(resolveAgentQuery(agents, 'chief').id, 'fleet:current')
})
