/**
 * UnderstandingLineShape — thin vertical margin line showing a user's understanding status.
 *
 * Rendered in the left margin of the document. One shape per contiguous range of
 * same-status lines, per user. Multiple users stack horizontally (2px wide each).
 *
 * Props:
 *   - w/h: dimensions
 *   - userId: owner of this understanding line
 *   - startLine: first source line in this range
 *   - endLine: last source line in this range
 *   - status: 'approved' | 'understood'
 *   - userIndex: horizontal stacking offset (0, 1, 2, ...)
 *
 * Interaction:
 *   - Click your own line → cycles status (approved → understood → remove)
 *   - Others' lines are read-only
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  stopEventPropagation,
} from 'tldraw'
import { useCallback } from 'react'
type LineStatus = 'approved' | 'understood' | 'unchecked'

const STATUS_COLORS: Record<LineStatus, string> = {
  approved: '#16a34a',
  understood: '#ca8a04',
  unchecked: '#9ca3af',
}

export class UnderstandingLineShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'understanding-line' as const
  static override props = {
    w: T.number,
    h: T.number,
    userId: T.string,
    displayName: T.string,
    startLine: T.number,
    endLine: T.number,
    status: T.string,  // 'approved' | 'understood'
    userIndex: T.number,
  }

  getDefaultProps() {
    return {
      w: 3, h: 20,
      userId: '', displayName: '',
      startLine: 0, endLine: 0,
      status: 'approved',
      userIndex: 0,
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

  component(shape: any) {
    const editor = useEditor()
    const status = shape.props.status as LineStatus
    const color = STATUS_COLORS[status] || STATUS_COLORS.approved
    const isOwn = shape.props.userId === (window as any).__tlda_userId

    const handleClick = useCallback((e: React.PointerEvent) => {
      if (!isOwn) return
      stopEventPropagation(e)
      // Cycle: approved → understood → delete (unchecked)
      const nextStatus = status === 'approved' ? 'understood' : null
      if (nextStatus) {
        editor.store.update(shape.id, (s: any) => ({
          ...s,
          props: { ...s.props, status: nextStatus },
        }))
      } else {
        // Remove the shape — line is now unchecked
        editor.deleteShape(shape.id)
      }
    }, [editor, shape.id, shape.props, status, isOwn])

    return (
      <HTMLContainer
        style={{
          width: '100%',
          height: '100%',
          pointerEvents: isOwn ? 'all' : 'none',
          cursor: isOwn ? 'pointer' : 'default',
        }}
        onPointerDown={isOwn ? handleClick : undefined}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            backgroundColor: color,
            borderRadius: 1,
            opacity: isOwn ? 0.7 : 0.4,
            transition: 'opacity 0.2s',
          }}
          title={`${shape.props.displayName}: ${status} (lines ${shape.props.startLine}–${shape.props.endLine})`}
        />
      </HTMLContainer>
    )
  }

  indicator() {
    return null as any
  }
}
