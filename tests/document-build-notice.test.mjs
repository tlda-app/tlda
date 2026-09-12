import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFailureReason, emptyDocumentNotice } from '../src/documentBuildNotice.ts'

test('a failed build is reported as a failure, not as waiting', () => {
  const notice = emptyDocumentNotice('hw1-source', 'error')
  assert.equal(notice.kind, 'build-failed')
  assert.match(notice.message, /failed/)
  // The defect this exists for: the reader was told to wait on a build that
  // had already stopped, and the wait had no end.
  assert.doesNotMatch(notice.message, /Waiting/)
})

test('a build still running is still a wait', () => {
  assert.deepEqual(emptyDocumentNotice('hw1-source', 'building'), {
    kind: 'waiting',
    message: 'Building hw1-source...',
  })
  assert.deepEqual(emptyDocumentNotice('hw1-source', undefined), {
    kind: 'waiting',
    message: 'Waiting for hw1-source...',
  })
})

test('a revision that is not the live one is not a failure', () => {
  for (const status of ['cancelled', 'superseded', 'not_required', 'unknown', 'success']) {
    assert.equal(emptyDocumentNotice('hw1-source', status).kind, 'waiting', status)
  }
})

test('the reason is the first thing the build actually reported', () => {
  assert.equal(
    buildFailureReason(['', "ERROR: Book chapter 'homework/hw1.handout.qmd' not found"], false),
    "ERROR: Book chapter 'homework/hw1.handout.qmd' not found",
  )
})

test('no errors and no log is said out loud, not read as clean', () => {
  assert.match(String(buildFailureReason([], true)), /not recorded/)
  assert.equal(buildFailureReason([], false), null)
})
