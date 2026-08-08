import test from 'node:test'
import assert from 'node:assert/strict'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'

// The per-problem view is where he marks, so who appears in it is who he sees.
// Driving it from the submissions table drops anyone who handed in nothing:
// the flick-through reads "1 of 1" while the roster holds two, and finishing
// the round feels like finishing the class.

function course() {
  const store = new ClassroomStore(':memory:')
  store.upsertCourse({ id: 'c', title: 'C' })
  store.upsertStudent({ id: 'ada', courseId: 'c', displayName: 'Ada', enrollmentToken: 'a' })
  store.upsertStudent({ id: 'bo', courseId: 'c', displayName: 'Bo', enrollmentToken: 'b' })
  store.upsertAssignment({ id: 'hw', courseId: 'c', title: 'HW', dueAt: '2026-09-12' })
  return store
}

test('a student who submitted nothing is still a stop on the round', () => {
  const store = course()
  store.submit({ assignmentId: 'hw', studentId: 'ada', contentRef: 'sub-ada', answerIds: ['ans-p1', 'ans-p2'] })
  // Bo submitted nothing at all.
  const view = store.problems('hw')
  for (const problem of view.problems) {
    assert.equal(problem.answers.length, 2, `${problem.problemId} lost a student`)
    const bo = problem.answers.find(a => a.studentId === 'bo')
    assert.equal(bo.anchor, null)
    assert.equal(bo.gradingStatus, 'not-submitted')
    assert.equal(bo.contentRef, null)
  }
})

test('a student who submitted but skipped one problem appears on that problem too', () => {
  const store = course()
  store.submit({ assignmentId: 'hw', studentId: 'ada', contentRef: 'sub-ada', answerIds: ['ans-p1', 'ans-p2'] })
  store.submit({ assignmentId: 'hw', studentId: 'bo', contentRef: 'sub-bo', answerIds: ['ans-p1'] })
  const p2 = store.problems('hw').problems.find(p => p.problemId === 'ans-p2')
  const bo = p2.answers.find(a => a.studentId === 'bo')
  assert.equal(bo.anchor, null, 'Bo has no answer to p2')
  assert.equal(bo.gradingStatus, 'ungraded', 'but Bo did submit')
})

test('an inactive student drops out of the round', () => {
  const store = course()
  store.submit({ assignmentId: 'hw', studentId: 'ada', contentRef: 'sub-ada', answerIds: ['ans-p1'] })
  store.upsertStudent({ id: 'bo', courseId: 'c', displayName: 'Bo', enrollmentToken: 'b', active: false })
  const view = store.problems('hw')
  assert.deepEqual(view.problems[0].answers.map(a => a.studentId), ['ada'])
})

test('nobody attempting a problem still lists the whole class', () => {
  // The case that argued for this: he flicks to question 4 and sees the class,
  // every one of them empty, rather than an absent problem.
  const store = course()
  store.submit({ assignmentId: 'hw', studentId: 'ada', contentRef: 'sub-ada', answerIds: ['ans-p1'] })
  store.submit({ assignmentId: 'hw', studentId: 'bo', contentRef: 'sub-bo', answerIds: ['ans-p1'] })
  const view = store.problems('hw')
  assert.deepEqual(view.problems.map(p => p.problemId), ['ans-p1'])
  assert.equal(view.problems[0].answers.length, 2)
})
