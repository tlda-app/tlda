import assert from 'node:assert/strict'
import test from 'node:test'

import { relayBuildOutputToRoom } from './build-dispatch.mjs'
import { getLastSignal } from './sync-rooms.mjs'

test('a streamed build line reaches the document room as a progress signal', () => {
  // The silence fix: the Quarto path streams its scope summary and
  // per-document progress to the server, and without this fan-out the lines
  // reached the server log only — a person with the book open saw nothing
  // until the build landed. The TOC tab already refetches on this signal.
  relayBuildOutputToRoom('progress-fixture-book', 'rendering 1 document(s): chapters/one.qmd', 0)
  const signal = getLastSignal('doc-progress-fixture-book', 'signal:build-progress')
  assert.equal(signal.phase, 'compiling')
  assert.match(signal.detail, /rendering 1 document\(s\): chapters\/one\.qmd/)
})

test('a relayed line carries its skipped count and stays pill-sized', () => {
  relayBuildOutputToRoom('progress-fixture-noisy', '[12/41] a chapter with a very long title that keeps going', 11)
  const signal = getLastSignal('doc-progress-fixture-noisy', 'signal:build-progress')
  assert.match(signal.detail, /\(\+11 lines\)$/)
  relayBuildOutputToRoom('progress-fixture-long', `x:${'y'.repeat(300)}`, 0)
  assert.equal(getLastSignal('doc-progress-fixture-long', 'signal:build-progress').detail.length <= 160, true)
})
