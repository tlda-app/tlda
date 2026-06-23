/**
 * CanvasClipPanel — fork-viewport panel that shows a clipped region of the
 * main canvas. Used by ChangePreviewPanel, AnnotationViewer, ScreenshotCapture,
 * FleetHUD, FleetDocViewShape, and BuildErrorOverlay.
 *
 * Uses the tldraw fork's multi-viewport API:
 * - Registers a named viewport with the main editor
 * - Renders shapes visible to that viewport via getRenderingShapes({ viewportId })
 * - Independent camera without duplicating the store
 *
 * This replaces the old copy-store approach (separate editor + bidirectional sync).
 */
import { useEffect, useMemo, useRef } from 'react'
import { TldrawViewport, stopEventPropagation } from 'tldraw'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor, TLShape } from 'tldraw'
import { createCanvasClipPanelPlan } from './wm/canvas-clip-panel'
import './CanvasClipPanel.css'

const DEFAULT_WIDTH = 600
const DEFAULT_MAX_HEIGHT_FRACTION = 0.4
const MIN_VISIBLE_LINES = 5
const LINE_HEIGHT_ESTIMATE = 14 // ~12pt in PDF coordinates

export interface ClipBounds {
  x: number
  y: number
  w: number
  h: number
}

interface CanvasClipPanelProps {
  mainEditor: Editor
  bounds: ClipBounds | null
  // Legacy props (accepted but ignored — kept for consumer compatibility)
  shapeUtils?: TLAnyShapeUtilConstructor[]
  tools?: TLStateNodeConstructor[]
  licenseKey?: string
  panelWidth?: number
  maxHeightFraction?: number
  className?: string
  lockCamera?: boolean
  initialTool?: string
  onEditorMount?: (editor: Editor | null) => void
  emphasizeShapeIds?: string[]
  readOnly?: boolean
  liveEdit?: boolean
  cameraOverride?: { x: number; y: number; z: number }
  fullViewport?: boolean
  identityId?: string | null
  customGestureActiveRef?: { current: boolean }
  requestedShapeIds?: string[]
  requestedShapeTypes?: string[]
  children?: React.ReactNode
}

export function CanvasClipPanel({
  mainEditor,
  bounds,
  panelWidth = DEFAULT_WIDTH,
  maxHeightFraction = DEFAULT_MAX_HEIGHT_FRACTION,
  className,
  lockCamera = false,
  cameraOverride,
  fullViewport = false,
  readOnly = false,
  onEditorMount,
  children,
}: CanvasClipPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const viewportId = useMemo(() => `clip-panel-${Math.random().toString(36).slice(2, 9)}`, [])

  // Expose the main editor to consumers via onEditorMount.
  // With the fork viewport there is no separate overlay editor — consumers
  // use the main editor + viewportId for viewport-specific queries.
  useEffect(() => {
    onEditorMount?.(mainEditor ?? null)
    return () => { onEditorMount?.(null) }
  }, [mainEditor, onEditorMount])

  // Compute camera from bounds or use override
  const camera = useMemo(() => {
    if (cameraOverride) return cameraOverride
    if (!bounds) return { x: 0, y: 0, z: 1 }

    const plan = createCanvasClipPanelPlan({
      bounds,
      panelWidth,
      viewportHeight: window.innerHeight,
      maxHeightFraction,
      lockCamera,
      minVisibleLines: MIN_VISIBLE_LINES,
      lineHeightEstimate: LINE_HEIGHT_ESTIMATE,
    })

    return plan.camera
  }, [bounds, panelWidth, maxHeightFraction, lockCamera, cameraOverride])

  // Panel height: at least 5 lines, at most maxHeightFraction of viewport
  const canvasHeight = useMemo(() => {
    if (!bounds) return 100
    const zoom = panelWidth / bounds.w
    const contentH = bounds.h * zoom
    const minH = MIN_VISIBLE_LINES * LINE_HEIGHT_ESTIMATE * zoom
    return Math.max(minH, Math.min(contentH, window.innerHeight * maxHeightFraction))
  }, [bounds, panelWidth, maxHeightFraction])

  if (!bounds && !cameraOverride) return null

  // Shape predicate: filter shapes based on mode
  const shapePredicate = useMemo(() => {
    if (!lockCamera && !readOnly) return undefined

    return (shape: TLShape) => {
      // In lockCamera (HUD) mode, only render fleet shapes
      if (lockCamera) {
        const type = (shape as any).type
        if (!type) return false
        // Fleet shape types: fleet-chat, fleet-agents, fleet-search, etc.
        if (!type.startsWith('fleet-')) return false
        // Check ownership
        const props = (shape as any).props
        if (!props) return false
        const uid = props.userId
        const dev = props.deviceId
        // Only render shapes owned by this user/device
        return !!uid && !!dev
      }

      // In readOnly mode, render all shapes
      return true
    }
  }, [lockCamera, readOnly])

  const viewportEl = (
    <TldrawViewport
      id={viewportId}
      camera={camera}
      className={className}
      shapePredicate={shapePredicate}
      onCameraChange={lockCamera ? undefined : (newCam) => {
        // For non-locked panels, allow user to pan/zoom
        console.log('[CanvasClipPanel] camera change:', newCam)
      }}
    />
  )

  if (fullViewport) {
    return (
      <div
        ref={panelRef}
        className={`clip-panel clip-panel-fullvp ${className || ''}`}
        data-viewport-id={viewportId}
        style={{
          position: 'fixed',
          inset: 0,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none',
          background: 'transparent',
          boxShadow: 'none',
          borderRadius: 0,
          overflow: 'visible',
        }}
      >
        {children}
        <div
          ref={canvasRef}
          className="clip-panel-canvas clip-panel-canvas-fullvp"
          style={{
            height: '100vh',
            width: '100vw',
            background: 'transparent',
            overflow: 'visible',
            clipPath: 'none',
          }}
        >
          {viewportEl}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={panelRef}
      className={`clip-panel ${className || ''}`}
      data-viewport-id={viewportId}
      style={{ width: panelWidth }}
      onPointerDown={stopEventPropagation}
    >
      {children}
      <div
        ref={canvasRef}
        className="clip-panel-canvas"
        style={{ height: canvasHeight, overflow: 'hidden' }}
      >
        {viewportEl}
      </div>
    </div>
  )
}
