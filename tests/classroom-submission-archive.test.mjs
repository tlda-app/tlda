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

test('an archive with no .qmd, or more than one, is refused', () => {
  assert.equal(inspectSubmissionArchive(zip({ 'answers.docx': PNG })).ok, false)
  const two = inspectSubmissionArchive(zip({ 'a.qmd': strToU8(ANSWERED), 'b.qmd': strToU8(ANSWERED), 'markov.jpg': PNG }))
  assert.equal(two.ok, false)
  assert.match(two.errors.join(' '), /exactly one/)
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
