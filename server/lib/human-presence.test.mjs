import assert from 'node:assert/strict'
import test from 'node:test'

import { createHumanPresenceTracker } from './human-presence.mjs'

test('human presence changes only on aggregate connection-count edges', () => {
  const edges = []
  const tracker = createHumanPresenceTracker({ onEdge: edge => edges.push(edge) })
  const first = {}
  const second = {}

  assert.equal(tracker.attach(first, 'fleet:skip', 1), true)
  assert.equal(tracker.attach(second, 'fleet:skip', 2), false)
  assert.equal(tracker.connectionCount('fleet:skip'), 2)
  assert.equal(tracker.detach(first, 3), false)
  assert.equal(tracker.connectionCount('fleet:skip'), 1)
  assert.equal(tracker.detach(second, 4), true)
  assert.deepEqual(edges, [
    { humanId: 'fleet:skip', status: 'here', atMs: 1 },
    { humanId: 'fleet:skip', status: 'away', atMs: 4 },
  ])
})

test('moving one connection between humans emits one away edge and one here edge', () => {
  const edges = []
  const tracker = createHumanPresenceTracker({ onEdge: edge => edges.push(edge) })
  const ws = {}

  tracker.attach(ws, 'fleet:first', 1)
  tracker.attach(ws, 'fleet:second', 2)
  tracker.detach(ws, 3)

  assert.deepEqual(edges, [
    { humanId: 'fleet:first', status: 'here', atMs: 1 },
    { humanId: 'fleet:first', status: 'away', atMs: 2 },
    { humanId: 'fleet:second', status: 'here', atMs: 2 },
    { humanId: 'fleet:second', status: 'away', atMs: 3 },
  ])
})
