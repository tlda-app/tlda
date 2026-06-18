/**
 * Inert tombstone for the retired TOC drop target.
 *
 * Keep the shape util registered so rooms with an old `toc-drop-target` record
 * still load, but do not create, position, receive drops, or intercept pointer
 * events. The visible document panel / phone TOC button is separate.
 */
import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'

export class TocDropTargetShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'toc-drop-target' as const
  static override props = {
    w: T.number,
    h: T.number,
  }

  getDefaultProps() {
    return { w: 80, h: 600 }
  }

  // Non-interactive for normal use
  override canEdit = () => false
  override canResize = () => false
  override canBind = () => false
  override isAspectRatioLocked = () => true
  override hideRotateHandle = () => true
  override hideResizeHandles = () => true
  override hideSelectionBoundsBg = () => true
  override hideSelectionBoundsFg = () => true

  // Retired: stale records must not receive dragged notes or touch events.
  override canReceiveNewChildrenOfType(_shape: any, type: string) {
    void type
    return false
  }

  // Render: invisible — no visual presence on canvas
  component() {
    return (
      <HTMLContainer
        style={{
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          opacity: 0,
        }}
      />
    )
  }

  // No indicator outline
  indicator() {
    return null as any
  }
}
