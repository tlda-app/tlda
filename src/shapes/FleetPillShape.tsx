/**
 * FleetPillShape — small draggable pill representing an agent or label.
 *
 * Drag is tldraw-native (shape translation). On drop:
 * - Over a fleet-chat → sets that chat's filter prop
 * - Over empty canvas → creates a new fleet-chat filtered to this value
 * - Always snaps back to home position (stored in meta)
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  createShapeId,
} from 'tldraw'
import type { TLShape } from 'tldraw'

const PILL_W = 70
const PILL_H = 18

export class FleetPillShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-pill' as const
  static override props = {
    w: T.number,
    h: T.number,
    pillType: T.string,   // 'agent' | 'label'
    value: T.string,       // agent ID or label name
    displayName: T.string, // rendered text
    color: T.string,       // nick color or label color
  }

  getDefaultProps() {
    return {
      w: PILL_W,
      h: PILL_H,
      pillType: 'agent',
      value: '',
      displayName: '',
      color: '#7a9ec8',
    }
  }

  override canEdit = () => false
  override canResize = () => false
  override canBind = () => false
  override hideRotateHandle = () => true
  override hideSelectionBoundsBg = () => true
  override hideSelectionBoundsFg = () => true

  override onTranslateEnd = (initial: TLShape, current: TLShape) => {
    const editor = this.editor
    const pill = current as any
    const homeX = pill.meta?.homeX ?? initial.x
    const homeY = pill.meta?.homeY ?? initial.y

    // Check what's under the pill's center (use page coordinates)
    const bounds = editor.getShapePageBounds(pill.id)
    const centerX = bounds ? bounds.x + bounds.w / 2 : pill.x + pill.props.w / 2
    const centerY = bounds ? bounds.y + bounds.h / 2 : pill.y + pill.props.h / 2
    const hitShape = editor.getShapeAtPoint({ x: centerX, y: centerY }, {
      hitInside: true,
      margin: 0,
      filter: (s: TLShape) => s.id !== pill.id && s.type !== 'fleet-pill' && s.type !== 'fleet-agents' && s.type !== 'fleet-container',
    })

    if (hitShape && hitShape.type === 'fleet-chat') {
      // Drop on existing chat → AND with last clause (or start new clause)
      const existingFilter: string[][] = (hitShape as any).props.filter || []
      let newFilter: string[][]
      if (existingFilter.length === 0) {
        // No filter yet — start fresh clause
        newFilter = [[pill.props.value]]
      } else {
        // AND with the last clause (add term to it)
        const lastClause = existingFilter[existingFilter.length - 1]
        if (lastClause.includes(pill.props.value)) {
          // Already in the clause — no-op
          newFilter = existingFilter
        } else {
          newFilter = [
            ...existingFilter.slice(0, -1),
            [...lastClause, pill.props.value],
          ]
        }
      }
      editor.updateShape({
        id: hitShape.id,
        type: 'fleet-chat',
        props: { ...(hitShape as any).props, filter: newFilter },
      })
    } else if (hitShape === undefined || hitShape === null || hitShape.type !== 'fleet-agents') {
      // Drop on empty canvas → create new fleet-chat with [[value]]
      const newId = createShapeId()
      editor.createShape({
        id: newId,
        type: 'fleet-chat',
        x: pill.x,
        y: pill.y,
        props: {
          w: 400,
          h: 600,
          filter: [[pill.props.value]],
        },
      })
    }

    // Snap back to home position (reparent if dragged out)
    const parentId = pill.meta?.originalParentId || initial.parentId
    editor.updateShape({
      id: pill.id,
      type: 'fleet-pill',
      parentId,
      x: homeX,
      y: homeY,
    })
  }

  component(shape: any) {
    const { displayName, color } = shape.props
    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          pointerEvents: 'none', // let tldraw handle selection/drag
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '1px 6px',
            borderRadius: 2,
            background: color,
            color: '#fff',
            fontSize: 9,
            fontWeight: 500,
            cursor: 'grab',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            lineHeight: '14px',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {displayName}
          </span>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={3} ry={3} />
  }
}
