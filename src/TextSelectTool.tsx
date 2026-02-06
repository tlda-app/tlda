import { StateNode } from 'tldraw'

/**
 * Custom tool that activates text selection mode.
 * When active, the TextSelectionLayer overlay gets pointer events,
 * letting users select text by dragging on the PDF pages.
 * Works on both desktop and iPad (pen/touch).
 */
export class TextSelectTool extends StateNode {
  static override id = 'text-select'

  override onEnter = () => {
    this.editor.setCursor({ type: 'text', rotation: 0 })
  }

  override onExit = () => {
    this.editor.setCursor({ type: 'default', rotation: 0 })
  }

  // Let pointer events pass through to the TextSelectionLayer overlay
  override onPointerDown = () => {}
  override onPointerMove = () => {}
  override onPointerUp = () => {}
}
