# WM Factoring TODO

This is a working note for the WM/tldraw-fork split. It is intentionally loose:
the goal is to keep the boundaries visible while the next RC slices prove which
abstractions are real.

## Target Layers

1. **tldraw fork**
   - Owns low-level editor/rendering primitives.
   - Named/custom viewports belong here.
   - Should stay generic enough to upstream or discard cleanly if tldraw grows
     the same primitive.
   - Current tldraw primitives are shape `parentId` plus fractional `index`
     ordering, with groups/frames and editing focus. That is not the same thing
     as product-level named compositing layers.

2. **WM package**
   - Owns layer composition over a shared canvas/store.
   - Treats layers as the conceptual abstraction and named viewports as the
     rendering mechanism.
   - Owns surface-to-viewport projection behind that layer model.
   - Defines semantic layer membership/ownership above tldraw's raw ordering
     primitives.
   - Owns layer records: coordinate space, transform/camera, extent, owner, and
     hit-test policy.
   - Should be small and reusable, with tlda as the first serious consumer.
   - Should not know about fleet chat, document source sync, notes, or voice.

3. **tlda app**
   - Owns product behavior: documents, fleet surfaces, annotations, source sync,
     CanvasClipPanel semantics, inbox behavior, voice, and app workflows.
   - Uses the WM package to place and render surfaces.

## Likely WM Abstractions

- Layer model: composited render layers over the same underlying canvas/store,
  each with its own camera/frame. A layer is semantic membership plus transform,
  not merely "whatever a viewport happens to show."
- Coordinate-space policy: layers declare whether they are canvas-stable,
  screen-stable, or relative to another layer. Screen-stable content must stay
  fixed on the screen by WM transform/compositor state, not by mutating shape
  positions on every camera change.
- Surface registry: ids, labels, default viewport policy, and focus behavior.
- Viewport layout model: which surface lives in which viewport/camera, with
  bounds and placement policy outside individual product components.
- Collision/ownership policy: the WM prevents independent users/surfaces from
  projecting into overlapping regions unless that overlap is intentional.
- Per-owner fleet layers: default rendering should show the current
  user/device's fleet layer, not all owners' fleet shapes. Other owners'
  layers can be hidden, ghosted, or explicitly enabled.
- Layer z-bands: WM assigns each countable layer a reserved z range, possibly
  spaced to leave room for insertion between layers. Product code should request
  intra-layer ordering instead of choosing global z positions directly.
- Avoid global cells as the conceptual model. Layer records and compositor
  transforms should remove the need to pre-partition the infinite canvas into a
  global grid of boxes. Extents may still exist for ownership, performance, and
  hit-testing, but they are layer bounds, not cells in a shared tiling scheme.
- Hit-test policy: layers are walked top-down; actual content or declared layer
  chrome catches events, while blank layer space falls through to lower layers.
- Layer transfer: moving content between layers changes membership and applies a
  coordinate conversion so the object appears continuous.
- Mapping to tldraw ordering: decide whether layer membership is represented by
  `parentId` containers, reserved `index` ranges, shape metadata, or an explicit
  WM record type.
- Viewport-relative visibility/culling helpers, so tlda shapes do not each
  rediscover named-viewport behavior.
- Test harness for rendering a surface inside a secondary viewport and asserting
  that it is actually visible.

## Keep In tlda

- FleetHUD contents and fleet data semantics.
- Fleet inbox behavior.
- CanvasClipPanel product behavior.
- Document/page/source-sync logic.
- Annotation, note, and voice workflows.

## Extraction Rule

Do not pre-abstract after one surface. Push one or two more concrete surfaces
through WM first. When the same viewport/surface pattern appears twice, move the
shared part into the WM layer and leave product-specific behavior in tlda.

## API Boundary Rule

Product-facing code should program to WM concepts: layer, surface, layout,
camera, ownership, and hit-test policy. `viewport` can remain an implementation
detail below that boundary. This lets WM change from the current named-viewport
renderer hook to a fuller layer compositor without forcing tlda product surfaces
to be rewritten.

## Open Implementation Questions

- Representation: explicit WM records vs shape metadata vs parent containers /
  reserved index bands.
- Compositor hook: how much existing tldraw rendering can support before fork
  changes are required.
- Hit-testing: where to implement top-down layer fall-through cleanly.
- Sync/schema: whether layer records need server schema support or can start as
  app-side state.
- Migration: how existing fleet surfaces move into per-owner fleet layers
  without breaking existing rooms.
