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
  chipRect?: { left: number; top: number; right: number; bottom: number; width: number; height: number }
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
  const clickStartRef = useRef<{ x: number; y: number } | null>(null)

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
        chipRect: detail.chipRect,
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

  // Click-to-pin: track pointerdown/pointerup, if < 5px movement → pin
  // Passive capture listeners so tldraw still gets events for panning
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = canvasWrapRef.current
    if (!el || !data) return
    const onDown = (e: PointerEvent) => {
      clickStartRef.current = { x: e.clientX, y: e.clientY }
    }
    const onUp = (e: PointerEvent) => {
      if (!clickStartRef.current) return
      const dx = e.clientX - clickStartRef.current.x
      const dy = e.clientY - clickStartRef.current.y
      clickStartRef.current = null
      if (Math.sqrt(dx * dx + dy * dy) < 5) {
        setState(cur => cur === 'hovering' ? 'pinned' : cur)
      }
    }
    el.addEventListener('pointerdown', onDown, { capture: true })
    el.addEventListener('pointerup', onUp, { capture: true })
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true })
      el.removeEventListener('pointerup', onUp, { capture: true })
    }
  }, [data])

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

  // Position on top of the chip — viewer overlaps, chip roughly centered vertically.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const totalH = size.h
  const chip = data.chipRect
  let left: number
  let top: number
  if (chip) {
    // Horizontal: align left edge with chip, clamp to viewport
    left = chip.left
    if (left + size.w > vw - 8) left = vw - size.w - 8
    if (left < 8) left = 8
    // Vertical: center viewer on chip, clamp to viewport
    const chipMid = chip.top + chip.height / 2
    top = chipMid - totalH / 2
    if (top < 8) top = 8
    if (top + totalH > vh - 8) top = vh - totalH - 8
  } else {
    // Fallback: center of viewport
    left = (vw - size.w) / 2
    top = (vh - totalH) / 2
  }

  return (
    <div
      className={`annotation-viewer annotation-viewer--${state}`}
      style={{ width: size.w, position: 'fixed', left, top, zIndex: 9999, pointerEvents: 'auto' }}
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
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Canvas — read-only, full page width, click anywhere to pin */}
      <div ref={canvasWrapRef} className="annotation-viewer-canvas" style={{ height: size.h }}>
        <CanvasClipPanel
          mainEditor={mainEditor}
          bounds={{
            x: 0,
            y: data.bounds.y - 200,
            w: 800,
            h: 1035,
          }}
          shapeUtils={shapeUtils}
          tools={[]}
          licenseKey={licenseKey}
          panelWidth={size.w}
          maxHeightFraction={0.5}
          emphasizeShapeIds={data.shapeIds}
          readOnly
          className="annotation-viewer-clip"
        />
      </div>

      {/* Nav buttons — positioned on top of the canvas */}
      {isPinnedOrNav && (
        <>
          <button
            className="annotation-viewer-nav-btn annotation-viewer-nav-left"
            onClick={state === 'pinned' ? handleGo : handleBack}
          >
            <svg width="250" height="250" viewBox="0 0 250 250">
              {state === 'pinned' ? (
                <path d="M12 125 H238 M170 12 L238 125 L170 238" fill="none" stroke="currentColor"
                  strokeWidth="48" strokeLinecap="square" strokeLinejoin="miter" />
              ) : (
                <path d="M238 125 H12 M80 12 L12 125 L80 238" fill="none" stroke="currentColor"
                  strokeWidth="48" strokeLinecap="square" strokeLinejoin="miter" />
              )}
            </svg>
          </button>

          <button
            className="annotation-viewer-nav-btn annotation-viewer-nav-right"
            onClick={handleClose}
          >
            <svg width="250" height="250" viewBox="0 0 250 250">
              <path d="M12 12 L238 238 M238 12 L12 238" fill="none" stroke="currentColor"
                strokeWidth="48" strokeLinecap="square" />
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
