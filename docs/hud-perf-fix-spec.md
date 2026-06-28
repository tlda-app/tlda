# FleetHUD pan/zoom perf (and movement) fix — spec

## The regression

Commit `c6cb4d66` ("Make WMCore load-bearing") introduced a per-frame **React
re-render** of the FleetHUD. A new `wmCameraTick` useState is bumped on every camera
change (`src/overlays/FleetHUD.tsx:779`, in the `react('fleet-hud-main-camera', …)`
subscription; also from `configureFleetHudOverlayLayer`'s `tick`). That forces the
entire FleetHUD render function + subtree to re-run every frame during pan/zoom.
Before, the camera tracked imperatively through the WM layer transform with **no
React render**. Skip's real numbers: 444ms frozen frame at zoom 0.282 (~4000 nodes).

What is NOT the cause (verified): the O(N) `getShapePageBounds` page-bounds loops
(FleetHUD.tsx:1111/1144/1185) are **gated** — initial-anchor-only
(`hudAnchorRef.current === null`), phone-only, and off-screen-no-pan-only. They do
not run on the steady-state pan path, and the margin/layout computation already
correctly lives in the discrete default-layout / re-layout path. Do not "optimize"
those loops; they're already gated. The fix is the per-frame React re-render.

## The motion model (Skip's spec — this is canonical)

> "There's a main canvas motion. The HUD motion is the same as the X-part of the
> main canvas motion. A zoom makes it a little complicated, but we just need a
> coherent interpretation: when we change the viewport transform for the main
> canvas, we change the viewport transform for the HUD only using the X motion,
> zoom-normalized scale — because the motion of the HUD is not zoom-sensitive."

Precisely:

- The main canvas has a viewport transform `(x, y, z)`.
- The HUD's viewport transform is a **derived re-interpretation** of that same input:
  - tracks the **X motion only**,
  - **zoom-normalized** (so it pans horizontally in lockstep with where the doc sits
    on screen, regardless of zoom),
  - **not zoom-sensitive**: fixed size, **no Y-track, no scale**.
- Per frame, the entire job is: recompute that one derived transform from the main
  camera and apply it to the HUD layer. Cheap. **Imperative. No React render, no
  shape scan, no layout recompute.**

The WM already has the exact knobs: per-axis track factors + a zoom factor in
`effectiveTransform` (`src/wm/wm-core.ts`). The HUD layer policy should express
"X-track, zoom-normalized, no Y, no zoom"; the per-frame update feeds the main camera
to that layer **through the transform**, not through a React state bump.

## The fix

1. **Delete the per-frame React re-render.** Remove the `wmCameraTick` state churn
   (`FleetHUD.tsx`) that forces a full component re-render on every camera change.
   The camera subscription should update the WM HUD layer's transform imperatively
   (set the layer camera/transform), not call `setState`.
2. **Express the HUD layer policy** as X-track + zoom-normalized + no-Y + no-zoom, so
   `effectiveTransform` produces the correct HUD position from the main camera every
   frame with cheap arithmetic.
3. Leave the gated default-layout / re-layout anchor computation exactly where it is
   (initial anchor + re-layout). It is correct and discrete; do not move it onto the
   per-frame path, and do not couple HUD positioning to page shapes.

This is a **decoupling + deletion**, not an added optimization. No appearance change
(no-UI-change rule) — the HUD must look and sit exactly as it does now.

## Verification (both required)

- **Perf:** frame-time before vs after, panning/zooming the SVG doc (use the
  `pan-perf` logging / instrument; drive the browser with `tlda-dev pw`). The 444ms-
  class frames at zoom should be gone; steady-state pan/zoom frames should be cheap.
- **Correctness (movement):** the HUD still tracks the doc horizontally on pan, stays
  fixed-size on zoom, and — critically — **panning/zooming actually works smoothly**
  (Skip's hypothesis is the per-frame re-render was also fighting the camera). Verify
  real pan + zoom gestures in the browser, not just frame numbers.
- No regression to latex/markdown/docview; HUD anchors correctly across layouts.
