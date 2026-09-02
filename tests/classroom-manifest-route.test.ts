import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldLoadClassroomManifest } from '../src/classroom/useClassroomManifest'

test('the instructor marking route does not request the student classroom identity', () => {
  const params = new URLSearchParams({
    project: 'submission-hw-1-student',
    token: 'read-token',
    markingCourse: 'course',
    markingAssignment: 'hw-1',
    markingStudent: 'student',
  })
  assert.equal(shouldLoadClassroomManifest(params, true), false)
})

test('a classroom student project still loads its course manifest', () => {
  const params = new URLSearchParams({ project: 'course-book', token: 'read-token' })
  assert.equal(shouldLoadClassroomManifest(params, true), true)
})
