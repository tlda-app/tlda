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
  /** When set, fade all highlight/annotation shapes except these to 0.15 opacity */
  emphasizeShapeIds?: string[]
  /** Make the editor read-only (no selection, no interaction with shapes) */
  readOnly?: boolean
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
  emphasizeShapeIds,
  readOnly = false,
  children,
}: CanvasClipPanelProps) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const emphasizedIdsRef = useRef<Set<string>>(new Set())
  const lockedIdsRef = useRef<Set<string>>(new Set())

  // Create copy store from main editor's document records
  const store = useMemo(() => {
    const allRecords = mainEditor.store.allRecords()
    const docRecords = allRecords.filter(isDocRecord)
    const s = createTLStore({ shapeUtils })
    s.mergeRemoteChanges(() => { s.put(docRecords) })
    return s
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mirror main editor's current tool into the panel editor (skip in readOnly mode)
  // Bidirectional sync: main store ↔ copy store (document records only)
  useEffect(() => {
    const FLEET_SHAPE_TYPES = new Set(['fleet-chat', 'fleet-agents', 'fleet-search'])
    // fleet-pill shapes are ephemeral drag ghosts — never sync between editors
    const isPill = (r: any) => r.typeName === 'shape' && r.type === 'fleet-pill'
    // main → copy
    const unsubMain = mainEditor.store.listen(({ changes }) => {
      store.mergeRemoteChanges(() => {
        for (const record of Object.values(changes.added)) {
          if (isPill(record)) continue
          if (isDocRecord(record)) {
            // Lock new shapes in readOnly mode
            if (readOnly && record.typeName === 'shape' && !(record as any).isLocked) {
              store.put([{ ...record, isLocked: true } as any])
              lockedIdsRef.current.add(record.id)
            } else {
              store.put([record])
            }
          }
        }
        for (const [, to] of Object.values(changes.updated)) {
          if (isPill(to)) continue
          if (isDocRecord(to)) {
            // Preserve isLocked when syncing shapes in readOnly mode
            if (readOnly && to.typeName === 'shape' && lockedIdsRef.current.has(to.id)) {
              store.put([{ ...to, isLocked: true } as any])
            } else if (to.typeName === 'shape' && FLEET_SHAPE_TYPES.has((to as any).type)) {
              // Don't overwrite copy's lock state for fleet shapes
              const copyShape = store.get((to as any).id)
              store.put([{ ...to, isLocked: (copyShape as any)?.isLocked ?? (to as any).isLocked } as any])
            } else {
              store.put([to])
            }
          }
        }
        for (const record of Object.values(changes.removed)) {
          if (isPill(record)) continue
          if (isDocRecord(record)) {
            try { store.remove([record.id]) } catch { /* might not exist */ }
          }
        }
      })
    }, { source: 'all', scope: 'document' })

    // copy → main (reverse sync for shape edits made in the panel)
    // Skip shapes that were locally faded for emphasis — don't propagate opacity changes back
    const unsubCopy = store.listen(({ changes }) => {
      mainEditor.store.mergeRemoteChanges(() => {
        for (const record of Object.values(changes.added)) {
          if (isPill(record)) continue
          if (isDocRecord(record)) mainEditor.store.put([record])
        }
        for (const [, to] of Object.values(changes.updated)) {
          if (isPill(to)) continue
          if (!isDocRecord(to) || emphasizedIdsRef.current.has(to.id) || lockedIdsRef.current.has(to.id)) continue
          // Don't sync isLocked changes for fleet shapes (panel manages lock independently)
          if (to.typeName === 'shape' && FLEET_SHAPE_TYPES.has((to as any).type)) {
            const mainShape = mainEditor.getShape((to as any).id)
            if (mainShape) {
              mainEditor.store.put([{ ...to, isLocked: mainShape.isLocked } as any])
            }
          } else {
            mainEditor.store.put([to])
          }
        }
        for (const record of Object.values(changes.removed)) {
          if (isPill(record)) continue
          if (isDocRecord(record)) {
            try { mainEditor.store.remove([record.id]) } catch { /* might not exist */ }
          }
        }
      })
    }, { source: 'all', scope: 'document' })

    return () => { unsubMain(); unsubCopy() }
  }, [mainEditor.store, store, readOnly])

  // Apply camera constraints when bounds change
  // Use clip bounds for initial position, full page extent for scroll range
  useEffect(() => {
    if (!editor || !bounds) return

    // readOnly mode: free infinite canvas, just set initial camera position
    if (readOnly) {
      const zoom = panelWidth / bounds.w
      const contentScreenH = bounds.h * zoom
      const viewportH = Math.min(contentScreenH, window.innerHeight * DEFAULT_MAX_HEIGHT_FRACTION)
      const yOffset = (viewportH > contentScreenH)
        ? (viewportH - contentScreenH) / (2 * zoom)
        : 0
      editor.setCamera({ x: -bounds.x, y: -(bounds.y - yOffset), z: zoom })
      return
    }

    // Find the vertical extent for scroll range
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

    // Position camera to show the clip region, centered vertically
    const zoom = panelWidth / bounds.w
    const contentScreenH = bounds.h * zoom
    const minScreenH = MIN_VISIBLE_LINES * LINE_HEIGHT_ESTIMATE * zoom
    const viewportH = Math.max(minScreenH, Math.min(contentScreenH, window.innerHeight * DEFAULT_MAX_HEIGHT_FRACTION))
    // Center the bounds vertically if viewport is taller than content
    const yOffset = (viewportH > contentScreenH)
      ? (viewportH - contentScreenH) / (2 * zoom)
      : 0
    editor.setCamera({ x: -bounds.x, y: -(bounds.y - yOffset), z: zoom })

    // Lock camera pan/zoom if requested (fleet HUD)
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
  }, [editor, bounds, panelWidth, lockCamera, readOnly])

  // Emphasize specific shapes by fading everything else (copy store only, no reverse sync)
  useEffect(() => {
    if (!editor || !emphasizeShapeIds || emphasizeShapeIds.length === 0) return
    const keepSet = new Set(emphasizeShapeIds)
    const FADE_TYPES = new Set(['highlight', 'dot-annotation'])
    const faded = new Set<string>()
    store.mergeRemoteChanges(() => {
      for (const shape of editor.getCurrentPageShapes()) {
        if (FADE_TYPES.has(shape.type) && !keepSet.has(shape.id)) {
          store.put([{ ...shape, opacity: 0.15 }])
          faded.add(shape.id)
        }
      }
    })
    emphasizedIdsRef.current = faded
    return () => { emphasizedIdsRef.current = new Set() }
  }, [editor, emphasizeShapeIds, store])

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
        const dx = e.deltaX / cam.z
        const dy = e.deltaY / cam.z
        editor.setCamera({ x: cam.x - dx, y: cam.y - dy, z: cam.z })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [editor, lockCamera, mainEditor])

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
          hideUi
          autoFocus={false}
          forceMobile
          onMount={(ed) => {
            setEditor(ed)
            if (readOnly) {
              ed.updateInstanceState({ isReadonly: true })
              // Lock all shapes so they can't be selected
              const lockAll = () => {
                for (const shape of ed.getCurrentPageShapes()) {
                  if (!shape.isLocked) {
                    ed.updateShape({ id: shape.id, type: shape.type, isLocked: true })
                    lockedIdsRef.current.add(shape.id)
                  }
                }
              }
              lockAll()
              // Re-lock after sync catches up (shapes arrive async from main store)
              setTimeout(lockAll, 500)
              setTimeout(lockAll, 2000)
            }
          }}
        />
      </div>
    </div>
  )
}

function isDocRecord(record: TLRecord): boolean {
  return record.typeName === 'shape' || record.typeName === 'asset' ||
    record.typeName === 'page' || record.typeName === 'document'
}

