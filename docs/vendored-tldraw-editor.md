# The forked tldraw editor

`@tldraw/editor` comes from the public `tlda-app/tldraw-fork` repository rather
than npm. `package.json` and `package-lock.json` pin one immutable package-root
artifact commit over HTTPS:

```json
"@tldraw/editor": "git+https://github.com/tlda-app/tldraw-fork.git#b8ae2f885e3311129e788f67c4bbdacc8f2aef19"
```

The wrapper package `tldraw` and the editor's six sibling packages remain the
ordinary published `5.2.0` packages. Only the editor is forked, from upstream
`5.2.0`.

## Why the pin names an artifact commit

The editor source lives at `packages/editor` in a Yarn monorepo. npm cannot
install a package from a subdirectory of a Git repository, so pinning the
monorepo source commit would install its private root package rather than
`@tldraw/editor`.

The source package is not independently installable either. Its six tldraw
dependencies are declared as `workspace:*`, and its build scripts reach into
the monorepo:

```json
"build": "yarn run -T tsx ../../internal/scripts/build-package.ts",
"prepack": "yarn run -T tsx ../../internal/scripts/prepack.ts"
```

The `prepack` step builds the editor and rewrites the sibling dependencies to
concrete `5.2.0` versions. npm runs `prepare`, not `prepack`, for a Git
dependency, so pointing at the source tree would skip the step that makes the
package installable.

The pinned commit solves both problems. Its repository root is the output of
packing `packages/editor`: the root `package.json` names `@tldraw/editor`, its
workspace dependencies are concrete, and `dist-cjs/`, `dist-esm/`, and `src/`
are already present. npm clones that commit as an ordinary Git dependency and
has nothing to build inside the fork.

The artifact commit is a child of the source commit it was built from. For the
current pin:

- `1d61d011c5a122cdabeb0893fe2f7d0b4f8d735d` is the source commit.
- `b8ae2f885e3311129e788f67c4bbdacc8f2aef19` is the package-root artifact
  commit.
- `artifact/editor-5.2.0-tlda.12` is the public branch that keeps the artifact
  commit reachable.

That parent relation makes the built package traceable without making the
monorepo root pretend to be the editor package.

## What the fork carries

### Multiple viewports

The fork adds `lib/editor/viewports/TLViewport.ts` and
`lib/components/TldrawViewport.tsx`, changes `Editor.ts`,
`notVisibleShapes.ts`, `Shape.tsx`, and `CanvasOverlays.tsx`, and exports
`TldrawViewport`, `DEFAULT_VIEWPORT_ID`, `getViewportPageBounds`, `TLViewport`,
`TLViewportId`, and `TLViewportOptions`.

This is what the fleet HUD is built on: a second camera over the same store.
The consumers under `src/wm/` depend on these exports and fail loudly if the
viewport feature disappears.

### Gesture interpretation

The fork adds `lib/hooks/gesture/GestureInterpreter.ts`, changes
`useGestureEvents.ts`, `useCanvasEvents.ts`, `InputsManager.ts`,
`getPointerInfo.ts`, and `event-types.ts`, and exports `GestureInterpreter`,
`DEFAULT_GESTURE_TUNING`, `TLGestureFrame`, `TLGestureKind`, `TLGesturePoint`,
and `TLGestureTuning`.

Two reported defects drove this path:

- Three fingers on the canvas zoom-jumped on lift because upstream opened a
  pinch as soon as the first two fingers arrived. The interpreter reads the
  touch stream once and can revise its decision as more evidence arrives.
- iPadOS Safari reported itself as a Mac and took the trackpad gesture path.
  The fork chooses from whether the input contains touch points instead of the
  reported operating system.

### Viewport wheel and stylus behavior

`TldrawViewport.tsx` adds the normalized wheel delta to its camera, matching
the main editor's sign. The previous subtraction made pinned clip panels pan in
the opposite direction from the main canvas.

The viewport also treats a primary pen pointer like primary touch input while
the hand or select tool owns the interaction. That is the stylus behavior first
shipped through the direct artifact dependency. Drawing tools still receive pen
input instead of panning the viewport.

## Building the source

The public `tlda-app/tldraw-fork` repository is a Yarn 4 monorepo. Run its
commands from the repository root.

The editor builds with:

```sh
yarn workspace @tldraw/editor run build
yarn workspace @tldraw/editor pack-tarball --out /path/to/editor.tgz
```

Packing runs the monorepo's `prepack` step. The resulting archive is build
output used to create the package-root artifact commit; it is not committed to
tlda.

## Publishing a fork change

1. Make and test the source change in the fork monorepo.
2. Commit the source change before building the artifact.
3. Pack `@tldraw/editor` from that source commit.
4. Create a package-root artifact commit from the archive contents, with the
   source commit as its parent.
5. Put the artifact commit on a public `artifact/editor-...` branch.
6. Pin the artifact commit's full SHA in both tlda manifests using
   `git+https://github.com/tlda-app/tldraw-fork.git#<sha>`.
7. Regenerate `package-lock.json` and check that its `resolved` entry is also
   `git+https://`, never `git+ssh://` or `git@github.com:`.
8. In a clean tlda checkout with a fresh npm cache, run `npm ci` with SSH
   disabled. This crosses the same public network boundary as the clean Fly
   builder.

The current dependency was verified with a fresh cache and
`GIT_SSH_COMMAND=/usr/bin/false`; `npm ci` installed the artifact successfully.
A full clean install also completed tlda's production Vite build, and `tsc -b`
passed.

## On an upstream upgrade

A tldraw upgrade is a re-fork rather than a version bump. Carry the viewport
and gesture features onto the new upstream base, then re-test the two gesture
defects, viewport wheel direction, and stylus panning before publishing a new
artifact commit.

Also check whether upstream fixed the vertical-toolbar safe-area bug worked
around in `src/App.css`. Against tldraw `5.2.0`, upstream uses
`safe-area-inset-bottom` for the vertical toolbar's left padding, which moves
the toolbar away from the iPad edge. Delete the workaround if upstream has
fixed the underlying rule.

Before changing tlda's pin, compare the packed artifact with the previous
artifact. A build includes the entire current fork checkout, so the package
diff—not the source edit alone—is the record of what the dependency update
will ship.
