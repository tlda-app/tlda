import test from 'node:test'
import assert from 'node:assert/strict'

import { RETIRED_MODEL_ALIASES, resolveModelAlias } from './model-alias-history.mjs'

test('a retired alias resolves to the alias that replaced it', () => {
  assert.equal(resolveModelAlias('muse-meta'), 'muse')
})

test('a live alias resolves to itself', () => {
  assert.equal(resolveModelAlias('muse'), 'muse')
  assert.equal(resolveModelAlias('opus'), 'opus')
})

test('unknown strings pass through untouched', () => {
  assert.equal(resolveModelAlias('sonnet-4-5-20250929'), 'sonnet-4-5-20250929')
  assert.equal(resolveModelAlias(''), '')
})

test('nullish input passes through for the caller to handle', () => {
  assert.equal(resolveModelAlias(null), null)
  assert.equal(resolveModelAlias(undefined), undefined)
})

test('every map value is a string (a live alias, not a chain)', () => {
  for (const [retired, current] of Object.entries(RETIRED_MODEL_ALIASES)) {
    assert.equal(typeof current, 'string', retired)
    assert.ok(!Object.hasOwn(RETIRED_MODEL_ALIASES, current), `${retired} chains to ${current}`)
  }
})
