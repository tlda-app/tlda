// A token one keystroke off a filter key must not become free text.
//
// `sinse:2h build` searched for the literal string "sinse:2h" and answered "No
// results" — the caller's time bound was read as a word and nothing said so.
// That is the worst shape of the dropped-term bug: a confident, well-formed,
// wrong answer. Meanwhile `from:X & build` was REFUSED for juxtaposition, so
// the grammar's strictness was landing on the correct query and not the typo.
//
// The check is a NEAR-miss test on purpose. "Any word: that is not a filter
// key" would swallow `https://…` and every colon in prose, and refusing those
// would break searching for text that contains one.
import assert from 'node:assert/strict';
import test from 'node:test';

import { nearestFilterKey, parseSearchQuery } from '../shared/fleet-search-query.mjs';

test('a near-miss filter key is refused, and names what it meant', () => {
  const cases = [
    ['sinse:2h', 'since'],
    ['sinse:2h build', 'since'],
    // A transposition is the commonest typo and scores 2 under plain
    // Levenshtein, so this one is the reason the distance is Damerau.
    ['form:skip', 'from'],
    ['fom:skip', 'from'],
    ['typ:chat', 'type'],
    ['proj:tlda', 'project'],
    ['befor:1h', 'before'],
  ];
  for (const [query, meant] of cases) {
    assert.throws(() => parseSearchQuery(query, {}), (error) => {
      assert.match(error.message, new RegExp(`did you mean "${meant}:"`));
      // It must also say how to search for it as text, or the refusal just
      // replaces a silent wrong answer with a dead end.
      assert.match(error.message, /quote it/);
      return true;
    }, `"${query}" must be refused`);
  }
});

test('CONTROL: ordinary text containing a colon is still searchable', () => {
  // Each of these would be refused by a "not a known key" test, and each is a
  // thing someone will really type into search.
  const allowed = [
    'https://example.com/x',
    'note: see this',
    'ratio 3:1',
    'C:\\path',
    'TODO:',
    'x:y',
    'fleet:skip',
  ];
  for (const query of allowed) {
    assert.doesNotThrow(() => parseSearchQuery(query, {}), `"${query}" must stay searchable`);
  }
});

test('CONTROL: quoting a near-miss states it is text, and is honoured', () => {
  const parsed = parseSearchQuery('"sinse:2h"', {});
  assert.equal(parsed.query, 'sinse:2h');
});

test('CONTROL: real filter keys are untouched', () => {
  for (const query of ['from:skip', 'since:2h', 'type:chat', 'project:tlda']) {
    assert.doesNotThrow(() => parseSearchQuery(query, {}));
    assert.equal(nearestFilterKey(query), null);
  }
});
