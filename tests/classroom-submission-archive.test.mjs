import test from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import { inspectSubmissionArchive } from '../server/lib/classroom-submission.mjs'

// Accepting or rejecting a student's submitted work wrongly is silent and
// destructive in both directions: a refused valid archive costs them a
// resubmission they may not be around to make, and an accepted broken one
// surfaces as a blank answer at marking time, reading as if they never tried.
// That is why this one has a test and the surrounding plumbing does not.

const PNG = new Uint8Array([137, 80, 78, 71])
const ANSWERED = `## Problem 1 {#exr-bias}
::: {#ans-exr-bias .callout-answer}
Did this on paper:
![my work](markov.jpg)
:::`

const zip = files => zipSync(files)

test('a complete archive is accepted and yields its answer ids', () => {
  const result = inspectSubmissionArchive(zip({ 'hw5.qmd': strToU8(ANSWERED), 'markov.jpg': PNG }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.answerIds, ['ans-exr-bias'])
  assert.equal(result.qmdPath, 'hw5.qmd')
})

test('a missing photo is refused and named, because the fix is theirs to make', () => {
  const result = inspectSubmissionArchive(zip({ 'hw5.qmd': strToU8(ANSWERED) }))
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /markov\.jpg/)
})

test('a zipped folder is accepted — that is what compressing a folder produces', () => {
  const result = inspectSubmissionArchive(zip({ 'hw5/hw5.qmd': strToU8(ANSWERED), 'hw5/markov.jpg': PNG }))
  assert.equal(result.ok, true, result.errors.join(' '))
})

test('macOS archive junk does not count against them', () => {
  const result = inspectSubmissionArchive(zip({
    'hw5.qmd': strToU8(ANSWERED), 'markov.jpg': PNG, '__MACOSX/._hw5.qmd': PNG, '.DS_Store': PNG,
  }))
  assert.equal(result.ok, true, result.errors.join(' '))
})

test('an archive with no answer-bearing QMD, or more than one, is refused', () => {
  assert.equal(inspectSubmissionArchive(zip({ 'answers.docx': PNG })).ok, false)
  const two = inspectSubmissionArchive(zip({ 'a.qmd': strToU8(ANSWERED), 'b.qmd': strToU8(ANSWERED), 'markov.jpg': PNG }))
  assert.equal(two.ok, false)
  assert.match(two.errors.join(' '), /one assignment QMD/)
})

test('included QMD files are accepted and their dependency closure is checked', () => {
  const root = `${ANSWERED}\n{{< include parts/shared.qmd >}}`
  const shared = '{{< include nested.qmd >}}\n![](inside.png)'
  const complete = inspectSubmissionArchive(zip({
    'hw5.qmd': strToU8(root),
    'markov.jpg': PNG,
    'parts/shared.qmd': strToU8(shared),
    'parts/nested.qmd': strToU8('Shared text.'),
    'parts/inside.png': PNG,
  }))
  assert.equal(complete.ok, true, complete.errors.join(' '))
  assert.equal(complete.qmdPath, 'hw5.qmd')

  const missing = inspectSubmissionArchive(zip({
    'hw5.qmd': strToU8(root),
    'markov.jpg': PNG,
    'parts/shared.qmd': strToU8(shared),
  }))
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join(' '), /nested\.qmd/)
  assert.match(missing.errors.join(' '), /inside\.png/)
})

test('replacing the answer callouts instead of filling them in is refused', () => {
  const result = inspectSubmissionArchive(zip({ 'hw5.qmd': strToU8('# my answers\nThe estimator is unbiased.') }))
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /answer blocks/)
})

test('a remote image is not mistaken for a missing one', () => {
  const result = inspectSubmissionArchive(zip({
    'hw5.qmd': strToU8('::: {#ans-a .callout-answer}\n![](https://example.test/plot.png)\n:::'),
  }))
  assert.equal(result.ok, true, result.errors.join(' '))
})

test('something that is not a zip is reported, not thrown', () => {
  const result = inspectSubmissionArchive(Buffer.from('this is my homework, sorry'))
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /not a readable zip/)
})

test('an entry escaping the archive root is refused', () => {
  const result = inspectSubmissionArchive(zip({ '../../etc/passwd': PNG }))
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /unsafe/)
})

// A filter the archive does not carry was fatal in a way a missing image is
// not: pandoc refuses the render outright, AFTER the whole document has
// knitted, so the work is complete and the page is lost. Measured on a real
// submission: 33 of 33 chunks executed, then `cannot open
// …answer-placement-warning.lua`, zero pages.
//
// INTAKE MUST NOT REFUSE WHAT THE RENDER PATH TOLERATES, and that is the rule
// these tests now hold. `withoutAbsentSupportFilters` drops an absent
// `<stem>.qmd.support/` filter from the build copy, because it is generated
// tooling that does nothing to the output. Refusing the same archive here left
// one real hand-in renderable and un-re-submittable at once — intake is the only
// route to a new revision, so there was no way to re-run its build at all. The
// two rules were written independently nine minutes apart and disagreed
// immediately; both now read `isGeneratedSupportFilter`.
//
// Every other missing filter is still refused. `solution-callout.lua` is what
// folds the solutions away, so a page rendered without it says something
// different. Refusing costs a re-zip; accepting costs the mark.

const FILTERED = `---
title: "Homework"
filters:
  - "solution-callout.lua"
  - "hw5.qmd.support/answer-placement-warning.lua"
---

${ANSWERED}`

const LUA = strToU8('function Meta(meta) return nil end\n')

test('an archive carrying the filters its front matter names is accepted', () => {
  const result = inspectSubmissionArchive(zip({
    'hw5.qmd': strToU8(FILTERED),
    'markov.jpg': PNG,
    'solution-callout.lua': LUA,
    'hw5.qmd.support/answer-placement-warning.lua': LUA,
  }))
  assert.equal(result.ok, true, result.errors.join(' '))
  assert.deepEqual(result.answerIds, ['ans-exr-bias'])
})

// This is the archive of the one real hand-in on the box, 2026-09-18: the
// document names its generated support filter and the zip does not carry the
// directory. It must be accepted, because the render drops that filter.
test('a missing support-directory filter is accepted, because the render drops it', () => {
  const result = inspectSubmissionArchive(zip({
    'hw5.qmd': strToU8(FILTERED),
    'markov.jpg': PNG,
    'solution-callout.lua': LUA,
  }))
  assert.equal(result.ok, true, result.errors.join(' '))
  assert.deepEqual(result.answerIds, ['ans-exr-bias'])
})

test('a missing filter outside the support directory is still refused and named', () => {
  const result = inspectSubmissionArchive(zip({
    'hw5.qmd': strToU8(FILTERED),
    'markov.jpg': PNG,
    'hw5.qmd.support/answer-placement-warning.lua': LUA,
  }))
  assert.equal(result.ok, false, 'a missing solution-callout.lua changes what the page says')
  assert.match(result.errors.join(' '), /solution-callout\.lua/)
  // And it must not blame the filter that is allowed to be absent.
  assert.doesNotMatch(result.errors.join(' '), /answer-placement-warning\.lua/)
})

test('a filter is resolved beside the qmd, so a zipped folder still passes', () => {
  const result = inspectSubmissionArchive(zip({
    'hw5/hw5.qmd': strToU8(FILTERED),
    'hw5/markov.jpg': PNG,
    'hw5/solution-callout.lua': LUA,
    'hw5/hw5.qmd.support/answer-placement-warning.lua': LUA,
  }))
  assert.equal(result.ok, true, result.errors.join(' '))
})

test('a remote filter is not demanded of the archive', () => {
  const remote = `---
filters:
  - "https://example.com/filter.lua"
---

${ANSWERED}`
  const result = inspectSubmissionArchive(zip({ 'hw5.qmd': strToU8(remote), 'markov.jpg': PNG }))
  assert.equal(result.ok, true, result.errors.join(' '))
})
