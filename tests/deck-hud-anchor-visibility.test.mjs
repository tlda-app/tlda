import assert from 'node:assert/strict'
import test from 'node:test'

const { computeFleetHudDefaultAnchor } = await import('../src/overlays/fleet-hud-anchor.ts')

// The reproducer for the deck-top defect, at the layer that actually decides
// screen placement.
//
// `computeFleetHudDefaultAnchor` returns the HUD camera offset. Its own rule is
// that the layout's FAR edge lands one marginGap before the document's near
// edge on screen:
//
//     acrossFlow = docNearScreen - marginGap - farEdge
//     screen(farEdge) = farEdge + acrossFlow = docNearScreen - marginGap
//
// so the offset is additive, and the layout's screen bottom is exactly
// `docNearScreen - marginGap` on a deck.
//
// THAT IDENTITY IS WHAT app-tester MEASURED. On pic-dev `b3134a531` the deck's
// top edge sat at screen 0 and four of six panels reported `bottom: -55`. With
// marginGap 55 the rule predicts -55 exactly. The model below is therefore
// checked against the live surface rather than assumed.

const VIEWPORT_H = 834

/**
 * Screen span of the layout band, given the anchor's across-flow offset.
 *
 * THE ONE ASSUMPTION THIS SUITE CANNOT SEE. `bounds.y + acrossFlow` is a model
 * of how the anchor is projected, not something the tests observe. It is sound
 * today because `FleetHUD.tsx` hands `computeFleetHudDefaultAnchor` the same
 * `bounds` the layout was built from, so the `bounds.y` in the offset and the
 * `bounds.y` in the position are the same number and cancel exactly:
 *
 *     acrossFlow = docNearScreen + marginGap - bounds.y
 *     screen top = bounds.y + acrossFlow = docNearScreen + marginGap
 *
 * **If that projection ever stops being additive, or the anchor is handed
 * different bounds from the ones the band is drawn at, the cancellation breaks
 * and every test in this file stays green.** A test cannot catch that — it is
 * the model itself that would be wrong — so it is written down here instead.
 * The live signal is the same one that found the original defect: panel
 * `bottom` on a real deck.
 */
function screenSpan({ boundsNear, boundsExtent, acrossFlow }) {
  return { top: boundsNear + acrossFlow, bottom: boundsNear + boundsExtent + acrossFlow }
}

/** A horizontal deck: pages run across, so the margin axis is y. */
function deckAnchor({ boundsNear = 4000, boundsExtent = 667, docNearScreen = 0, marginGap = 55 } = {}) {
  const anchor = computeFleetHudDefaultAnchor({
    bounds: { x: 0, y: boundsNear, w: 900, h: boundsExtent },
    docNearScreen,
    flowAxis: 'x',
    screenPad: 8,
    marginGap,
  })
  // flowAxis 'x' pins x, so the across-flow offset is carried on cameraY.
  return { anchor, ...screenSpan({ boundsNear, boundsExtent, acrossFlow: anchor.cameraY }) }
}

/** A paper: pages run down, so the margin axis is x. The control. */
function paperAnchor({ boundsNear = -900, boundsExtent = 800, docNearScreen = 300, marginGap = 55 } = {}) {
  const anchor = computeFleetHudDefaultAnchor({
    bounds: { x: boundsNear, y: 0, w: boundsExtent, h: 700 },
    docNearScreen,
    flowAxis: 'y',
    screenPad: 8,
    marginGap,
  })
  // flowAxis 'y' pins y, so the across-flow offset is carried on panOffset.
  return { anchor, ...screenSpan({ boundsNear, boundsExtent, acrossFlow: anchor.panOffset }) }
}

test('the model reproduces the live measurement under the OLD rule', () => {
  // Validity check for everything below, and it carries the old rule itself
  // rather than depending on current behaviour — otherwise fixing the defect
  // would delete the evidence that the model was ever right.
  //
  // Old rule: the layout's FAR edge lands one marginGap before the document's
  // near edge, so the band's screen bottom is exactly `docNearScreen - marginGap`.
  const oldRuleAcrossFlow = (docNearScreen, marginGap, farEdge) => docNearScreen - marginGap - farEdge

  const boundsNear = 4000, boundsExtent = 667, docNearScreen = 0, marginGap = 55
  const acrossFlow = oldRuleAcrossFlow(docNearScreen, marginGap, boundsNear + boundsExtent)
  const { bottom } = screenSpan({ boundsNear, boundsExtent, acrossFlow })

  // app-tester, pic-dev b3134a531: deck top at screen 0, four panels at -55.
  assert.equal(bottom, -55, 'the old rule predicts the number the browser reported')
  assert.ok(bottom <= 0, 'and puts the whole band above the viewport, which is the defect')
})

test('a deck band is visible: some of it lies inside the viewport', () => {
  // The assertion the fix has to satisfy, and the one that distinguishes a real
  // repair from a no-op. My previous candidate moved the shapes in page space,
  // which this cannot see — the anchor is derived from the same bounds, so the
  // offset absorbs the move and the screen result is identical.
  const { top, bottom } = deckAnchor()
  assert.ok(bottom > 0, `band bottom ${bottom} must be below the viewport top`)
  assert.ok(top < VIEWPORT_H, `band top ${top} must be above the viewport bottom`)
})

test('a deck band starts at the deck top, not over the middle of the slide', () => {
  // Skip rejected the other outcome in this exact function: "the fucking two
  // chats being almost perfectly overlaid on my fucking slide". Along the top is
  // not the same thing as centred on it, and that difference is why a screen
  // clamp was removed here once already.
  const docNearScreen = 0
  const { top } = deckAnchor({ docNearScreen, marginGap: 55 })
  assert.ok(top >= docNearScreen, `band begins at or after the deck top edge, not ${top}`)
  assert.ok(top <= docNearScreen + 120, `band begins near the top, not ${top}px down`)
})

test('the deck rule holds wherever the deck top happens to be on screen', () => {
  // The deck's top edge is not always at 0 — the reader may have panned.
  for (const docNearScreen of [-200, 0, 120, 400]) {
    const { top } = deckAnchor({ docNearScreen })
    assert.ok(top >= docNearScreen, `top ${top} tracks the deck top ${docNearScreen}`)
  }
})

test('CONTROL: the paper is untouched — its band still sits in the margin', () => {
  // Beside the document, far edge one marginGap before the near edge. This must
  // not move; a paper leaves the width and the placement already works.
  const { anchor, bottom } = paperAnchor({ docNearScreen: 300, marginGap: 55 })
  assert.equal(bottom, 300 - 55, 'far edge lands one marginGap before the document')
  assert.equal(anchor.panOffset, 300 - 55 - (-900 + 800))
})

test('CONTROL: the paper band is on screen, and stays on screen', () => {
  const { top, bottom } = paperAnchor()
  assert.ok(bottom > 0 && top < 1200, 'the paper control is visible before and after any change')
})
// --- Stored anchors --------------------------------------------------------
//
// The blocker on the first version of this candidate. `computeFleetHudDefaultAnchor`
// is the DEFAULT, and a stored anchor takes precedence over it — so changing the
// default without invalidating stored anchors fixes a fresh profile and leaves
// an existing one exactly as broken as before.
//
// And a live gate structurally cannot catch it: panels created moments before
// measurement carry fresh anchors. Skip positions his own panels, so he is
// precisely the person who would see no change at all.

const { ANCHOR_RULES, readStoredAnchor } = await import('../src/overlays/fleet-hud-anchor-rule.ts')

const paperAnchorMeta = { panOffset: 62, cameraY: 110, rule: 'flow-axis-1', axis: 'y' }
const staleDeckMeta = { panOffset: 62, cameraY: 110, rule: 'flow-axis-1', axis: 'x' }
const freshDeckMeta = { panOffset: 62, cameraY: 110, rule: ANCHOR_RULES.x, axis: 'x' }

test('a stored DECK anchor written under the old placement is rejected', () => {
  // Without this the fix is invisible to every existing deck: the stored anchor
  // wins over the corrected default and the band stays off screen.
  assert.equal(readStoredAnchor(staleDeckMeta, 'x'), null)
  assert.equal(readStoredAnchor(staleDeckMeta, null), null, 'rejected with no flow axis supplied too')
})

test('a stored PAPER anchor survives — its placement rule did not change', () => {
  assert.deepEqual(readStoredAnchor(paperAnchorMeta, 'y'), { panOffset: 62, cameraY: 110 })
  assert.deepEqual(readStoredAnchor(paperAnchorMeta, null), { panOffset: 62, cameraY: 110 })
})

test('a deck anchor written under the new placement is honoured', () => {
  assert.deepEqual(readStoredAnchor(freshDeckMeta, 'x'), { panOffset: 62, cameraY: 110 })
})

test('invalidation is scoped: the deck bump did not take papers with it', () => {
  // The alternative — one global rule name — discards every paper anchor on
  // documents whose placement never moved. That cost is what b81326d6a avoided.
  assert.notEqual(ANCHOR_RULES.x, ANCHOR_RULES.y)
  assert.equal(ANCHOR_RULES.y, 'flow-axis-1', 'the paper rule name is unchanged')
})

test('the axis guard still rejects an anchor whose document changed shape', () => {
  // A separate job from the rule guard: a deck that used to flow down carries a
  // 'y' anchor, which is not a position under 'x' whatever rule wrote it.
  assert.equal(readStoredAnchor(paperAnchorMeta, 'x'), null)
  const untagged = { panOffset: 62, cameraY: 110, rule: 'flow-axis-1' }
  assert.deepEqual(readStoredAnchor(untagged, 'y'), { panOffset: 62, cameraY: 110 }, 'untagged reads as y')
  assert.equal(readStoredAnchor(untagged, 'x'), null, 'and is not a position on a deck')
})

test('junk is not an anchor', () => {
  assert.equal(readStoredAnchor(null, 'x'), null)
  assert.equal(readStoredAnchor({}, 'x'), null)
  assert.equal(readStoredAnchor({ panOffset: 1, cameraY: 2 }, 'x'), null, 'no rule at all')
  assert.equal(readStoredAnchor({ panOffset: 1, cameraY: 2, rule: 'made-up', axis: 'x' }, 'x'), null)
})
