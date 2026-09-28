import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRemoteEvidence,
  hookBodyToEvidence,
  serverActivityToEvidence,
} from './remote-evidence.mjs'

test('hook bodies map to alive+activity; unknown omits the process claim', () => {
  assert.deepEqual(
    hookBodyToEvidence({ agent_id: 'fleet:a', activity: 'thinking', tool: 'Read' }, 777),
    { agentId: 'fleet:a', source: 'hook', atMs: 777, activity: 'thinking', process: 'alive', tool: 'Read' },
  )
  assert.deepEqual(
    hookBodyToEvidence({ agent_id: 'fleet:a', activity: 'unknown' }, 777),
    { agentId: 'fleet:a', source: 'hook', atMs: 777, activity: 'unknown' },
  )
  assert.equal(hookBodyToEvidence({ activity: 'thinking' }, 777), null)
  assert.equal(hookBodyToEvidence(null, 777), null)
})

test('hook mapping passes garbage through for admission to drop, trims tool', () => {
  assert.deepEqual(
    hookBodyToEvidence({ agent_id: 'fleet:a', activity: 'vibing', tool: '  ' }, 777),
    { agentId: 'fleet:a', source: 'hook', atMs: 777, activity: 'vibing', process: 'alive' },
  )
})

test('server acts map to active with the server observation time', () => {
  assert.deepEqual(
    serverActivityToEvidence({ agent_id: 'fleet:a', atMs: 555 }, 777),
    { agentId: 'fleet:a', source: 'server-observed', atMs: 555, activity: 'active' },
  )
  assert.deepEqual(
    serverActivityToEvidence({ agent_id: 'fleet:a' }, 777),
    { agentId: 'fleet:a', source: 'server-observed', atMs: 777, activity: 'active' },
  )
  assert.equal(serverActivityToEvidence({}, 777), null)
})

test('unbound agents decline without admitting', () => {
  const admitted = []
  const remote = createRemoteEvidence({
    isBound: id => id !== 'fleet:ghost',
    admit: envelope => { admitted.push(envelope); return {} },
  })
  assert.deepEqual(remote.admitHook({ agent_id: 'fleet:ghost', activity: 'thinking' }), {
    ok: true, admitted: false, reason: 'unbound',
  })
  assert.deepEqual(remote.admitServerActivity({ agent_id: 'fleet:ghost', atMs: 1 }), {
    ok: true, admitted: false, reason: 'unbound',
  })
  assert.equal(admitted.length, 0)
  assert.deepEqual(remote.admitHook({ agent_id: 'fleet:a', activity: 'thinking' }).admitted, true)
  assert.equal(admitted.length, 1)
})

test('admission drops surface as declined, not thrown', () => {
  const remote = createRemoteEvidence({ isBound: () => true, admit: () => undefined })
  assert.deepEqual(remote.admitHook({ agent_id: 'fleet:a', activity: 'thinking' }), {
    ok: true, admitted: false, reason: 'dropped',
  })
  const unmappable = createRemoteEvidence({ isBound: () => true, admit: () => ({}) })
  assert.deepEqual(unmappable.admitHook({ activity: 'thinking' }), {
    ok: true, admitted: false, reason: 'unmappable',
  })
})
