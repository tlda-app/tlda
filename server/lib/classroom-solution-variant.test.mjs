// Which rendering of a homework page a reader gets.
//
// The substitution is the whole point — Skip: *"IT'S A FUCKING SUBSTITUTE NOT
// AN ADDITIONAL CHAPTER."* — and it is also the thing that can leak. So every
// entitlement below is paired with the refusal beside it, and the refusals are
// the assertions that matter: a classmate who has handed in nothing, and a
// reader with no classroom identity, which is what both the static site and the
// shared class read link look like from here.
//
// The page-info fixtures are the real shape, copied from the live course
// publication: a homework page and its solutions sibling differ by the SOURCE
// they were rendered from (`…​.qmd` against `…​.solutions.qmd`), not by anything
// in the output name that could be relied on.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClassroomStore } from './classroom-store.mjs'
import { solutionsVariantFileFor } from './classroom-solution-variant.mjs'

const COURSE = 'qtm285'
const ASSIGNMENT = 'week1-homework'
const HANDED_IN = `${COURSE}:ada`
const NOT_HANDED_IN = `${COURSE}:biko`

const HOMEWORK_PAGE = '_book/homework/homework-calibration.html'
const SOLUTIONS_PAGE = '_book/homework/homework-calibration-solutions.html'

const pageInfo = [
  {
    file: HOMEWORK_PAGE,
    title: 'Homework: The Idea of Calibration',
    source: { type: 'project-source', format: 'qmd', file: 'homework/homework-calibration.qmd' },
  },
  {
    file: SOLUTIONS_PAGE,
    title: 'Homework: The Idea of Calibration',
    source: { type: 'project-source', format: 'qmd', file: 'homework/homework-calibration.solutions.qmd' },
  },
  {
    file: '_book/chapters/chapter-bootstrap.html',
    title: 'The Bootstrap',
    source: { type: 'project-source', format: 'qmd', file: 'chapters/chapter-bootstrap.qmd' },
  },
]

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-solution-variant-'))
  const store = new ClassroomStore(join(root, 'classroom.db'))
  store.upsertCourse({ id: COURSE, title: 'QTM 285', preferredName: 'Instructor' })
  store.registerStudent({ courseId: COURSE, preferredName: 'Ada', universityLogin: 'ada', enrollmentToken: 'tok-ada' })
  store.registerStudent({ courseId: COURSE, preferredName: 'Biko', universityLogin: 'biko', enrollmentToken: 'tok-biko' })
  store.upsertAssignment({
    id: ASSIGNMENT, courseId: COURSE, title: 'Calibration', dueAt: '2026-09-10T00:00:00.000Z',
    // The prefix-less page the CLI derives from the homework source. Matching
    // this is what the `source.file` route exists to make reliable.
    bookPageFile: 'homework/homework-calibration.html',
  })
  store.submit({ assignmentId: ASSIGNMENT, studentId: HANDED_IN, contentRef: `submission-${ASSIGNMENT}-${HANDED_IN}` })
  try { return fn(store) } finally { store.db.close(); rmSync(root, { recursive: true, force: true }) }
}

const ask = (store, principal, overrides = {}) => solutionsVariantFileFor({
  store, principal, pageInfo, servedFilePath: HOMEWORK_PAGE, ...overrides,
})

test('an instructor asking for the homework page is given the solutions rendering', () => {
  withStore(store => {
    assert.equal(ask(store, { role: 'instructor', courseId: COURSE }), SOLUTIONS_PAGE)
  })
})

test('a student is given the solutions once they have handed in, and not before', () => {
  withStore(store => {
    assert.equal(ask(store, { role: 'student', studentId: HANDED_IN, courseId: COURSE }), SOLUTIONS_PAGE)
    // The leak. Same course, same page, nothing handed in.
    assert.equal(ask(store, { role: 'student', studentId: NOT_HANDED_IN, courseId: COURSE }), null)
  })
})

test('a reader with no classroom identity gets the page they asked for', () => {
  withStore(store => {
    assert.equal(ask(store, null), null)
    assert.equal(ask(store, {}), null)
    assert.equal(ask(store, { role: 'student', studentId: HANDED_IN }), null)
  })
})

test('the static site never substitutes, even for an instructor', () => {
  withStore(store => {
    assert.equal(
      ask(store, { role: 'instructor', courseId: COURSE }, { isStaticPage: true }),
      null,
    )
  })
})

test('a page that is not an assignment is never substituted', () => {
  withStore(store => {
    assert.equal(
      ask(store, { role: 'instructor', courseId: COURSE }, { servedFilePath: '_book/chapters/chapter-bootstrap.html' }),
      null,
    )
  })
})

test('with no solutions rendering in the build, the homework page stands', () => {
  withStore(store => {
    // An entitled instructor, an assignment that matches — and a publication
    // that simply does not carry the sibling. Serving the handout is correct;
    // inventing a filename would 404 the chapter instead.
    assert.equal(
      solutionsVariantFileFor({
        store,
        principal: { role: 'instructor', courseId: COURSE },
        pageInfo: pageInfo.filter(page => page.file !== SOLUTIONS_PAGE),
        servedFilePath: HOMEWORK_PAGE,
      }),
      null,
    )
  })
})

test('an alternate rendering of the same chapter is found by its variant mark', () => {
  // The other build shape: one source, two outputs, the second marked the way
  // page-info already marks a deck. Serving must not care which shape it is.
  withStore(store => {
    const alternates = [
      pageInfo[0],
      {
        file: SOLUTIONS_PAGE,
        title: 'Homework: The Idea of Calibration',
        variant: 'solutions',
        source: { type: 'project-source', format: 'qmd', file: 'homework/homework-calibration.qmd' },
      },
    ]
    assert.equal(
      solutionsVariantFileFor({
        store,
        principal: { role: 'instructor', courseId: COURSE },
        pageInfo: alternates,
        servedFilePath: HOMEWORK_PAGE,
      }),
      SOLUTIONS_PAGE,
    )
    // And it is still refused to a classmate who has handed in nothing.
    assert.equal(
      solutionsVariantFileFor({
        store,
        principal: { role: 'student', studentId: NOT_HANDED_IN, courseId: COURSE },
        pageInfo: alternates,
        servedFilePath: HOMEWORK_PAGE,
      }),
      null,
    )
  })
})

test('a variant entry that IS the requested page is not a substitution', () => {
  // A build that marked the homework page itself would otherwise make an
  // entitled request read as substituted while nothing changed.
  withStore(store => {
    assert.equal(
      solutionsVariantFileFor({
        store,
        principal: { role: 'instructor', courseId: COURSE },
        pageInfo: [{ ...pageInfo[0], variant: 'solutions' }],
        servedFilePath: HOMEWORK_PAGE,
      }),
      null,
    )
  })
})

test('an unreadable page-info is refused rather than guessed at', () => {
  withStore(store => {
    const instructor = { role: 'instructor', courseId: COURSE }
    assert.equal(solutionsVariantFileFor({ store, principal: instructor, pageInfo: null, servedFilePath: HOMEWORK_PAGE }), null)
    assert.equal(solutionsVariantFileFor({ store, principal: instructor, pageInfo: [], servedFilePath: HOMEWORK_PAGE }), null)
  })
})
