import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeSpawnRelayInput } from '../server/lib/spawn-relay-input.mjs'

test('spawn relay rejects legacy policy permission input at the boundary', () => {
  assert.throws(
    () => normalizeSpawnRelayInput({ type: 'spawn', name: 'agent', policy: 'wd' }),
    /rejected legacy "policy"; use permissionRequest/,
  )
})

test('spawn relay accepts permissionRequest as the only permission input', () => {
  const normalized = normalizeSpawnRelayInput({
    type: 'spawn',
    name: 'agent',
    permissionRequest: 'wd',
    model: 'gpt-5.5',
  })
  assert.equal(normalized.permissionRequest, 'wd')
  assert.equal(normalized.model, 'gpt-5.5')
  assert.equal(Object.hasOwn(normalized.modelOptions, 'permissionRequest'), false)
})

test('spawn relay preserves normal non-permission fields as model options', () => {
  const normalized = normalizeSpawnRelayInput({
    type: 'spawn',
    name: 'agent',
    modelOptions: { reasoning: 'low' },
    effort: 'high',
    temperature: 0.2,
    customFlag: 'kept',
    emptyValue: '',
    nullValue: null,
  })
  assert.deepEqual(normalized.modelOptions, {
    reasoning: 'low',
    effort: 'high',
    temperature: 0.2,
    customFlag: 'kept',
  })
})
