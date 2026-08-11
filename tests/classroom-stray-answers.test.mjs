import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { zipSync } from 'fflate'
import { strayAnswers, inspectSubmissionArchive, parseQmdReferences } from '../server/lib/classroom-submission.mjs'

// Both fixtures are Skip's own homework through his own bin/make-handout.py.
// They are here because the two documents fail differently: in hw9 an answer
// block is followed by the next exercise, and in week 0 it is followed by his
// narrative prose and {r} chunks. A check built against either one alone looks
// correct and is wrong on the other.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const hw9 = readFileSync(join(fixtures, 'hw9-causality.handout.qmd'), 'utf8')
const week0 = readFileSync(join(fixtures, 'week0-homework.handout.qmd'), 'utf8')

const underTheBox = (source, answer = 'The answer is 42.') =>
  source.replace(/(\*\(your answer here\)\*\n\n:::)/, `$1\n\n${answer}\n`)

test('an untouched handout is never refused', () => {
  // This is the regression. The shape-based version refused four blocks of
  // week 0 before a student had typed anything, because prose under an answer
  // block is his document continuing, not a misplaced answer.
  assert.deepEqual(strayAnswers(week0, week0), [])
  assert.deepEqual(strayAnswers(hw9, hw9), [])
})

test('an answer typed under the box is caught and quoted back', () => {
  const found = strayAnswers(underTheBox(hw9), hw9)
  assert.equal(found.length, 1)
  assert.match(found[0].id, /^ans-/)
  assert.equal(found[0].firstLine, 'The answer is 42.')
})

test('it is caught in the narrative document too', () => {
  const found = strayAnswers(underTheBox(week0), week0)
  assert.equal(found.length, 1)
  assert.equal(found[0].firstLine, 'The answer is 42.')
})

test('an answer inside the box is not a stray answer', () => {
  const answered = hw9.replace('*(your answer here)*', 'The ATE is the average of the individual effects.')
  assert.deepEqual(strayAnswers(answered, hw9), [])
})

test('without a template it makes no claim', () => {
  // The extension runs offline and has no handout to compare against. Silence
  // is the required behaviour there: a guess refuses correct work.
  assert.deepEqual(strayAnswers(underTheBox(week0)), [])
  assert.deepEqual(strayAnswers(week0), [])
})

test('a skipped question is allowed', () => {
  // Leaving a block untouched is not an error — plenty of students hand in
  // partial work, and refusing it would be refusing the hand-in itself.
  assert.deepEqual(strayAnswers(hw9, hw9), [])
})

test('the upload refuses the archive and names the exercise', () => {
  const archive = zipSync({ 'hw9-causality.qmd': new Uint8Array(Buffer.from(underTheBox(hw9))) })
  const rejected = inspectSubmissionArchive(archive, { template: hw9 })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.errors.length, 1)
  assert.match(rejected.errors[0], /underneath the answer box/)
  assert.match(rejected.errors[0], /Move it between the `:::` lines/)

  // Same bytes, no frozen template: it must still be accepted rather than
  // guessed at.
  assert.equal(inspectSubmissionArchive(archive).ok, true)
})

test('an image shown in backticks is not a missing image', () => {
  // His week 0 "How to Submit" tells students to write `![](my-photo.png)`.
  // Reading that as a real reference refused every hand-in for the assignment
  // over a photo that never existed — and unlike the stray-answer check, this
  // one was already live.
  const shown = 'To include a photo, write `![](my-photo.png)` with your filename.\n'
  assert.deepEqual(parseQmdReferences(shown).images, [])

  const fenced = '```markdown\n![](example.png)\n```\n'
  assert.deepEqual(parseQmdReferences(fenced).images, [])

  // A real reference still counts, including one beside a shown example.
  assert.deepEqual(parseQmdReferences(`${shown}![](actual-photo.png)\n`).images, ['actual-photo.png'])
})

test('an untouched handout uploads clean', () => {
  for (const [name, source] of [['hw9-causality.qmd', hw9], ['week0-homework.qmd', week0]]) {
    const archive = zipSync({ [name]: new Uint8Array(Buffer.from(source)) })
    const inspection = inspectSubmissionArchive(archive, { template: source })
    assert.deepEqual(inspection.errors, [], `${name} should upload clean`)
    assert.ok(inspection.answerIds.length > 0, `${name} should carry answer ids`)
  }
})
