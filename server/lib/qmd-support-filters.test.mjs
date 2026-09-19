// Dropping a handout's student-side filter from a document that did not bring
// it — and, more importantly, NOT dropping anything else.
//
// The front matter here is the real one, copied from a generated handout:
// `solution-callout.lua` and the support-directory warning filter sit in the
// same `filters:` list. `solution-callout.lua` is what folds the solutions, so
// the assertion that it survives is the one that keeps this from silently
// changing what a page says.

import test from 'node:test'
import assert from 'node:assert/strict'
import { withoutAbsentSupportFilters } from './qmd-support-filters.mjs'

const HANDOUT = `---
title: "Homework: The Idea of Calibration"
tlda-answer-baseline: "homework-calibration.qmd.support/baseline.txt"
filters:
  - "solution-callout.lua"
  - "homework-calibration.qmd.support/answer-placement-warning.lua"
---

Body text stays exactly as it was.
`

const present = () => true
const absent = () => false

test('an absent support filter is dropped and the real filter is kept', () => {
  const { text, dropped } = withoutAbsentSupportFilters(HANDOUT, path => path === 'solution-callout.lua')
  assert.deepEqual(dropped, ['homework-calibration.qmd.support/answer-placement-warning.lua'])
  assert.ok(text.includes('- "solution-callout.lua"'), 'solution-callout.lua must survive')
  assert.ok(!text.includes('answer-placement-warning.lua'))
  assert.ok(text.includes('Body text stays exactly as it was.'))
  assert.ok(text.includes('title: "Homework: The Idea of Calibration"'))
})

test('a support filter that is present is left alone', () => {
  const { text, dropped } = withoutAbsentSupportFilters(HANDOUT, present)
  assert.deepEqual(dropped, [])
  assert.equal(text, HANDOUT)
})

test('a missing filter outside a support directory is never dropped', () => {
  // The whole scoping decision, asserted. Everything is absent, and only the
  // support-directory entry goes.
  const { text, dropped } = withoutAbsentSupportFilters(HANDOUT, absent)
  assert.deepEqual(dropped, ['homework-calibration.qmd.support/answer-placement-warning.lua'])
  assert.ok(text.includes('- "solution-callout.lua"'))
})

test('emptying the list removes the key, because a null `filters:` is rejected', () => {
  const onlySupport = `---
title: "T"
filters:
  - "hw.qmd.support/answer-placement-warning.lua"
execute:
  cache: true
---

Body.
`
  const { text, dropped } = withoutAbsentSupportFilters(onlySupport, absent)
  assert.deepEqual(dropped, ['hw.qmd.support/answer-placement-warning.lua'])
  assert.ok(!/filters\s*:/.test(text), 'an emptied filters key must not be left behind')
  assert.ok(text.includes('execute:'), 'the following key must survive')
  assert.ok(text.includes('cache: true'))
  assert.ok(text.includes('Body.'))
})

test('a document with no front matter, or no filters, is returned unchanged', () => {
  for (const text of ['Just a body.\n', '---\ntitle: "T"\n---\n\nBody.\n']) {
    const result = withoutAbsentSupportFilters(text, absent)
    assert.equal(result.text, text)
    assert.deepEqual(result.dropped, [])
  }
})

test('an unquoted list item is handled too', () => {
  const unquoted = `---
filters:
  - solution-callout.lua
  - hw.qmd.support/answer-placement-warning.lua
---

Body.
`
  const { text, dropped } = withoutAbsentSupportFilters(unquoted, path => path === 'solution-callout.lua')
  assert.deepEqual(dropped, ['hw.qmd.support/answer-placement-warning.lua'])
  assert.ok(text.includes('- solution-callout.lua'))
})

test('a support path appearing outside the filters block is not touched', () => {
  // `tlda-answer-baseline` names a file in the same directory. It is metadata
  // the filter reads, not a filter, and removing it would be a different change.
  const { text } = withoutAbsentSupportFilters(HANDOUT, absent)
  assert.ok(text.includes('tlda-answer-baseline: "homework-calibration.qmd.support/baseline.txt"'))
})
