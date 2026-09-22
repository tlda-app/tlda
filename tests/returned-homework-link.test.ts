import assert from 'node:assert/strict'
import test from 'node:test'
import { markingHomeworkHref, returnedHomeworkHref } from '../src/classroom/returnedHomeworkLink'

test('returned homework opens the assignment book page and preserves app authentication', () => {
  assert.equal(
    returnedHomeworkHref(
      'https://pic.example/?project=qtm285-course&token=read-token&workspace=classroom-gradebook&course=qtm285&student=ada',
      {
        id: 'homework-0',
        courseId: 'qtm285',
        title: 'Homework 0',
        dueAt: '2026-09-30T00:00:00.000Z',
        solutionsDocKey: 'qtm285-course',
        bookPageFile: 'homework/homework-descriptive.html',
      },
      'qtm285',
    ),
    '/docs/qtm285-course/app/homework/homework-descriptive.html?token=read-token&course=qtm285',
  )
})

test('book output prefixes are not repeated in app presentation routes', () => {
  const assignment = {
    id: 'homework-1',
    courseId: 'qtm285',
    title: 'Homework 1',
    dueAt: '2026-09-30T00:00:00.000Z',
    solutionsDocKey: 'qtm285-course',
    bookPageFile: '_book/homework/homework-calibration-solutions.html',
  }
  assert.equal(
    markingHomeworkHref('https://pic.example/?workspace=classroom-gradebook', assignment, 'qtm285', 'qtm285:student'),
    '/docs/qtm285-course/app/homework/homework-calibration-solutions.html?course=qtm285&student=qtm285%3Astudent',
  )
})

test('returned homework has no book destination until both coordinates exist', () => {
  const base = {
    id: 'homework-0',
    courseId: 'qtm285',
    title: 'Homework 0',
    dueAt: '2026-09-30T00:00:00.000Z',
  }
  assert.equal(returnedHomeworkHref('https://pic.example/', base, 'qtm285'), null)
  assert.equal(returnedHomeworkHref('https://pic.example/', { ...base, solutionsDocKey: 'qtm285-course' }, 'qtm285'), null)
})
