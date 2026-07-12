import test from 'node:test'
import assert from 'node:assert/strict'
import { rankSourceSpanCandidates } from '../server/lib/synctex-query.mjs'

test('rankSourceSpanCandidates resolves an unambiguous source span', () => {
  const sourceLine = 'We first prove the calibrated source mapping lemma for the reader.'
  const result = rankSourceSpanCandidates({
    sourceLine,
    fragmentTexts: ['calibrated source mapping lemma'],
    highlightText: 'calibrated source mapping lemma',
    lineRecords: [{ x: 0 }, { x: 50 }, { x: 100 }],
    hitRange: { minX: 20, maxX: 70 },
  })

  assert.equal(result.ambiguous, false)
  assert.ok(result.confidence >= 0.45)
  assert.equal(result.candidates[0].text, 'calibrated source mapping lemma')
})

test('rankSourceSpanCandidates keeps repeated equally plausible spans ambiguous', () => {
  const sourceLine = 'The ranker chooses local evidence; the ranker chooses local evidence.'
  const result = rankSourceSpanCandidates({
    sourceLine,
    fragmentTexts: ['ranker chooses local evidence'],
    highlightText: 'ranker chooses local evidence',
    lineRecords: [{ x: 0 }, { x: 50 }, { x: 100 }],
    hitRange: { minX: 0, maxX: 100 },
  })

  assert.equal(result.ambiguous, true)
  assert.ok(result.candidates.length >= 2)
  assert.ok(result.candidates.every(c => c.start != null && c.end != null))
})
