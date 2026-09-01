import assert from 'node:assert/strict'
import test from 'node:test'

import { layoutPageBounds } from '../src/loaders/pageLayout.ts'

test('horizontal slide pages remain top-aligned when their heights differ', () => {
  const bounds = layoutPageBounds([
    { width: 1000, height: 700 },
    { width: 1000, height: 900 },
    { width: 1000, height: 600 },
  ], 'horizontal', 500)

  assert.deepEqual(bounds.map(box => ({ x: box.x, y: box.y, w: box.w, h: box.h })), [
    { x: 0, y: 0, w: 1000, h: 700 },
    { x: 1500, y: 0, w: 1000, h: 900 },
    { x: 3000, y: 0, w: 1000, h: 600 },
  ])
})

test('vertical document pages remain horizontally centered', () => {
  const bounds = layoutPageBounds([
    { width: 800, height: 1000 },
    { width: 1000, height: 1200 },
  ], 'vertical', 32)

  assert.deepEqual(bounds.map(box => ({ x: box.x, y: box.y, w: box.w, h: box.h })), [
    { x: 100, y: 0, w: 800, h: 1000 },
    { x: 0, y: 1032, w: 1000, h: 1200 },
  ])
})
