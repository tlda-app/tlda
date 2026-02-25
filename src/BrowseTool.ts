import { StateNode, type TLPointerEventInfo } from 'tldraw'

/**
 * Smart browse tool for HTML documents.
 *
 * Respects z-order:
 * - Unlocked shape (note, annotation) → delegate to select (drag/edit)
 * - Locked html-page shape (iframe) → pass through for web interaction
 * - Empty canvas → delegate to select (box select / lasso)
 *
 * The select tool returns to browse when selection empties
 * (see SvgDocument.tsx bounce-back reactor).
 */
export class BrowseTool extends StateNode {
  static override id = 'browse'

  override onEnter = () => {
    this.editor.setCursor({ type: 'default', rotation: 0 })
  }

  override onPointerDown = (info: TLPointerEventInfo) => {
    const point = this.editor.inputs.currentPagePoint
    const hitShape = this.editor.getShapeAtPoint(point, {
      hitInside: true,
      margin: 0,
      renderingOnly: true,
    })

    if (hitShape && hitShape.isLocked) {
      // Locked shape (html-page iframe) — pass through for web interaction
      return
    }

    // Unlocked shape or empty canvas — delegate to select for
    // shape interaction or box-select/lasso
    this.editor.setCurrentTool('select')
    this.editor.root.handleEvent(info)
  }

  override onPointerMove = () => {}
  override onPointerUp = () => {}
}
