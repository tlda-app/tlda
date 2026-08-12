# The window manager

Developer documentation. This describes how panels get their position, their
coordinate system, and their behaviour when the document moves — the machinery
under `src/wm/`, the fleet HUD, and the clip panels. It is not user guidance;
what a reader can do with the workspace is in [the README](../README.md)
§"Arrange the workspace" and [Using tlda](using-tlda.md).

It has an [errata section](#errata). The design below is what the system is
trying to be. The errata is what currently does not match it, and it is part of
the document rather than an appendix to it — a description of intent alone is
how the next person concludes that a defect is a feature.

---

## What it is

Every surface that floats over the document — a fleet panel, the annotation
viewer, a page column, the picture-in-picture document view — sits in a **layer**.
A layer is a coordinate system with a declared relationship to its parent, and
the window manager is the thing that holds those relationships and converts
points between them.

The core is deliberately small. `src/wm/wm-core.ts` (476 lines) knows about
layers, cameras, transforms, and one conversion primitive. It knows nothing
about tldraw, fleet identity, or what a panel contains. Around it:

| module | what it owns |
|---|---|
| `wm/wm-core.ts` | the layer graph, track policy, `translate` |
| `wm/editor-wm.ts` | one `WMCore` per tldraw editor; named-viewport registration |
| `wm/viewport-coordinates.ts` | point conversion through a registered viewport |
| `wm/canvas-clip-panel.ts` | the clip-panel plan and its camera |
| `wm/tldraw-fork-viewport-adapter.ts` | a layer backed by a real fork viewport |
| `wm/managed-surfaces.ts` | the request vocabulary a surface is asked for with |
| `wm/hosted-panel-registry.ts` | panel app definitions and default sizes |
| `wm/gesture-policy.ts` | pure gesture thresholds and axis-lock arithmetic |
| `wm/fleet-hud-layer.ts` | the HUD's own layers and the flow-axis rule |

`src/wm/tldraw-wm-extraction-boundary.ts` classifies each module as package
core, tldraw adapter, tlda host adapter, or tlda app surface. That file is the
statement of which parts are meant to be extractable and which are ours; read it
before moving code between them.

---

## The layer model

### Layers

A layer has an id, a parent, a **transform** to that parent, a **camera**, a
**track policy**, and a **backing** (`wm-core.ts:70`). Layers form a tree rooted
at one layer that is pinned and zoom-locked — under a tldraw editor that root is
called `screen` (`editor-wm.ts:4`).

Four backings exist (`wm-core.ts:54`):

- **`screen`** — the root. No transform of its own.
- **`frame`** — a pure transform. The default, and what most layers are.
- **`page`** — delegates conversion to an editor's `pageToScreen` /
  `screenToPage`. Used where one side of a hop is a real tldraw page.
- **`viewport`** — delegates to a *named* viewport of the tldraw fork, so the
  layer's frame is that viewport's camera and screen bounds.

The `viewport` backing delegates rather than recomputing the arithmetic, and
`tldraw-fork-viewport-adapter.ts:8` says why: tldraw's conversion is
`(x + camera.x) * camera.z + screenBounds.x`, and reimplementing it here would
work until tldraw changed it and then fail as a connector landing *somewhere
plausible and wrong*.

### Track policy

The policy is per axis (`wm-core.ts:28`):

```
x, y : 'pan' | 'pin' | { track: number }
zoom : 'inherit' | 'lock' | 'own'
```

`pan` means the layer moves with its parent; `pin` means it holds still against
it; `{track: n}` is the parametric case between them. For zoom, `inherit`
multiplies the parent's scale, `lock` ignores both the parent's scale and its own
camera zoom, and `own` uses its own camera zoom while ignoring the parent's
(`wm-core.ts:150-164`, `432-453`).

This is the configurable part, and it is what lets a layout rule be one line
rather than a branch. The HUD's whole placement rule is a policy assignment —
see [the flow-axis rule](#where-the-layout-sits-the-flow-axis-rule).

One more knob matters in practice: `cameraPanUnit` (`wm-core.ts:76`). A camera
pan arrives in page units; a layer with `cameraPanUnit: 'screen'` multiplies it
by the camera's zoom, so the layer moves in screen pixels. The HUD's
`main-camera` layer uses it (`fleet-hud-layer.ts:81-86`), which is what converts
a document pan into the screen-pixel motion the panels ride.

### `translate` is the primitive

```ts
wm.translate(point, fromLayer, toLayer): Point
wm.translateBounds(bounds, fromLayer, toLayer): Bounds
```

It composes up to the root and back down (`wm-core.ts:288`). Every coordinate
hop in the app is supposed to be this call rather than hand-rolled
`pageToScreen` / `screenToPage` arithmetic, and the conversion helpers in
`viewport-coordinates.ts` are the tldraw-facing form of it.

`clientPointToPage` and `pagePointToClient` take an optional viewport id and
resolve down one of **three paths**, each of which records which one it took
(`viewport-coordinates.ts:14-82`):

- **`main`** — no viewport id: straight `editor.screenToPage`.
- **`wm`** — a registered viewport layer: refresh the frame, then `wm.translate`.
- **`fallback`** — a viewport id with no registered layer: tldraw's own
  per-viewport conversion.

The traces are the debugging instrument for anything landing in the wrong place.
The last 100 are on `window.__tlda_wm_coordinate_traces__`, the core itself is on
`window.__tlda_wm_core__` (`editor-wm.ts:57-76`), and the three conversion
functions are on `window.__tlda_wm_coordinates__` (`viewport-coordinates.ts:94`).
A misplaced panel whose trace says `fallback` is a missing registration, not bad
arithmetic.

### One core per editor

`getEditorWMCore(editor)` returns the editor's `WMCore`, held in a `WeakMap`
keyed by the editor and created on first use (`editor-wm.ts:78-95`). Viewport
registrations live in that state *and* in a module-global map, so a lookup still
resolves if it arrives against a different editor object
(`editor-wm.ts:116-136`).

Each registered viewport gets two layers (`CanvasClipPanel.tsx:304-340`):

- `wm:viewport-frame:<id>` — pinned, zoom-locked, transform = the panel's client
  rect (or the origin when the panel is full-viewport).
- `wm:viewport-camera:<id>` — child of the frame, transform =
  `{x: cam.x * cam.z, y: cam.y * cam.z, scale: cam.z}` (`editor-wm.ts:145`).

Separating them is what makes "where the panel is on screen" and "where its
camera is looking" independently updatable; `refreshViewportFrame` re-reads the
first on every conversion (`editor-wm.ts:22`).

---

## The fleet HUD is a second viewport on the same editor

**This is the fact that most often has to be rediscovered, so it is stated
first.** The HUD is not a second document, a copy of the canvas, or a separate
editor. It is a transparent full-screen layer rendering **the same store through
a second camera**.

The comment at `src/overlays/FleetHUD.css:58` has been the only written record
of this:

> The WM HUD is a transparent same-store fleet layer over the real document
> canvas.

The mechanism: `CanvasClipPanel` registers a named viewport with the main editor
and renders `<TldrawViewport id={viewportId} …/>` — the fork component described
in [The vendored tldraw editor](vendored-tldraw-editor.md) §"What the fork
carries". There is no second editor to mount, so `onEditorMount` hands the
consumer **the main editor** (`CanvasClipPanel.tsx:261-264`), and the HUD then
publishes it as the HUD editor (`FleetHUD.tsx:1509`). Both globals therefore name
the same object:

```
window.__tldraw_hud_editor__ === window.__tldraw_editor__
```

### What follows from one store

- **An edit in the HUD is an edit on the canvas.** There is nothing to sync back;
  the panels are ordinary shapes at their real page coordinates.
- **Every mirrored shape renders twice while the HUD is open** — once through the
  main viewport and once through the HUD's. Both copies mount their React
  content, so both run subscriptions, observers, and timers unless something
  stops them.
- **A viewport-wide filter is not available.** `getShapeVisibility` is a property
  of the editor, not of a viewport (`SvgDocument.tsx:802`, passed at `:1104`), so
  hiding the main-canvas copy with it would hide the HUD's copy too. That is why
  the duplicate is suppressed by CSS and by a render gate instead, and it is the
  answer to "why isn't this done the obvious way".

The render gate is `FleetHudRenderGate` (`shapes/useIsInViewport.ts:50`): a
component renders nothing when it has **no viewport id and the body carries
`fleet-hud-open`**. It reads that class through a `MutationObserver`
(`useIsInViewport.ts:33`), so it is DOM state rather than React state — the same
signal the CSS uses. Commit `85c06a69e` moved the gate into that shared helper
and wrapped the nine registry panel types with it, so the main-canvas copy
unmounts and its effects clean up while the HUD copy keeps running. `fleet-pill`
is deliberately outside the gate: it is a transient drag preview that carries no
ownership props and must render inside the HUD viewport that owns the gesture
(`overlays/fleet-viewport-predicate.ts:10-12`).

The CSS half is `FleetHUD.css:259-280`: fleet shapes under `.tl-canvas` are
hidden while `body.fleet-hud-open`, restored inside `.fleet-hud-wrap`, and the
main canvas's selection overlay is hidden when a fleet shape is selected so the
resize handles align with the copy being edited.

### HUD-open means `expanded && fleetBounds`

The body class is set from `!!(expanded && fleetBounds)` (`FleetHUD.tsx:901-911`)
— not from "the HUD component exists". With the pill collapsed, or with no owned
fleet shapes to bound, the main-canvas copy is the *only* copy and the gate is
inert. Any reasoning about duplicate rendering has to carry that condition.

`fleetBounds` is the page-space bounding box of the viewer's own fleet shapes. A
transient null blanks the HUD, so both null reasons are logged permanently under
the `fleet-hud` namespace, the uncomputable-bounds case at `warn`
(`FleetHUD.tsx:284-302`). Those lines are the thing to grep for if the panels
ever flash.

### Other clip-panel surfaces

`CanvasClipPanel` is not HUD-specific. Its other consumers are
`overlays/AnnotationViewer.tsx:568`, `overlays/ScreenshotCapture.tsx:92`,
`panels/ProjectTab.tsx:130`, and `shapes/FleetDocViewShape.tsx:706`. The HUD is
the one that passes `fullViewport`, `disableCulling`, and `lockCamera` together;
the others are bounded panels with their own cameras.

---

## Where the layout sits: the flow-axis rule

Skip's rule, quoted in `src/shapes/document-flow-axis.ts:7` and again in
`overlays/fleet-hud-anchor.ts:12` (the source comments carry his words but no
timestamp):

> the shapes on the HUD are in a fixed position relative to the fucking screen in
> one direction and the slides in the other. Right? Like so it's not a hack. It's
> just the fucking rule.

Stated once, with no document type in it: **screen-fixed along the axis the pages
flow, document-fixed across it.**

- A paper flows **down**, so its layout holds a height on screen and rides
  sideways with the document, living in the side margin.
- A deck flows **across**, so it holds a horizontal position on screen and lives
  in the margin above.

Neither is a case and there is no branch on document kind. The flow axis is read
off the pages themselves — whichever of the two extents is larger, defaulting to
`y` below two pages (`document-flow-axis.ts:44-61`).

The rule is implemented as one policy assignment
(`fleet-hud-layer.ts:127-133`): pin the flow axis, pan across it, lock zoom. The
layer chain is

```
screen  →  main-camera (pan/pan/inherit, cameraPanUnit: 'screen')
        →  fleet-overlay (pin on flow axis, pan across it, zoom: 'lock')
```

so both axes of the main camera reach the overlay layer and its policy decides
which one it rides.

### The default anchor

`computeFleetHudDefaultAnchor` (`overlays/fleet-hud-anchor.ts:36`) places the
layout with two numbers:

- **Along the flow:** the layout's near edge sits `screenPad` from the screen
  edge and stays there while you move through the document.
- **Across the flow:** the layout's far edge sits one `marginGap` before the
  document's near edge, projected to screen — it lives in the margin and moves
  with the document.

Every term is read off the layout's own current bounds rather than a stored
number, so it can place a layout whose shapes are somewhere unexpected.

There is deliberately **no screen clamp**. One was added to keep the layout on
screen and did the opposite of what it was for — overriding the slide-relative
position is what put the panels *on* the slide. The comment at
`fleet-hud-anchor.ts:56-78` records that, with Skip's report, and the cause
(a layout 2.3× the size of the screen) was fixed elsewhere.

### The stored anchor

A deliberate reposition is persisted as an invisible 1×1 locked `geo` shape in
the document store, one per `(identity, device)`, carrying
`{panOffset, cameraY, rule}` in its meta (`FleetHUD.tsx:110-166`). Three things
about it are load-bearing:

- **It is never written without a resolved identity and device.** `getMyAnchorId()`
  would otherwise fall back to a bare id shared across users
  (`FleetHUD.tsx:115-127`).
- **It is written with `history: 'ignore'`.** The anchor is UI bookkeeping, not a
  document edit, and must not consume an undo step.
- **It names the rule that wrote it** — currently `flow-axis-1`
  (`FleetHUD.tsx:98`). An anchor is two numbers whose meaning comes entirely from
  the rule that computed them; under a changed rule they stay perfectly readable
  and mean something else. Any anchor stamped with another rule is ignored.
  **Bump `ANCHOR_RULE` whenever the placement rule changes.**

It is saved only on a *deliberate* reposition: same zoom, tracking not
suppressed, and movement on the ride axis — the axis across the flow
(`FleetHUD.tsx:1071-1075`). Moving along the flow is navigation, and persisting an
anchor for it would save a position nobody chose. Navigation paths announce
themselves by calling `suppressFleetHudCameraTracking()`, which sets a 700 ms
window (`wm/fleet-hud-state.ts:28`).

### Self-heal, and what it must not undo

If the layout is no longer reachable, the HUD re-derives a default
(`FleetHUD.tsx:918-937`). Reachability is measured **only on the pinned axis**
(`FleetHUD.tsx:39-50`): across the flow the layout rides the document, so being
off screen there means the document is scrolled away, and re-deriving would throw
away a position the user chose. A deliberate pan sets `userPannedRef`, which
blocks both the self-heal and the late-arriving-anchor adoption
(`FleetHUD.tsx:934`, `:1111`).

The adopt-on-arrival listener exists because in large multi-machine rooms the
anchor record can sync *after* the fleet shapes; the first render then computes a
provisional default, and the real anchor replaces it when it lands
(`FleetHUD.tsx:1109-1133`). That provisional default is deliberately **not**
persisted (`FleetHUD.tsx:1446-1451`).

### Navigating to another document

Navigation translates the layout onto the new document and moves the camera by
the same offset, then dispatches `fleet-hud-wrap` with that delta. The panels
moved `dx` page units while the camera slid them `dx * z` the other way, so the
anchor absorbs the difference and the panels hold their screen position over the
new document (`FleetHUD.tsx:1355-1383`, `wm/editor-host-bridge.ts:11-16`). The
stored anchor is shifted too — otherwise opening the HUD after a navigation reads
an anchor belonging to the document you left.

---

## Whose panels you see

Fleet shapes carry `userId` and `deviceId` props, and everything about visibility
keys off that pair:

- The editor hides fleet shapes that are not yours (`SvgDocument.tsx:802-808`).
  `fleet-video` is the exception — remote camera tiles must be renderable by
  receivers.
- The HUD viewport's own predicate requires an exact `(userId, deviceId)` match
  (`overlays/fleet-viewport-predicate.ts`).
- Layouts are kept physically disjoint rather than by z-order: each owner's
  layout is offset into a **lane** 20 000 page units down from the canonical
  base, taking the first unoccupied one, plus a horizontal offset hashed from
  `(userId, deviceId)` (`shapes/fleet-layout-geometry.ts`).

When a device has no owned layout, the HUD does not render empty — it renders a
diagnostic naming the identity, the device, how many fleet shapes exist, and how
many belong to other devices of the same user (`FleetHUD.tsx:362-399`). That
failure mode is a new browser device id, and silence about it reads as a broken
HUD.

---

## Managed surfaces

A surface that is not a fleet panel — an annotation preview, a page column, a
lightbox, a grading pane — is requested through one vocabulary
(`wm/managed-surfaces.ts:56`). A `ManagedSurfaceRequest` carries a kind, ids, an
owner, an extent, and four policies:

| field | choices |
|---|---|
| `placement` | `page`, `chip-anchored`, `viewport-centered` |
| `cameraPolicy` | per-axis `pan`/`pin`, `zoom: inherit`/`lock` |
| `hitPolicy` | `preview-readonly`, `chrome-catches-content-pans`, `modal-catches-all` |
| `cleanup` | on close: `remove-surface`/`hide-surface`/`preserve-shape`; on replace; on owner change |
| `persistence` | `pinned`, scope `session`/`room` |

The request is serialised onto the shape's `meta` by `managedSurfaceShapeMeta`
(`managed-surfaces.ts:151`), so a surface's policy travels with the shape rather
than living in the component that made it. Owner is required and throws if
missing (`:75`).

The kinds are enumerated in `wm/tlda-managed-surface-kinds.ts`:
`temporary-markdown`, `annotation-viewer`, `page-column`, `page-column-handle`,
`lightbox`, `homework-grading`. Each has a small adapter in `src/wm/` that builds
the request; those adapters are classified `tlda-app-surface` in the extraction
boundary, meaning their vocabulary is generic but their payload semantics stay
here.

## Panels

The nine fleet panel types, their default sizes, and their default props are one
table in `shapes/fleet-panel-registry.ts:22`, built on the generic
`wm/hosted-panel-registry.ts`. `FLEET_SHAPE_TYPES` is derived from that table and
is the single source of truth for ownership filtering, visibility, HUD gating,
and hit-test exclusion — add a panel there and the rest follows.

---

## Interaction

### Gestures

The touch vocabulary is Skip's, recorded at `overlays/useFleetGestures.ts:1-24`:
one finger scrolls the content under it; two fingers on a shape move and resize
it at once; two fingers spanning shapes move that cluster; three fingers pan the
main canvas from anywhere, including over the panels.

The commitment thresholds match tldraw's own pinch classifier deliberately
(`wm/gesture-policy.ts:1-9`): 24 px of finger-distance change commits to resize,
16 px of centre movement commits to move, and once moving, 64 px is required to
commit to resize. Anisotropic resize is our extension; the ordering is theirs, so
a HUD gesture and a canvas gesture decide at the same moment.

Axis locks are soft and breakable, with decayed accumulators so recent motion
weighs more: pan locks after 8 px and breaks when the off-axis out-travels the
locked one by 1.6×, retaining 45 % of off-axis motion meanwhile
(`gesture-policy.ts:11-18`).

Gestures mount only when `expanded && fleetBounds && docShapesReady &&
cameraReady` (`FleetHUD.tsx:493`). The `cameraReady` term is the youngest and the
one that has already cost a day: on 2026-08-12 a change made the HUD render
nothing until camera restore, the gesture hook ran against that empty render,
found no element, installed no listeners, and never re-ran — so three-finger pan
over the panels was dead on iPad and phone until `1b8eca699` mounted the gestures
after camera restore. **A hook that installs DOM listeners against a conditional
render needs a re-run condition, not just a mount.**

Three-finger pan drives the **main** camera; the HUD's camera poll mirrors that
onto the overlay. That poll must therefore fire on movement along *either* axis
even though the overlay rides only one — the distinction between "when to
recompute" and "what counts as a deliberate reposition" is spelled out at
`FleetHUD.tsx:963-989`, and conflating them broke three-finger pan on a deck.

### Snapping is two different things, and only one of them is wanted

**tldraw's native snap is off.** `SvgDocument.tsx:1138` sets `isSnapMode: false`
at mount. It is a tldraw *user preference*, so it persists per browser profile
and has to be written rather than merely left alone. Six fleet shapes still carry
`canSnap = () => true`, which is inert while the preference is off.

**Soft snap for fleet panels is on, and is a specified feature.** Skip,
2026-08-12 13:22:18 EDT:

> There is there we have, like, soft snap that was supposed to be implemented for
> our shapes, bro.

It is not tldraw's snap and does not use it. `nudgeFleetPanelTranslate`
(`shapes/fleet-utils.ts:242`) runs on translate, finds the closest edge, centre,
or equal-gap match against the other panels, and applies a *fraction* of the
remaining distance — 0.35 (`fleet-utils.ts:80`) — so it is a pull, not a jump.
Strength is a readability-profile setting in `em`, so it tracks the device's own
text size; `0` turns it off. The matched page line is published to
`shapes/fleet-nudge-guides.ts` and drawn as a hairline by
`overlays/FleetNudgeGuides.tsx` for as long as the pull is on.

**Do not delete soft snap to make odd behaviour stop.** That instruction is here
because the opposite was briefed to an agent on 2026-08-12 and corrected within
three minutes: the standing "snapping is off everywhere" rule is about tldraw's
native snap, and reading it as covering fleet panels would remove a feature Skip
asked for.

### Layout mode

Layout mode (the ⊞ control) is a DOM-level mode: `.hud-layout-active` on the wrap
and `fleet-hud-fleet-selected` on the body (`overlays/fleet-layout-mode.ts:48`).
It makes the HUD canvas itself pointer-interactive so brush-select and
click-to-deselect work on empty areas (`FleetHUD.css:131`); outside it, empty-area
clicks pass through to the main canvas.

Entering it re-syncs the viewport camera first (`FleetHUD.tsx:441-448`), because
selection handles are drawn by the viewport overlay canvas while the panels are
positioned by an imperative DOM write — without the sync the two enter the mode
on different transforms and snap together a frame later.

### Pointer events in the overlay

The overlay covers the whole screen, so the default is that **nothing** in it
takes pointer events and clicks reach the main canvas; fleet shapes and tldraw's
selection foreground opt back in (`FleetHUD.css:74-127`). Two consequences worth
knowing: iframes inside the HUD are made inert because an iframe captures
pointer events regardless of an ancestor's `pointer-events: none`
(`FleetHUD.css:159-167`), and in drag mode the shape *content* goes inert so
events reach `.tl-html-container`, which is what tldraw hit-tests against
(`FleetHUD.css:107-116`).

### Drops

Drop targets are registered per DOM element in a `WeakMap`
(`wm/drop-targets.ts:18`) and resolved by walking `elementsFromPoint`, which is
visual stacking order. A failed resolution is otherwise completely silent, so the
resolver records why: `detached` (a stale registration whose element left the
DOM), `pointer-events-none`, `visibility-hidden`, and `display-none` — the last
being ordinary, since tldraw culls off-screen shapes by toggling display
(`drop-targets.ts:33-54`). Those four must stay distinguishable; collapsing them
makes the buffer cry wolf on every pan.

### Undo

Anchor writes, HUD-open cache-invalidation touches, and raise-on-tap all run with
`history: 'ignore'` (`FleetHUD.tsx:131`, `:951`, `:1216`). They are UI
bookkeeping and must not consume an undo step, while still syncing normally.

---

## Errata

Checked on 2026-08-12 against `main` at `3fc71ba18`; the most recent commit
touching any path described here is `85c06a69e`. This says nothing about what is
deployed. These are mismatches between the design above and the code as it
stands.

### The code still describes a copy-store editor that no longer exists

Three comment blocks describe the HUD as a second editor holding a synced copy of
the store, and route behaviour around that belief:

- `FleetHUD.tsx:894-897` — "In the copy-store HUD, opening the HUD hides fleet
  shapes in the main editor because CanvasClipPanel renders separate copies."
- `FleetHUD.tsx:1222-1227` — "The HUD runs a second (copy-store) editor with its
  OWN history that is ephemeral and unmarked", and on that basis intercepts
  Cmd+Z/Cmd+Y inside the HUD to drive `mainEditor.undo()` instead.
- `useFleetGestures.ts:17-23` — identifies the shape under the touch "via the
  overlay (copy) editor", applies the change to the main editor, and warns that
  writing to the copy editor would be clobbered by "the main→copy mirror".

There is one editor. `CanvasClipPanel` returns `mainEditor` from `onEditorMount`
(`CanvasClipPanel.tsx:262`), so the overlay editor, the HUD editor global, and the
main editor are the same object. The undo interception consequently routes the
main editor's undo to the main editor, and the "mirror" it warns about does not
run.

The behaviour is not visibly wrong, which is exactly the problem: this is the
belief three separate agents each had to disprove from symptoms.

**And it is still being written into new code.** `shapes/fleet-nudge-guides.ts:9`
— added by `210ff19ed` on 2026-08-12 — says a fleet panel "can be dragged on the
HUD layer, which has its own editor, and only that editor can project its own
pages." Same claim, twelve hours old. The stale comments are not merely
historical residue; they are the source the next author reads, so each one
reproduces itself. That is the argument for correcting them rather than leaving
them as harmless.

### `.tool-passes-through` has CSS and no writer

`FleetHUD.css:140-157` disables pointer events on eight panel types when the wrap
carries `.tool-passes-through`, so a drawing or erasing tool can operate over
them. The only code that touches the class **removes** it unconditionally on
every render (`FleetHUD.tsx:1178-1187`). The comment there records why: the
tradeoff cost the ability to interact with chat without switching tools, and Skip
judged it bad. Both halves of a reverted feature are still in the tree.

### The layer model's shape-membership half has no consumer

`moveToLayer`, `pinToViewport`, and `unpin` (`wm-core.ts:355-368`) — §2.4 of the
original design, "shapes belong to a layer and move between them" — have **zero
callers** anywhere in `src/` or `tests/`. Layers today are positional frames for
surfaces; nothing re-expresses a shape's coordinates into a different layer.

Two API entries from that design never landed at all: `wm.hitTest` and
`wm.snapTargets`. Hit-testing is still the DOM walk in `drop-targets.ts` and the
gesture layer.

### The `viewport` backing is implemented and unmounted

`LayerBacking: {kind: 'viewport'}` was routed through `wm-core` from the start
with nothing implementing it; `de5646c21` supplied the adapter. Its only consumer
is `src/classroom/gradingPanes.ts`, whose only importer is
`tests/classroom-grading-panes.test.mjs`. Nothing in the running application
mounts a viewport-backed layer. `src/prototypes/HomeworkGradingPrototype.tsx`,
the other half of that feature, has no importer either.

So the grading panes are covered by a test and reachable by nothing — worth
knowing before concluding from a green test that the path runs.

### Auto-reflow after add/remove is disabled

Adding or removing a fleet shape leaves the others where they are; the reflow was
removed because it made things worse, with a TODO to reimplement add-and-delete
as identity (`FleetHUD.tsx:795-798`).

### Open symptoms Skip has reported

These are his words with timestamps, not diagnoses. Read forward from them before
acting — one item on this list was answered 24 minutes after he raised it.

**Flicker under a held finger. Open.** 2026-08-12 13:13:49 EDT, from an iPad:

> when I have my thumb down, Sometimes … there was, like, sort of up down, like,
> sort of visual flicker. … I guess something was, like, measuring its height.
> Right? But that wasn't that's not to spec.

And at 13:22:46 EDT, on why it matters more than its size suggests:

> it just creates anxiety, right, to, like, observe flicker all the time

Owned by `anchor-drift` as of 13:24:52 EDT, with telemetry reported as pointing
at the height-measurement path. **This document does not name a cause** — the
plausible candidates in here (bounds recomputation during a touch drag, the
`ResizeObserver`s on panel content) have not been measured against his session,
and a guess in this file would be read as a finding.

**Soft snap felt wrong and showed nothing. Answered.** 2026-08-12 13:11:24 EDT:

> No visual indication and, like, just weird feeling. I think something is in
> there

and at 13:19:58 EDT, on priority:

> it's not super high priority, but it is an important feel issue, and I would
> like it fixed.

`210ff19ed` (13:35:52 EDT) is the response: the pull could never move a panel
more than 3 screen pixels, which on a high-DPI tablet is not a perceptible
distance, so strength became an `em` setting on the readability profile, and
every match now draws a hairline guide at the line it is pulling toward.
**Whether that satisfies him is not established** — he has not been asked since it
landed, and a fix is not a confirmation.

### Smaller mismatches

- `repackFleetShapes` (`FleetHUD.tsx:229`) is exported, carries an
  `eslint-disable` for being unused, and has no caller or test.
- `CanvasClipPanel` accepts `shapeUtils`, `tools`, and `licenseKey` and ignores
  them, marked "Legacy props … kept for consumer compatibility"
  (`CanvasClipPanel.tsx:116-119`). `FleetHUD` still passes all three
  (`FleetHUD.tsx:1495-1497`). `AGENTS.md` says this project does not preserve
  compatibility shims without a current requirement.
- `WMCore.updateLayer` assigns the new parent before `assertAcyclic` runs
  (`wm-core.ts:243-267`), so a rejected re-parent throws with the bad parent
  already written.
- `scratch/wm-core-spec.md` (2026-06-20) is the design proposal this was built
  from. It is a *proposal*, several parts of which did not ship, and it is in
  `scratch/`. Do not cite it as a description of the system.

---

## What is not established here

- **Whether the reported-symptoms list is complete.** It is what he said in one
  bounded window of his own thread on 2026-08-12 (12:14–13:30 EDT), read in
  order. He has said the WM "is kinda fucked right now", and that sentence is
  broader than the two items above. The rest of what he means is not established
  here.
- **The cause of the flicker.** Named as open above, deliberately without a
  mechanism.
- **Whether the double render is fully gated.** `85c06a69e` covers the nine
  registry panel types through the shared gate. Whether any other component
  mirrored into the HUD viewport still mounts twice has not been measured.
- **The performance cost of the two viewports** when the gate is inert — that is,
  with the HUD collapsed or with no owned fleet bounds. Not measured.
