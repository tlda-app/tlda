import assert from 'node:assert/strict'
import test from 'node:test'

import { planFleetLayoutShapes } from '../src/shapes/fleet-layout-plan.ts'
import { closestFleetNudgeGuide, completeFleetNudgeGuides, mergeFleetNudgeGuides } from '../src/shapes/fleet-nudge-grid.ts'
import { permanentGuideKey, permanentGuidesOf, withPermanentGuides } from '../src/shapes/fleet-permanent-guides.ts'

const ALL_FEATURES = new Set(['left', 'right', 'top', 'bottom'])

function planInput(variant, overrides = {}) {
  return {
    variant,
    myId: 'fleet:me',
    myDevice: 'device-1',
    anchorX: 100,
    anchorY: 200,
    docMaxRight: 900,
    docMaxBottom: 1600,
    flowAxis: 'y',
    dx: 0,
    gap: 12,
    leftW: 200,
    columnW: 300,
    innerColumnW: 240,
    marginGap: 40,
    totalH: 800,
    agentsH: 320,
    searchH: 468,
    rightChatH: 600,
    docviewH: 188,
    viewport: { w: 390, h: 844 },
    makeSlotId: slot => `shape:${slot}`,
    filters: [[], [], [], []],
    ...overrides,
  }
}

test('single-chat makes the box it placed permanent, and no other layout declares lines', () => {
  const plan = planFleetLayoutShapes(planInput('single-chat'))
  const chat = plan.shapes.find(shape => shape.type === 'fleet-chat')
  assert.ok(chat, 'single-chat places a chat')

  const left = chat.x
  const top = chat.y
  const right = chat.x + chat.props.w
  const bottom = chat.y + chat.props.h
  assert.deepEqual(
    plan.permanentGuides.map(guide => `${guide.axis}:${guide.line}`).sort(),
    [`x:${left}`, `x:${right}`, `y:${top}`, `y:${bottom}`].sort(),
  )

  for (const variant of ['two-chat', '3-col', '2x2', 'big-chat', 'both-margins']) {
    assert.deepEqual(planFleetLayoutShapes(planInput(variant)).permanentGuides, [], variant)
  }
})

test('a permanent line captures an edge with no other panel on the page', () => {
  // The phone case: one panel, so the panel-to-panel grid is empty. Without the
  // permanent lines there is nothing to snap to at all — which is the defect.
  const dragged = { left: 106, top: 200, right: 306, bottom: 700 }
  const fromPanels = completeFleetNudgeGuides(dragged, [])
  assert.deepEqual(fromPanels, [], 'one panel gives no panel-to-panel lines')

  const permanent = planFleetLayoutShapes(planInput('single-chat')).permanentGuides
  const grid = mergeFleetNudgeGuides(fromPanels, permanent)
  const match = closestFleetNudgeGuide(dragged, grid, 'x', ALL_FEATURES)
  assert.ok(match, 'the permanent box is reachable')
  assert.equal(match.line, 100, 'the near edge of the box is what it takes')
  assert.equal(match.feature, 'left')
  assert.equal(match.delta, -6)
})

test('merging keeps one line per axis and position, spanning both sources', () => {
  const merged = mergeFleetNudgeGuides(
    [{ axis: 'x', line: 40, spanFrom: 0, spanTo: 100 }],
    [{ axis: 'x', line: 40, spanFrom: 60, spanTo: 300 }, { axis: 'y', line: 5, spanFrom: 0, spanTo: 10 }],
  )
  assert.equal(merged.filter(guide => guide.axis === 'x' && guide.line === 40).length, 1)
  assert.deepEqual(
    merged.find(guide => guide.axis === 'x' && guide.line === 40),
    { axis: 'x', line: 40, spanFrom: 0, spanTo: 300 },
  )
  assert.equal(merged.length, 2)
})

test('choosing a layout replaces the permanent lines, including with none', () => {
  const key = permanentGuideKey('a-project', 'fleet:me', 'device-1')
  const other = permanentGuideKey('a-project', 'fleet:me', 'device-2')

  const lines = [{ axis: 'x', line: 10, spanFrom: 0, spanTo: 5 }]
  const withLines = withPermanentGuides({ [other]: lines }, key, lines)
  assert.deepEqual(permanentGuidesOf(withLines, key), lines)

  const cleared = withPermanentGuides(withLines, key, [])
  assert.deepEqual(permanentGuidesOf(cleared, key), [])
  assert.deepEqual(permanentGuidesOf(cleared, other), lines, 'another device keeps its own')

  assert.equal(withPermanentGuides(withLines, key, lines), withLines, 'an unchanged write is skipped')
})
