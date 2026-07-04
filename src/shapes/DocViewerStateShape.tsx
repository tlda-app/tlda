/**
 * DocViewerStateShape — hidden per-document viewer state.
 *
 * This is the TLDraw-native durable home for user-visible viewer state that must
 * converge after reconnects. Feature-specific wiring is added only after the
 * product behavior is confirmed.
 */
import { BaseBoxShapeUtil, T } from 'tldraw'

export const DOC_VIEWER_STATE_SHAPE_ID = 'shape:doc-viewer-state--sentinel'

export class DocViewerStateShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'doc-viewer-state' as const
  static override props = {
    w: T.number,
    h: T.number,
    timestamp: T.number,
    diffReviewJson: T.optional(T.string),
    diffSummariesJson: T.optional(T.string),
  }

  getDefaultProps() {
    return {
      w: 1,
      h: 1,
      timestamp: 0,
      diffReviewJson: '',
      diffSummariesJson: '',
    }
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

  getIndicatorPath() {
    return undefined
  }

  indicator(_shape: any) {
    return null
  }
}
