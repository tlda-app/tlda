import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentMoveTarget } from '../shared/agent-move-target.mjs'

test('move target parses env-only shorthand', () => {
  assert.deepEqual(parseAgentMoveTarget('stable'), {
    targetName: null,
    machine_id: null,
    env_name: 'stable',
  })
})

test('move target parses box env address', () => {
  assert.deepEqual(parseAgentMoveTarget('mini:unstable'), {
    targetName: null,
    machine_id: 'mini',
    env_name: 'unstable',
  })
})

test('move target parses explicit target name', () => {
  assert.deepEqual(parseAgentMoveTarget('worker@air:stable'), {
    targetName: 'worker',
    machine_id: 'air',
    env_name: 'stable',
  })
})

test('move target rejects malformed addresses', () => {
  assert.throws(() => parseAgentMoveTarget('mini:'), /env is required/)
  assert.throws(() => parseAgentMoveTarget(':stable'), /empty box/)
  assert.throws(() => parseAgentMoveTarget('a:b:c'), /expected/)
})
