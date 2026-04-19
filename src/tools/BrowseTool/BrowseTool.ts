import { type TLStateNodeConstructor } from 'tldraw'
import { SelectTool } from 'tldraw'
import { BrowseIdle } from './BrowseIdle'
import { BrowsePointingCanvas } from './BrowsePointingCanvas'

/**
 * BrowseTool — the default interaction tool for tlda.
 *
 * Subclasses tldraw's SelectTool with custom child states:
 *   - BrowseIdle: routes locked fleet shapes and HTML pages to DOM interaction
 *   - BrowsePointingCanvas: skips premature selectNone() on pointerdown so
 *     hud-layout-active stays alive until the brush gesture completes
 *
 * All other select states (Translating, Resizing, Rotating, Brushing, etc.)
 * are inherited unchanged.
 */
export class BrowseTool extends SelectTool {
  static override id = 'select'

  static override children(): TLStateNodeConstructor[] {
    const parentChildren = super.children()
    return parentChildren.map(child => {
      if (child.id === 'idle') return BrowseIdle
      if (child.id === 'pointing_canvas') return BrowsePointingCanvas
      return child
    })
  }
}
