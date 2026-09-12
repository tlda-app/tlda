# The layout picker, the two-margin bug, and a wrong answer I published first {#findings}

**Status: diagnosed and fixed. Root cause is one line in `src/overlays/fleet-hud-anchor.ts`.**

**Read the retraction section before reusing anything from the first version of this file.**
The 22:52 version of this document gave a confident, arithmetically clean, and **wrong**
diagnosis, and it reached Skip as established before he corrected it from his screen.

---

## What is actually wrong

**`fleet-hud-anchor.ts:52–54` anchors the HUD on the right edge of the *entire* fleet
bounding box:**

```js
const acrossFlow = docNearScreen - marginGap - (marginAxis === 'x'
  ? bounds.x + bounds.w
  : bounds.y + bounds.h)
```

The HUD is positioned so that edge lands one `marginGap` before the document. **For every
layout whose shapes live in one margin, that edge *is* the near margin's far edge, so it is
correct.** `both-margins` is the only variant that straddles the document — its bounding box
includes the source editor placed *past* the document. Anchoring that edge in the near
margin drags the whole arrangement, document-shaped gap and all, into the left margin.

**Skip, from his screen:** *"I'm getting the right layout in the wrong location. It doesn't
wrap the document."* and *"a nice two column layout in the left margin of my document with a
hole for my document to go in."* Both are exactly this.

### Measured on the rendered page, 1470×866, deployed `5f68565d2`

Two layers, both at zoom 1, read off their CSS transforms:

| | `both-margins` | `3-col` (control) |
|---|---|---|
| document layer x | **+32.125** | +32.125 |
| fleet HUD layer x | **−1315** | +32012 |

`fleetLayoutDx()` returns **0** for `both-margins`, so its HUD offset should equal the
document's `+32.125`. It is `−1315`. 3-col's `+32012` looks wilder but is correct: its panels
carry the owner-lane offset and the HUD cancels it.

Panel positions, `both-margins`, document at 335..1135:

```
fleet-source-editor  -176..279     LEFT margin   ← belongs at 1171..1626
fleet-chat/docview  -1503..-1048
fleet-agents/search -1755..-1513
fleet-inbox         -2007..-1765
```

The gap between the inner column's right edge (−1048) and the editor's left edge (−176) is
**872px = document 800 + two margin gaps of 36.** The hole he describes, to the pixel.

### The fix

**Near margin = the shapes between the document and the edge the HUD is anchored to** —
every shape whose far edge is at or before the document's near edge. Anchor on the furthest
of those. Definition from `chief-night`.

`test/fleet-hud-anchor-near-margin.test.mjs` asserts the part that matters: **the five
single-margin layouts come out bit-identical**, and `both-margins` moves by exactly the
1327px that lives on the far side.

---

## Retracted: the fit theory {#retracted}

**The first version of this file said the defect was that the layouts are too wide for a
13-inch screen.** It had a table showing `both-margins` needing 2,286px on a 1,470px screen,
`big-chat` over by 476, and the observation that the fit ordering reproduced Skip's five
verdicts monotonically with no exceptions.

**All of those numbers are correct. None of them is the bug.**

Skip: *"the general fit approach is, we don't need to cram the whole layout onto your 13
inch M[ac]."* It is a canvas and he pans. **Over-width is not a defect at all.** His actual
rule is narrower: *"we want the inner column of shapes in each margin"* to fit alongside the
document — one column, not the arrangement.

**Why it was persuasive, which is the part worth keeping.** The planner's total for
`both-margins` is 2,286px, and the misplaced unit measured **−2007..279 = 2,286px**. The
width was right and the *position* was wrong, so a width-shaped explanation fitted the
evidence perfectly and was still not the cause. A monotonic correlation across five
independent verdicts felt like proof and was a correlation between his verdicts and **a model
of the layout rather than the layout**.

**Two further claims from that version, also withdrawn:**

- **That `variantContentW()` omits the far margin and is therefore the mechanism.** It
  returns the near-margin group only, which is *correct*. I built on it twice.
- **That the layout wrapped a phantom document** whose bounds were 760 wide and 1,327px to
  the left. Derived by working backwards through an assumed `marginGap`; the 3-col control
  disproved it by resolving the document's left edge to 335 exactly.

**The method error, once, in one sentence: I measured `planFleetLayoutShapes()` — a pure
function whose output I could compute without a browser — and reported it as the layout.**
The planner says the editor goes right of the document; the DOM says left. **Where those
disagree the planner is the thing that is wrong about the world**, and the DOM is three
commands away.

---

## Still true from the first version

**Four of the six picker previews omit `fleet-inbox`.** Every variant with a rail draws two
rail rectangles and builds three panels; the planner puts `fleet-inbox` a full column
further out. `single-chat` and `two-chat` are accurate.

**This is a separate defect from the placement bug and is not fixed here.** Whether to draw
the inbox or stop building it in those layouts changes what everyone gets, so it is a
product decision rather than a repair.

## Open

**A ~20px residual.** The measured layer-offset delta is 1347.1; the far-side span the fix
removes is 1327. The mechanism is not in doubt and the fix is pinned to 1327 by test.
`bounds` comes from `readMaintainedFleetBounds()`, which may carry padding I have not read.
**Named rather than rounded away.**

**"2-col" is a stale alias for `both-margins`** in `fleet-layout-context.ts:130` and
`FleetIconPill.tsx:5`. It collides with Skip's own "two column" for a different family and
should go in `docs/naming-errata.md`.
