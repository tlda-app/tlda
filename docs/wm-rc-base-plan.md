# WM RC Base Plan

This branch is the release-candidate base for factoring the existing TLDraw
window manager out of tlda without changing visible behavior first.

Base commit: `7ce94b15` (`Fix HUD-framed fleet pill drops`). That baseline
matters: HUD-framed missed agent/label pill drops now create owned `fleet-chat`
shapes through the same creation choke point instead of producing stray raw
canvas chats.

## Goal

tlda already contains the TLDraw window manager. The RC work is to make its
boundaries explicit enough that the WM can become an independent project, with
tlda as the first serious host.

The first RC should preserve behavior while clarifying dependency direction:

- TLDraw WM owns frame, viewport, panel, layout, ownership, hit-test, gesture,
  and persistence contracts.
- tlda owns document review, fleet data, chat routing, inbox semantics, agent
  spawning, build state, source sync, and app workflows.
- tlda registers concrete hosted apps into the WM: chat, inbox, agents,
  docview, source editor, notifications, and future panels.
- The TLDraw fork stays small and upstreamable. Fork-specific affordances should
  be consumed through the WM adapter, not scattered through app shapes.

## Current Shape

Already WM-like:

- `src/wm/wm-core.ts`: generic layer, camera, and coordinate transform model.
- `src/wm/editor-wm.ts`: attaches WM layers to TLDraw editors and named
  viewports.
- `src/CanvasClipPanel.tsx`: fork-viewport host for rendering clipped regions
  of the shared canvas/store.
- `src/wm/managed-surfaces.ts`: surface request vocabulary: placement, hit
  policy, persistence, cleanup, and owner.
- `src/overlays/fleet-bounds.ts`: maintained bounds tracker with a fleet
  predicate supplied by the caller.

WM behavior still mixed with fleet/tlda concerns:

- `src/shapes/fleet-utils.ts`: fleet shape registry, ownership, shape creation,
  default dimensions, layout variants, lane collision, document-relative
  placement, preferences, and recent-agent filter seeding all live together.
- `src/overlays/FleetHUD.tsx`: HUD anchor persistence, camera tracking, overlay
  visibility, layout mode, raise-on-interaction, undo routing, and recentering.
- `src/overlays/useFleetGestures.ts`: shape move/resize, cluster move/resize,
  three-finger pan, phone lane snap, DOM hit testing, ownership filtering, and
  main-editor mutation are coupled in one fleet hook.
- `src/wm/fleet-hud-layer.ts` and `src/wm/fleet-docview-layer.ts`: useful
  adapter examples, but still fleet/docview named.

tlda app surfaces:

- `FleetChatShape`, `FleetInboxShape`, `FleetAgentsShape`,
  `FleetDocViewShape`, `FleetTouchInboxShape`, `FleetSearchShape`,
  `FleetSourceEditorShape`, `FleetNotificationsShape`.
- These should become hosted app registrations, not WM kernel concepts.

## Frame Contract

The WM boundary must make these frames explicit:

- Visual frame: where the user sees a panel.
- Hit-test frame: where pointer/touch target resolution runs.
- Mutation frame: where persistent shape updates are written.
- Layout frame: where default layouts and lane boundaries are computed.

Known debts to protect against:

- visual hit target, geometry hit test, and mutation target disagreeing near
  HUD boundaries;
- phone lane boundaries feeling soft or moving with document zoom;
- default-layout/HUD-managed chats behaving differently from stray/free chats;
- app code doing ad hoc coordinate conversion instead of using a WM contract.

## Fork Boundary

Do not plan around eliminating the TLDraw fork. The fork is currently small
enough that the right target is upstreamability:

- keep fork affordances generic and non-tlda named;
- isolate them behind WM-facing adapters;
- document the exact primitives needed: named/multiple viewports, frame-aware
  coordinate transforms, rendering/culling hooks, and possibly gesture internals;
- keep app surfaces ignorant of whether an affordance comes from public TLDraw,
  forked TLDraw, or vendored TLDraw internals.

`useFleetGestures` is a working adapter wart. It should not be ripped out first.
The RC should instead isolate the policy and math so a later pass can decide
whether to reuse TLDraw gesture internals through a fork-native WM adapter.

## First RC Sequence

1. Split `src/shapes/fleet-utils.ts` by responsibility:
  - fleet ownership and owned HUD/tool panel creation;
   - panel/app registration and default dimensions;
   - layout planning and lane collision;
   - tlda-specific fleet-data seeding for default chat filters.
2. Introduce an internal panel/app registry for existing `fleet-*` shapes.
   Tools and default layout should read the registry instead of hardcoding type
   dimensions and creation defaults in multiple places.
3. Preserve current shape props and server schemas. Any custom shape prop change
   must update both the client shape util and `server/lib/sync-rooms.mjs`.
4. Add contract tests around owned-panel creation and default layout:
   - default layout creates only owned fleet panels;
   - fleet chat tool and pill-drop paths use the same owned creation choke point;
   - server/client prop schemas remain aligned for fleet panel shapes.
5. Only after this base is clean, isolate gesture code:
   - pure gesture classifiers/math;
   - DOM/fork viewport hit testing;
   - tlda phone/document lane policy;
   - main-editor mutation adapter.

## First Slice Status

Started in this branch:

- `src/shapes/fleet-panel-registry.ts` owns the fleet panel type registry,
  default dimensions, and app default props, using the generic hosted-panel
  registration helpers in `src/wm/hosted-panel-registry.ts`.
- `src/shapes/fleet-ownership.ts` owns anchor IDs and owner/device predicates.
- `src/shapes/fleet-layout-geometry.ts` owns layout offsets, lane selection, and
  lane disjointness repair.
- `src/shapes/fleet-layout-context.ts` owns tlda-specific layout input
  preparation: preferences, viewport sizing, document-relative anchors, lane
  offsets, panel counts, and default chat filter seeding.
- `src/shapes/fleet-layout-plan.ts` owns default layout shape construction:
  deterministic slot IDs, owned props, variant-specific panel sets, and phone
  layout HUD reset intent. It emits panels through the registry-backed
  `panelShape(...)` helper and does not import TLDraw; the tlda adapter supplies
  a `makeSlotId` function.
- `src/shapes/fleet-layout-seeding.ts` owns tlda-specific recent-agent chat
  filter defaults for the default layout.
- `shared/shapes/fleet-panel-schema.mjs` owns fleet panel prop validators shared
  by the client shape utils and `server/lib/sync-rooms.mjs`.
- `src/shapes/fleet-utils.ts` remains the compatibility export surface for
  existing callers and now coordinates layout cleanup, context collection, and
  shape creation from an explicit layout plan. It also owns
  `createOwnedFleetPanelShape`, the adapter for owned app-internal panel
  creation.
- `src/wm/gesture-policy.ts` owns pure touch policy: TLDraw-mirrored
  move/resize thresholds, anisotropic resize axis locking, and lane snap
  decisions with stops supplied by the tlda host. `useFleetGestures` still owns
  DOM hit testing, event capture, and editor mutation.
- `src/wm/gesture-frame.ts` owns gesture frame helpers: viewport
  camera/container lookup, screen-to-overlay page conversion, DOM element
  descriptions, element chains, and corner-control hit checks with DOM
  selectors supplied by the tlda host.
- `src/wm/editor-host-bridge.ts` owns the current host-editor globals and HUD
  reset/toggle event contract used by WM-facing HUD/tool placement. `fleet-utils`,
  `FleetHUD`, `FleetToolGhost`, the fleet/sync pills, and the document reload
  path now route HUD editor access and HUD reset/toggle dispatch through this
  bridge; the remaining app-internal main-editor reads are deliberately left for
  later, narrower passes.
- `src/wm/fleet-hud-state.ts` owns the HUD expanded-state persistence contract:
  the storage key, read/write helpers, hidden-state predicate, and toggle
  resolution. `FleetHUD`, `FleetIconPill`, and `SyncErrorPill` no longer
  hardcode the expanded-state localStorage key.
- `src/wm/canvas-clip-panel.ts` owns the CanvasClipPanel fork-facing contract:
  named viewport capabilities, optional viewport lookup, surface camera
  projection/writes, and camera equality.
- `test/fleet-layout-set.test.mjs` now pins these split boundaries in addition
  to the existing layout and pill-drop regressions, and checks fleet panel
  client/server schemas import the same shared prop definitions. It also checks
  the WM host-editor bridge owns HUD editor globals for tool placement.
- `test/fleet-layout-plan-runtime.test.mts` executes the planner directly for
  phone, 2x2, and both-margins variants, checking locked states, ownership
  props, filters, default props, and key coordinates.
- `test/fleet-gesture-classifier.test.mjs` now imports the gesture policy module
  directly, while still checking TLDraw threshold parity and phone-lane event
  consumption in the hook.

## RC Success Criteria

- Same visible behavior as the baseline.
- One canonical owned-panel creation path for fleet HUD/default-layout/tool
  panels. App-internal child panel spawns remain app behavior for a later pass.
- Default layout builds from an app/panel registry rather than scattered
  `fleet-*` constants.
- WM-facing code has named frame and ownership contracts.
- tlda app semantics do not leak into WM kernel modules.
- The fork-facing API surface is small enough to explain as an upstreamable
  TLDraw capability.

## Post-RC Extraction Slice 1

The first post-RC slice moves the WM-facing host-editor access behind
`src/wm/editor-host-bridge.ts`.

This is intentionally not a wholesale cleanup of every `window.__tldraw_editor__`
read in app shapes. It targets the extraction-critical path:

- owned fleet panel creation marks undo through `markMainEditorHistoryStoppingPoint`;
- cursor placement checks HUD coordinates through `getHudEditor`;
- tool ghost sizing reads HUD zoom through `getFleetToolPlacementZoom`;
- `FleetHUD` registers/unregisters the overlay editor through `setHudEditor`;
- layout reset dispatch/listen share `FLEET_HUD_RESET_EVENT`.
- HUD toggle dispatch/listen share `FLEET_HUD_TOGGLE_EVENT`.
- `FleetIconPill`, `SyncErrorPill`, and the document reload reset path use
  bridge dispatch helpers instead of constructing raw HUD events.

That leaves tlda app-internal child-panel spawns and source/chat/docview
workflows alone while making the WM host contract explicit enough to replace
the current globals later.

## Post-RC Extraction Slice 2

Slice 2 moves HUD expanded-state persistence into `src/wm/fleet-hud-state.ts`.

This is the first HUD state/persistence cut. It does not move the anchor shape
lifecycle yet; that lifecycle still depends on current tlda ownership/device
resolution and should be separated in a later, narrower pass. The completed
slice makes the current HUD visibility state contract explicit:

- `FLEET_HUD_EXPANDED_STORAGE_KEY` is the single storage key;
- `readFleetHudExpanded` and `writeFleetHudExpanded` own persistence;
- `isFleetHudHidden` replaces local storage peeks in pills;
- `resolveFleetHudToggle` preserves explicit event requests and fallback toggle
  behavior.

`test/fleet-hud-state-runtime.test.mts` covers the runtime contract, and
`test/fleet-layout-set.test.mjs` pins the production call sites.

## Post-RC Extraction Slice 3

Slice 3 adds the generic hosted-panel registration boundary in
`src/wm/hosted-panel-registry.ts`.

The fleet registry still owns tlda's concrete panel apps, but it no longer
hardcodes the registry mechanics itself:

- `HostedPanelAppDefinition` is the generic WM-side shape of a hosted panel;
- `defineHostedPanelApps` preserves the app definition list;
- `hostedPanelAppMap` builds the type-to-definition registry;
- `hostedPanelSizeMap` builds tool/ghost dimensions;
- `hostedPanelDefaultProps` clones default props for created panels.

`src/shapes/fleet-panel-registry.ts` now supplies tlda's concrete fleet panels
through that generic boundary. `test/hosted-panel-registry-runtime.test.mts`
covers the generic helper behavior, while `test/fleet-layout-set.test.mjs` pins
the fleet registry's use of it.

## Post-RC Extraction Slice 4

Slice 4 introduces `createOwnedFleetPanelShape` as the explicit owned child-panel
creation adapter in `src/shapes/fleet-utils.ts`.

The first migrated app-internal path is the `FleetTouchInboxShape` auto-created
child chat. That path already manually stamped owner/device props; it now uses
the adapter so ownership/default props stay centralized, while preserving the
old auto-create undo behavior with `markHistoryStoppingPoint: false`.

This slice deliberately does not sweep every `editor.createShape` call. The
remaining direct fleet panel creation sites have workflow-specific behavior:

- docview split buttons in `FleetDocViewShape`;
- playback frame setup in `PlaybackFrameShape`;
- chat/source/docview workflow spawns in large app shapes.

Those should be migrated one workflow at a time so ownership/defaults can be
preserved without changing app behavior.

## Post-RC Extraction Slice 5

Slice 5 splits the gesture frame adapter out of `useFleetGestures`.

`src/wm/gesture-frame.ts` now owns the DOM/frame helpers that are
not themselves the gesture state machine:

- named viewport camera lookup;
- named viewport container lookup;
- screen point to overlay page conversion;
- element description and ancestor-chain diagnostics;
- corner-control hit checks.

`useFleetGestures` still owns the capture listener, gesture state machine,
telemetry/replay, hit resolution, and main-editor mutation writes. Those remain
separate future slices because they are behavior-heavy and should not be moved
mechanically.

## Post-RC Extraction Slice 6

Slice 6 makes the CanvasClipPanel / TLDraw-fork viewport contract explicit in
`src/wm/canvas-clip-panel.ts`.

The React `CanvasClipPanel` still owns rendering and DOM event routing, but the
WM module now owns the generic fork-facing contract:

- `CANVAS_CLIP_VIEWPORT_CAPABILITIES` names the required fork capabilities:
  named viewports, independent cameras, shape predicates, culling control,
  frame-aware coordinates, and clipped rendering;
- `getOptionalCanvasClipViewport` is the optional named-viewport lookup;
- `canvasClipSurfaceCamera` projects a WM surface layer to a viewport camera;
- `setCanvasClipSurfaceCamera` writes camera changes back through WM layer
  policy;
- `sameCanvasClipCamera` centralizes camera equality.

This keeps the fork affordances small and named without changing
`CanvasClipPanel` behavior.

## Post-RC Extraction Slice 7

Slice 7 tightens the managed-surface contract in `src/wm/managed-surfaces.ts`.

The surface modules still own tlda semantics: annotation labels and bullets,
temporary markdown payloads, page-column shadow sources, and lightbox source
keys. The WM module now owns the generic request vocabulary that is independent
of those app payloads:

- `requireManagedSurfaceOwner` centralizes the owner/device requirement used by
  managed surfaces that must be scoped to a concrete user/device;
- `managedSurfaceShapeMeta` serializes the common managed-surface metadata for
  shapes that persist the request contract on TLDraw shape meta;
- page-column page and handle shape meta now use the shared serializer instead
  of duplicating extent, placement, camera, cleanup, owner, persistence, and
  source fields.

Remaining tlda-specific surfaces are deliberately left in their app adapters:

- `annotation-viewer-surface.ts` still owns annotation selection, chip anchoring,
  labels, colors, pinned state, and full-bounds behavior;
- `markdown-surface.ts` still owns temporary markdown document identity and
  chat/shared-path provenance;
- `page-column-surface.ts` still owns shadow column keys and canvas-page payload
  semantics;
- `lightbox-surface.ts` still owns chat/media source keys.

The contract improvement is covered by `test/managed-surfaces.test.ts`, which
checks generic owner validation and verifies that the shared shape-meta
serializer preserves the page-column meta contract.

## Post-RC Extraction Slice 8

Slice 8 adds the concrete extraction handoff artifact in
`src/wm/tldraw-wm-extraction-boundary.ts`.

This file is not a package export yet. It is a manifest that records the module
boundary after the RC slices, so the next pass can extract deliberately instead
of re-discovering the cut:

- `wm-package-core`: `wm-core`, `hosted-panel-registry`,
  `managed-surfaces`, and the pure gesture policy;
- `wm-package-tldraw-adapter`: `editor-wm`, `viewport-coordinates`,
  `canvas-clip-panel`, and the gesture frame adapter;
- `tlda-host-adapter`: current fleet/HUD host bridges, fleet panel registry,
  fleet layout plan/geometry, and ownership predicates;
- `tlda-app-surface`: annotation viewer, markdown, page-column, and lightbox
  surface adapters.

The recommended next implementation step is to create a real package entrypoint
from the `wm-package-core` and `wm-package-tldraw-adapter` sets, then rename the
remaining `fleet-*` package candidates before publishing the boundary. Do not
move `tlda-host-adapter` or `tlda-app-surface` modules into the package without
first replacing their fleet identity, document-page, chat, source, or annotation
dependencies with host-supplied callbacks/data.

`test/wm-extraction-boundary-runtime.test.mts` checks that the manifest points
at real modules, has no duplicate paths, keeps package candidates separate from
tlda host modules, and exposes queryable classifications.
