import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldReuseTrackedSourceAnchor } from '../src/sourceCursorTracking.ts'

const threshold = 2

test('stale synctex anchor is not reused for markdown at the same file and line', () => {
  assert.equal(
    shouldReuseTrackedSourceAnchor(
      { file: 'proof.md', line: 31, source: 'synctex', anchored: true },
      { file: 'proof.md', line: 31, source: 'html-page', anchored: true },
      threshold,
    ),
    false,
  )
})

test('sourceless initial anchor is not reused when synctex resolves at the same file and line', () => {
  assert.equal(
    shouldReuseTrackedSourceAnchor(
      { file: 'body.tex', line: 60, anchored: true },
      { file: 'body.tex', line: 60, source: 'synctex', anchored: true },
      threshold,
    ),
    false,
  )
})

test('near-line reuse still suppresses churn for the same source kind', () => {
  assert.equal(
    shouldReuseTrackedSourceAnchor(
      { file: 'body.tex', line: 60, source: 'synctex', anchored: true },
      { file: 'body.tex', line: 61, source: 'synctex', anchored: true },
      threshold,
    ),
    true,
  )
})

test('near-line reuse does not cross source kinds', () => {
  assert.equal(
    shouldReuseTrackedSourceAnchor(
      { file: 'proof.md', line: 30, source: 'synctex', anchored: true },
      { file: 'proof.md', line: 31, source: 'html-page', anchored: true },
      threshold,
    ),
    false,
  )
})
