/**
 * FleetContainerShape — a container frame that groups all fleet shapes
 * (fleet-chat, fleet-agents). The FleetHUD clips to this frame's bounds
 * instead of computing bounds from individual shapes.
 *
 * Children move with the container (tldraw native parent-child behavior).
 * On first render, adopts any orphaned fleet shapes on the page.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
} from 'tldraw'
import { useEffect, useRef } from 'react'

const FLEET_CHILD_TYPES = ['fleet-chat', 'fleet-agents']

const DEFAULT_W = 860
const DEFAULT_H = 640

export class FleetContainerShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-container' as const
  static override props = {
    w: T.number,
    h: T.number,
    label: T.string,
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, label: 'fleet' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <FleetContainerComponent shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={6} ry={6} />
  }
}

function FleetContainerComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h, label } = shape.props
  const adoptedRef = useRef(false)

  // Adopt orphaned fleet shapes on first render
  useEffect(() => {
    if (adoptedRef.current) return
    adoptedRef.current = true

    const allShapes = editor.getCurrentPageShapes()
    const orphans = allShapes.filter(
      (s) =>
        FLEET_CHILD_TYPES.includes(s.type) &&
        s.parentId !== shape.id
    )

    if (orphans.length === 0) return

    // Reparent: convert page coords to local (relative to container)
    const containerBounds = editor.getShapePageBounds(shape.id)
    if (!containerBounds) return

    for (const orphan of orphans) {
      const orphanBounds = editor.getShapePageBounds(orphan.id)
      if (!orphanBounds) continue
      editor.updateShape({
        id: orphan.id,
        type: orphan.type,
        parentId: shape.id,
        x: orphanBounds.x - containerBounds.x,
        y: orphanBounds.y - containerBounds.y,
      })
    }
  }, [editor, shape.id])

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: 'none',
      }}
    >
      <div
        className="fleet-container-frame"
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 6,
          border: '1px solid rgba(128, 128, 128, 0.08)',
          position: 'relative',
        }}
      >
        {/* Label in top-left corner */}
        <div
          style={{
            position: 'absolute',
            top: -18,
            left: 4,
            fontSize: 9,
            fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
            fontWeight: 500,
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
            opacity: 0.15,
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          {label}
        </div>
      </div>
    </HTMLContainer>
  )
}
