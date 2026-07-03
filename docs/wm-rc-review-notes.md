# WM RC Review Notes

Branch: `codex/wm-rc-base-20260702`
Base: `7ce94b15a6b2e452ae931a661643932ab86f7511`

## Scope

This RC does not introduce a new window manager and does not change visible UI.
It factors existing fleet/TLDraw window-manager behavior into explicit boundary
modules so tlda can remain the first host while the WM surface becomes separable.

## Boundary Split

- Panel/app registry: `src/shapes/fleet-panel-registry.ts`
  - fleet panel type set
  - default tool dimensions
  - app default props used by tools and layout planning
- Hosted panel registry: `src/wm/hosted-panel-registry.ts`
  - generic hosted panel definition shape
  - registry/default-size/default-prop helper functions consumed by the fleet
    app registry
- Canvas clip viewport contract: `src/wm/canvas-clip-panel.ts`
  - named fork viewport capabilities
  - optional viewport lookup
  - WM surface camera projection and writes
  - camera equality helper consumed by `CanvasClipPanel`
  - host-injected shape predicate boundary; tlda fleet ownership filtering lives
    in `src/overlays/fleet-viewport-predicate.ts`
- Ownership: `src/shapes/fleet-ownership.ts`
  - HUD anchor IDs
  - owner/device predicates
  - current-session fleet shape predicate
- Layout geometry: `src/shapes/fleet-layout-geometry.ts`
  - owner/device layout offsets
  - vertical lane selection
  - lane disjointness repair
- Layout context: `src/shapes/fleet-layout-context.ts`
  - document bounds and phone target selection
  - preferences and viewport-derived sizes
  - panel counts and default chat filter seeding
  - lane offsets folded into planner input
- Layout plan: `src/shapes/fleet-layout-plan.ts`
  - pure default layout shape plan
  - registry-backed panel defaults
  - owned props and deterministic slot IDs supplied by adapter
  - no TLDraw import
- Shared shape schemas: `shared/shapes/fleet-panel-schema.mjs`
  - fleet panel prop validators imported by both client shape utils and
    `server/lib/sync-rooms.mjs`
- Gesture policy: `src/wm/gesture-policy.ts`
  - TLDraw-mirrored move/resize thresholds
  - resize axis lock policy
  - host-supplied lane snap stops and drag decisions
- Gesture frame: `src/wm/gesture-frame.ts`
  - viewport camera/container lookup
  - screen-to-overlay coordinate conversion
  - DOM element diagnostics and corner-control hit checks
  - host-supplied viewport DOM selectors
- Host editor bridge: `src/wm/editor-host-bridge.ts`
  - current main/HUD editor globals isolated behind a WM-facing adapter
  - shared HUD reset/toggle event dispatch/listen contract
  - tool ghost placement zoom and creation undo marking hooks
- HUD state: `src/wm/fleet-hud-state.ts`
  - expanded-state storage key and read/write helpers
  - hidden-state predicate used by pills
  - explicit toggle resolution used by `FleetHUD`
- Managed surfaces: `src/wm/managed-surfaces.ts`
  - generic owner/device requirement helper
  - generic managed-surface shape-meta serialization
  - common request vocabulary for placement, hit policy, cleanup, camera, owner,
    persistence, source, and payload
- Extraction boundary: `src/wm/tldraw-wm-extraction-boundary.ts`
  - module manifest for the package handoff
  - package-core, TLDraw-adapter, tlda-host-adapter, and tlda-app-surface
    classifications
  - package candidate and tlda host module lists for the next extraction pass

`src/shapes/fleet-utils.ts` remains the compatibility surface and side-effect
adapter: identity resolution, owned shape creation, legacy adoption, layout
cleanup, deterministic TLDraw IDs, final shape creation, and the
`createOwnedFleetPanelShape` adapter for app-internal owned panel creation.

`src/overlays/useFleetGestures.ts` remains the event/mutation adapter: DOM hit
testing, capture listeners, telemetry/replay, and main-editor writes.

## Behavior Preservation

- Existing fleet panel shape props are preserved. Client shape utils and server
  sync schemas now import the same validators instead of duplicating them.
- Default layout variants keep the same panel types, locked states, ownership
  props, filters, dimensions, source/docview defaults, and HUD reset intent.
- Fleet tool dimensions still come through `FLEET_TOOL_DIMS`; tool-created
  panels now also receive registry default props before caller overrides.
- The canonical owned-panel creation path covers HUD/default-layout/tool panel
  creation. Existing app-internal child panel spawns, such as opening a related
  chat/docview from inside a panel, remain app behavior and are intentionally
  outside this RC.
- Phone lane gesture decisions preserve the existing thresholds and event
  consumption behavior, with pure policy extracted for direct testing.
- Gesture frame helpers are unchanged behaviorally but no longer live inside
  `useFleetGestures`; the hook still owns the gesture state machine and editor
  mutation writes.
- `CanvasClipPanel` behavior is unchanged, but fork-facing viewport helpers,
  capability names, and the generic shape-predicate boundary now live in
  `src/wm/canvas-clip-panel.ts`; the fleet ownership predicate is supplied by
  `FleetHUD` from tlda-owned code.
- HUD/tool placement behavior is unchanged, but the direct host-editor global
  reads have been removed from `fleet-utils`, `FleetHUD`, and `FleetToolGhost`
  and routed through `src/wm/editor-host-bridge.ts`.
- HUD reset/toggle dispatch sites in `FleetIconPill`, `SyncErrorPill`, and the
  document reload path also route through the bridge, preserving existing event
  payloads.
- HUD expanded-state persistence is unchanged behaviorally but now flows through
  `src/wm/fleet-hud-state.ts`; `FleetHUD`, `FleetIconPill`, and `SyncErrorPill`
  no longer hardcode the localStorage key.
- Fleet panel definitions still list the same tlda panel apps, sizes, and
  defaults, but the registry mechanics now flow through the generic
  `src/wm/hosted-panel-registry.ts` boundary.
- `FleetTouchInboxShape` still auto-creates the same child `fleet-chat`, but it
  now uses `createOwnedFleetPanelShape` instead of manually stamping
  owner/device/default props.
- Annotation viewer, lightbox, page-column, and temporary markdown requests keep
  the same IDs, policies, placement, cleanup, persistence, and payloads. Slice 7
  only moves owner validation and common shape-meta serialization into the WM
  managed-surface helper.
- The slice-8 extraction artifact is manifest-only. It does not change runtime
  imports, exports, or behavior; it records the current package boundary after
  slices 2-7.

## Extraction Handoff

Package candidates:

- `src/wm/wm-core.ts`
- `src/wm/hosted-panel-registry.ts`
- `src/wm/managed-surfaces.ts`
- `src/wm/gesture-policy.ts`
- `src/wm/editor-wm.ts`
- `src/wm/viewport-coordinates.ts`
- `src/wm/canvas-clip-panel.ts`
- `src/wm/gesture-frame.ts`

tlda-owned host/app adapters:

- host/HUD bridge: `src/wm/editor-host-bridge.ts`,
  `src/wm/fleet-hud-state.ts`
- concrete fleet app registration and layout:
  `src/shapes/fleet-panel-registry.ts`,
  `src/shapes/fleet-layout-plan.ts`,
  `src/shapes/fleet-layout-geometry.ts`,
  `src/shapes/fleet-ownership.ts`
- app surfaces: `src/wm/annotation-viewer-surface.ts`,
  `src/wm/markdown-surface.ts`, `src/wm/page-column-surface.ts`,
  `src/wm/lightbox-surface.ts`

The package entrypoint now exists as `@tlda/tldraw-wm`, with `.` / `./core` /
`./tldraw-adapter` exports. The former `fleet-gesture-policy` and
`fleet-gesture-frame` package candidates are now package-neutral
`src/wm/gesture-policy.ts` and `src/wm/gesture-frame.ts`; the tlda hook supplies
its lane stops and viewport DOM selectors. Keep the remaining tlda-owned
adapters in this repo until their fleet identity, document-page, chat/source,
annotation, and shadow-column dependencies are supplied by host callbacks/data.

## Verification

Run from `/Users/skip/work/tlda-wm-rc-base-20260702`:

```sh
node --test test/fleet-layout-set.test.mjs
node --import tsx --test test/fleet-layout-plan-runtime.test.mts
node --import tsx --test test/fleet-hud-state-runtime.test.mts
node --import tsx --test test/hosted-panel-registry-runtime.test.mts
node --import tsx --test test/fleet-gesture-classifier.test.mjs
node --import tsx --test test/fleet-gesture-frame-runtime.test.mts
node --import tsx --test test/canvas-clip-panel-wm.test.ts
node --import tsx --test test/managed-surfaces.test.ts
node --import tsx --test test/wm-extraction-boundary-runtime.test.mts
./node_modules/.bin/tsc -p tsconfig.app.json --noEmit --pretty false
git diff --check
```

Expected current TypeScript status: full `tsc` exits nonzero on baseline errors
outside this RC slice. The filtered touched-file scan should show no errors in:

- `src/shapes/fleet-*.ts`
- fleet panel shape utils
- `src/overlays/useFleetGestures.ts`
- `src/wm/gesture-policy.ts`
- `src/wm/gesture-frame.ts`
- `src/wm/editor-host-bridge.ts`
- `src/wm/fleet-hud-state.ts`
- `src/wm/hosted-panel-registry.ts`
- `src/wm/canvas-clip-panel.ts`
- `src/wm/managed-surfaces.ts`
- `src/wm/tldraw-wm-extraction-boundary.ts`
- `src/wm/*-surface.ts`
- `shared/shapes/fleet-panel-schema.mjs`
- `server/lib/sync-rooms.mjs`

`npm test` was also attempted in this sparse RC worktree. It is not usable as a
branch signal here because the sparse checkout omits required baseline files
such as `cli/tlda.mjs`, `cli/lib/source-files.mjs`,
`server/lib/project-store.mjs`, and `bin/lib/singleton-lock.mjs`; the resulting
failures are module-resolution failures before the full suite can evaluate this
slice.

## Follow-Up After RC

- The remaining `useFleetGestures` DOM hit testing and editor mutation adapter
  is intentionally left in place. It should be split only after this base lands.
- `FleetHUD.tsx` still mixes HUD anchor persistence, camera tracking,
  and recentering. The host-editor global and expanded-state parts are now
  isolated, but anchor-shape persistence and camera/recentering remain.
- App-internal direct main-editor reads remain in chat/docview/source workflows.
  Those should be split by workflow, not swept mechanically.
- The hosted-panel registry is intentionally still in-process TypeScript, not a
  published package surface. Slice 8 should decide the actual package/module
  handoff shape after the remaining boundaries land.
- Remaining direct app-internal fleet panel creation sites should be migrated by
  workflow, not swept mechanically: docview splits, playback-frame setup, and
  chat/source/docview workflow spawns still need separate review.
- `useFleetGestures` still owns hit resolution, capture listener wiring,
  telemetry/replay, and main-editor mutation. Those are behavior-heavy and
  should be split with browser proof, not by source movement alone.
- `CanvasClipPanel` still directly renders `TldrawViewport`; slice 6 only names
  and isolates the fork-facing helper contract, it does not replace the fork API.
- Managed-surface request dispatch and runtime rendering are still tlda-hosted:
  annotation viewer, markdown, page-column, and lightbox adapters retain app
  payload semantics. The WM boundary now covers shared vocabulary and metadata,
  not a published surface runtime.
- `src/wm/tldraw-wm-extraction-boundary.ts` is a handoff manifest, not the final
  package entrypoint. The next pass should turn its package candidate list into
  actual exports after package-neutral renames are in place.
- Fork-facing affordances should be documented as generic TLDraw capabilities:
  named viewports, frame-aware coordinate transforms, rendering/culling hooks,
  and gesture internals access.
