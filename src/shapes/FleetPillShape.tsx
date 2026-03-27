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
  TLShape,
  stopEventPropagation,
  createShapeId,
} from 'tldraw'

const PILL_W = 120
const PILL_H = 24

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

    // Check what's under the pill's center
    const centerX = pill.x + pill.props.w / 2
    const centerY = pill.y + pill.props.h / 2
    const hitShape = editor.getShapeAtPoint({ x: centerX, y: centerY }, {
      hitInside: true,
      margin: 0,
      filter: (s: TLShape) => s.id !== pill.id && s.type !== 'fleet-pill' && s.type !== 'fleet-agents',
    })

    if (hitShape && hitShape.type === 'fleet-chat') {
      // Drop on existing chat → set filter
      editor.updateShape({
        id: hitShape.id,
        type: 'fleet-chat',
        props: { ...(hitShape as any).props, filter: pill.props.value },
      })
    } else if (hitShape === undefined || hitShape === null || hitShape.type !== 'fleet-agents') {
      // Drop on empty canvas → create new fleet-chat
      const newId = createShapeId()
      editor.createShape({
        id: newId,
        type: 'fleet-chat',
        x: pill.x,
        y: pill.y,
        props: {
          w: 400,
          h: 600,
          filter: pill.props.value,
        },
      })
    }

    // Snap back to home position
    editor.updateShape({
      id: pill.id,
      type: 'fleet-pill',
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
          pointerEvents: 'all',
        }}
      >
        <div
          onPointerDown={stopEventPropagation}
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 8px',
            borderRadius: 12,
            border: `1.5px solid ${color}60`,
            background: `${color}15`,
            color: color,
            fontSize: 11,
            fontWeight: 600,
            cursor: 'grab',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            userSelect: 'none',
          }}
        >
          {/* Small avatar circle for agents */}
          {shape.props.pillType === 'agent' && (
            <div style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: `${color}25`,
              border: `1px solid ${color}50`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 9,
              fontWeight: 700,
              flexShrink: 0,
              textTransform: 'uppercase',
            }}>
              {displayName.charAt(0)}
            </div>
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {displayName}
          </span>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} ry={12} />
  }
}
