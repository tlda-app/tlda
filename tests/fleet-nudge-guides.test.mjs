import assert from 'node:assert/strict'
import test from 'node:test'

import {
  completeFleetNudgeGuides,
  highlightFleetNudgeGuides,
} from '../src/shapes/fleet-nudge-grid.ts'

const rect = (left, top, right, bottom) => ({
  left, top, right, bottom,
  centerX: (left + right) / 2,
  centerY: (top + bottom) / 2,
})

test('snap overlay returns the complete faint grid and highlights only taken guides', () => {
  const dragged = rect(11, 0, 21, 10)
  const candidates = [rect(0, 0, 10, 10), rect(25, 0, 35, 10)]
  const grid = completeFleetNudgeGuides(dragged, candidates)

  assert.ok(grid.some(guide => guide.axis === 'x' && guide.line === 0))
  assert.ok(grid.some(guide => guide.axis === 'x' && guide.line === 5))
  assert.ok(grid.some(guide => guide.axis === 'x' && guide.line === -15))
  assert.ok(grid.every(guide => guide.highlighted !== true))

  const shown = highlightFleetNudgeGuides(grid, [{ axis: 'x', line: 5 }, null])
  assert.equal(shown.filter(guide => guide.highlighted === true).length, 1)
  assert.equal(shown.find(guide => guide.axis === 'x' && guide.line === 5)?.highlighted, true)
  assert.equal(shown.find(guide => guide.axis === 'x' && guide.line === 0)?.highlighted, false)
})
