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
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import { useEffect, useRef, useCallback } from 'react'

const FLEET_CHILD_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search']

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

  indicator() {
    return null
  }
}

function FleetContainerComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h, label } = shape.props
  const adoptedRef = useRef(false)
  const isLocked = useValue('locked', () => editor.getShape(shape.id)?.isLocked ?? true, [editor, shape.id])

  const toggleLock = useCallback(() => {
    const newLocked = !isLocked
    // Toggle container
    editor.updateShape({ id: shape.id, type: 'fleet-container', isLocked: newLocked })
    // Toggle all fleet children
    const children = editor.getCurrentPageShapes().filter(
      (s) => FLEET_CHILD_TYPES.includes(s.type) && s.parentId === shape.id
    )
    for (const child of children) {
      editor.updateShape({ id: child.id, type: child.type, isLocked: newLocked })
    }
  }, [editor, shape.id, isLocked])

  // Adopt orphaned fleet shapes — runs on store changes
  useEffect(() => {
    const adopt = () => {
      const allShapes = editor.getCurrentPageShapes()
      const orphans = allShapes.filter(
        (s) =>
          FLEET_CHILD_TYPES.includes(s.type) &&
          s.parentId !== shape.id
      )
      if (orphans.length === 0) return

      const containerBounds = editor.getShapePageBounds(shape.id)
      if (!containerBounds) return

      for (const orphan of orphans) {
        const orphanBounds = editor.getShapePageBounds(orphan.id)
        if (!orphanBounds) continue
        editor.updateShape({
          id: orphan.id,
          type: orphan.type,
          parentId: shape.id,
          isLocked: isLocked,
          x: orphanBounds.x - containerBounds.x,
          y: orphanBounds.y - containerBounds.y,
        })
      }
    }
    adopt()

    return editor.store.listen(({ changes }) => {
      const hasNewFleet = Object.values(changes.added).some(
        (r: any) => r.typeName === 'shape' && FLEET_CHILD_TYPES.includes(r.type)
      )
      if (hasNewFleet) adopt()
    }, { source: 'all', scope: 'document' })
  }, [editor, shape.id, isLocked])

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: 'auto',
      }}
    >
      <div
        className="fleet-container-frame"
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 0,
          border: '1px solid rgba(128, 128, 128, 0.1)',
          position: 'relative',
        }}
      >
        {/* Lock toggle */}
        <button
          onPointerDown={stopEventPropagation}
          onPointerUp={(e) => {
            stopEventPropagation(e)
            toggleLock()
          }}
          style={{
            position: 'absolute',
            top: 4,
            left: 4,
            background: 'none',
            border: 'none',
            padding: '2px 4px',
            cursor: 'pointer',
            fontSize: 11,
            opacity: isLocked ? 0.15 : 0.5,
            color: 'inherit',
            fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
            lineHeight: 1,
            pointerEvents: 'auto',
            userSelect: 'none',
            zIndex: 10,
          }}
          title={isLocked ? 'Unlock layout' : 'Lock layout'}
        >
          {isLocked ? '🔒' : '🔓'}
        </button>
      </div>
    </HTMLContainer>
  )
}
