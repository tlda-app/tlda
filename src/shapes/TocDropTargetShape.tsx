/**
 * TocDropTargetShape — invisible TLDraw-native drop target at the viewport right edge.
 *
 * When a chapter-capable math-note is dragged onto this shape, it triggers the
 * chapter-add flow (create markdown project, add to book).
 *
 * Uses TLDraw's onDragShapesOver/onDropShapesOver callbacks — no HTML5 drag needed.
 */
import { BaseBoxShapeUtil, HTMLContainer, T, useEditor, react } from 'tldraw'
import type { TLShape, TLShapeId } from 'tldraw'
import { useEffect, useRef } from 'react'

const TOC_DROP_TARGET_ID = 'shape:toc-drop-target' as TLShapeId

// Check if a shape is a chapter-capable math-note (starts with # heading)
function isChapterCapable(shape: TLShape): boolean {
  if ((shape.type as string) !== 'math-note') return false
  const text = (shape.props as any)?.text || ''
  return /^#\s+/.test(text.trim())
}

function getChapterTitle(text: string): string {
  const match = text.trim().match(/^#\s+(.+)/)
  return match ? match[1].trim() : ''
}

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

  // Accept math-note children (for drop target detection)
  override canReceiveNewChildrenOfType(_shape: any, type: string) {
    return type === 'math-note'
  }

  // Visual feedback when shapes are dragged over
  override onDragShapesOver = (_shape: any, shapes: TLShape[]) => {
    const hasChapter = shapes.some(isChapterCapable)
    if (hasChapter) {
      window.dispatchEvent(new CustomEvent('toc-drop-hover', { detail: { active: true } }))
    }
  }

  override onDragShapesOut = () => {
    window.dispatchEvent(new CustomEvent('toc-drop-hover', { detail: { active: false } }))
  }

  // Handle the actual drop
  override onDropShapesOver = (_shape: any, shapes: TLShape[]) => {
    window.dispatchEvent(new CustomEvent('toc-drop-hover', { detail: { active: false } }))

    const chapterShapes = shapes.filter(isChapterCapable)
    if (chapterShapes.length === 0) return

    // Don't reparent — move shapes back to page root
    for (const s of shapes) {
      if (s.parentId !== this.editor.getCurrentPageId()) {
        this.editor.reparentShapes([s], this.editor.getCurrentPageId())
      }
    }

    // Trigger chapter-add for the first chapter-capable shape
    const shape = chapterShapes[0]
    const text = (shape.props as any)?.text || ''
    const title = getChapterTitle(text)

    window.dispatchEvent(new CustomEvent('toc-drop-chapter', {
      detail: { text, title, shapeId: shape.id },
    }))
  }

  // Render: invisible — no visual presence on canvas
  component() {
    return (
      <HTMLContainer
        style={{
          width: '100%',
          height: '100%',
          pointerEvents: 'all',
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

/**
 * TocDropTargetManager — React component that creates and positions the
 * drop target shape at the viewport right edge. Include inside <Tldraw>.
 */
export function TocDropTargetManager() {
  const editor = useEditor()
  const createdRef = useRef(false)

  // Create the drop target shape once
  useEffect(() => {
    if (createdRef.current) return
    createdRef.current = true

    // Check if it already exists (from sync)
    const existing = editor.getShape(TOC_DROP_TARGET_ID)
    if (!existing) {
      const vb = editor.getViewportScreenBounds()
      const topRight = editor.screenToPage({ x: vb.maxX - 40, y: vb.minY })
      const bottomRight = editor.screenToPage({ x: vb.maxX, y: vb.maxY })

      editor.createShape({
        id: TOC_DROP_TARGET_ID,
        type: 'toc-drop-target' as any,
        x: topRight.x,
        y: topRight.y,
        isLocked: false,
        props: {
          w: 80 / editor.getCamera().z,
          h: (bottomRight.y - topRight.y),
        },
      } as any)
    }
  }, [editor])

  // Track camera changes and reposition the drop target
  useEffect(() => {
    return react('toc-drop-target-position', () => {
      const camera = editor.getCamera()
      const vb = editor.getViewportScreenBounds()
      if (!vb) return

      const topRight = editor.screenToPage({ x: vb.maxX - 40, y: vb.minY })
      const bottomRight = editor.screenToPage({ x: vb.maxX, y: vb.maxY })
      const w = 80 / camera.z
      const h = bottomRight.y - topRight.y

      const existing = editor.getShape(TOC_DROP_TARGET_ID)
      if (!existing) return

      // Only update if position actually changed (avoid infinite loop)
      const ex = existing as any
      if (Math.abs(ex.x - topRight.x) > 1 || Math.abs(ex.y - topRight.y) > 1 ||
          Math.abs(ex.props.w - w) > 1 || Math.abs(ex.props.h - h) > 1) {
        editor.updateShape({
          id: TOC_DROP_TARGET_ID,
          type: 'toc-drop-target' as any,
          x: topRight.x,
          y: topRight.y,
          props: { w, h },
        } as any)
      }
    })
  }, [editor])

  return null
}
