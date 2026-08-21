import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closestFleetNudgeGuide,
  completeFleetNudgeGuides,
  fleetNudgeGuidesForFeatures,
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

test('every drawn edge and gap line can pull either translating edge', () => {
  const candidates = [rect(0, 0, 10, 10), rect(25, 0, 35, 10)]
  const grid = completeFleetNudgeGuides(rect(11, 0, 21, 10), candidates)
  const live = new Set(['left', 'right', 'top', 'bottom'])

  for (const guide of grid.filter(guide => guide.axis === 'x')) {
    const leftMatch = closestFleetNudgeGuide(
      rect(guide.line - 1, 100, guide.line + 9, 110),
      [guide],
      'x',
      live,
    )
    assert.equal(leftMatch?.line, guide.line)
    assert.equal(leftMatch?.feature, 'left')

    const rightMatch = closestFleetNudgeGuide(
      rect(guide.line - 9, 100, guide.line + 1, 110),
      [guide],
      'x',
      live,
    )
    assert.equal(rightMatch?.line, guide.line)
    assert.equal(rightMatch?.feature, 'right')
  }

  for (const guide of grid.filter(guide => guide.axis === 'y')) {
    const topMatch = closestFleetNudgeGuide(
      rect(100, guide.line - 1, 110, guide.line + 9),
      [guide],
      'y',
      live,
    )
    assert.equal(topMatch?.line, guide.line)
    assert.equal(topMatch?.feature, 'top')

    const bottomMatch = closestFleetNudgeGuide(
      rect(100, guide.line - 9, 110, guide.line + 1),
      [guide],
      'y',
      live,
    )
    assert.equal(bottomMatch?.line, guide.line)
    assert.equal(bottomMatch?.feature, 'bottom')
  }
})

test('resize grid draws only axes carried by the grabbed edge', () => {
  const grid = completeFleetNudgeGuides(
    rect(11, 0, 21, 10),
    [rect(0, 0, 10, 10), rect(25, 0, 35, 10)],
  )
  const rightEdgeGrid = fleetNudgeGuidesForFeatures(grid, new Set(['right']))

  assert.ok(rightEdgeGrid.length > 0)
  assert.ok(rightEdgeGrid.every(guide => guide.axis === 'x'))
  for (const guide of rightEdgeGrid) {
    const match = closestFleetNudgeGuide(
      rect(guide.line - 11, 100, guide.line - 1, 110),
      [guide],
      'x',
      new Set(['right']),
    )
    assert.equal(match?.line, guide.line)
    assert.equal(match?.feature, 'right')
  }
})
