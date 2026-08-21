import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-'))
  const store = new ClassroomStore(path.join(dir, 'classroom.db'))
  store.upsertCourse({ id: 'qtm285', title: 'QTM 285' })
  store.upsertStudent({ id: 'ada', courseId: 'qtm285', displayName: 'Ada', enrollmentToken: 'ada-secret' })
  store.upsertStudent({ id: 'grace', courseId: 'qtm285', displayName: 'Grace', enrollmentToken: 'grace-secret' })
  store.upsertAssignment({ id: 'hw1', courseId: 'qtm285', title: 'Homework 1', dueAt: '2026-09-01T20:00:00Z', sourceDocKey: 'hw1-source', handoutFilter: 'homework/assignment-callout.lua', solutionFilter: 'homework/solution-callout.lua', solutionsDocKey: 'hw1-solutions', solutionsVersion: 'abc' })
  return { store, close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('gradebook derives missing and ungraded states from roster and submissions', () => {
  const f = fixture()
  try {
    f.store.submit({ assignmentId: 'hw1', studentId: 'ada', contentRef: 'hw1-ada', submittedAt: '2026-08-31T12:00:00Z' })
    const status = f.store.status('qtm285')
    assert.deepEqual(status.counts, { missing: 1, ungraded: 1, graded: 0, returned: 0 })
    assert.equal(status.rows.find(r => r.id === 'ada').assignments[0].state, 'ungraded')
    assert.equal(status.rows.find(r => r.id === 'grace').assignments[0].state, 'not-submitted')
  } finally { f.close() }
})

test('a common-layer student is an ordinary roster member through missing, submission, and marking', () => {
  const f = fixture()
  try {
    const demo = f.store.upsertStudent({
      id: 'demo', courseId: 'qtm285', displayName: 'Demo Student', enrollmentToken: 'demo-secret', layerScope: 'common',
    })
    assert.equal(demo.layerScope, 'common')
    assert.equal(f.store.studentForToken('demo-secret').layerScope, 'common')
    assert.equal(f.store.status('qtm285').rows.find(row => row.id === 'demo').assignments[0].state, 'not-submitted')

    f.store.submit({ assignmentId: 'hw1', studentId: 'demo', contentRef: 'hw1-demo', answerIds: ['ans-p1'] })
    assert.equal(f.store.status('qtm285').rows.find(row => row.id === 'demo').assignments[0].state, 'ungraded')
    const answer = f.store.problems('hw1').problems[0].answers.find(row => row.studentId === 'demo')
    assert.equal(answer.layerScope, 'common')
    f.store.setStatus('hw1', 'demo', 'graded')
    assert.equal(f.store.getSubmission('hw1', 'demo').gradingStatus, 'graded')
  } finally { f.close() }
})

test('generated handout reference freezes once per assignment', () => {
  const f = fixture()
  try {
    const frozen = f.store.freezeTemplate('hw1', { templateDocKey: 'hw1-handout', templateVersion: 'handout-build-abc' })
    assert.equal(frozen.templateDocKey, 'hw1-handout')
    assert.equal(frozen.templateVersion, 'handout-build-abc')
    assert.deepEqual(f.store.freezeTemplate('hw1', { templateDocKey: 'hw1-handout', templateVersion: 'handout-build-abc' }), frozen)
    assert.throws(() => f.store.freezeTemplate('hw1', { templateDocKey: 'changed', templateVersion: 'changed' }), /already frozen/)
  } finally { f.close() }
})

test('return transaction exposes attached feedback and advances lifecycle', () => {
  const f = fixture()
  try {
    f.store.submit({ assignmentId: 'hw1', studentId: 'ada', contentRef: 'hw1-ada' })
    f.store.addFeedback({ id: 'attached', assignmentId: 'hw1', studentId: 'ada', title: 'Sign', text: 'Check the sign.', attached: true })
    f.store.addFeedback({ id: 'loose', assignmentId: 'hw1', studentId: 'ada', title: 'Later', text: 'Private note.', attached: false })
    f.store.returnFeedback('hw1', 'ada', '2026-09-02T12:00:00Z')
    const student = f.store.getSubmission('hw1', 'ada')
    const instructor = f.store.getSubmission('hw1', 'ada', { includeDrafts: true })
    assert.equal(student.gradingStatus, 'returned')
    assert.deepEqual(student.feedback.map(x => x.id), ['attached'])
    assert.deepEqual(instructor.feedback.map(x => x.id), ['attached', 'loose'])
    assert.equal(instructor.feedback.find(x => x.id === 'loose').visibility, 'instructor-draft')
  } finally { f.close() }
})

test('enrollment tokens resolve server-side and are stored only as hashes', () => {
  const f = fixture()
  try {
    assert.equal(f.store.studentForToken('ada-secret').id, 'ada')
    assert.equal(f.store.studentForToken('wrong'), null)
    const raw = f.store.db.prepare('SELECT enrollment_token_hash FROM students WHERE id=?').get('ada')
    assert.notEqual(raw.enrollment_token_hash, 'ada-secret')
  } finally { f.close() }
})
