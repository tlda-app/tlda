/**
 * Every layout's document-adjacent column is the same width.
 *
 * Skip, 2026-08-25: "something is broken w/ default layout width calculation ---
 * the like, editing layout wiht chat over browser editor. like, that inner
 * column is wider than inner columns otherwise. all inner column widths are
 * supposed to be the same, calculated like in the 3col layout ... this is what
 * makes shit work on laptops."
 *
 * That width is `innerColumnW`, and it is the ADAPTIVE one: it shrinks so the
 * document and the layout both fit the screen. A layout that sized its column
 * any other way was wider than the rest and the first to stop fitting on a
 * laptop — `big-chat` laid its chat and editor out at `columnW + innerColumnW`,
 * a full column too wide, and `both-margins` at `columnW * 0.5 + innerColumnW`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { planFleetLayoutShapes } from '../src/shapes/fleet-layout-plan.ts'

const COLUMN_W = 300
const INNER_COLUMN_W = 240

function plan(variant) {
  return planFleetLayoutShapes({
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
    columnW: COLUMN_W,
    innerColumnW: INNER_COLUMN_W,
    marginGap: 40,
    totalH: 800,
    agentsH: 320,
    searchH: 468,
    rightChatH: 600,
    docviewH: 188,
    viewport: { w: 1440, h: 900 },
    makeSlotId: slot => `shape:${slot}`,
    filters: [[], [], [], []],
  })
}

/** The panels that sit in the column nearest the document. */
function innerColumnPanels(variant) {
  const shapes = plan(variant).shapes
  const byType = type => shapes.filter(shape => shape.type === type)
  if (variant === 'big-chat') return [...byType('fleet-chat'), ...byType('fleet-source-editor')]
  if (variant === 'both-margins') return [...byType('fleet-chat'), ...byType('fleet-docview')]
  if (variant === '3-col') return [...byType('fleet-chat').slice(1), ...byType('fleet-docview')]
  return []
}

test('big-chat and both-margins use the same inner column as 3-col', () => {
  for (const variant of ['3-col', 'big-chat', 'both-margins']) {
    const panels = innerColumnPanels(variant)
    assert.ok(panels.length > 0, `${variant} has an inner column`)
    for (const panel of panels) {
      assert.equal(panel.props.w, INNER_COLUMN_W, `${variant}/${panel.id} is the inner column width`)
    }
  }
})

test('big-chat is no longer a full column wider than the rest', () => {
  // The exact defect: chat and editor at columnW + innerColumnW.
  const panels = innerColumnPanels('big-chat')
  for (const panel of panels) {
    assert.notEqual(panel.props.w, COLUMN_W + INNER_COLUMN_W)
  }
})

test('the inner column tracks innerColumnW rather than being a constant', () => {
  // It is the adaptive width — when the document leaves less room it shrinks,
  // and every layout has to shrink with it or one of them stops fitting.
  const narrow = planFleetLayoutShapes({
    variant: 'big-chat',
    myId: 'fleet:me',
    myDevice: 'device-1',
    anchorX: 0, anchorY: 0, docMaxRight: 900, docMaxBottom: 1600,
    flowAxis: 'y', dx: 0, gap: 12, leftW: 200,
    columnW: COLUMN_W, innerColumnW: 90, marginGap: 40,
    totalH: 800, agentsH: 320, searchH: 468, rightChatH: 600, docviewH: 188,
    viewport: { w: 1024, h: 768 },
    makeSlotId: slot => `shape:${slot}`,
    filters: [[], [], [], []],
  })
  const chat = narrow.shapes.find(shape => shape.type === 'fleet-chat')
  assert.equal(chat.props.w, 90)
})

test('the columns that are not the inner column are untouched', () => {
  // 3-col's first chat is the normal column and stays columnW; two-chat and 2x2
  // have no document-adjacent column and are not in scope.
  const threeCol = plan('3-col').shapes.filter(shape => shape.type === 'fleet-chat')
  assert.equal(threeCol[0].props.w, COLUMN_W)

  const twoChat = plan('two-chat').shapes.filter(shape => shape.type === 'fleet-chat')
  assert.deepEqual(twoChat.map(shape => shape.props.w), [COLUMN_W, COLUMN_W])
})
