import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareHighlightFeedbackBySource,
  highlightFeedbackFromShape,
} from '../server/lib/highlight-feedback.mjs'

test('highlight feedback derives source range from sourceLines, not stale meta.sourceLine', () => {
  const feedback = highlightFeedbackFromShape({
    id: 'shape:hl',
    props: { color: 'yellow' },
    opacity: 0.7,
    meta: {
      highlightText: 'selected text',
      highlightLines: ['selected text'],
      sourceLine: 999,
      sourceLines: [
        { anchored: true, file: 'proof.md', line: 5, content: 'start', highlighted: true },
        { anchored: true, file: 'proof.md', line: 7, content: 'end', highlighted: true },
      ],
      createdAt: 123,
    },
  })

  assert.deepEqual(feedback.lines, [5, 7])
  assert.equal(feedback.sourceFile, 'proof.md')
  assert.equal(Object.hasOwn(feedback, 'sourceLine'), false)
  assert.deepEqual(feedback.sourceLines.map(line => line.line), [5, 7])
})

test('highlight feedback preserves explicit unanchored source lines without falling back to sourceLine', () => {
  const feedback = highlightFeedbackFromShape({
    id: 'shape:hl',
    props: { color: 'orange' },
    meta: {
      highlightText: 'selected text',
      sourceLine: 42,
      sourceLines: [{ anchored: false, reason: 'missing-line-anchor' }],
    },
  })

  assert.equal(feedback.type, 'comment')
  assert.equal(feedback.lines, null)
  assert.equal(feedback.sourceFile, null)
  assert.equal(Object.hasOwn(feedback, 'sourceLine'), false)
  assert.deepEqual(feedback.sourceLines, [{ anchored: false, reason: 'missing-line-anchor' }])
})

test('highlight feedback sorting uses structured sourceLines', () => {
  const laterStaleLine = highlightFeedbackFromShape({
    id: 'shape:later',
    props: { color: 'yellow' },
    meta: {
      highlightText: 'later',
      sourceLine: 1,
      sourceLines: [{ anchored: true, file: 'proof.md', line: 20 }],
    },
  })
  const earlierStaleLine = highlightFeedbackFromShape({
    id: 'shape:earlier',
    props: { color: 'yellow' },
    meta: {
      highlightText: 'earlier',
      sourceLine: 999,
      sourceLines: [{ anchored: true, file: 'proof.md', line: 5 }],
    },
  })

  const sorted = [laterStaleLine, earlierStaleLine].sort(compareHighlightFeedbackBySource)

  assert.deepEqual(sorted.map(item => item.shapeId), ['shape:earlier', 'shape:later'])
})
