import assert from 'node:assert/strict'
import test from 'node:test'
import { homeworkKeyForTocRow } from '../src/homeworkTocKey'

// The first six entries of `qtm285-course`'s pageFiles, read from
// pic-preview 2026-09-13. Real order, real prefix — the off-by-one below is
// only a real hazard because index 6 is the solutions page for index 5.
const PAGE_FILES = [
  '_book/index.html',
  '_book/lectures/chapter-social-pressure-experiment.html',
  '_book/part1-one-sample.html',
  '_book/lectures/chapter-sampling.html',
  '_book/homework/homework-setup.html',
  '_book/homework/homework-descriptive.html',
  '_book/homework/homework-descriptive-solutions.html',
]

// The row as the course's own toc.json writes it: three keys, no file.
const ASSIGNED_CHAPTER = { level: 'chapter', page: 6 }
const UNASSIGNED_CHAPTER = { level: 'chapter', page: 4 }

test('an assigned chapter resolves to the page file its assignment records', () => {
  assert.equal(
    homeworkKeyForTocRow(ASSIGNED_CHAPTER, PAGE_FILES),
    'homework/homework-descriptive.html',
  )
})

test('the resolved key is the handout, never the solutions page beside it', () => {
  // Reading `page` 0-based lands here, and it would look like a working join.
  assert.notEqual(
    homeworkKeyForTocRow(ASSIGNED_CHAPTER, PAGE_FILES),
    'homework/homework-descriptive-solutions.html',
  )
})

test('an unassigned chapter resolves to its own page, which no assignment claims', () => {
  const key = homeworkKeyForTocRow(UNASSIGNED_CHAPTER, PAGE_FILES)
  assert.equal(key, 'lectures/chapter-sampling.html')

  // The negative control the panel actually depends on: a chapter that is not
  // an assignment must find nothing, or a decorator that marks every row passes.
  const assignments = new Map([['homework/homework-descriptive.html', { assignmentId: 'walk-2' }]])
  assert.equal(assignments.get(key!), undefined)
  assert.ok(assignments.get(homeworkKeyForTocRow(ASSIGNED_CHAPTER, PAGE_FILES)!))
})

test('rows that are not chapters carry no homework key', () => {
  assert.equal(homeworkKeyForTocRow({ level: 'part', page: 3 }, PAGE_FILES), undefined)
  assert.equal(homeworkKeyForTocRow({ level: 'section', page: 6 }, PAGE_FILES), undefined)
})

test('a book row still keys on its member, unchanged', () => {
  assert.equal(
    homeworkKeyForTocRow({ level: 'chapter', page: 1, targetFile: 'qtm285-course' }, PAGE_FILES),
    'qtm285-course',
  )
})

test('a page with no corresponding file yields no key rather than a wrong one', () => {
  assert.equal(homeworkKeyForTocRow({ level: 'chapter', page: 99 }, PAGE_FILES), undefined)
  assert.equal(homeworkKeyForTocRow({ level: 'chapter' }, PAGE_FILES), undefined)
  assert.equal(homeworkKeyForTocRow(ASSIGNED_CHAPTER, []), undefined)
})
