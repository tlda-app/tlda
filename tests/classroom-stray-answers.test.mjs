import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { zipSync } from 'fflate'
import { strayAnswers, inspectSubmissionArchive, parseQmdReferences, missingAnswers, missingExercises } from '../server/lib/classroom-submission.mjs'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'
import { createClassroomRouter } from '../server/routes/classroom.mjs'

// Both fixtures are Skip's own homework through his own bin/make-handout.py.
// They are here because the two documents fail differently: in hw9 an answer
// block is followed by the next exercise, and in week 0 it is followed by his
// narrative prose and {r} chunks. A check built against either one alone looks
// correct and is wrong on the other.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const hw9 = readFileSync(join(fixtures, 'hw9-causality.handout.qmd'), 'utf8')
const week0 = readFileSync(join(fixtures, 'week0-homework.handout.qmd'), 'utf8')
const sharedCode = new Uint8Array(Buffer.from('Shared setup.'))

const underTheBox = (source, answer = 'The answer is 42.') =>
  source.replace(/(\*\(your answer here\)\*\n\n:::)/, `$1\n\n${answer}\n`)

test('an untouched handout is never refused', () => {
  // This is the regression. The shape-based version refused four blocks of
  // week 0 before a student had typed anything, because prose under an answer
  // block is his document continuing, not a misplaced answer.
  assert.deepEqual(strayAnswers(week0, week0), [])
  assert.deepEqual(strayAnswers(hw9, hw9), [])
})

// A deleted answer block used to pass validation and surface as a blank at
// marking time — or, once a student can read their work beside the solution, as
// "nothing for this question" long after they could fix it.
const deleteAnswerBlock = (source, id) =>
  source.replace(new RegExp(`:::\\s*\\{[^}]*#${id}[^}]*\\}[\\s\\S]*?\\n:::\\n`), '')

test('a handout nobody has touched is missing nothing', () => {
  assert.deepEqual(missingAnswers(hw9, parseQmdReferences(hw9).answerIds), [])
  assert.deepEqual(missingAnswers(week0, parseQmdReferences(week0).answerIds), [])
})

test('an answer block the student deleted is caught and the exercise named', () => {
  for (const [name, source] of [['hw9', hw9], ['week 0', week0]]) {
    const id = parseQmdReferences(source).answerIds[0]
    const without = deleteAnswerBlock(source, id)
    // The control: the deletion has to actually remove it, or the test proves nothing.
    assert.ok(!parseQmdReferences(without).answerIds.includes(id), `${name}: fixture edit removed ${id}`)
    assert.deepEqual(missingAnswers(source, parseQmdReferences(without).answerIds), [id], `${name}: names the deleted block`)
  }
})

test('the refusal reaches the student as a sentence naming the exercise', () => {
  const id = parseQmdReferences(hw9).answerIds[0]
  const without = deleteAnswerBlock(hw9, id)
  const result = inspectSubmissionArchive(zipSync({ 'hw9.qmd': new Uint8Array(Buffer.from(without)) }), { template: hw9 })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.includes(id.replace(/^ans-/, ''))), result.errors.join(' | '))
  // Same bytes with no template vouching for anything: it cannot claim a block
  // is missing, so it must not.
  const unvouched = inspectSubmissionArchive(zipSync({ 'hw9.qmd': new Uint8Array(Buffer.from(without)) }))
  assert.ok(!unvouched.errors.some(error => error.includes('missing the answer')), unvouched.errors.join(' | '))
})

const deleteBlock = (source, id) =>
  source.replace(new RegExp(`:::\\s*\\{[^}]*#${id}[^}]*\\}[\\s\\S]*?\\n:::\\n`), '')

test('a deleted question block is caught too, in both documents', () => {
  for (const [name, source] of [['hw9', hw9], ['week 0', week0]]) {
    const id = parseQmdReferences(source).exerciseIds[0]
    const without = deleteBlock(source, id)
    assert.ok(!parseQmdReferences(without).exerciseIds.includes(id), `${name}: fixture edit removed ${id}`)
    assert.deepEqual(missingExercises(source, parseQmdReferences(without).exerciseIds), [id], `${name}: names the deleted question`)
  }
  assert.deepEqual(missingExercises(hw9, parseQmdReferences(hw9).exerciseIds), [])
  assert.deepEqual(missingExercises(week0, parseQmdReferences(week0).exerciseIds), [])
})

test('the student is told which question they deleted', () => {
  const id = parseQmdReferences(hw9).exerciseIds[0]
  const without = deleteBlock(hw9, id)
  const result = inspectSubmissionArchive(zipSync({ 'hw9.qmd': new Uint8Array(Buffer.from(without)) }), { template: hw9 })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.includes('question') && error.includes(id)), result.errors.join(' | '))
  // Without a template there is nothing vouching for that question, so no claim.
  const unvouched = inspectSubmissionArchive(zipSync({ 'hw9.qmd': new Uint8Array(Buffer.from(without)) }))
  assert.ok(!unvouched.errors.some(error => error.includes('missing the question')), unvouched.errors.join(' | '))
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
  const archive = zipSync({
    'hw9-causality.qmd': new Uint8Array(Buffer.from(underTheBox(hw9))),
    'shared-code.qmd': sharedCode,
  })
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
    const archive = zipSync({ [name]: new Uint8Array(Buffer.from(source)), 'shared-code.qmd': sharedCode })
    const inspection = inspectSubmissionArchive(archive, { template: source })
    assert.deepEqual(inspection.errors, [], `${name} should upload clean`)
    assert.ok(inspection.answerIds.length > 0, `${name} should carry answer ids`)
  }
})

test('an edit to the handout after the freeze is not blamed on the student', async () => {
  // The freeze names a revision, not a fingerprint. An instructor who fixes a
  // typo in the handout after students have started must not turn every
  // hand-in into a refusal: the comparison stays at the revision they were
  // given. Reading current source here was the defect this test pins.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-freeze-'))
  const store = new ClassroomStore(path.join(dir, 'classroom.db'))
  try {
    store.upsertCourse({ id: 'qtm285', title: 'QTM 285' })
    store.upsertAssignment({ id: 'hw9', courseId: 'qtm285', title: 'Homework 9', dueAt: '2026-09-01T20:00:00Z' })
    store.freezeTemplate('hw9', { templateDocKey: 'hw9-handout', templateVersion: 'rev-at-freeze' })

    // Current source has moved on: the instructor reworded narrative prose
    // that sits under an answer block. Against that revision the student's
    // own untouched copy of that prose is text the handout does not contain —
    // which is exactly what the check calls an answer typed under the box.
    const prose = week0.match(/:::\n\n([^:#\n][^\n]{25,})/)[1]
    const revisions = {
      'rev-at-freeze': week0,
      'rev-now': week0.replace(prose, 'Reworded after the freeze.'),
    }
    assert.equal(strayAnswers(week0, revisions['rev-now']).length, 1, 'the edit must be one the check would flag')
    const upload = async resolveTemplateSource => {
      const app = express(); app.use(express.json())
      app.use('/api/classroom', createClassroomRouter({
        store,
        resolvePrincipal: () => ({ role: 'student', studentId: 'ada', courseId: 'qtm285' }),
        resolveTemplateSource,
        submitSubmissionSource: async () => ({ status: 200, body: { ok: true } }),
      }))
      const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
      try {
        const archive = zipSync({
          'week0-homework.qmd': new Uint8Array(Buffer.from(week0)),
          'shared-code.qmd': sharedCode,
        })
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/classroom/assignments/hw9/submissions/ada/upload`, {
          method: 'POST', headers: { 'content-type': 'application/zip' }, body: archive,
        })
        return { status: response.status, body: await response.json().catch(() => ({})) }
      } finally { server.close() }
    }

    // Positive control: pointed at current source, the check does fire and does
    // refuse this hand-in. Without this the assertion below passes on a route
    // that never reached the check at all.
    const againstCurrent = await upload(async () => revisions['rev-now'])
    assert.equal(againstCurrent.status, 422, 'the current revision should refuse this hand-in')
    assert.match(againstCurrent.body.problems[0], /underneath the answer box/)

    // The real assertion: resolving the stored version leaves it accepted.
    const againstFrozen = await upload(async (docKey, version) => revisions[version])
    assert.notEqual(againstFrozen.status, 422, `the hand-in was refused: ${JSON.stringify(againstFrozen.body.problems || againstFrozen.body)}`)
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
