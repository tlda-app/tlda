import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CANONICAL_EVENT_REFERENCE_SOURCE,
  canonicalEventReference,
  parseCanonicalEventReference,
} from './canonical-references.mjs'

test('event references use the database type and integer id directly', () => {
  assert.equal(canonicalEventReference('chat', 2112060), 'chat#2112060')
  assert.deepEqual(parseCanonicalEventReference('task_done#42'), {
    type: 'task_done', id: 42, canonical: 'task_done#42',
  })
})

test('event references reject presentation payloads and non-integer ids', () => {
  assert.equal(parseCanonicalEventReference('msg:Skip#2112060'), null)
  assert.equal(parseCanonicalEventReference('chat#fleet:skip'), null)
})

test('reference matcher finds canonical references in ordinary text', () => {
  assert.deepEqual('see chat#2112060 and task#9'.match(new RegExp(CANONICAL_EVENT_REFERENCE_SOURCE, 'g')), [
    'chat#2112060', 'task#9',
  ])
})
