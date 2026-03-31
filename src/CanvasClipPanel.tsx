/**
 * CanvasClipPanel — shared copy-store TLDraw panel that shows a clipped
 * region of the main canvas. Used by ProofStatementOverlay, RefViewer,
 * and ChangePreviewPanel.
 *
 * Creates a one-way synced copy of the main editor's store and constrains
 * the camera to show only the specified bounds region.
 *
 * Label bar content is passed as children — each consumer renders its own
 * buttons and title.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Tldraw, createTLStore, stopEventPropagation } from 'tldraw'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor, TLRecord } from 'tldraw'
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
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
  panelWidth?: number
  maxHeightFraction?: number
  className?: string
  lockCamera?: boolean
  initialTool?: string
  onEditorMount?: (editor: Editor | null) => void
  children?: React.ReactNode
}

export function CanvasClipPanel({
  mainEditor,
  bounds,
  shapeUtils,
  tools,
  licenseKey,
  panelWidth = DEFAULT_WIDTH,
  maxHeightFraction = DEFAULT_MAX_HEIGHT_FRACTION,
  className,
  lockCamera = false,
  initialTool = 'select',
  onEditorMount,
  children,
}: CanvasClipPanelProps) {
  const [editor, setEditor] = useState<Editor | null>(null)

  // Expose editor to parent
  useEffect(() => {
    onEditorMount?.(editor)
  }, [editor, onEditorMount])

  // Enable snapping in locked-camera mode (HUD fleet shape arrangement)
  useEffect(() => {
    if (!editor || !lockCamera) return
    editor.user.updateUserPreferences({ isSnapMode: true })
  }, [editor, lockCamera])

  // Create copy store from main editor's document records
  const store = useMemo(() => {
    const allRecords = mainEditor.store.allRecords()
    const docRecords = allRecords.filter(isDocRecord)
      .map(r => lockCamera ? unlockFleetShape(r) : r)
    const s = createTLStore({ shapeUtils })
    s.mergeRemoteChanges(() => { s.put(docRecords) })
    return s
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Bidirectional sync: main store ↔ copy store (document records only)
  useEffect(() => {
    // main → copy (unlock fleet shapes in HUD so they're draggable)
    const unsubMain = mainEditor.store.listen(({ changes }) => {
      store.mergeRemoteChanges(() => {
        for (const record of Object.values(changes.added)) {
          if (isDocRecord(record)) store.put([lockCamera ? unlockFleetShape(record) : record])
        }
        for (const [, to] of Object.values(changes.updated)) {
          if (isDocRecord(to)) store.put([lockCamera ? unlockFleetShape(to) : to])
        }
        for (const record of Object.values(changes.removed)) {
          if (isDocRecord(record)) {
            try { store.remove([record.id]) } catch { /* might not exist */ }
          }
        }
      })
    }, { source: 'all', scope: 'document' })

    // copy → main (re-lock fleet shapes so they stay locked on main canvas)
    const unsubCopy = store.listen(({ changes }) => {
      mainEditor.store.mergeRemoteChanges(() => {
        for (const record of Object.values(changes.added)) {
          if (isDocRecord(record)) mainEditor.store.put([lockCamera ? relockFleetShape(record) : record])
        }
        for (const [, to] of Object.values(changes.updated)) {
          if (isDocRecord(to)) mainEditor.store.put([lockCamera ? relockFleetShape(to) : to])
        }
        for (const record of Object.values(changes.removed)) {
          if (isDocRecord(record)) {
            try { mainEditor.store.remove([record.id]) } catch { /* might not exist */ }
          }
        }
      })
    }, { source: 'all', scope: 'document' })

    return () => { unsubMain(); unsubCopy() }
  }, [mainEditor.store, store, lockCamera])

  // Apply camera constraints when bounds change
  // Use clip bounds for initial position, full page extent for scroll range
  const initialBoundsRef = useRef(true)
  const animFrameRef = useRef(0)
  useEffect(() => {
    if (!editor || !bounds) return

    // Target camera for these bounds
    const zoom = panelWidth / bounds.w
    const contentScreenH = bounds.h * zoom
    const minScreenH = MIN_VISIBLE_LINES * LINE_HEIGHT_ESTIMATE * zoom
    const viewportH = Math.max(minScreenH, Math.min(contentScreenH, window.innerHeight * DEFAULT_MAX_HEIGHT_FRACTION))
    const yOffset = (viewportH > contentScreenH)
      ? (viewportH - contentScreenH) / (2 * zoom)
      : 0
    const targetCam = { x: -bounds.x, y: -(bounds.y - yOffset), z: zoom }

    if (lockCamera && !initialBoundsRef.current) {
      // Animate camera to new bounds (post-drop rearrangement)
      cancelAnimationFrame(animFrameRef.current)
      const startCam = editor.getCamera()
      const duration = 250
      const start = performance.now()

      const animate = (now: number) => {
        const t = Math.min(1, (now - start) / duration)
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
        editor.setCamera({
          x: startCam.x + (targetCam.x - startCam.x) * ease,
          y: startCam.y + (targetCam.y - startCam.y) * ease,
          z: startCam.z + (targetCam.z - startCam.z) * ease,
        })
        // Update constraints to match current animated position
        const curZoom = startCam.z + (targetCam.z - startCam.z) * ease
        const curBoundsW = panelWidth / curZoom
        editor.setCameraOptions({
          constraints: {
            bounds: { x: bounds.x, y: bounds.y, w: curBoundsW, h: bounds.h },
            behavior: 'fixed',
            origin: { x: 0.5, y: 0 },
            padding: { x: 0, y: 0 },
            initialZoom: 'fit-x',
            baseZoom: 'fit-x',
          },
          zoomSteps: [1, 1],
        })
        if (t < 1) animFrameRef.current = requestAnimationFrame(animate)
      }
      animFrameRef.current = requestAnimationFrame(animate)
    } else {
      // First mount or non-locked: set immediately
      // Find the vertical extent for scroll range (non-locked panels)
      if (!lockCamera) {
        let minY = bounds.y
        let maxY = bounds.y + bounds.h
        for (const shape of editor.getCurrentPageShapes()) {
          if ((shape.type as string) === 'svg-page') {
            const geo = editor.getShapeGeometry(shape)
            if (geo) {
              minY = Math.min(minY, (shape as any).y)
              maxY = Math.max(maxY, (shape as any).y + geo.bounds.h)
            }
          }
        }
        editor.setCameraOptions({
          constraints: {
            bounds: { x: bounds.x, y: minY, w: bounds.w, h: maxY - minY },
            behavior: 'inside',
            origin: { x: 0.5, y: 0 },
            padding: { x: 0, y: 0 },
            initialZoom: 'fit-x',
            baseZoom: 'fit-x',
          },
          zoomSteps: [0.5, 1, 2],
        })
      }

      editor.setCamera(targetCam)

      if (lockCamera) {
        editor.setCameraOptions({
          constraints: {
            bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
            behavior: 'fixed',
            origin: { x: 0.5, y: 0 },
            padding: { x: 0, y: 0 },
            initialZoom: 'fit-x',
            baseZoom: 'fit-x',
          },
          zoomSteps: [1, 1],
        })
      }
    }
    initialBoundsRef.current = false

    return () => cancelAnimationFrame(animFrameRef.current)
  }, [editor, bounds, panelWidth, lockCamera])

  // Wheel handling — two modes:
  // Normal panels: wheel pans the camera vertically
  // Locked camera (fleet HUD): deltaY scrolls .fleet-chat-log, deltaX pans fleet shapes
  // Both modes preventDefault to block Safari back-gesture on horizontal swipe
  const canvasRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = canvasRef.current
    if (!el || !editor) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (lockCamera) {
        // Vertical: scroll the hovered fleet shape's chat log.
        // forceMobile=true disables hover tracking so getHoveredShapeId() always
        // returns null — use elementFromPoint instead.
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          const target = document.elementFromPoint(e.clientX, e.clientY)
          const chatLog = (target?.closest('[data-shape-id]')
            ?.querySelector('.fleet-chat-log') ?? null) as HTMLElement | null
          if (chatLog) chatLog.scrollTop += e.deltaY
        }
        // Horizontal: pan main editor camera so HUD viewport shifts
        if (Math.abs(e.deltaX) > 0) {
          const cam = mainEditor.getCamera()
          mainEditor.setCamera({ x: cam.x - e.deltaX / cam.z, y: cam.y, z: cam.z })
        }
      } else {
        const cam = editor.getCamera()
        const dy = e.deltaY / cam.z
        editor.setCamera({ x: cam.x, y: cam.y - dy, z: cam.z })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [editor, lockCamera, mainEditor])

  // Clear selection when clicking outside the panel (e.g. on the main canvas).
  // The panel's own tldraw editor doesn't see events outside its container,
  // so resize handles would otherwise stay stuck.
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!editor) return
    const onPointerDown = (e: PointerEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return
      if (editor.getSelectedShapeIds().length > 0) {
        editor.selectNone()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => document.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [editor])

  // Fleet drag-mode: when a fleet shape is selected in the HUD, disable
  // pointer-events on its HTMLContainer so tldraw's SelectTool can handle
  // drag/resize. Same mechanism as BrowseIdle uses on the main canvas.
  const fleetSelectedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!editor) return
    const FLEET_TYPES = new Set(['fleet-chat', 'fleet-agents', 'fleet-search'])

    function update() {
      const container = editor!.getContainer()
      const selected = new Set(editor!.getSelectedShapeIds() as string[])
      const prev = fleetSelectedRef.current

      // Remove class from deselected
      for (const id of prev) {
        if (!selected.has(id)) {
          container.querySelector(`[data-shape-id="${id}"]`)?.classList.remove('fleet-drag-mode')
        }
      }

      // Add class to newly selected fleet shapes
      const next = new Set<string>()
      for (const id of selected) {
        const shape = editor!.getShape(id as any)
        if (shape && FLEET_TYPES.has(shape.type as string)) {
          next.add(id as string)
          if (!prev.has(id as string)) {
            container.querySelector(`[data-shape-id="${id}"]`)?.classList.add('fleet-drag-mode')
          }
        }
      }
      fleetSelectedRef.current = next
    }

    update()
    const unsub = editor.store.listen(({ changes }) => {
      for (const [, to] of Object.values(changes.updated)) {
        if ((to as any).typeName === 'instance_page_state') {
          update()
          return
        }
      }
    }, { scope: 'session', source: 'all' })

    return () => {
      unsub()
      // Restore all on cleanup
      const container = editor!.getContainer()
      for (const id of fleetSelectedRef.current) {
        container.querySelector(`[data-shape-id="${id}"]`)?.classList.remove('fleet-drag-mode')
      }
      fleetSelectedRef.current = new Set()
    }
  }, [editor])

  // Panel height: at least 5 lines, at most maxHeightFraction of viewport
  const canvasHeight = useMemo(() => {
    if (!bounds) return 100
    const zoom = panelWidth / bounds.w
    const contentH = bounds.h * zoom
    const minH = MIN_VISIBLE_LINES * LINE_HEIGHT_ESTIMATE * zoom
    return Math.max(minH, Math.min(contentH, window.innerHeight * maxHeightFraction))
  }, [bounds, panelWidth, maxHeightFraction])

  if (!bounds) return null

  return (
    <div
      ref={panelRef}
      className={`clip-panel ${className || ''}`}
      style={{ width: panelWidth, height: canvasHeight + 20 }}
      onPointerDown={stopEventPropagation}
      onPointerUp={stopEventPropagation}
      onTouchStart={stopEventPropagation}
      onTouchEnd={stopEventPropagation}
    >
      {children}
      <div ref={canvasRef} className="clip-panel-canvas" style={{ height: canvasHeight }}>
        <Tldraw
          store={store}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={licenseKey}
          initialState={initialTool}
          hideUi
          autoFocus={false}
          forceMobile
          onMount={setEditor}
        />
      </div>
    </div>
  )
}

const FLEET_TYPES = new Set(['fleet-chat', 'fleet-agents', 'fleet-search'])

function isDocRecord(record: TLRecord): boolean {
  return record.typeName === 'shape' || record.typeName === 'asset' ||
    record.typeName === 'page' || record.typeName === 'document'
}

/** Unlock fleet shapes in the HUD copy store so they're draggable/resizable. */
function unlockFleetShape(record: TLRecord): TLRecord {
  if (record.typeName === 'shape' && FLEET_TYPES.has((record as any).type) && (record as any).isLocked) {
    return { ...record, isLocked: false } as TLRecord
  }
  return record
}

/** Re-lock fleet shapes when syncing back to main store. */
function relockFleetShape(record: TLRecord): TLRecord {
  if (record.typeName === 'shape' && FLEET_TYPES.has((record as any).type)) {
    return { ...record, isLocked: true } as TLRecord
  }
  return record
}

