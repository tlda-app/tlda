import { type TLStateNodeConstructor } from 'tldraw'
import { SelectTool } from 'tldraw'
import { BrowseIdle } from './BrowseIdle'

/**
 * BrowseTool — the default interaction tool for tlda.
 *
 * Subclasses tldraw's SelectTool with a custom Idle state that routes
 * locked fleet shapes and HTML pages to DOM interaction instead of
 * treating them as inert locked shapes.
 *
 * All other select states (Translating, Resizing, Rotating, Brushing, etc.)
 * are inherited unchanged.
 */
export class BrowseTool extends SelectTool {
  static override id = 'browse'

  static override children(): TLStateNodeConstructor[] {
    // Get all of SelectTool's children, swap Idle → BrowseIdle
    const parentChildren = super.children()
    return parentChildren.map(child =>
      child.id === 'idle' ? BrowseIdle : child
    )
  }
}
