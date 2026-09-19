// A thread card re-runs the filter its stored tool input carried, so an escaped
// filter reaches the grammar and the reader is told `juxtaposition is not valid
// syntax in "skip &lt;&gt; staff-lead"` — the grammar blamed for something it
// did not do.
//
// The escaping is not this app's doing. The live store holds the tool input
// already escaped, while 39,742 stored events carry a raw `<>` without trouble,
// so a caller passed text copied out of rendered output.
//
// These tests pin the two properties that make decoding safe rather than
// permissive: it recovers exactly the expression that was meant, and it does
// not make anything parse that should not.

import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeFilterEntities, parseMessageFilter, parseFilter } from '../shared/fleet-labels.mjs'

test('the reported filter parses after decoding and not before', () => {
  const escaped = 'skip &lt;&gt; staff-lead'
  // Precondition: this is the exact failure, in both grammars.
  assert.throws(() => parseMessageFilter(escaped), /juxtaposition is not valid syntax/)
  assert.throws(() => parseFilter(escaped), /juxtaposition is not valid syntax/)

  const decoded = decodeFilterEntities(escaped)
  assert.equal(decoded, 'skip <> staff-lead')
  assert.doesNotThrow(() => parseMessageFilter(decoded))
  assert.doesNotThrow(() => parseFilter(decoded))
})

test('an ordinary filter is returned untouched', () => {
  for (const s of ['skip <> staff-lead', 'awake & reviewers', 'mathy & !goose', 'fleet:77274c1e', '']) {
    assert.equal(decodeFilterEntities(s), s, `must not alter: ${JSON.stringify(s)}`)
  }
})

test('a double escape comes back one layer, not two', () => {
  // `&amp;` decodes last for this reason. Collapsing `&amp;lt;` straight to `<`
  // would invent a bracket the caller never wrote.
  assert.equal(decodeFilterEntities('skip &amp;lt;&amp;gt; staff-lead'), 'skip &lt;&gt; staff-lead')
})

test('decoding does not make a genuinely malformed filter parse', () => {
  // The point of the error is that it catches corrupt queries. Decoding must
  // not turn one into a successful query with confidently wrong results.
  const stillBroken = 'skip staff-lead'
  assert.equal(decodeFilterEntities(stillBroken), stillBroken)
  assert.throws(() => parseMessageFilter(stillBroken), /juxtaposition is not valid syntax/)
})

test('the other escapes a renderer produces are handled', () => {
  assert.equal(decodeFilterEntities('a &quot;b&quot; c'), 'a "b" c')
  assert.equal(decodeFilterEntities('it&#39;s'), "it's")
})
