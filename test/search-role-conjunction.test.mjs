// `role:` must combine with the rest of the grammar.
//
// It is lifted out of the filter expression into its own wire parameter, and the
// join it was written with used to be left behind: `from:skip & role:user`
// produced the expression `"from: skip &"` and died on "unexpected end of",
// while `role:user & from:skip` produced a leading `&`. Measured against every
// other filter key in both orders on 2026-09-12, all twenty pairs were a parse
// error — so `role:` could not be combined with anything at all, and the error
// quoted the mangled internal string rather than what the caller typed.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFleetSearchFilters, parseSearchQuery } from '../shared/fleet-search-query.mjs';

const OTHER_KEYS = [
  'from:skip', 'to:skip', 'involving:skip', 'agent:skip', 'project:tlda',
  'since:2h', 'after:2h', 'before:1h', 'type:chat', 'id:12345',
];

test('role: conjoins with every other filter key, in either order', () => {
  for (const key of OTHER_KEYS) {
    for (const query of [`${key} & role:user`, `role:user & ${key}`]) {
      const filters = buildFleetSearchFilters(parseSearchQuery(query, {}).filters);
      // Both halves have to survive. Keeping the expression while losing `role`
      // would be the silent-wrong-answer version of the same bug.
      assert.equal(filters.role, 'user', `role lost in "${query}"`);
      assert.ok(filters.filterExpression, `filter expression lost in "${query}"`);
      assert.doesNotMatch(filters.filterExpression, /(^\s*&|&\s*$)/, `dangling & in "${query}"`);
    }
  }
});

test('a lone role: still carries, and still leaves no expression behind', () => {
  const filters = buildFleetSearchFilters(parseSearchQuery('role:user', {}).filters);
  assert.equal(filters.role, 'user');
});

// The refusal is the other half of the fix. `role` is ANDed against every match
// at the wire, so it can only narrow; there is no way to OR a wire parameter
// against an expression term. Treating `|` as `&` would answer a question the
// caller did not ask, which is the failure mode this whole pass is about.
test('role: under a disjunction is refused, in the caller\'s own words', () => {
  for (const query of ['from:skip | role:user', 'role:user | from:skip']) {
    assert.throws(() => parseSearchQuery(query, {}), (error) => {
      assert.match(error.message, /role:user/);
      assert.match(error.message, /cannot be combined/);
      // The old message quoted the half-built internal expression. The caller
      // can only act on what they typed.
      assert.match(error.message, new RegExp(query.replace(/[|]/g, '\\|')));
      return true;
    }, `"${query}" must be refused`);
  }
});

test('CONTROL: a pair with no role: term is unaffected', () => {
  const filters = buildFleetSearchFilters(parseSearchQuery('from:skip & type:chat', {}).filters);
  assert.equal(filters.eventType, 'chat');
  assert.match(filters.filterExpression, /from: skip & type:chat/);
});
