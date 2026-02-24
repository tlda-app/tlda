import { StateNode, type TLPointerEventInfo } from 'tldraw'

/**
 * Smart browse tool for HTML documents.
 *
 * Respects z-order: if an unlocked shape (math note, annotation) is under
 * the pointer, delegates to the select tool for full select/drag/edit.
 * Otherwise, passes through to the iframe layer for link clicks, text
 * selection, and normal web interaction.
 *
 * The select tool returns to browse when the user clicks on empty
 * canvas / bare iframe (see editorSetup.ts bounce-back logic).
 */
export class BrowseTool extends StateNode {
  static override id = 'browse'

  override onEnter = () => {
    this.editor.setCursor({ type: 'default', rotation: 0 })
  }

  override onPointerDown = (info: TLPointerEventInfo) => {
    // Hit test: is there an unlocked shape (note, annotation) under the cursor?
    const point = this.editor.inputs.currentPagePoint
    const zoomLevel = this.editor.getZoomLevel()
    const hitShape = this.editor.getShapeAtPoint(point, {
      hitInside: true,
      margin: 0 / zoomLevel,
      renderingOnly: true,
    })

    if (hitShape && !hitShape.isLocked) {
      // Delegate to the select tool for full interaction (drag, resize, edit)
      this.editor.setCurrentTool('select')
      // Forward the pointer event so the select tool processes it
      this.editor.root.handleEvent(info)
      return
    }

    // No interactive shape — let the event pass through to the iframe
  }

  override onPointerMove = () => {}
  override onPointerUp = () => {}
}
