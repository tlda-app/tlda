import { StateNode } from 'tldraw'

/**
 * Browse tool for HTML documents.
 * Default cursor on the canvas; iframes become interactive (pointer-events: auto)
 * so users can click links, select text, and interact with web content.
 *
 * Like TextSelectTool, pointer events pass through to the browser/iframe layer.
 * For annotation selection/drag, switch to the demoted select tool.
 */
export class BrowseTool extends StateNode {
  static override id = 'browse'

  override onEnter = () => {
    this.editor.setCursor({ type: 'default', rotation: 0 })
  }

  // Let pointer events pass through to iframe content
  override onPointerDown = () => {}
  override onPointerMove = () => {}
  override onPointerUp = () => {}
}
