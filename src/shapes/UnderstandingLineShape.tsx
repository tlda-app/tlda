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
 *   - status: 'approved' | 'presentation' | 'uncertain' | 'rejected' | 'unchecked'
 *   - userIndex: horizontal stacking offset (0, 1, 2, ...)
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
  stopEventPropagation,
} from 'tldraw'
import { useCallback, useState } from 'react'

export type LineStatus = 'approved' | 'presentation' | 'uncertain' | 'rejected' | 'unchecked'

export const STATUS_COLORS: Record<LineStatus, string> = {
  approved: '#16a34a',
  presentation: '#3b82f6',
  uncertain: '#ca8a04',
  rejected: '#dc2626',
  unchecked: '#9ca3af',
}

export const STATUS_LABELS: Record<LineStatus, string> = {
  approved: 'approved',
  presentation: 'presentation',
  uncertain: 'uncertain',
  rejected: 'rejected',
  unchecked: 'unchecked',
}

// Highlighter colors that modify status when drawn on the ribbon
export const HIGHLIGHT_TO_STATUS: Record<string, LineStatus | undefined> = {
  'light-green': 'approved',
  'green': 'approved',
  'blue': 'presentation',
  'light-blue': 'presentation',
  'grey': 'presentation',
  'yellow': 'uncertain',
  'orange': 'uncertain',
  'light-red': 'rejected',
  'red': 'rejected',
  'black': 'rejected',
}

function StatusBadge({ status, arrow }: { status: LineStatus; arrow?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 3,
    }}>
      {arrow && <span style={{ color: '#999', fontSize: 10 }}>→</span>}
      <span style={{
        background: STATUS_COLORS[status],
        color: '#fff',
        fontSize: 10,
        fontWeight: 600,
        padding: '1px 5px',
        borderRadius: 3,
        lineHeight: '14px',
        whiteSpace: 'nowrap',
      }}>
        {STATUS_LABELS[status]}
      </span>
    </span>
  )
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
    status: T.string,
    userIndex: T.number,
  }

  getDefaultProps() {
    return {
      w: 3, h: 20,
      userId: '', displayName: '',
      startLine: 0, endLine: 0,
      status: 'unchecked',
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
    const status = (shape.props.status as LineStatus) || 'unchecked'
    const color = STATUS_COLORS[status] || STATUS_COLORS.unchecked
    const isOwn = shape.props.userId === (window as any).__tlda_userId
    const [hovered, setHovered] = useState(false)

    const activeHighlightColor = useValue('active-hl-color', () => {
      const tool = editor.getCurrentToolId()
      if (tool !== 'highlight') return null
      return (editor.getInstanceState().stylesForNextShape?.['tldraw:color'] as string) || null
    }, [editor])

    const handleClick = useCallback((e: React.PointerEvent) => {
      if (!isOwn) return
      stopEventPropagation(e)
      const cycle: LineStatus[] = ['approved', 'presentation', 'uncertain', 'rejected', 'unchecked']
      const idx = cycle.indexOf(status)
      const nextStatus = cycle[(idx + 1) % cycle.length]
      editor.store.update(shape.id, (s: any) => ({
        ...s,
        props: { ...s.props, status: nextStatus },
      }))
    }, [editor, shape.id, status, isOwn])

    const targetStatus = activeHighlightColor ? HIGHLIGHT_TO_STATUS[activeHighlightColor as string] : undefined
    const showTransition = hovered && targetStatus && targetStatus !== status

    return (
      <HTMLContainer
        style={{
          width: '100%',
          height: '100%',
          pointerEvents: 'all',
          cursor: isOwn ? 'pointer' : 'default',
        }}
        onPointerDown={isOwn ? handleClick : undefined}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            backgroundColor: color,
            borderRadius: 1,
            opacity: status === 'unchecked' ? 0.3 : (isOwn ? 0.7 : 0.4),
            transition: 'opacity 0.2s',
          }}
        />
        {hovered && (
          <div
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              background: 'rgba(30,30,30,0.9)',
              padding: '3px 6px',
              borderRadius: 4,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              zIndex: 100,
            }}
          >
            {showTransition ? (
              <>
                {status !== 'unchecked' && <StatusBadge status={status} />}
                <StatusBadge status={targetStatus!} arrow />
              </>
            ) : (
              <StatusBadge status={status} />
            )}
          </div>
        )}
      </HTMLContainer>
    )
  }

  indicator() {
    return null as any
  }
}
