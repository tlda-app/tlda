import assert from 'node:assert/strict'
import test from 'node:test'

const { layoutAcrossOrigin } = await import('../src/shapes/fleet-layout-origin.ts')
const { ANCHOR_RULES, readStoredAnchor } = await import('../src/overlays/fleet-hud-anchor-rule.ts')

// Measured on pic-dev `index-B6438pUE.js` before this change: ownership, HUD
// mount and screen-x invariance under horizontal pan all pass, and every HUD
// panel sits at `bottom <= -55` — wholly above the viewport, so nothing is
// visible along the deck top.
//
// Skip: "having fleet shapes run along the top of decks like really helps me
// write decks", and "it's a priority fix really."

// --- Placement -------------------------------------------------------------

test('a paper keeps the layout OUTSIDE its near edge, exactly as before', () => {
  // The far edge lands marginGap before the document starts, so the two never
  // overlap. This is the case that was already right and must not move.
  assert.equal(
    layoutAcrossOrigin({ marginAxis: 'x', docNear: 1000, marginGap: 40, contentAcross: 600 }),
    360,
  )
  // Its far edge: 360 + 600 = 960, which is marginGap short of the document.
  assert.equal(360 + 600, 1000 - 40)
})

test('a deck puts the band INSIDE the top edge, where it can be seen', () => {
  const origin = layoutAcrossOrigin({ marginAxis: 'y', docNear: 0, marginGap: 40, contentAcross: 667 })
  assert.equal(origin, 40)

  // The counterfactual, written out rather than described: the old rule put the
  // band's far edge marginGap ABOVE the top, so with the camera on the slides
  // every panel was off the top of the screen. That is the reported defect.
  const oldRule = 0 - 40 - 667
  assert.equal(oldRule, -707)
  assert.ok(oldRule + 667 < 0, 'old rule: the whole band is above the document top')
  assert.ok(origin >= 0, 'new rule: the band starts at or after the document top')
})

test('the deck band is inside the deck, not merely less far outside it', () => {
  // A deck is 1000 tall in the measured case. The band has to begin within it,
  // otherwise "along the top" is still off screen for anyone looking at slides.
  const deckTop = 250
  const origin = layoutAcrossOrigin({ marginAxis: 'y', docNear: deckTop, marginGap: 40, contentAcross: 667 })
  assert.ok(origin > deckTop, 'begins below the top edge')
  assert.ok(origin < deckTop + 1000, 'and within the deck, not past its bottom')
})

test('the two cases are different rules, not one with a sign flip', () => {
  // Same inputs, both axes. If these ever coincide, someone has collapsed them.
  const args = { docNear: 500, marginGap: 40, contentAcross: 600 }
  assert.notEqual(
    layoutAcrossOrigin({ marginAxis: 'x', ...args }),
    layoutAcrossOrigin({ marginAxis: 'y', ...args }),
  )
})

// --- Stored anchors --------------------------------------------------------
//
// The advocate's warning, and it is the failure mode that would ship: the gate
// panels are created moments before measurement, so they carry fresh anchors. A
// candidate that forgets stored ones passes on a clean profile and leaves
// anyone with an existing deck at the old offscreen placement — including Skip,
// whose panels he positioned himself.

const paperAnchor = { panOffset: 62, cameraY: 110, rule: 'flow-axis-1', axis: 'y' }
const staleDeckAnchor = { panOffset: 62, cameraY: 110, rule: 'flow-axis-1', axis: 'x' }
const freshDeckAnchor = { panOffset: 62, cameraY: 110, rule: ANCHOR_RULES.x, axis: 'x' }

test('a paper anchor survives — its placement rule did not change', () => {
  assert.deepEqual(readStoredAnchor(paperAnchor, 'y'), { panOffset: 62, cameraY: 110 })
  // And with no flow axis supplied, which is how one caller reads it.
  assert.deepEqual(readStoredAnchor(paperAnchor, null), { panOffset: 62, cameraY: 110 })
})

test('a deck anchor written under the OLD placement is rejected', () => {
  // This is the whole point. Without it the fix is invisible to every existing
  // deck: the panels stay exactly where they were and the change looks broken.
  assert.equal(readStoredAnchor(staleDeckAnchor, 'x'), null)
  assert.equal(readStoredAnchor(staleDeckAnchor, null), null, 'rejected even with no axis supplied')
})

test('a deck anchor written under the new placement is honoured', () => {
  assert.deepEqual(readStoredAnchor(freshDeckAnchor, 'x'), { panOffset: 62, cameraY: 110 })
})

test('invalidation is scoped: bumping the deck rule did not take papers with it', () => {
  // The alternative — one global rule name — would have discarded every paper
  // anchor on every document whose placement never moved. That is the cost
  // b81326d6a avoided, and it must not be re-incurred here.
  assert.notEqual(ANCHOR_RULES.x, ANCHOR_RULES.y)
  assert.equal(ANCHOR_RULES.y, 'flow-axis-1', 'the paper rule name is unchanged')
  assert.deepEqual(readStoredAnchor(paperAnchor, 'y'), { panOffset: 62, cameraY: 110 })
})

test('the axis guard still rejects an anchor whose document changed shape', () => {
  // Separate job from the rule guard: a deck that used to flow down carries a
  // 'y' anchor, which is not a position under 'x' whatever rule wrote it.
  assert.equal(readStoredAnchor(paperAnchor, 'x'), null)
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
