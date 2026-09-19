// Who may see an assignment's solutions.
//
// Skip's rule, stated twice in one night: *"we're meant to fking serve the
// solution to instructors and students who have submitted"* and *"it's subbed
// you get it"*. One homework occupies one slot; what renders into it depends on
// who is asking. The predicate below is what the serving path asks, so the
// refusals here are the difference between a student seeing answers they have
// not earned and not.
//
// Each entitlement is paired with the refusal that sits next to it. A rule that
// admits the instructor is not evidence of anything on its own — the failure
// that matters is a classmate who has handed in nothing being handed the
// answers, and the reader with no classroom identity at all, which is what both
// the static site and the shared class read link look like from here.
//
// These are written against `maySeeSolutionsFor` rather than through HTTP
// deliberately: the existing route tests pass unchanged when the rule is
// inverted, so they are not a gate on it. Measured — replacing the submission
// check with `return true` left all nine of them green.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClassroomStore } from './classroom-store.mjs'

const COURSE = 'qtm285'
const OTHER_COURSE = 'qtm220'
const ASSIGNMENT = 'week1-homework'
const OTHER_ASSIGNMENT = 'qtm220-week1'
const HANDED_IN = `${COURSE}:ada`
const NOT_HANDED_IN = `${COURSE}:biko`
const OTHER_COURSE_STUDENT = `${OTHER_COURSE}:cleo`

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-solution-entitlement-'))
  const store = new ClassroomStore(join(root, 'classroom.db'))
  store.upsertCourse({ id: COURSE, title: 'QTM 285', preferredName: 'Instructor' })
  store.upsertCourse({ id: OTHER_COURSE, title: 'QTM 220', preferredName: 'Instructor' })
  store.registerStudent({ courseId: COURSE, preferredName: 'Ada', universityLogin: 'ada', enrollmentToken: 'tok-ada' })
  store.registerStudent({ courseId: COURSE, preferredName: 'Biko', universityLogin: 'biko', enrollmentToken: 'tok-biko' })
  store.registerStudent({ courseId: OTHER_COURSE, preferredName: 'Cleo', universityLogin: 'cleo', enrollmentToken: 'tok-cleo' })
  store.upsertAssignment({ id: ASSIGNMENT, courseId: COURSE, title: 'Calibration', dueAt: '2026-09-10T00:00:00.000Z' })
  store.upsertAssignment({ id: OTHER_ASSIGNMENT, courseId: OTHER_COURSE, title: 'Other', dueAt: '2026-09-10T00:00:00.000Z' })
  store.submit({ assignmentId: ASSIGNMENT, studentId: HANDED_IN, contentRef: `submission-${ASSIGNMENT}-${HANDED_IN}` })
  store.submit({ assignmentId: OTHER_ASSIGNMENT, studentId: OTHER_COURSE_STUDENT, contentRef: `submission-${OTHER_ASSIGNMENT}-${OTHER_COURSE_STUDENT}` })
  try { return fn(store) } finally { store.db.close(); rmSync(root, { recursive: true, force: true }) }
}

const assignmentOf = store => store.getAssignment(ASSIGNMENT)

test('an instructor of the course sees the solutions', () => {
  withStore(store => {
    assert.equal(store.maySeeSolutionsFor(assignmentOf(store), { role: 'instructor', courseId: COURSE }), true)
  })
})

test('a student who has handed in sees the solutions, and their classmate who has not does not', () => {
  withStore(store => {
    const assignment = assignmentOf(store)
    assert.equal(store.maySeeSolutionsFor(assignment, {
      role: 'student', studentId: HANDED_IN, courseId: COURSE,
    }), true)
    // The one that matters. Same course, same assignment, nothing handed in.
    assert.equal(store.maySeeSolutionsFor(assignment, {
      role: 'student', studentId: NOT_HANDED_IN, courseId: COURSE,
    }), false)
  })
})

test('a reader with no classroom identity is refused, which is the static site and the class read link', () => {
  withStore(store => {
    const assignment = assignmentOf(store)
    assert.equal(store.maySeeSolutionsFor(assignment, null), false)
    assert.equal(store.maySeeSolutionsFor(assignment, {}), false)
    // A role that is neither instructor nor student must not fall through to
    // shown; the default is withheld.
    assert.equal(store.maySeeSolutionsFor(assignment, { role: 'observer', courseId: COURSE }), false)
  })
})

test('handing in elsewhere earns nothing here', () => {
  withStore(store => {
    // Cleo has a submission, for a different course's assignment. Asking about
    // this one must not find it.
    assert.equal(store.maySeeSolutionsFor(assignmentOf(store), {
      role: 'student', studentId: OTHER_COURSE_STUDENT, courseId: OTHER_COURSE,
    }), false)
    // And an instructor of that other course is not an instructor of this one.
    assert.equal(store.maySeeSolutionsFor(assignmentOf(store), {
      role: 'instructor', courseId: OTHER_COURSE,
    }), false)
  })
})

test('no assignment means no solutions', () => {
  withStore(store => {
    assert.equal(store.maySeeSolutionsFor(null, { role: 'instructor', courseId: COURSE }), false)
  })
})
