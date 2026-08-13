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

## Where the fork checkout is

`/Users/skip/work/tldraw-fork`, branch `tlda/gesture-transitions`, at
`249a8acb6` when this was written — clean, with root `node_modules` present and
`yarn@4.12.0`.

**It is the one this tarball was packed from, not a lookalike.**
`packages/editor/src/lib/components/TldrawViewport.tsx` is byte-identical to the
`src/` shipped in `vendor/tldraw-editor-5.2.0-tlda.10.tgz`. That check is the one
to repeat, because there are three near-misses beside it on the same machine:
`tldraw-multicam-fork` and `tldraw-multicam-fork-pushfix` both differ by 48 lines
in that file, and `tldraw-fork.wrong-20260727093621` says what it is in its name.
Its top commits are the gesture work described in §"What the fork carries".

This section used to say the location was unknown. It was a `find` away —
`find ~ -name build-package.ts -path '*internal/scripts*'` — and the previous
text discouraged assuming the fork could be rebuilt, which is not the same as
discouraging a look.

**It builds.** `yarn workspace @tldraw/editor run build` exits 0 and produces
`dist-cjs/` and `dist-esm/`; `yarn pack` runs the `prepack` script and produces a
tarball in about two minutes. Building leaves the checkout clean — `dist/` is
ignored. **That was the other half of the open question and it is now answered
rather than assumed.**

## A defect in the fork, fixed at the root

`TldrawViewport.tsx`'s wheel handler inverts pan relative to the main canvas.
`normalizeWheel` already returns negated deltas (`{ x: -deltaX, y: -deltaY }`);
`Editor.ts`'s wheel case **adds** them (`cx + dx * panSpeed / cz`) and the
viewport handler **subtracts** them (`camera.x - delta.x / camera.z`). Same
gesture, opposite directions.

Skip reported it as *"scrolling on the canvas and scrolling in the thing are
giving me opposite scroll directions"*. It reaches any `CanvasClipPanel` that
passes `onCameraChange` without `lockCamera` — five of six consumers — but only
in a non-`preview` interaction mode, because `handleReadOnlyWheelCapture` takes
the wheel first in `preview` and routes it through `canvasClipWheelCamera`, which
has the correct sign. **That is why the wheel is right while hovering and inverts
the moment you pin.**

**Fixed in `-tlda.11`**: the handler now adds the normalized delta, the way
`Editor.ts` does. There is no workaround in `CanvasClipPanel` to unpick — the
`handleReadOnlyWheelCapture` path was already correct and is unchanged.

**On an upgrade, re-check it.** The bug is in fork-only code
(`TldrawViewport.tsx` does not exist upstream), so a re-fork carries it forward
unless someone looks. The comment at the site says why the sign is what it is.

**One difference remains and is not a bug I fixed:** `Editor.ts` scales its pan
by `cameraOptions.panSpeed` and the viewport handler does not. They agree while
`panSpeed` is 1, which is the default. Left alone deliberately — matching the
sign is the reported defect; adding a speed term is a change to how fast a
viewport pans, and nobody asked for that.

### Check a rebuild against the tarball it replaces

A rebuild picks up whatever the fork checkout has, not what you changed. If the
branch has moved since the last pack, the new tarball quietly carries that too —
and a vendored artifact is the last place anyone looks for an unexplained change.

So diff the two, unpacked, before pinning:

```sh
tar xzf vendor/tldraw-editor-5.2.0-tlda.10.tgz -C old   # git show works too
tar xzf vendor/tldraw-editor-5.2.0-tlda.11.tgz -C new
diff -rq old/package/src new/package/src
diff -rq old/package/dist-esm new/package/dist-esm
diff old/package/package.json new/package/package.json
```

For `-tlda.11` that was **one file in `src/`** (`TldrawViewport.tsx`), **two in
each `dist/`** (the module and its sourcemap), and an **identical
`package.json`** — so the checkout had not drifted and the toolchain produced
byte-identical output everywhere else. **A clean diff is what makes a vendored
rebuild trustworthy**; without it "I only changed one line" is a claim about the
edit, not about the artifact.

## What is not established here

Whether `-tlda.11` behaves correctly in a browser. The change is one sign,
derived by reading both wheel paths end to end, and the tarball was verified to
carry it in `src/`, `dist-esm/` and `dist-cjs/` — but **it has not been
installed**. The worktree it was built for symlinks `node_modules` to the shared
checkout, so installing would swap the editor under every other agent working
there. The pin is bumped and the artifact is committed; the install belongs to
whoever lands the branch.
