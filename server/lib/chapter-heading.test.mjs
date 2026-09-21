import test from 'node:test'
import assert from 'node:assert/strict'

import { chapterHeadingFor } from './chapter-heading.mjs'

// A book whose first pages sit outside any part, then two parts. The numbering
// rule is the one the served page and the table of contents have to agree on,
// and `Lab 1:` is the shape of title the no-position rule exists for.
const BOOK = [
  { file: 'book/index.html', title: 'Prediction, Inference, and Causality' },
  { file: 'book/lab-1.html', title: 'Lab 1: Getting Started' },
  { file: 'book/part-one.html', title: 'Sampling', tocLevel: 'part' },
  { file: 'book/chapter-a.html', title: 'With Replacement' },
  { file: 'book/chapter-b.html', title: 'Without Replacement' },
  { file: 'book/part-two.html', title: 'Inference', tocLevel: 'part' },
  { file: 'book/chapter-c.html', title: 'Lecture 9 — Confidence' },
]

test('a page before any part keeps its title and is not numbered', () => {
  const heading = chapterHeadingFor(BOOK, 'book/lab-1.html')
  assert.equal(heading.chapterTitle, 'Getting Started')
  assert.equal(heading.isFirstPage, false)
})

test('a part keeps its title exactly', () => {
  assert.equal(chapterHeadingFor(BOOK, 'book/part-one.html').chapterTitle, 'Sampling')
})

test('chapters are numbered within their part, and the count restarts', () => {
  assert.equal(chapterHeadingFor(BOOK, 'book/chapter-a.html').chapterTitle, 'Chapter 1: With Replacement')
  assert.equal(chapterHeadingFor(BOOK, 'book/chapter-b.html').chapterTitle, 'Chapter 2: Without Replacement')
  assert.equal(chapterHeadingFor(BOOK, 'book/chapter-c.html').chapterTitle, 'Chapter 1: Confidence')
})

test('neighbours are the pages either side, stripped of their positions', () => {
  const heading = chapterHeadingFor(BOOK, 'book/part-two.html')
  assert.equal(heading.navPrev, 'Without Replacement')
  assert.equal(heading.navNext, 'Confidence')
})

test('the first page says so and has no previous', () => {
  const heading = chapterHeadingFor(BOOK, 'book/index.html')
  assert.equal(heading.isFirstPage, true)
  assert.equal(heading.navPrev, null)
})

test('the last page has no next', () => {
  assert.equal(chapterHeadingFor(BOOK, 'book/chapter-c.html').navNext, null)
})

test('a page the list does not contain gets nothing rather than a wrong answer', () => {
  const heading = chapterHeadingFor(BOOK, 'book/not-in-the-book.html')
  assert.deepEqual(heading, { chapterTitle: '', isFirstPage: false, navPrev: null, navNext: null })
})
