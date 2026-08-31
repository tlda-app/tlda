import test from 'node:test'
import assert from 'node:assert/strict'
import { findBookMemberIndex } from '../src/bookMemberNavigation.ts'

// A navigation that resolves to nothing is silent: no error, no log line, and a
// page that simply does not turn. That is what an index page's links did while
// the same destinations opened from the table of contents, so these are the
// encodings the book has to answer to, not a restatement of the code.

const members = [
  { key: 'course-index', name: 'Course index', pages: 1, basePath: '/docs/course-index/' },
  { key: 'course-hw-1', name: 'Homework 1', pages: 1, basePath: '/docs/course-hw-1/' },
  { key: 'course-lecture-2', name: 'Lecture 2', pages: 1, basePath: '/docs/course-lecture-2/' },
]

test('a member key resolves — the table of contents sends this and it always worked', () => {
  assert.equal(findBookMemberIndex(members, 'course-hw-1'), 1)
})

test('a display name resolves', () => {
  assert.equal(findBookMemberIndex(members, 'Lecture 2'), 2)
})

test('an absolute /docs/ link resolves through its path, which is all it carries', () => {
  // [HW 1](/docs/course-hw-1/index.html) — the file name is `index.html`, which
  // names nothing, so the path is the only part that says where to go.
  assert.equal(findBookMemberIndex(members, 'index.html', '/docs/course-hw-1/index.html'), 1)
})

test('a relative markdown link goes to the member it NAMES, not the page it is written in', () => {
  // The measured case, from a rendered book: [HW 1](course-hw-1.md) written in
  // the index becomes href="/docs/course-index/course-hw-1.html". The path is
  // the index — itself a member — so reading the path first would send a reader
  // clicking "HW 1" back to the page they were already on.
  assert.equal(findBookMemberIndex(members, 'course-hw-1.html', '/docs/course-index/course-hw-1.html'), 1)
})

test('a bare file name resolves to the member it names', () => {
  assert.equal(findBookMemberIndex(members, 'course-lecture-2.html'), 2)
  assert.equal(findBookMemberIndex(members, './course-lecture-2.md'), 2)
})

test('a query and a fragment do not stop a link resolving', () => {
  assert.equal(findBookMemberIndex(members, 'course-hw-1.html?_tldaShape=x#problem-2'), 1)
  assert.equal(findBookMemberIndex(members, 'index.html', '/docs/course-hw-1/index.html#problem-2'), 1)
})

test('a link to nothing in this book stays unresolved rather than landing somewhere', () => {
  assert.equal(findBookMemberIndex(members, 'some-other-paper.html'), -1)
  assert.equal(findBookMemberIndex(members, 'index.html', '/docs/some-other-paper/index.html'), -1)
  assert.equal(findBookMemberIndex(members, ''), -1)
  assert.equal(findBookMemberIndex(members, null), -1)
})
