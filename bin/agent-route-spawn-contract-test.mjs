import assert from 'node:assert/strict'
import test from 'node:test'

import { bindAgentRoute } from '../agent-launch/route-binding.mjs'
import { daemonDeliveryPolicy, DELIVERY_DURABLE_FIFO } from '../daemon/delivery-policy.mjs'
import { recordAgentRouteEvent } from '../server/lib/agent-route-events.mjs'
import { normalizeSpawnRelayInput } from '../server/lib/spawn-relay-input.mjs'

test('launcher route publication reaches the server with daemon identity only', async () => {
  const writes = []
  const fleetStore = {
    async setAgentDaemonRoute(agentId, daemonKey) {
      writes.push({ agentId, daemonKey })
      return { agent_id: agentId, daemon_key: daemonKey }
    },
  }
  let published = null

  const result = await bindAgentRoute({
    agentId: 'fleet:route-test',
    daemonKey: 'box-a:testing',
    submit: async payload => {
      published = { type: 'agent-route', ...payload }
      await recordAgentRouteEvent(fleetStore, published)
    },
  })

  assert.equal(result.bound, true)
  assert.deepEqual(published, {
    type: 'agent-route',
    agent_id: 'fleet:route-test',
    daemon_key: 'box-a:testing',
  })
  assert.deepEqual(writes, [{
    agentId: 'fleet:route-test',
    daemonKey: 'box-a:testing',
  }])
  assert.equal(daemonDeliveryPolicy(published), DELIVERY_DURABLE_FIFO)
  for (const forbidden of ['session', 'sessionId', 'session_id', 'resume_id', 'terminal_capability']) {
    assert.equal(Object.hasOwn(published, forbidden), false)
  }
})

test('server spawn relay cannot select a daemon session', () => {
  const normalized = normalizeSpawnRelayInput({
    name: 'route-spawn',
    model: 'gpt',
    cwd: '/tmp/project',
    permissionRequest: { profile: 'test' },
  })
  assert.equal(normalized.name, 'route-spawn')
  assert.equal(normalized.model, 'gpt')

  for (const key of ['session', 'sessionId', 'session_id']) {
    assert.throws(
      () => normalizeSpawnRelayInput({ name: 'route-spawn', [key]: 'server-chosen-session' }),
      /spawn session selection belongs to the daemon/,
    )
  }
})
