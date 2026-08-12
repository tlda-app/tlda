# The vendored tldraw editor

`@tldraw/editor` is not installed from npm. `package.json` pins it to a file in
this repository:

```json
"@tldraw/editor": "file:vendor/tldraw-editor-5.2.0-tlda.10.tgz"
```

The wrapper package `tldraw` is the ordinary published `5.2.0`. Only the editor
is forked, and the fork is based on upstream `5.2.0` — both `package.json` files
report that version, so `-tlda.10` is our tenth build on top of it rather than a
different upstream release.

Vendored rather than fetched from a release URL because `Dockerfile.live` ships
a prebuilt `dist/` and installs only server dependencies. The editor is resolved
on the build machine and never inside the image, so a file in the repository
needs no external publish and keeps the build reproducible from a checkout.

## What the fork carries

Measured by unpacking `vendor/tldraw-editor-5.2.0-tlda.10.tgz` and diffing its
`src/` against `npm pack @tldraw/editor@5.2.0`, on 2026-08-12: **13 files,
+476/-194**, in two features.

**Multiple viewports.** New: `lib/editor/viewports/TLViewport.ts`,
`lib/components/TldrawViewport.tsx` (337 lines). Changed: `Editor.ts` (+129),
`notVisibleShapes.ts`, `Shape.tsx`, `CanvasOverlays.tsx`. Adds the exports
`TldrawViewport`, `DEFAULT_VIEWPORT_ID`, `getViewportPageBounds`, `TLViewport`,
`TLViewportId`, `TLViewportOptions`.

This is what the fleet HUD is built on — a second camera over the same store.
Twelve files under `src/` reference these exports, including `src/wm/`, whose
`tldraw-fork-viewport-adapter.ts` exists to sit on top of them.

**Gesture interpretation.** New: `lib/hooks/gesture/GestureInterpreter.ts` (418
lines). Changed: `useGestureEvents.ts` (+375/-161), `useCanvasEvents.ts`,
`InputsManager.ts`, `getPointerInfo.ts`, `event-types.ts`. Adds the exports
`GestureInterpreter`, `DEFAULT_GESTURE_TUNING`, `TLGestureFrame`,
`TLGestureKind`, `TLGesturePoint`, `TLGestureTuning`.

Two defects drove it, both recorded in the commits that bumped the pin:

- Three fingers on the canvas zoom-jumped on lift. tldraw opens a pinch the
  first moment it sees two fingers, and three fingers always pass through two,
  so a pinch opened underneath our own pan handler and settled on release. The
  forked interpreter reads the touch stream once and can revise what it decided,
  so a pinch is never opened on evidence that has not arrived yet
  (`5fed2cece`, `52014f5b6`).
- An iPad took the trackpad gesture path. The choice was made on `!tlenv.isIos`
  and iPadOS Safari reports itself as a Mac, so the touch listeners were never
  registered and the camera was driven from `GestureEvent.scale` by a handler
  with no pan-or-zoom decision in it — which is why a two-finger drag zoomed.
  The fork chooses on whether the input has touch points (`177d8fde6`,
  `bdfdbc980`).

## The tarball cannot rebuild itself

It ships `src/`, so the fork's source is readable and diffable from a checkout —
that is how the delta above was produced, and it is enough to answer "what does
our editor do differently". It is **not** enough to produce a new tarball. The
package's own build scripts point outside it:

```json
"build": "yarn run -T tsx ../../internal/scripts/build-package.ts",
"prepack": "yarn run -T tsx ../../internal/scripts/prepack.ts"
```

Those paths are the tldraw monorepo the package was packed from, and it is not
in this repository. Producing `-tlda.11` needs that checkout. **Do not plan work
that assumes the fork can be rebuilt from `vendor/` alone**, and do not treat
"fix it upstream and rebuild" as an available cheap move until someone has
located the fork checkout and confirmed it still builds.

## On an upgrade, re-check these

A tldraw bump is not a version bump. It is a re-fork: the two features above
have to be carried onto the new base, and workarounds written against upstream
bugs have to be re-tested and deleted if upstream fixed them.

**Workarounds to delete if upstream fixes them.** Each is commented at its site
with the version it was written against.

- `src/App.css`, `.tlui-layout .tlui-main-toolbar--vertical` — tldraw defines
  `--tl-sab` as `env(safe-area-inset-bottom)` and then uses it for the *vertical*
  toolbar's *left* padding. On iPad that inset is ~20px in both orientations, so
  the toolbar sits a constant distance off the left edge; desktop never shows it
  because the inset is 0 there. Written against `tldraw 5.2.0`. This is a bug in
  the published `tldraw` package, not in our fork of the editor, so it can be
  checked against upstream without the fork checkout.

**Fork features to carry forward.** Both are load-bearing, and both fail loudly
rather than silently if dropped — the exports simply will not resolve.

- The viewport exports, or the fleet HUD has no second camera.
- The gesture exports, plus the two defects above re-tested on a real iPad,
  since both were reported from Skip's device and neither is visible on desktop.

## What is not established here

Where the fork checkout lives, and whether it still builds. Nothing in this
repository records it, and this document does not resolve that — it records that
the question is open so the next person meets it before committing to a bump
rather than an hour into one.
