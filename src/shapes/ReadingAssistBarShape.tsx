/**
 * ReadingAssistBarShape — thin vertical margin bar indicating an agent response to a highlight.
 *
 * Appears in the right margin (configurable for lefties), spanning the height of the
 * associated highlight. Color matches the highlight. Desaturates when addressed.
 * Click/tap opens an inline popover showing the response text.
 *
 * Props:
 *   - w/h: dimensions (thin bar)
 *   - highlightId: ID of the associated highlight shape
 *   - responseId: ID of the agent's response annotation (math-note)
 *   - color: tldraw color name matching the highlight
 *
 * Meta:
 *   - addressed: boolean — when true, renders at 30% opacity (desaturated)
 *   - fleet_id: string — agent identity
 *   - friendly_name: string — agent display name
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  DefaultColorStyle,
  useEditor,
  stopEventPropagation,
} from 'tldraw'
import { useState, useEffect, useCallback } from 'react'

// Color hex values matching tldraw's highlight colors
const COLOR_HEX: Record<string, string> = {
  'yellow': '#ffc940',
  'light-green': '#65c365',
  'light-blue': '#4ea2e2',
  'light-violet': '#7c3aed',
  'orange': '#ff8c40',
  'red': '#dc2626',
  'green': '#16a34a',
  'blue': '#2563eb',
  'violet': '#7c3aed',
  'grey': '#6b7280',
  'black': '#374151',
}

export class ReadingAssistBarShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'reading-assist-bar' as const
  static override props = {
    w: T.number,
    h: T.number,
    highlightId: T.string,
    responseId: T.string,
    color: DefaultColorStyle,
  }

  getDefaultProps() {
    return { w: 6, h: 100, highlightId: '', responseId: '', color: 'yellow' as const }
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
    const addressed = shape.meta?.addressed === true
    const color = COLOR_HEX[shape.props.color] || COLOR_HEX['yellow']
    const [popoverOpen, setPopoverOpen] = useState(false)
    const [responseText, setResponseText] = useState('')
    const [responseName, setResponseName] = useState('')

    const handleBarClick = useCallback((e: React.PointerEvent) => {
      stopEventPropagation(e)
      const responseId = shape.props.responseId
      if (!responseId) return

      const responseShape = editor.getShape(responseId as any)
      if (!responseShape) return

      const text = (responseShape.props as any)?.text || ''
      const name = (responseShape.meta as any)?.friendly_name || ''
      setResponseText(text)
      setResponseName(name)
      setPopoverOpen(!popoverOpen)
    }, [editor, shape.props.responseId, popoverOpen])

    const handleResolve = useCallback((e: React.PointerEvent) => {
      stopEventPropagation(e)
      // Mark the highlight as addressed
      const highlightId = shape.props.highlightId
      if (highlightId) {
        const hlShape = editor.getShape(highlightId as any)
        if (hlShape) {
          editor.store.update(highlightId as any, (s: any) => ({
            ...s,
            opacity: 0.3,
            meta: { ...s.meta, addressed: true },
          }))
        }
      }
      // Mark the bar as addressed
      editor.store.update(shape.id, (s: any) => ({
        ...s,
        meta: { ...s.meta, addressed: true },
      }))
      setPopoverOpen(false)
    }, [editor, shape.id, shape.props.highlightId])

    // Close popover on outside click
    useEffect(() => {
      if (!popoverOpen) return
      const dismiss = (e: PointerEvent) => {
        const target = e.target as HTMLElement
        if (target?.closest?.('[data-reading-assist-popover]')) return
        setPopoverOpen(false)
      }
      document.addEventListener('pointerdown', dismiss, true)
      return () => document.removeEventListener('pointerdown', dismiss, true)
    }, [popoverOpen])

    return (
      <HTMLContainer
        style={{
          width: '100%',
          height: '100%',
          pointerEvents: 'all',
          cursor: 'pointer',
          overflow: 'visible',
        }}
        onPointerDown={handleBarClick}
      >
        {/* The bar itself */}
        <div
          style={{
            width: '100%',
            height: '100%',
            backgroundColor: color,
            borderRadius: 3,
            opacity: addressed ? 0.3 : 0.8,
            transition: 'opacity 0.3s ease',
          }}
        />
        {/* Response popover — expands leftward from the bar */}
        {popoverOpen && responseText && (
          <div
            data-reading-assist-popover
            onPointerDown={stopEventPropagation}
            style={{
              position: 'absolute',
              right: 10,
              top: 0,
              width: 220,
              maxHeight: 200,
              backgroundColor: 'var(--color-background, #fff)',
              border: `2px solid ${color}`,
              borderRadius: 6,
              padding: '8px 10px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              fontSize: 13,
              lineHeight: 1.4,
              overflow: 'auto',
              zIndex: 10,
            }}
          >
            {responseName && (
              <div style={{
                fontSize: 10,
                color: 'var(--color-text-1, #666)',
                textAlign: 'right',
                marginBottom: 4,
              }}>
                {responseName}
              </div>
            )}
            <div style={{ color: 'var(--color-text, #222)', whiteSpace: 'pre-wrap' }}>
              {responseText.length > 300 ? responseText.slice(0, 300) + '...' : responseText}
            </div>
            <div style={{ marginTop: 8, textAlign: 'right' }}>
              <button
                onPointerDown={handleResolve}
                style={{
                  background: 'none',
                  border: `1px solid ${color}`,
                  borderRadius: 4,
                  padding: '3px 8px',
                  fontSize: 11,
                  cursor: 'pointer',
                  color: 'var(--color-text, #333)',
                }}
              >
                {'\u2713'} resolved
              </button>
            </div>
          </div>
        )}
      </HTMLContainer>
    )
  }

  indicator() {
    return null as any
  }
}
