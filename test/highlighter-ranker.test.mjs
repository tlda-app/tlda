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

test('rankSourceSpanCandidates uses full highlight text when fragments are sparse', () => {
  const sourceLine = 'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium'
  const result = rankSourceSpanCandidates({
    sourceLine,
    fragmentTexts: ['perspiciatis unde omnis iste natus error sit voluptatem'],
    highlightText: 'ut perspiciatis unde omnis iste natus error sit voluptatem',
    lineRecords: [{ x: 0 }, { x: 100 }, { x: 200 }],
    hitRange: { minX: 20, maxX: 288 },
  })

  assert.equal(result.ambiguous, false)
  assert.ok(result.confidence >= 0.45)
  assert.equal(result.candidates[0].text, 'ut perspiciatis unde omnis iste natus error sit voluptatem')
})

test('rankSourceSpanCandidates resolves spans contained in longer rendered highlights', () => {
  const sourceLine = 'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium'
  const result = rankSourceSpanCandidates({
    sourceLine,
    fragmentTexts: ['erspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque'],
    highlightText: 'erspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque rem aperiam eaque ipsa quae ab illo inventore veritatis et quasi architecto',
    lineRecords: [{ x: 30 }, { x: 120 }, { x: 210 }, { x: 300 }],
    hitRange: { minX: 45, maxX: 360 },
  })

  assert.equal(result.ambiguous, false)
  assert.ok(result.confidence >= 0.45)
  assert.equal(result.candidates[0].text, 'perspiciatis unde omnis iste natus error sit voluptatem accusantium')
})

test('rankSourceSpanCandidates resolves browser-fragmented SVG text', () => {
  const sourceLine = 'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium'
  const result = rankSourceSpanCandidates({
    sourceLine,
    fragmentTexts: [
      'erspiciatis', 'unde', 'omnis', 'iste', 'natus', 'error', 'sit',
      'v', 'oluptatem', 'accusan', 'tium', 'doloremque',
    ],
    highlightText: 'erspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto',
    lineRecords: [{ x: 30 }, { x: 120 }, { x: 210 }, { x: 300 }],
    hitRange: { minX: 39, maxX: 408 },
  })

  assert.equal(result.ambiguous, false)
  assert.ok(result.confidence >= 0.55)
  assert.equal(result.candidates[0].text, 'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium')
})
