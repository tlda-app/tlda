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
import { parseFilter, addressTerms, dependencyTerms } from './fleet-labels.mjs'

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
