# A surface layer's lifetime is the shape's, not a mount's

Force-added: this is the resumption point for `fleet:9307-mtz6mnxx`, not a
report of it.

## What the crash is

`Layer "fleet-docview:fleet-docview-photographer-c87ef20d" is not defined.`

The fleet HUD is a second viewport over the **same store**, so one fleet shape's
component mounts **twice** — main canvas and HUD — with the same `shape.id`,
therefore the same layer id, against the same editor-scoped `WMCore`. Each
instance's unmount ran `removeLayers(surface.wm, [surface.layerId])`. When the
render gate unmounts the main-canvas copy, the HUD copy is still mounted holding
a memoised surface whose layer has just been deleted underneath it.

Reproduced with no browser in `scratchpad/docview-repro.ts`:

```
both instances mounted; layer present: true
main-canvas copy unmounted; layer present: false
RED — Layer "fleet-docview:…" is not defined.
```

## What the history says, because the chief asked the right question

Not *why was the cleanup added* but **what is the layer's lifetime tied to**.

The cleanup arrived correct. `c6cb4d66a` — *"consolidate the five separate cores
into one editor-scoped WMCore (`getEditorWMCore` via `WeakMap<Editor>`); all
surfaces register their layers into it"* — is what made it wrong. Before it, each
surface had its **own** core, so a per-instance core died with its instance and
removing the layer on unmount was just tidying a core nobody else held. After it,
one core is shared and the layer id is derived from **`shape.id`**
(`fleet-docview:${slug(shapeId)}`, `doc-clip:${shape.id}`) — not from the
instance, not from the viewport.

So the lifetime is **per-shape** and has been since that commit. Nothing in the
history argues for per-mount; the per-mount removal is residue of the old
per-core arrangement that consolidation did not revisit.

## The intended behaviour

- **A shape's surface layer exists while the shape exists.** Mounting a renderer
  for it ensures the layer (`ensureViewLayer` is already idempotent, so the
  second renderer is a no-op). Unmounting a renderer does nothing to it.
- **Deleting the shape removes the layer**, once, from the editor-scoped core —
  registered on the editor, where shape deletion is observable, rather than in
  any component.
- **No refcount.** Two renderers of one shape are not two owners; neither owns
  it. Nothing counts them.
- **No leak.** The removal still happens, at the moment the thing it is keyed to
  goes away.

`CanvasClipPanel`'s removal is **not** this and stays as it is: its layers are
keyed by `viewportId` and paired with a viewport registration, so they genuinely
are per-registration.

## How it is demonstrated

`scratchpad/docview-repro.ts` goes GREEN — the surviving renderer can still read
its layer after the other unmounts — and a second case shows the layer **is**
gone after the shape is deleted, so the fix is not "stop removing".
