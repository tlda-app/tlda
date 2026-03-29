import { StateNode, type TLPointerEventInfo } from 'tldraw'

const FLEET_TYPES = new Set(['fleet-chat', 'fleet-agents', 'fleet-search'])

/**
 * Smart browse tool for HTML documents and fleet UI.
 *
 * Event routing by shape type:
 * - Fleet shapes (locked): stay in browse. React components handle pointer
 *   events via pointer-events:all. Wheel scroll works natively through DOM.
 * - Locked html-page shapes (iframes): pass through for web interaction.
 * - Unlocked shapes / empty canvas: delegate to select (drag/edit/box select).
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
      // Locked shapes (fleet UI, html-page iframes): stay in browse,
      // let DOM handle the interaction via pointer-events:all
      return
    }

    // Unlocked shape or empty canvas — delegate to select
    this.editor.setCurrentTool('select')
    this.editor.root.handleEvent(info)
  }

  override onPointerMove = () => {}
  override onPointerUp = () => {}
}
