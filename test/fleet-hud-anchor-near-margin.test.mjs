import test from 'node:test'
import assert from 'node:assert/strict'
import { computeFleetHudDefaultAnchor } from '../src/overlays/fleet-hud-anchor.ts'

// Measured on the deployed build at 1470x866, project rc-anchored-list-probe.
// A paper flows down, so marginAxis is 'x' and the layout rides in the side margin.
const FLOW = 'y'
const SCREEN_PAD = 24
const MARGIN_GAP = 56
const DOC_NEAR_SCREEN = 335       // document's left edge, projected to screen

// Each layout's own bounding box, and the far edge of its NEAR-margin group.
// For everything that lives in one margin those are the same number, which is
// the property this file exists to pin down.
const LAYOUTS = {
  'single-chat':  { bounds: { x: -652, y: 100, w: 616, h: 606 }, nearMarginFarEdge: -36 },
  'two-chat':     { bounds: { x: -652, y: 100, w: 616, h: 606 }, nearMarginFarEdge: -36 },
  '3-col':        { bounds: { x: -1156, y: 100, w: 1120, h: 606 }, nearMarginFarEdge: -36 },
  '2x2':          { bounds: { x: -1156, y: 100, w: 1120, h: 606 }, nearMarginFarEdge: -36 },
  'big-chat':     { bounds: { x: -1146, y: 100, w: 1110, h: 606 }, nearMarginFarEdge: -36 },
}

// both-margins is the only variant that straddles: its source editor sits past
// the document, so the bounding box's far edge (1291) is on the FAR side while
// the near margin ends at -36 like everything else.
const BOTH_MARGINS = { bounds: { x: -995, y: 100, w: 2286, h: 606 }, nearMarginFarEdge: -36 }

const anchor = (o) => computeFleetHudDefaultAnchor({
  docNearScreen: DOC_NEAR_SCREEN, flowAxis: FLOW, screenPad: SCREEN_PAD, marginGap: MARGIN_GAP, ...o,
})

test('single-margin layouts are bit-identical with and without the near-margin edge', () => {
  for (const [name, layout] of Object.entries(LAYOUTS)) {
    const before = anchor({ bounds: layout.bounds })
    const after = anchor(layout)
    assert.deepEqual(after, before, `${name} moved; the near-margin definition is wrong`)
  }
})

test('both-margins stops anchoring on its far-margin editor', () => {
  const before = anchor({ bounds: BOTH_MARGINS.bounds })
  const after = anchor(BOTH_MARGINS)
  assert.notDeepEqual(after, before, 'both-margins did not change; the fix did nothing')

  // The whole arrangement was pushed into the near margin by exactly the span
  // that lives on the far side of the document.
  const farSideSpan = (BOTH_MARGINS.bounds.x + BOTH_MARGINS.bounds.w) - BOTH_MARGINS.nearMarginFarEdge
  assert.equal(after.panOffset - before.panOffset, farSideSpan)
  assert.equal(farSideSpan, 1327)
})

test('both-margins now lands where the single-margin layouts do', () => {
  // Same near margin, same document: the near edge must be placed identically
  // no matter what the layout does on the far side.
  assert.equal(anchor(BOTH_MARGINS).panOffset, anchor(LAYOUTS['3-col']).panOffset)
})

test('omitting the near-margin edge preserves the old behaviour exactly', () => {
  const b = { x: -1156, y: 100, w: 1120, h: 606 }
  assert.equal(anchor({ bounds: b }).panOffset, DOC_NEAR_SCREEN - MARGIN_GAP - (b.x + b.w))
})
