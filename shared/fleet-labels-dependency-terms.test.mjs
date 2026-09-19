// `addressTerms` and `dependencyTerms` answer two questions that agree on every
// expression without a negation. That agreement is the hazard: a cache keyed on
// the addressing question looks correct until someone writes `!someone`, and
// then serves a stale set forever without erroring.
//
// These tests exist to make the divergence fail loudly rather than be noticed
// six months later, so the negation cases are the point and the agreeing cases
// are here to show the two are not simply the same function.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFilter, addressTerms, dependencyTerms, canonicalAstKey } from './fleet-labels.mjs'

// `canonicalAstKey` exists because the obvious one-liner is wrong in a way that
// produces no error: `JSON.stringify(ast, Object.keys(ast).sort())` treats its
// second argument as a property ALLOWLIST applied at every depth, so only the
// top node's key names survive anywhere in the tree. Two different expressions
// then key to the same cache entry and one silently gets the other's answer.
test('two expressions differing only in a nested literal get different keys', () => {
  const a = canonicalAstKey(parseFilter('awake & sleeper'))
  const b = canonicalAstKey(parseFilter('hibernating & sleeper'))
  assert.notEqual(a, b, 'nested literal values must survive into the key')
  assert.ok(a.includes('awake'), 'the key must actually carry the literal')
})

test('the same expression written two ways gets the same key', () => {
  assert.equal(
    canonicalAstKey(parseFilter('mathy & reviewers')),
    canonicalAstKey(parseFilter('mathy  &  reviewers')),
    'whitespace is not part of the expression',
  )
})

const sorted = set => [...set].sort()

test('a negated term is not addressed but IS depended on', () => {
  const ast = parseFilter('awake & !goose')
  // `!goose` says who is excluded, not who was written to.
  assert.deepEqual(sorted(addressTerms(ast)), ['awake'])
  // But relabelling goose changes who this resolves to, so the cache must know.
  assert.deepEqual(sorted(dependencyTerms(ast)), ['awake', 'goose'])
})

test('the two agree when nothing is negated — which is why the bug hides', () => {
  for (const expr of ['helm | skip', 'awake & reviewers', 'fleet:77274c1e', 'mathy & (helm | skip)']) {
    const ast = parseFilter(expr)
    assert.deepEqual(
      sorted(addressTerms(ast)),
      sorted(dependencyTerms(ast)),
      `expected agreement with no negation present: ${expr}`,
    )
  }
})

test('a doubly negated term is addressed again, and still depended on', () => {
  const ast = parseFilter('!!goose')
  assert.deepEqual(sorted(addressTerms(ast)), ['goose'])
  assert.deepEqual(sorted(dependencyTerms(ast)), ['goose'])
})

test('every literal under a negated group is depended on', () => {
  const ast = parseFilter('awake & !(goose | helm)')
  assert.deepEqual(sorted(addressTerms(ast)), ['awake'])
  assert.deepEqual(sorted(dependencyTerms(ast)), ['awake', 'goose', 'helm'])
})

test('an empty expression names nothing and depends on nothing', () => {
  // A null AST matches everything, so it has no terms to key on. A cache must
  // treat it as uncacheable-by-term rather than as an empty dependency set that
  // nothing can ever invalidate.
  assert.deepEqual(sorted(addressTerms(parseFilter(''))), [])
  assert.deepEqual(sorted(dependencyTerms(parseFilter(''))), [])
})
