import assert from 'node:assert/strict'
import test from 'node:test'

import {
  completeFleetNudgeGuides,
  highlightFleetNudgeGuides,
} from '../src/shapes/fleet-nudge-grid.ts'

const rect = (left, top, right, bottom) => ({
  left, top, right, bottom,
})

test('snap overlay returns the complete faint grid and highlights only taken guides', () => {
  const dragged = rect(11, 0, 21, 10)
  const candidates = [rect(0, 0, 10, 10), rect(25, 0, 35, 10)]
  const grid = completeFleetNudgeGuides(dragged, candidates)

  assert.ok(grid.some(guide => guide.axis === 'x' && guide.line === 0))
  assert.ok(grid.some(guide => guide.axis === 'x' && guide.line === 10))
  assert.ok(grid.some(guide => guide.axis === 'x' && guide.line === -15))
  assert.ok(grid.some(guide => guide.axis === 'x' && guide.line === 50))
  assert.ok(!grid.some(guide => guide.axis === 'x' && guide.line === 5))
  assert.ok(!grid.some(guide => guide.axis === 'x' && guide.line === 30))
  assert.ok(grid.every(guide => guide.highlighted !== true))

  const shown = highlightFleetNudgeGuides(grid, [{ axis: 'x', line: 10 }, null])
  assert.equal(shown.filter(guide => guide.highlighted === true).length, 1)
  assert.equal(shown.find(guide => guide.axis === 'x' && guide.line === 10)?.highlighted, true)
  assert.equal(shown.find(guide => guide.axis === 'x' && guide.line === 0)?.highlighted, false)
})

test('guide grid never advertises horizontal or vertical center targets', () => {
  const dragged = rect(100, 100, 112, 116)
  const grid = completeFleetNudgeGuides(dragged, [rect(0, 10, 20, 40)])

  assert.deepEqual(grid.filter(guide => guide.axis === 'x').map(guide => guide.line).sort((a, b) => a - b), [0, 20])
  assert.deepEqual(grid.filter(guide => guide.axis === 'y').map(guide => guide.line).sort((a, b) => a - b), [10, 40])
})
