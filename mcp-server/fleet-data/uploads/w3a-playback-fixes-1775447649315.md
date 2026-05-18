# PlaybackFrame Bug Fixes: Scale-to-Fit + Yjs Filter Crash

**Branch:** `w3a-playback-v2`  
**Commits:** `241d33e` (scale-to-fit), `c03f9d0` (filter type cast), `9099145` (server schema)

---

## Bug 1: Scale-to-Fit (was: clipping)

**Problem:** `getClipPath()` clipped child shapes to the frame bounds. Skip's feedback: should be scale-to-fit like the HUD.

**Fix:** Removed `getClipPath()`. Added `onResize()` that scales all child shapes proportionally when the frame is resized:

```typescript
override onResize(shape: any, info: any) {
  const { editor } = this
  const { scaleX, scaleY } = info
  const children = editor.getSortedChildIdsForParent(shape.id)
    .map((id: any) => editor.getShape(id))
    .filter(Boolean)

  if (children.length > 0) {
    editor.updateShapes(children.map((child: any) => ({
      id: child.id,
      type: child.type,
      x: child.x * scaleX,
      y: CHROME_H + (child.y - CHROME_H) * scaleY,
      props: {
        ...child.props,
        w: Math.max(10, child.props.w * Math.abs(scaleX)),
        h: Math.max(10, child.props.h * Math.abs(scaleY)),
      },
    })))
  }

  return super.onResize(shape, info)
}
```

**Why not CanvasClipPanel?** The HUD uses a separate TLDraw instance with a copy store and locked camera. That approach requires threading shapeUtils/tools through a new context, which is expensive for a shape that already lives on the canvas. `onResize` achieves scale-to-fit at resize time with no extra editor overhead.

**Chrome preservation:** `CHROME_H = 100` (header 36px + scrubber 64px). Y positions are measured from `CHROME_H` so the chrome stays fixed; only the content area scales.

---

## Bug 2: Yjs Filter Crash

**Error:** `ValidationError: At shape(type = fleet-chat).props.filter.0.0: Expected an array, got a string`

**Root cause (two parts):**

### Part A — Missing server schema (`9099145`)
`server/lib/sync-rooms.mjs` had no entry for the `playback-frame` shape type. When a PlaybackFrame was created, the server couldn't validate its schema, cascading to Yjs sync failures for child shapes (including the filter validation on fleet-chat children).

Fix: added `playback-frame` schema to the server's shape registry.

### Part B — Bad filter type cast (`c03f9d0`)
`FleetChatShape.tsx` was casting the filter prop: `filter as string[][] | null`. This narrowed the type from the correct `[string,string][][]` (triple-nested) to `string[][]` (double-nested), causing Yjs to serialize the filter as strings instead of string arrays at depth.

Fix: removed the cast — `filter.length > 0 ? filter : null`.

**Filter schema alignment:**
- Client (`FleetChatShape.tsx`): `T.arrayOf(T.arrayOf(T.arrayOf(T.string)))`
- Server (`sync-rooms.mjs`): `T.arrayOf(T.arrayOf(T.arrayOf(T.string)))`
- `simplifyDnf()`: correctly typed `[string, string][][]` → `[string, string][][]` — no format mismatch

---

## Verification

- `npx tsc --noEmit` — clean (no new type errors)
- `simplifyDnf` signature and return type verified — triple-nested throughout
- Server schema and client schema confirmed aligned
