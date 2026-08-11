import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CANONICAL_REFERENCE_SOURCE,
  canonicalEventReference,
  canonicalSearchReference,
  parseCanonicalEventReference,
  parseCanonicalSearchReference,
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
  assert.deepEqual('see chat#2112060 and search#session:390868'.match(new RegExp(CANONICAL_REFERENCE_SOURCE, 'g')), [
    'chat#2112060', 'search#session:390868',
  ])
})

test('search references carry the result source inside the id', () => {
  assert.equal(canonicalSearchReference('msg', 2023209), 'search#msg:2023209')
  assert.deepEqual(parseCanonicalSearchReference('search#session:390868'), {
    source: 'session', id: 390868, canonical: 'search#session:390868',
  })
  assert.equal(parseCanonicalSearchReference('search#390868'), null)
})
