# Pointer-drivable fleet HUD — findings and resume point

Written 2026-09-02 ~20:05 EDT by `hud-pointer-opus`, on a stop order from
`cleanup-chief` (no nontrivial computation on the Mini). Force-added because it
is a resumption point, not a report: the next session works *from* it.

Branch `hud-pointer-reachability`, at `01c1138cf`, off `main` at `96ced8b73`.
Working tree clean. Nothing deployed, nothing merged, `shared-3` released.

## The blocker was the instrument, not the app

Three agents in a row (`features-pm`, `search-pm`, `sol-dev`) reported that a
fleet control cannot be driven by real pointer input in an automated session,
because every fleet shape renders tens of thousands of pixels outside the
viewport and nothing available to an agent brings it back. The conclusion on
the way in was that this needs a camera handle exposed to automated sessions or
a new HUD layout.

**Neither is needed. The panel was reachable throughout.**

`pw center chat|fleet` set the main camera from a fleet shape's **page** bounds
(`cam.x = -shape.minX + 32`). That equation is only correct for a shape the main
canvas draws. With the HUD open the panels are drawn by the HUD viewport, whose
across-flow position is `docNearScreen - marginGap - layoutFarEdge`
(`src/overlays/fleet-hud-anchor.ts`). Solving the main-canvas equation for a
HUD-projected shape moves the camera by roughly the owner-lane offset in the
wrong direction, which is where the "x is about 40,893, and centering does not
shift it" reading came from.

It also took the **first** fleet shape on the page. A shared room carries every
owner's layout, one 20,000px lane apart, so that pick was usually somebody
else's panel.

## What is actually true, measured

Deployed testing build, project `dev-linked-remote-probe`, my tab, viewport
1200x834, HUD open (`body.fleet-hud-open`, `fleet-hud-expanded = "1"`):

| fact | value |
|---|---|
| document page bounds | x 0, y 0, w 800, h 1200 |
| main camera | x 200, y 50, z 1 |
| my 6 panels, page coords | x -21365 to -20400, y 58800 |
| HUD shape-layer transform | `translate(20200, -58700)` |
| my panels on screen | x -1165 to +165, y 100 to 684 |

So the layout sits in the margin left of the document, the document's near edge
is at screen x=200, and the layout is 1330px wide. 1165px of it hangs off the
left edge. The HUD rule is being satisfied exactly; there is simply no margin
to satisfy it in.

**Panning the main camera moves the HUD 1:1 on the margin axis.** Measured:
camera x 200 to 1200 moved the HUD layer 20200 to 21200 and the search panel
from x=-921 to **x=79, y=332, 234x352 — fully inside the viewport**, with
`elementFromPoint` at its centre returning the panel's own `INPUT`.

Along the flow axis the HUD is screen-pinned and does not move with the camera
at all. That is why solving *both* axes from page coordinates cannot work for
these shapes in either document orientation.

## The change

One file, `cli/lib/pw.mjs`, 131 insertions / 6 deletions. No app code. No
product behaviour. Search behaviour untouched.

`pw center` for a fleet region now measures the rendered element and pans by the
minimum residual that brings it inside the viewport, per axis, and nothing when
it is already inside. Reimplementing the anchor rule in the tool would work
until that rule changed and then land the camera somewhere plausible and wrong,
which is the same reason the WM delegates conversion to the fork instead of
recomputing it.

With it:

- restricted to the caller's own panels via `__tldaFleetIdentity`, so a shared
  room cannot centre another owner's layout;
- picks the copy that is not `visibility: hidden` — an open HUD puts each shape
  in the DOM **twice**, under different cameras, and the visible one is the copy
  `elementFromPoint` honours, so this is the copy a real pointer hits;
- sets `__tldaFleetHudSuppressCameraTrackingUntil`, the app's own flag, so the
  pan is navigation rather than a deliberate pan the HUD persists to Yjs for
  everyone in the room. **The old `pw center` did not do this**, so every
  `center` call it made wrote a displaced HUD anchor into the room it was
  pointed at;
- reports the rect it actually achieved, and says so when a panel is wider than
  the viewport and cannot fit;
- `doc` is unchanged — a document page really is drawn by the main canvas;
- regions extended with `agents | search | inbox | docview` alongside
  `doc | fleet | chat`, which is the fleet panel registry's own vocabulary.

`01c1138cf` is a follow-up worth reading before trusting any output: the first
version re-measured **synchronously** after `setCamera`, so it read the rect
from before the move and reported `onScreen: false` for a camera that was
already correct — the tool manufacturing its own false negative. It now awaits
two animation frames.

## Verification state — this is the resume point

`npx eslint cli/lib/pw.mjs` clean, and confirmed able to go red (injected an
undefined reference, got `no-undef`, restored). Module parses.

Real-surface verification is written and **half-run**. Script:
`scratchpad/verify.sh` in this session's scratchpad, reproduced below in
substance so it survives:

1. reset camera to x=200, the broken starting state
2. measure — expect the search panel off the left edge
3. `pw center search` — the fix
4. measure again

**Steps 1 and 2 passed on the real surface** against the *first* commit: camera
x=200, search panel at x=-921, and exactly 6 elements matched (the HUD copies),
which is itself the check that the `visibility` filter works — without it 12
would match. Step 3 ran and computed `dx: 945` correctly, which is the right
answer: -921 + 945 = 24 = the pad.

**Step 4 has never been observed after the frame-wait fix.** The rerun was
stopped mid-flight by the Mini stop order. So:

**The one unproven claim is the achieved rect, and the click.** Everything
upstream of it is measured. Do not report this as verified.

## Next actions, in order, when the Mini is available again

1. `zsh scratchpad/verify.sh` — or re-create it; it runs
   `node /Users/skip/worktrees/hud-pointer-reachability/cli/tlda-dev.mjs`,
   **not** the `tlda-dev` on PATH, which currently symlinks to
   `~/worktrees/land-tonight` and would exercise the old code. Expect step 4 to
   show the search panel at x≈24 with `onScreen: true`.
2. Then the original task's gate: type a query into the centred search panel,
   get a card carrying `Show more messages`, click it with real pooled pointer
   input, observe the additional messages and no console error.
3. Route the diff for independent review. Do not deploy or integrate.

## Two observations for whoever owns them — not acted on

**The 3-col layout is wider than the viewport it was laid out for.** 1330px of
layout on a 1200px screen, with the document then starting at screen x=200 and
leaving 200px of margin for it. Not the blocker here — the search panel alone is
234px and fits fine — but it means no camera position shows the whole layout at
once on this viewport, and `adaptiveInnerColumnWidth` exists precisely to stop
that. Worth a look on a small laptop.

**`pw`'s shared pool lock was heavily contended throughout**, with
`fleet:37940530` repeatedly taking `shared-3` after `cleanup-chief` had released
it to me. Most single commands needed several attempts. Anyone timing work on
that pool should assume retries.
