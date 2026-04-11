/**
 * FleetHUD — toggle pill in bottom-left that expands to show fleet shapes
 * region (chat + agents) via CanvasClipPanel.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor, TLShapeId } from 'tldraw'
import { createShapeId } from 'tldraw'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { useFleetAgents } from '../fleet-data-adapter'
import { dropGhostState, dropGhostBus } from '../shapes/FleetPillShape'
import './FleetHUD.css'

const FLEET_SHAPE_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search']

/** Transient proxy shape created on the main editor during layout mode.
 *  Exported so CanvasClipPanel can filter it out of the HUD mirror. */
export const HUD_PROXY_SHAPE_ID: TLShapeId = createShapeId('fleet-hud-proxy')

/** HUD geometry override — mixed-unit. Horizontal is a canvas-space anchor
 *  (so the HUD pans with the doc); vertical + size are screen pixels (so the
 *  HUD stays at a fixed screen row and doesn't resize on zoom). */
interface HudOverride {
  canvasX: number
  screenY: number
  screenW: number
  screenH: number
}

function loadHudOverride(): HudOverride | null {
  try {
    const raw = localStorage.getItem('fleet-hud-override')
    if (!raw) return null
    const v = JSON.parse(raw)
    if (
      typeof v?.canvasX === 'number' &&
      typeof v?.screenY === 'number' &&
      typeof v?.screenW === 'number' &&
      typeof v?.screenH === 'number'
    ) {
      return v as HudOverride
    }
    return null
  } catch { return null }
}

function saveHudOverride(o: HudOverride) {
  localStorage.setItem('fleet-hud-override', JSON.stringify(o))
}

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
    const bounds = editor.getShapePageBounds(s.id)
    if (!bounds) continue
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.w)
    maxY = Math.max(maxY, bounds.y + bounds.h)
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

/** Ghost rect shown over the empty slot when dragging a pill over bare canvas */
function FleetDropGhost({ mainEditor }: { mainEditor: Editor }) {
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  useEffect(() => {
    const handler = () => {
      const slot = dropGhostState.slot
      if (!slot) { setGhost(null); return }
      const tl = mainEditor.pageToScreen({ x: slot.x, y: slot.y })
      const br = mainEditor.pageToScreen({ x: slot.x + slot.w, y: slot.y + slot.h })
      setGhost({ x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y })
    }
    dropGhostBus.addEventListener('change', handler)
    return () => { dropGhostBus.removeEventListener('change', handler); setGhost(null) }
  }, [mainEditor])

  if (!ghost) return null
  return (
    <div
      className="fleet-drop-ghost"
      style={{ left: ghost.x, top: ghost.y, width: ghost.w, height: ghost.h }}
    />
  )
}

export function FleetHUD({
  mainEditor,
  shapeUtils,
  tools,
  licenseKey,
}: FleetHUDProps) {
  const [expanded, setExpanded] = useState(() => localStorage.getItem('fleet-hud-expanded') === '1')
  const [fleetBounds, setFleetBounds] = useState<ClipBounds | null>(() => getFleetBounds(mainEditor))
  const [hudOverride, setHudOverride] = useState<HudOverride | null>(loadHudOverride)
  const [layoutMode, setLayoutMode] = useState(false)
  // Camera tick used to recompute canvas→screen for the render on camera change
  const [cameraTick, setCameraTick] = useState(0)
  const agents = useFleetAgents()
  const hudRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // Reactively update fleet bounds when shapes change.
  // Position updates: freeze during drag, recalculate on pointerup only.
  // This prevents the auto-zoom panel from resizing mid-drag.
  useEffect(() => {
    setFleetBounds(getFleetBounds(mainEditor))

    const unsub = mainEditor.store.listen(({ changes }) => {
      const isFleetChange = (record: any) =>
        record.typeName === 'shape' && FLEET_SHAPE_TYPES.includes(record.type)

      // Immediate: add/remove always recalculates
      const hasAddOrRemove =
        Object.values(changes.added).some(isFleetChange) ||
        Object.values(changes.removed).some(isFleetChange)

      if (hasAddOrRemove) {
        draggingRef.current = false
        setFleetBounds(getFleetBounds(mainEditor))
        return
      }

      // Position/size updates: mark as dragging, recalc on pointerup
      const hasUpdate = Object.values(changes.updated)
        .some(([from, to]) => isFleetChange(from) || isFleetChange(to))

      if (hasUpdate) {
        draggingRef.current = true
      }
    }, { source: 'all', scope: 'document' })

    const handlePointerUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false
        setFleetBounds(getFleetBounds(mainEditor))
      }
    }
    window.addEventListener('pointerup', handlePointerUp, true)

    return () => {
      unsub()
      window.removeEventListener('pointerup', handlePointerUp, true)
    }
  }, [mainEditor])

  // When HUD is expanded, add a body class so CSS can hide fleet shapes in the
  // main canvas — avoids the "two copies" issue where both the HUD and main
  // canvas show the same shapes simultaneously.
  useEffect(() => {
    if (expanded && fleetBounds) {
      document.body.classList.add('fleet-hud-open')
    } else {
      document.body.classList.remove('fleet-hud-open')
    }
    return () => document.body.classList.remove('fleet-hud-open')
  }, [expanded, fleetBounds])

  const aliveCount = useMemo(() => {
    return agents.filter((a: any) => !a.dead && !a.human).length
  }, [agents])

  // Track camera so render recomputes canvas→screen projection for HUD x.
  // We poll via rAF because tldraw camera changes don't fire store listeners
  // on the same scope we care about.
  useEffect(() => {
    if (!expanded) return
    let rafId: number
    let lastCamX = mainEditor.getCamera().x
    let lastCamZ = mainEditor.getCamera().z
    const poll = () => {
      const cam = mainEditor.getCamera()
      if (cam.x !== lastCamX || cam.z !== lastCamZ) {
        lastCamX = cam.x
        lastCamZ = cam.z
        setCameraTick(t => t + 1)
      }
      rafId = requestAnimationFrame(poll)
    }
    rafId = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(rafId)
  }, [mainEditor, expanded])

  // Layout mode entry — create proxy on main, snapshot baselines, subscribe
  // to proxy changes for live anisotropic fan-out to every fleet shape.
  const handleLayoutEnter = useCallback(() => {
    if (layoutMode || !fleetBounds) return

    // Compute the HUD's current canvas rect (same projection logic as render)
    const cam = mainEditor.getCamera()
    const fbRight = (fleetBounds.x + fleetBounds.w + cam.x) * cam.z
    const autoScreenH = window.innerHeight * 0.8
    const autoZoom = autoScreenH / fleetBounds.h
    const autoScreenW = fleetBounds.w * autoZoom
    const curCanvasX = hudOverride?.canvasX ?? (fbRight - autoScreenW) / cam.z - cam.x
    const curScreenY = hudOverride?.screenY ?? (window.innerHeight - autoScreenH) / 2
    const curScreenW = hudOverride?.screenW ?? autoScreenW
    const curScreenH = hudOverride?.screenH ?? autoScreenH

    // Translate to canvas coords for the proxy shape (which lives on main)
    const canvasX = curCanvasX
    const canvasY = curScreenY / cam.z - cam.y
    const canvasW = curScreenW / cam.z
    const canvasH = curScreenH / cam.z

    // Snapshot baseline rects for every fleet shape on main — we fan out
    // the anisotropic rescale relative to these.
    const fleetShapes = mainEditor.getCurrentPageShapes()
      .filter(s => FLEET_SHAPE_TYPES.includes(s.type as string))
    const baselineMap = new Map<string, { x: number; y: number; w: number; h: number; type: string }>()
    for (const s of fleetShapes) {
      const w = (s as any).props?.w as number | undefined
      const h = (s as any).props?.h as number | undefined
      if (typeof w !== 'number' || typeof h !== 'number') continue
      baselineMap.set(s.id as string, { x: s.x, y: s.y, w, h, type: s.type as string })
    }
    const baselineProxy = { x: canvasX, y: canvasY, w: canvasW, h: canvasH }
    const prevTool = mainEditor.getCurrentToolId()

    // Create or replace the transient proxy shape on main.
    // fill: 'solid' + opacity: 0 keeps it invisible but hit-testable.
    // bringToFront makes tldraw's hit test route interior pointerdowns to
    // the proxy rather than the fleet shapes behind it.
    try { mainEditor.deleteShape(HUD_PROXY_SHAPE_ID) } catch { /* not present */ }
    mainEditor.createShape({
      id: HUD_PROXY_SHAPE_ID,
      type: 'geo',
      x: canvasX,
      y: canvasY,
      opacity: 0,
      props: { w: canvasW, h: canvasH, geo: 'rectangle', fill: 'solid', color: 'grey', dash: 'solid' },
    })
    mainEditor.updateShapes([{ id: HUD_PROXY_SHAPE_ID, type: 'geo', isLocked: false }] as any)
    mainEditor.bringToFront([HUD_PROXY_SHAPE_ID])
    mainEditor.setCurrentTool('select')
    mainEditor.select(HUD_PROXY_SHAPE_ID)

    hudRef.current?.classList.add('fleet-hud-layout-mode')
    layoutStateRef.current = { baselineMap, baselineProxy, prevTool }
    setLayoutMode(true)
  }, [layoutMode, fleetBounds, hudOverride, mainEditor])

  // Layout mode state kept in a ref so the store listener (registered once
  // on entry) can read the latest baselines without re-subscribing.
  const layoutStateRef = useRef<{
    baselineMap: Map<string, { x: number; y: number; w: number; h: number; type: string }>
    baselineProxy: { x: number; y: number; w: number; h: number }
    prevTool: string
  } | null>(null)

  const handleLayoutExit = useCallback(() => {
    if (!layoutStateRef.current) return
    const { prevTool } = layoutStateRef.current
    // Commit in-memory override (already up-to-date from drag) to localStorage
    const current = hudOverrideRef.current
    if (current) saveHudOverride(current)
    try { mainEditor.deleteShape(HUD_PROXY_SHAPE_ID) } catch { /* already gone */ }
    try { mainEditor.setCurrentTool(prevTool) } catch { /* tool may not exist */ }
    hudRef.current?.classList.remove('fleet-hud-layout-mode')
    layoutStateRef.current = null
    setLayoutMode(false)
  }, [mainEditor])

  // Mirror hudOverride state in a ref so exit can read the latest committed
  // value without depending on React state timing.
  const hudOverrideRef = useRef<HudOverride | null>(hudOverride)
  useEffect(() => { hudOverrideRef.current = hudOverride }, [hudOverride])

  // Live fan-out during layout mode: watch proxy changes and the selection
  // state so we can rescale fleet shapes + detect exit (proxy deselected).
  useEffect(() => {
    if (!layoutMode) return

    const unsub = mainEditor.store.listen(({ changes }) => {
      const state = layoutStateRef.current
      if (!state) return
      let proxyUpdated: any = null
      let deselected = false
      for (const [, to] of Object.values(changes.updated)) {
        const rec: any = to
        if (rec.id === HUD_PROXY_SHAPE_ID && rec.typeName === 'shape') {
          proxyUpdated = rec
        } else if (rec.typeName === 'instance_page_state') {
          const selIds = rec.selectedShapeIds as string[]
          if (!selIds.includes(HUD_PROXY_SHAPE_ID as string)) deselected = true
        }
      }

      if (proxyUpdated) {
        const p = proxyUpdated
        const b = state.baselineProxy
        const sx = p.props.w / b.w
        const sy = p.props.h / b.h
        const updates: any[] = []
        for (const [id, baseline] of state.baselineMap) {
          updates.push({
            id,
            type: baseline.type,
            x: p.x + (baseline.x - b.x) * sx,
            y: p.y + (baseline.y - b.y) * sy,
            props: {
              w: Math.max(1, baseline.w * sx),
              h: Math.max(1, baseline.h * sy),
            },
          })
        }
        if (updates.length > 0) {
          mainEditor.updateShapes(updates)
        }
        // Update in-memory HudOverride so the HUD wrap follows in real time
        const cam = mainEditor.getCamera()
        const next: HudOverride = {
          canvasX: p.x,
          screenY: (p.y + cam.y) * cam.z,
          screenW: p.props.w * cam.z,
          screenH: p.props.h * cam.z,
        }
        hudOverrideRef.current = next
        setHudOverride(next)
      }

      if (deselected) {
        // Defer to next tick so we don't tear down mid-listener
        queueMicrotask(() => handleLayoutExit())
      }
    }, { source: 'all', scope: 'all' })

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        handleLayoutExit()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => {
      unsub()
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [layoutMode, mainEditor, handleLayoutExit])

  // Don't render if no fleet shapes
  if (!fleetBounds) return null

  const ghost = <FleetDropGhost mainEditor={mainEditor} />

  // Collapsed: just the pill
  if (!expanded) {
    return (
      <>
        {ghost}
        <div className="fleet-pill-container">
          <span
            className="fleet-pill"
            onClick={() => { setExpanded(true); localStorage.setItem('fleet-hud-expanded', '1') }}
            onPointerDown={e => e.stopPropagation()}
          >
            {aliveCount > 0 ? `${aliveCount} agent${aliveCount !== 1 ? 's' : ''}` : 'Fleet'}
          </span>
        </div>
      </>
    )
  }

  // Expanded: CanvasClipPanel with fleet region.
  //
  // Geometry rules:
  //   - If HudOverride is set, render at (canvasX projected to screen x,
  //     screenY, screenW, screenH). Pan horizontally → HUD slides; pan
  //     vertically / zoom → HUD y/size unchanged.
  //   - Otherwise, fall back to the auto layout: right-anchored to fleet
  //     bounding box, 80% of window height, vertically centered.
  //
  // cameraTick participates in the dependency-less inline calculation so
  // the component re-renders on pan/zoom.
  void cameraTick
  const cam = mainEditor.getCamera()
  const autoScreenH = window.innerHeight * 0.8
  const autoZoom = autoScreenH / fleetBounds.h
  const autoScreenW = fleetBounds.w * autoZoom
  const fbRight = (fleetBounds.x + fleetBounds.w + cam.x) * cam.z

  const panelLeft = hudOverride
    ? (hudOverride.canvasX + cam.x) * cam.z
    : fbRight - autoScreenW
  const panelTop = hudOverride?.screenY ?? (window.innerHeight - autoScreenH) / 2
  const panelWidth = hudOverride?.screenW ?? autoScreenW
  const panelHeight = hudOverride?.screenH ?? autoScreenH

  return (
    <>
      {ghost}
      <div
        className="fleet-hud-wrap"
        ref={hudRef}
        style={{ left: panelLeft, top: panelTop, width: panelWidth, height: panelHeight }}
      >
        <div className="fleet-hud-controls">
          <button
            className={`fleet-hud-layout${layoutMode ? ' active' : ''}`}
            onClick={layoutMode ? handleLayoutExit : handleLayoutEnter}
            title={layoutMode ? 'Exit layout mode (click or Esc)' : 'Move / resize HUD'}
          >
            ⊞
          </button>
          <button
            className="fleet-hud-close"
            onClick={() => { setExpanded(false); localStorage.setItem('fleet-hud-expanded', '0') }}
            title="Collapse"
          >
            ×
          </button>
        </div>
        <CanvasClipPanel
          mainEditor={mainEditor}
          bounds={fleetBounds}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={licenseKey}
          panelWidth={panelWidth}
          maxHeightFraction={1}
          lockCamera={true}
          className="fleet-hud"
        />
      </div>
    </>
  )
}
