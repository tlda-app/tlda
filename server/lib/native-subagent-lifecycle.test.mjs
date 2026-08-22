import assert from 'node:assert/strict'
import test from 'node:test'

import {
  reconcileUnroutedNativeDescendantLiveness,
  unroutedNativeDescendantIds,
  unroutedNativeDescendantsForParents,
} from './native-subagent-lifecycle.mjs'

test('parent lifecycle changes include only native descendants without their own route', () => {
  const agents = [
    { id: 'fleet:native-child', parent_agent_id: 'fleet:parent', route_present: false },
    { id: 'fleet:native-grandchild', parent_agent_id: 'fleet:native-child', route_present: false },
    { id: 'fleet:independent-child', parent_agent_id: 'fleet:parent', route_present: true },
    { id: 'fleet:other-child', parent_agent_id: 'fleet:other', route_present: false },
  ]

  assert.deepEqual(
    unroutedNativeDescendantIds(agents, 'fleet:parent'),
    ['fleet:native-child', 'fleet:native-grandchild'],
  )
})

test('one large multi-root traversal is bounded and deduplicates overlapping descendants', () => {
  const agents = []
  const roots = []
  for (let root = 0; root < 100; root++) {
    const rootId = `fleet:root-${root}`
    roots.push(rootId)
    let parent = rootId
    for (let depth = 0; depth < 100; depth++) {
      const id = `fleet:child-${root}-${depth}`
      agents.push({ id, parent_agent_id: parent, route_present: false })
      parent = id
    }
  }
  // The same root repeated in a complete batch must not multiply traversal or writes.
  const descendants = unroutedNativeDescendantsForParents(agents, [...roots, ...roots])
  assert.equal(descendants.length, 10_000)
  assert.equal(new Set(descendants.map(item => item.descendantId)).size, 10_000)
})

test('settled descendants produce zero steady-state writes', async () => {
  let durableWrites = 0
  let runtimeWrites = 0
  const changed = await reconcileUnroutedNativeDescendantLiveness({
    agents: [{ id: 'fleet:child', parent_agent_id: 'fleet:parent', route_present: false }],
    parentAgentIds: ['fleet:parent'],
    livenessFor: () => 'dead',
    writeDurable: async () => { durableWrites++ },
    markRuntime: async () => { runtimeWrites++ },
  })
  assert.equal(changed, false)
  assert.equal(durableWrites, 0)
  assert.equal(runtimeWrites, 0)
})

test('a rejected durable write leaves runtime retryable on the next batch', async () => {
  let liveness = 'unknown'
  let attempts = 0
  let runtimeWrites = 0
  const reconcile = () => reconcileUnroutedNativeDescendantLiveness({
    agents: [{ id: 'fleet:child', parent_agent_id: 'fleet:parent', route_present: false }],
    parentAgentIds: ['fleet:parent'],
    livenessFor: () => liveness,
    writeDurable: async () => {
      attempts++
      if (attempts === 1) throw new Error('injected durable failure')
    },
    markRuntime: async () => {
      runtimeWrites++
      liveness = 'dead'
    },
  })

  await assert.rejects(reconcile(), /injected durable failure/)
  assert.equal(liveness, 'unknown')
  assert.equal(runtimeWrites, 0)
  assert.equal(await reconcile(), true)
  assert.equal(attempts, 2)
  assert.equal(runtimeWrites, 1)
  assert.equal(liveness, 'dead')
})
