// F4: mark-only deaths emit agent-died with explicit actor provenance.
// A supplied actor rides as self-asserted; silence defaults to the server.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AGENT_DIED_TYPE, buildAgentDiedEvent, emitAgentDiedEvent } from './agent-died-event.mjs'

test('supplied actor is self-asserted, never authenticated', () => {
  const event = buildAgentDiedEvent({ agentId: 'fleet:x', path: 'http-mark-dead', actor: 'tlda-agent-dismiss', serverOwnerId: 'fleet:tlda' })
  assert.equal(event.type, AGENT_DIED_TYPE)
  assert.equal(event.from, 'tlda-agent-dismiss')
  assert.equal(event.to, 'fleet:x')
  assert.match(event.text, /http-mark-dead/)
  assert.deepEqual(event.metadata, { path: 'http-mark-dead', actor: 'tlda-agent-dismiss', actor_provenance: 'self-asserted' })
})

test('absent actor defaults to the server owner', () => {
  for (const actor of [null, undefined, '', '   ']) {
    const event = buildAgentDiedEvent({ agentId: 'fleet:x', path: 'ws-mark-dead', actor, serverOwnerId: 'fleet:tlda' })
    assert.equal(event.from, 'fleet:tlda')
    assert.deepEqual(event.metadata, { path: 'ws-mark-dead', actor: null, actor_provenance: 'server' })
  }
})

test('emit shares the built event', async () => {
  const shared = []
  await emitAgentDiedEvent({
    share: async event => { shared.push(event) },
    agentId: 'fleet:x',
    path: 'http-mark-dead',
    actor: 'tlda-agent-dismiss',
    serverOwnerId: 'fleet:tlda',
  })
  assert.equal(shared.length, 1)
  assert.equal(shared[0].type, AGENT_DIED_TYPE)
  assert.equal(shared[0].metadata.actor_provenance, 'self-asserted')
})
