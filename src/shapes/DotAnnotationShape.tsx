/**
 * DotAnnotationShape — small colored dot that expands into a note card on tap.
 *
 * Used by agents to annotate highlights with response text. Collapsed state is
 * a tiny presence indicator; expanded state shows the full response.
 *
 * Props:
 *   - w/h: dimensions (small when collapsed, card-sized when expanded)
 *   - highlightColor: hex color matching the associated highlight
 *   - text: agent response text (markdown-ish, rendered as plain text for now)
 *   - collapsed: whether to show as dot or card
 *   - highlightId: optional ID of the associated highlight shape
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  createShapeId,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import type { Editor } from 'tldraw'
import { useCallback, useRef } from 'react'
import { dropPillOnTarget } from './FleetPillShape'

const DOT_SIZE = 10
const CARD_W = 240
const CARD_H = 160

export class DotAnnotationShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'dot-annotation' as const
  static override props = {
    w: T.number,
    h: T.number,
    highlightColor: T.string,
    text: T.string,
    collapsed: T.boolean,
    highlightId: T.string,
  }

  getDefaultProps() {
    return {
      w: DOT_SIZE,
      h: DOT_SIZE,
      highlightColor: '#ffc940',
      text: '',
      collapsed: true,
      highlightId: '',
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
    return <DotAnnotationComponent shape={shape} />
  }

  indicator(shape: any) {
    if (shape.props.collapsed) {
      return <circle cx={DOT_SIZE / 2} cy={DOT_SIZE / 2} r={DOT_SIZE / 2} />
    }
    return <rect width={shape.props.w} height={shape.props.h} rx={6} ry={6} />
  }
}

const DRAG_THRESHOLD = 5

/** Extract visible text from SVG that spatially intersects the highlight region. */
function extractTextFromHighlight(editor: Editor, shape: any): string {
  // Use the referenced highlight shape's bounds if available; fall back to annotation bounds
  const refId = shape.props.highlightId
  const bounds = refId
    ? editor.getShapePageBounds(refId as any) ?? editor.getShapePageBounds(shape.id)
    : editor.getShapePageBounds(shape.id)
  if (!bounds) return ''

  const tl = editor.pageToScreen({ x: bounds.x, y: bounds.y })
  const br = editor.pageToScreen({ x: bounds.x + bounds.w, y: bounds.y + bounds.h })
  // Expand a bit to capture partially-overlapping text
  const pad = 8
  const minX = tl.x - pad, maxX = br.x + pad
  const minY = tl.y - pad, maxY = br.y + pad

  const hits: { text: string; x: number; y: number }[] = []
  document.querySelectorAll<SVGTextElement>('.tl-shapes text, .tl-canvas text').forEach(el => {
    const r = el.getBoundingClientRect()
    if (r.right < minX || r.left > maxX || r.bottom < minY || r.top > maxY) return
    const t = el.textContent?.trim()
    if (t) hits.push({ text: t, x: r.left, y: r.top })
  })

  hits.sort((a, b) => Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y)
  return hits.map(h => h.text).join(' ')
}

function DotAnnotationComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { highlightColor, text, collapsed } = shape.props
  const dragRef = useRef<{
    pillId: string | null
    startX: number
    startY: number
    started: boolean
    extractedText: string
  } | null>(null)

  const toggleCollapsed = useCallback(() => {
    const newCollapsed = !collapsed
    editor.store.update(shape.id, (s: any) => ({
      ...s,
      props: {
        ...s.props,
        collapsed: newCollapsed,
        w: newCollapsed ? DOT_SIZE : CARD_W,
        h: newCollapsed ? DOT_SIZE : Math.max(CARD_H, 60),
      },
    }))
  }, [editor, shape.id, collapsed])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    stopEventPropagation(e)
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { pillId: null, startX: e.clientX, startY: e.clientY, started: false, extractedText: '' }
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY
    if (!drag.started && Math.hypot(dx, dy) < DRAG_THRESHOLD) return

    if (!drag.started) {
      drag.started = true
      drag.extractedText = extractTextFromHighlight(editor, shape)
      const displayName = (drag.extractedText.slice(0, 40) || 'annotation').trim()
      const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
      const pillId = createShapeId()
      editor.createShape({
        id: pillId,
        type: 'fleet-pill' as any,
        x: pagePos.x - 35,
        y: pagePos.y - 9,
        props: { pillType: 'annotation', value: shape.id, displayName, color: highlightColor },
      })
      drag.pillId = pillId as string
    }

    if (drag.pillId) {
      const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
      editor.updateShape({ id: drag.pillId as any, type: 'fleet-pill' as any, x: pagePos.x - 35, y: pagePos.y - 9 })
    }
  }, [editor, shape, highlightColor])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    dragRef.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch {}
    if (!drag) return

    if (!drag.started) {
      toggleCollapsed()
      return
    }
    if (!drag.pillId) return
    const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
    dropPillOnTarget(editor, drag.pillId as any, shape.id, pagePos, drag.extractedText || text || shape.id)
    try { editor.deleteShapes([drag.pillId as any]) } catch {}
  }, [editor, shape, text, toggleCollapsed])

  const handleToggle = useCallback((e: React.PointerEvent) => {
    stopEventPropagation(e)
    toggleCollapsed()
  }, [toggleCollapsed])

  if (collapsed) {
    return (
      <HTMLContainer
        style={{
          width: DOT_SIZE,
          height: DOT_SIZE,
          pointerEvents: 'all',
          cursor: 'grab',
          overflow: 'visible',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div
          style={{
            width: DOT_SIZE,
            height: DOT_SIZE,
            borderRadius: '50%',
            backgroundColor: highlightColor,
            opacity: 0.7,
            transition: 'opacity 0.2s, transform 0.2s',
            boxShadow: `0 0 0 2px rgba(255,255,255,0.8), 0 1px 3px rgba(0,0,0,0.15)`,
          }}
        />
      </HTMLContainer>
    )
  }

  // Expanded: note card
  return (
    <HTMLContainer
      style={{
        width: shape.props.w,
        height: shape.props.h,
        pointerEvents: 'all',
        overflow: 'visible',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: 'var(--color-background, #fff)',
          border: `2px solid ${highlightColor}`,
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
        }}
      >
        {/* Header with dot + collapse button */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 8px',
            borderBottom: `1px solid color-mix(in srgb, ${highlightColor} 25%, transparent)`,
            cursor: 'pointer',
          }}
          onPointerDown={handleToggle}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: highlightColor,
              flexShrink: 0,
            }}
          />
          <span style={{
            fontSize: 10,
            color: 'var(--color-text-1, #999)',
            flex: 1,
          }}>
            annotation
          </span>
          <span style={{
            fontSize: 12,
            color: 'var(--color-text-1, #999)',
            cursor: 'pointer',
            lineHeight: 1,
          }}>
            {'\u2715'}
          </span>
        </div>
        {/* Body text */}
        <div
          style={{
            flex: 1,
            padding: '6px 10px',
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--color-text, #222)',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
          onPointerDown={stopEventPropagation}
        >
          {text || '(empty)'}
        </div>
      </div>
    </HTMLContainer>
  )
}
