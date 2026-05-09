import { SelectTool } from 'tldraw'
import type { TLPointerEventInfo } from 'tldraw'

// PointingCanvas is not in tldraw's public exports map — retrieve it at runtime
// from SelectTool's own children list. This is safer than a deep path import:
// we get exactly the class SelectTool uses (no version mismatch), with no
// dependency on internal file structure. Throws loudly at module load if missing.
const PointingCanvasBase = SelectTool.children().find(c => c.id === 'pointing_canvas')
  ?? (() => { throw new Error('BrowsePointingCanvas: pointing_canvas state not found in SelectTool.children()') })()

/**
 * BrowsePointingCanvas — overrides PointingCanvas.onEnter to skip the immediate
 * selectNone() call.
 *
 * Root cause of the brush-stuck bug:
 *   PointingCanvas.onEnter calls selectNone() on pointerdown, which fires the
 *   store listener → checkSelection() → removes hud-layout-active before brushing
 *   even starts. With hud-layout-active gone, pointer-events: none is restored
 *   mid-drag, TLDraw never receives pointerup, and the brush stays stuck.
 *
 * Fix:
 *   Skip selectNone() in onEnter. The inherited onPointerUp calls
 *   selectOnCanvasPointerUp(), which handles click-to-deselect correctly after
 *   the full interaction has completed — no timing race.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class BrowsePointingCanvas extends (PointingCanvasBase as any) {
  static id = 'pointing_canvas'
  // NOTE: don't redeclare other statics (isLockable, useCoalescedEvents).
  // Tldraw reads them off the constructor with specific defaults from the
  // parent; overriding here changes runtime behavior. The TS error from the
  // `as any` parent is silenced at the call site in BrowseTool.children()
  // via `as unknown as TLStateNodeConstructor` — see that file.

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onEnter(_info: TLPointerEventInfo & { target: 'canvas' }) {
    // Intentionally skip selectNone() here. See class comment above.
  }
}
