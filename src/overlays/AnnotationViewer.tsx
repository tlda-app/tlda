/**
 * AnnotationViewer — hover/pinnable canvas viewer for annotation ref-chips.
 *
 * States:
 * 1. Hovering — preview shown, dismiss on mouseleave
 * 2. Pinned — resizable, pannable, X to close
 * 3. Navigated — becomes a back button (translucent arrow overlay)
 *
 * Rendered in bottomPanelsContent alongside RefViewer.
 * Triggered by custom DOM events from FleetChatShape ref-chip hover.
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import './AnnotationViewer.css'

type ViewerState = 'hovering' | 'pinned' | 'navigated'

interface AnnotationViewerProps {
  mainEditor: Editor
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
}

interface ViewerData {
  bounds: ClipBounds
  shapeId?: string
  label?: string
  color?: string
}

export function AnnotationViewer({
  mainEditor,
  shapeUtils,
  tools,
  licenseKey,
}: AnnotationViewerProps) {
  const [data, setData] = useState<ViewerData | null>(null)
  const [state, setState] = useState<ViewerState>('hovering')
  const [size, setSize] = useState({ w: 500, h: 300 })
  const prevCameraRef = useRef<{ x: number; y: number; z: number } | null>(null)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Listen for show/hide events from FleetChatShape
  useEffect(() => {
    function onShow(e: Event) {
      const detail = (e as CustomEvent).detail
      if (!detail?.bounds) return
      setData({
        bounds: detail.bounds,
        shapeId: detail.shapeId,
        label: detail.label,
        color: detail.color,
      })
      setState('hovering')
      prevCameraRef.current = null
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    }
    function onHide() {
      // Only auto-hide when hovering (not pinned/navigated)
      dismissTimerRef.current = setTimeout(() => {
        setState(cur => {
          if (cur === 'hovering') {
            setData(null)
            return 'hovering'
          }
          return cur
        })
      }, 200)
    }
    function onCancelHide() {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    }
    window.addEventListener('annotation-viewer-show', onShow)
    window.addEventListener('annotation-viewer-hide', onHide)
    window.addEventListener('annotation-viewer-cancel-hide', onCancelHide)
    return () => {
      window.removeEventListener('annotation-viewer-show', onShow)
      window.removeEventListener('annotation-viewer-hide', onHide)
      window.removeEventListener('annotation-viewer-cancel-hide', onCancelHide)
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    }
  }, [])

  // Pin on click
  const handleClick = useCallback(() => {
    if (state === 'hovering') {
      setState('pinned')
    }
  }, [state])

  // Navigate on double-click: vertical only, maintain x
  const handleDoubleClick = useCallback(() => {
    if (state !== 'pinned' || !data) return
    const cam = mainEditor.getCamera()
    prevCameraRef.current = { x: cam.x, y: cam.y, z: cam.z }
    // Navigate to annotation bounds — vertical only
    const targetY = -(data.bounds.y - 100) // show annotation near top with some padding
    mainEditor.setCamera(
      { x: cam.x, y: targetY, z: cam.z },
      { animation: { duration: 300 } }
    )
    setState('navigated')
  }, [state, data, mainEditor])

  // Go back
  const handleBack = useCallback(() => {
    if (state !== 'navigated' || !prevCameraRef.current) return
    mainEditor.setCamera(prevCameraRef.current, { animation: { duration: 300 } })
    prevCameraRef.current = null
    setState('pinned')
  }, [state, mainEditor])

  // Close
  const handleClose = useCallback(() => {
    setData(null)
    setState('hovering')
    prevCameraRef.current = null
  }, [])

  // Resize drag
  const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null)
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h }
    const onMove = (ev: PointerEvent) => {
      if (!resizeRef.current) return
      const dw = ev.clientX - resizeRef.current.startX
      const dh = ev.clientY - resizeRef.current.startY
      setSize({
        w: Math.max(300, resizeRef.current.startW + dw),
        h: Math.max(200, resizeRef.current.startH + dh),
      })
    }
    const onUp = () => {
      resizeRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [size])

  if (!data) return null

  return (
    <div
      className={`annotation-viewer annotation-viewer--${state}`}
      style={{ width: size.w }}
      onMouseEnter={() => {
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
      }}
      onMouseLeave={() => {
        if (state === 'hovering') {
          dismissTimerRef.current = setTimeout(() => {
            setData(null)
            setState('hovering')
          }, 200)
        }
      }}
      onClick={state === 'navigated' ? handleBack : handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {/* Label bar */}
      <div className="annotation-viewer-label">
        {data.color && (
          <span className="annotation-viewer-dot" style={{ background: data.color }} />
        )}
        <span className="annotation-viewer-title">
          {data.label || 'Annotation'}
        </span>
        <span className="annotation-viewer-spacer" />
        {state === 'pinned' && (
          <span className="annotation-viewer-hint">double-click to go</span>
        )}
        {(state === 'pinned' || state === 'navigated') && (
          <button
            className="annotation-viewer-close"
            onClick={(e) => { e.stopPropagation(); handleClose() }}
          >
            ×
          </button>
        )}
      </div>

      {/* Canvas */}
      <div className="annotation-viewer-canvas" style={{ height: size.h }}>
        <CanvasClipPanel
          mainEditor={mainEditor}
          bounds={data.bounds}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={licenseKey}
          panelWidth={size.w}
          maxHeightFraction={0.5}
          className="annotation-viewer-clip"
        />
      </div>

      {/* Back button overlay — translucent gray with arrow */}
      {state === 'navigated' && (
        <div className="annotation-viewer-back-overlay">
          <svg width="48" height="48" viewBox="0 0 48 48">
            <path
              d="M30 12 L18 24 L30 36"
              fill="none"
              stroke="white"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}

      {/* Resize handle */}
      {state === 'pinned' && (
        <div
          className="annotation-viewer-resize"
          onPointerDown={handleResizeStart}
        />
      )}
    </div>
  )
}
