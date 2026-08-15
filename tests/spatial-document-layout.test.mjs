import assert from 'node:assert/strict'
import test from 'node:test'

import { horizontalSpatialDocumentPoint } from '../src/spatial-document-layout.mjs'

test('a selected project document is placed horizontally to the right', () => {
  assert.deepEqual(
    horizontalSpatialDocumentPoint(
      { x: 100, y: 240, w: 800, h: 1200 },
      [{ x: 100, y: 240, w: 800, h: 1200 }],
      { w: 800, h: 1200 },
      90_000,
    ),
    { x: 90900, y: 240 },
  )
})

test('a later project document continues the horizontal row', () => {
  assert.deepEqual(
    horizontalSpatialDocumentPoint(
      { x: 100, y: 240, w: 800, h: 1200 },
      [
        { x: 100, y: 240, w: 800, h: 1200 },
        { x: 90900, y: 240, w: 800, h: 1200 },
      ],
      { w: 800, h: 1200 },
      90_000,
    ),
    { x: 181700, y: 240 },
  )
})
