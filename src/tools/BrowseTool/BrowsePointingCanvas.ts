import { SelectTool } from 'tldraw'
import type { TLPointerEventInfo } from 'tldraw'

// PointingCanvas is not in tldraw's public API — retrieve it at runtime from
// SelectTool's own children list rather than a fragile deep import.
const PointingCanvasBase = SelectTool.children().find(c => c.id === 'pointing_canvas')!

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
  static override id = 'pointing_canvas'

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onEnter(_info: TLPointerEventInfo & { target: 'canvas' }) {
    // Intentionally skip selectNone() here. See class comment above.
  }
}
