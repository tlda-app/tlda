import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeThreadFilterExpression } from './lib/thread-filter-normalize.mjs'

test('thread filter normalizer decodes escaped between operator from tool input', () => {
  assert.equal(
    normalizeThreadFilterExpression('outline-hands-opus &lt;&gt; skip'),
    'outline-hands-opus <> skip',
  )
})

test('thread filter normalizer preserves raw between operator', () => {
  assert.equal(
    normalizeThreadFilterExpression('outline-hands-opus <> skip'),
    'outline-hands-opus <> skip',
  )
})

test('thread filter normalizer decodes escaped boolean operators before parsing', () => {
  assert.equal(
    normalizeThreadFilterExpression('from:outline-hands-opus &amp; to:skip'),
    'from: outline-hands-opus & to: skip',
  )
})
