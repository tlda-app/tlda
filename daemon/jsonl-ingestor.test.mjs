import test from 'node:test'
import assert from 'node:assert/strict'
import {
  catchupReplayBoundary,
  shouldSuppressCatchupOutput,
} from './jsonl-ingestor.mjs'

test('large JSONL tail gaps enter display catch-up mode', () => {
  assert.equal(catchupReplayBoundary({
    startOffset: 100,
    liveOffset: 1000,
    thresholdBytes: 500,
  }), 1000)
})

test('small JSONL tail gaps replay normally', () => {
  assert.equal(catchupReplayBoundary({
    startOffset: 100,
    liveOffset: 300,
    thresholdBytes: 500,
  }), null)
})

test('display catch-up suppresses chat/activity but preserves indexing and identity', () => {
  for (const type of ['activity', 'context', 'qualification', 'terminalChat', 'nativeTask']) {
    assert.equal(shouldSuppressCatchupOutput({ type }), true, type)
  }
  for (const type of ['searchIndex', 'identity']) {
    assert.equal(shouldSuppressCatchupOutput({ type }), false, type)
  }
})
