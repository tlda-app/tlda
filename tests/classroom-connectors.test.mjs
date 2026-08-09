import test from 'node:test'
import assert from 'node:assert/strict'
import {
  connectorArrowheadPoints,
  connectorPanes,
  isClassroomConnectorArrow,
  pointInRect,
} from '../src/classroom/connectorGeometry.ts'

const submission = { x: 0, y: 0, w: 880, h: 1200 }
const solution = { x: 904, y: 0, w: 880, h: 1200 }

test('a classroom connector is an arrow spanning the two marking panes', () => {
  assert.equal(pointInRect({ x: 40, y: 100 }, submission), true)
  assert.equal(pointInRect({ x: 900, y: 100 }, submission), false)
  assert.equal(isClassroomConnectorArrow(
    { x: 940, y: 140 },
    { x: 120, y: 180 },
    submission,
    solution,
  ), true)
  assert.deepEqual(connectorPanes(
    { x: 940, y: 140 },
    { x: 120, y: 180 },
    submission,
    solution,
  ), { start: 'solution', end: 'submission' })
})

test('an arrow inside one pane is not a cross-pane connector', () => {
  assert.equal(isClassroomConnectorArrow(
    { x: 120, y: 100 },
    { x: 260, y: 140 },
    submission,
    solution,
  ), false)
  assert.equal(connectorPanes(
    { x: 940, y: 100 },
    { x: 1060, y: 140 },
    submission,
    solution,
  ), null)
})

test('the rendered arrowhead points toward the student endpoint', () => {
  const points = connectorArrowheadPoints({ x: 1000, y: 100 }, { x: 100, y: 100 }, 10)
    .split(' ')
    .map(pair => pair.split(',').map(Number))
  assert.deepEqual(points[0], [100, 100])
  assert.equal(points.length, 3)
  assert.ok(points[1][0] > 100)
  assert.ok(points[2][0] > 100)
})
