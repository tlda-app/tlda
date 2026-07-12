import assert from 'node:assert/strict'
import test from 'node:test'

import {
  anchoredSourceLocation,
  sourceLineMetaFromRankerLine,
  unanchoredSourceLocation,
} from '../src/sourceLocation.ts'

test('anchored source locations require a real file and positive line', () => {
  assert.deepEqual(anchoredSourceLocation('./notes.md', 12), {
    anchored: true,
    file: 'notes.md',
    line: 12,
  })
  assert.equal(anchoredSourceLocation('', 12), null)
  assert.equal(anchoredSourceLocation('notes.md', 0), null)
})

test('unanchored locations carry the reason without fabricating a line', () => {
  assert.deepEqual(unanchoredSourceLocation('missing-line-anchor'), {
    anchored: false,
    reason: 'missing-line-anchor',
  })
})

test('ranker adapter keeps anchored span ambiguity distinct from line ambiguity', () => {
  const line = sourceLineMetaFromRankerLine({
    file: './paper.tex',
    line: 31,
    content: 'A highlighted theorem statement.',
    highlighted: true,
    hlStart: 2,
    hlEnd: 13,
    ambiguous: true,
    confidence: 0.44,
  })

  assert.deepEqual(line, {
    anchored: true,
    file: 'paper.tex',
    line: 31,
    content: 'A highlighted theorem statement.',
    highlighted: true,
    ambiguous: true,
    confidence: 0.44,
  })
  assert.equal('hlStart' in line, false)
  assert.equal('hlEnd' in line, false)
})

test('ranker adapter drops source text and spans when no source line is anchored', () => {
  const line = sourceLineMetaFromRankerLine({
    reason: 'ambiguous',
    content: 'do not persist this as line zero',
    highlighted: true,
    hlStart: 0,
    hlEnd: 4,
  })

  assert.deepEqual(line, {
    anchored: false,
    reason: 'ambiguous',
  })
})

test('ranker adapter drops span ambiguity when no source line is anchored', () => {
  const line = sourceLineMetaFromRankerLine({
    reason: 'ambiguous',
    ambiguous: true,
    confidence: 0.72,
  })

  assert.deepEqual(line, {
    anchored: false,
    reason: 'ambiguous',
    confidence: 0.72,
  })
  assert.equal('ambiguous' in line, false)
})

test('ranker adapter preserves exact word-synctex provenance on anchored lines', () => {
  const line = sourceLineMetaFromRankerLine({
    file: 'paper.tex',
    line: 8,
    content: 'Exact prose token.',
    highlighted: true,
    hlStart: 6,
    hlEnd: 11,
    exact: true,
    approximate: false,
    resolver: 'word-synctex',
  })

  assert.deepEqual(line, {
    anchored: true,
    file: 'paper.tex',
    line: 8,
    content: 'Exact prose token.',
    highlighted: true,
    hlStart: 6,
    hlEnd: 11,
    exact: true,
    resolver: 'word-synctex',
  })
})

test('ranker adapter preserves approximate fallback provenance without treating columns as exact', () => {
  const line = sourceLineMetaFromRankerLine({
    file: 'paper.tex',
    line: 13,
    content: '$E = mc^2$',
    highlighted: true,
    hlStart: 0,
    hlEnd: 10,
    exact: false,
    approximate: true,
    resolver: 'ranker',
  })

  assert.deepEqual(line, {
    anchored: true,
    file: 'paper.tex',
    line: 13,
    content: '$E = mc^2$',
    highlighted: true,
    hlStart: 0,
    hlEnd: 10,
    exact: false,
    approximate: true,
    resolver: 'ranker',
  })
})
