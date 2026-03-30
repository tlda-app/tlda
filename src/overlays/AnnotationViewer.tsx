/**
 * AnnotationViewer — hover/pinnable canvas viewer for annotation ref-chips.
 *
 * States:
 * 1. Hovering — preview shown, dismiss on mouseleave
 * 2. Pinned — faint forward arrow (top-left) + × (top-right) overlaid
 * 3. Navigated — back arrow replaces forward, × stays
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
  shapeIds?: string[]
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
  const [size, setSize] = useState({ w: 650, h: 450 })
  const prevCameraRef = useRef<{ x: number; y: number; z: number } | null>(null)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Listen for show/hide events from FleetChatShape
  useEffect(() => {
    function onShow(e: Event) {
      const detail = (e as CustomEvent).detail
      if (!detail?.bounds) return
      setData({
        bounds: detail.bounds,
        shapeIds: detail.shapeIds,
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

  // Pin on click (hovering → pinned)
  const handleClick = useCallback(() => {
    if (state === 'hovering') {
      setState('pinned')
    }
  }, [state])

  // Navigate: vertical only, maintain x
  const handleGo = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!data) return
    const cam = mainEditor.getCamera()
    prevCameraRef.current = { x: cam.x, y: cam.y, z: cam.z }
    const targetY = -(data.bounds.y - 100)
    mainEditor.setCamera(
      { x: cam.x, y: targetY, z: cam.z },
      { animation: { duration: 300 } }
    )
    setState('navigated')
  }, [data, mainEditor])

  // Go back
  const handleBack = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!prevCameraRef.current) return
    mainEditor.setCamera(prevCameraRef.current, { animation: { duration: 300 } })
    prevCameraRef.current = null
    setState('pinned')
  }, [mainEditor])

  // Close
  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
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

  const isPinnedOrNav = state === 'pinned' || state === 'navigated'

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
      onClick={state === 'hovering' ? handleClick : undefined}
    >
      {/* Label bar */}
      <div className="annotation-viewer-label">
        {data.color && (
          <span className="annotation-viewer-dot" style={{ background: data.color }} />
        )}
        <span className="annotation-viewer-title">
          {data.label || 'Annotation'}
        </span>
      </div>

      {/* Canvas */}
      <div className="annotation-viewer-canvas" style={{ height: size.h }}>
        <CanvasClipPanel
          mainEditor={mainEditor}
          bounds={{
            x: data.bounds.x - 80,
            y: data.bounds.y - 120,
            w: data.bounds.w + 160,
            h: data.bounds.h + 240,
          }}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={licenseKey}
          panelWidth={size.w}
          maxHeightFraction={0.5}
          emphasizeShapeIds={data.shapeIds}
          className="annotation-viewer-clip"
        />
      </div>

      {/* Overlay buttons — faint, large, top corners */}
      {isPinnedOrNav && (
        <>
          {/* Top-left: forward (pinned) or back (navigated) */}
          <button
            className="annotation-viewer-nav-btn annotation-viewer-nav-left"
            onClick={state === 'pinned' ? handleGo : handleBack}
          >
            <svg width="48" height="48" viewBox="0 0 48 48">
              {state === 'pinned' ? (
                /* → forward arrow */
                <path d="M16 24 H32 M26 18 L32 24 L26 30" fill="none" stroke="currentColor"
                  strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                /* ← back arrow */
                <path d="M32 24 H16 M22 18 L16 24 L22 30" fill="none" stroke="currentColor"
                  strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>

          {/* Right half: close */}
          <button
            className="annotation-viewer-nav-btn annotation-viewer-nav-right"
            onClick={handleClose}
          >
            <svg width="48" height="48" viewBox="0 0 48 48">
              <path d="M16 16 L32 32 M32 16 L16 32" fill="none" stroke="currentColor"
                strokeWidth="3" strokeLinecap="round" />
            </svg>
          </button>
        </>
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
