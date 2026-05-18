/**
 * DocVersionShape — invisible sentinel shape that records the source git commit hash
 * for the current document build. Stored as a TLDraw shape so tldraw's native
 * undo reverts the commit ref for free.
 *
 * One per room, fixed ID: shape:doc-version--sentinel
 * Renders nothing — opacity 0, 1×1px, off-screen not required.
 */
import { BaseBoxShapeUtil, T } from 'tldraw'

export class DocVersionShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'doc-version' as const
  static override props = {
    w: T.number,
    h: T.number,
    commitHash: T.string,
    timestamp: T.number,
    buildReadyAt: T.optional(T.number),
  }

  getDefaultProps() {
    return { w: 1, h: 1, commitHash: 'unknown', timestamp: 0, buildReadyAt: 0 }
  }

  override canEdit = () => false
  override canResize = () => false
  override canBind = () => false
  override isAspectRatioLocked = () => true
  override hideRotateHandle = () => true
  override hideResizeHandles = () => true
  override hideSelectionBoundsBg = () => true
  override hideSelectionBoundsFg = () => true

  component(_shape: any) {
    return null
  }

  indicator(_shape: any) {
    return null
  }
}
