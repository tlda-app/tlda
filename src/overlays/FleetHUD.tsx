/**
 * FleetHUD — floating panel that shows the fleet shapes region (chat + agents)
 * when the camera is zoomed into the paper, away from fleet shapes.
 *
 * Uses CanvasClipPanel (same primitive as RefViewer / ProofStatementOverlay)
 * to render a copy-store view of the fleet region.
 */
import { useEffect, useMemo, useState, useCallback } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { useFleetAgents } from '../fleet-data-adapter'
import './FleetHUD.css'

const FLEET_SHAPE_TYPES = ['fleet-chat', 'fleet-agents']
const HUD_WIDTH = 360
const VISIBILITY_MARGIN = 200 // px of screen overlap before hiding

interface FleetHUDProps {
  mainEditor: Editor
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
}

function getFleetBounds(editor: Editor): ClipBounds | null {
  const shapes = editor.getCurrentPageShapes()
    .filter(s => FLEET_SHAPE_TYPES.includes(s.type as string))
  if (shapes.length === 0) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of shapes) {
    const geo = editor.getShapeGeometry(s)
    if (!geo) continue
    minX = Math.min(minX, s.x)
    minY = Math.min(minY, s.y)
    maxX = Math.max(maxX, s.x + geo.bounds.w)
    maxY = Math.max(maxY, s.y + geo.bounds.h)
  }
  if (!isFinite(minX)) return null

  const PAD = 20
  return {
    x: minX - PAD,
    y: minY - PAD,
    w: maxX - minX + PAD * 2,
    h: maxY - minY + PAD * 2,
  }
}

function isFleetVisible(editor: Editor, fleetBounds: ClipBounds): boolean {
  const vp = editor.getViewportScreenBounds()
  const cam = editor.getCamera()
  // Convert viewport screen bounds to page coordinates
  const vpLeft = -cam.x
  const vpTop = -cam.y
  const vpRight = vpLeft + vp.w / cam.z
  const vpBottom = vpTop + vp.h / cam.z

  const fRight = fleetBounds.x + fleetBounds.w
  const fBottom = fleetBounds.y + fleetBounds.h

  // Check if viewport overlaps with fleet region (with margin in page coords)
  const margin = VISIBILITY_MARGIN / cam.z
  return (
    vpLeft < fRight + margin &&
    vpRight > fleetBounds.x - margin &&
    vpTop < fBottom + margin &&
    vpBottom > fleetBounds.y - margin
  )
}

export function FleetHUD({
  mainEditor,
  shapeUtils,
  tools,
  licenseKey,
}: FleetHUDProps) {
  const [dismissed, setDismissed] = useState(false)
  const [cameraVisible, setCameraVisible] = useState(true)
  const agents = useFleetAgents()

  // Compute fleet shape bounds
  const fleetBounds = useMemo(() => {
    return getFleetBounds(mainEditor)
  }, [mainEditor])

  // Track camera position to show/hide HUD
  useEffect(() => {
    if (!fleetBounds) return

    const check = () => {
      setCameraVisible(isFleetVisible(mainEditor, fleetBounds))
    }
    check()

    // Listen for camera changes
    const unsub = mainEditor.store.listen(({ changes }) => {
      for (const [, to] of Object.values(changes.updated)) {
        if ((to as any).typeName === 'camera') {
          check()
          return
        }
      }
    }, { source: 'all', scope: 'session' })

    return unsub
  }, [mainEditor, fleetBounds])

  const aliveCount = useMemo(() => {
    return agents.filter((a: any) => !a.dead && !a.human).length
  }, [agents])

  // Don't render if no fleet shapes or dismissed
  if (!fleetBounds || dismissed) return null

  return (
    <div className="fleet-hud-wrap" onWheel={(e) => e.stopPropagation()}>
      <CanvasClipPanel
        mainEditor={mainEditor}
        bounds={fleetBounds}
        shapeUtils={shapeUtils}
        tools={tools}
        licenseKey={licenseKey}
        panelWidth={800}
        maxHeightFraction={1.0}
        lockCamera={true}
        className="fleet-hud"
      >
        <div className="fleet-hud-label">
          <span className="fleet-hud-title">fleet</span>
          <span className="fleet-hud-count">{aliveCount} online</span>
          <button
            className="fleet-hud-close"
            onClick={() => setDismissed(true)}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      </CanvasClipPanel>
    </div>
  )
}
