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
import { Tldraw, createTLStore, stopEventPropagation, useValue } from 'tldraw'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor, TLRecord } from 'tldraw'
import { chatInsertBus } from './shapes/FleetPillShape'
import { HUD_PROXY_SHAPE_ID } from './overlays/FleetHUD'
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
  /** When set, fade all highlight/annotation shapes except these to 0.15 opacity */
  emphasizeShapeIds?: string[]
  /** Make the editor read-only (no selection, no interaction with shapes) */
  readOnly?: boolean
  /** When true, skip the bounds-change camera animation and snap instantly.
   *  Used during live editing (HUD layout mode) where bounds update per-frame
   *  and a running 250ms animation lags the target, making content visibly
   *  grow as the user resizes the HUD smaller. */
  liveEdit?: boolean
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
  emphasizeShapeIds,
  readOnly = false,
  liveEdit = false,
  children,
}: CanvasClipPanelProps) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const emphasizedIdsRef = useRef<Set<string>>(new Set())
  const lockedIdsRef = useRef<Set<string>>(new Set())
  const boundsRef = useRef<ClipBounds | null>(bounds)
  boundsRef.current = bounds

  // Expose editor to parent
  useEffect(() => {
    onEditorMount?.(editor)
  }, [editor, onEditorMount])

  // Snapping in HUD: non-fleet shapes are already locked (lockNonFleetUnlockFleet),
  // and tldraw's snap manager excludes locked shapes from snap targets. So enabling
  // isSnapMode: true gives us fleet-shapes-only snapping for free.

  // In lockCamera (HUD) mode, the HUD only renders fleet shapes — the
  // document content stays on the main canvas behind the HUD's transparent
  // background. Mirroring non-fleet shapes (especially html-page shapes
  // containing iframes) into the HUD breaks hit testing for fleet shapes
  // because iframes capture pointer events and intercept clicks.

  // Location-based filtering: only sync shapes that overlap the visible region.
  // The visible region starts as the clip bounds (so the store is lightweight on
  // mount) and expands as the user pans/zooms in the panel. Skipped for HUD mode
  // which already filters to fleet shapes only.
  const BOUNDS_PADDING = 200
  const visibleRegionRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null)

  // Initialize/reset visible region from clip bounds
  const prevBoundsRef = useRef<ClipBounds | null>(null)
  if (bounds && (bounds !== prevBoundsRef.current)) {
    prevBoundsRef.current = bounds
    visibleRegionRef.current = {
      minX: bounds.x - BOUNDS_PADDING,
      minY: bounds.y - BOUNDS_PADDING,
      maxX: bounds.x + bounds.w + BOUNDS_PADDING,
      maxY: bounds.y + bounds.h + BOUNDS_PADDING,
    }
  }

  const shapeOverlapsVisibleRegion = (shapeId: string): boolean => {
    const vr = visibleRegionRef.current
    if (!vr || lockCamera) return true
    const pb = mainEditor.getShapePageBounds(shapeId as any)
    if (!pb) return true
    return pb.x + pb.w > vr.minX && pb.x < vr.maxX &&
      pb.y + pb.h > vr.minY && pb.y < vr.maxY
  }

  const shouldSyncToCopy = (r: TLRecord): boolean => {
    if (!isDocRecord(r)) return false
    // Never mirror the transient HUD layout-mode proxy shape into the HUD editor.
    if (r.typeName === 'shape' && (r as any).id === HUD_PROXY_SHAPE_ID) return false
    if (lockCamera && r.typeName === 'shape' && !FLEET_TYPES.has((r as any).type)) return false
    if (r.typeName === 'shape' && !shapeOverlapsVisibleRegion(r.id)) return false
    return true
  }

  // Create copy store from main editor's document records
  // Known shape types for this panel — shapes with unknown types are skipped during sync
  const knownTypes = useMemo(() => new Set(shapeUtils.map((u: any) => u.type).filter(Boolean)), [shapeUtils])

  const isKnownShape = (r: TLRecord) =>
    r.typeName !== 'shape' || knownTypes.has((r as any).type) || knownTypes.size === 0

  const store = useMemo(() => {
    const allRecords = mainEditor.store.allRecords()
    const docRecords = allRecords.filter(r => shouldSyncToCopy(r) && isKnownShape(r))
      .map(r => lockCamera ? lockNonFleetUnlockFleet(r) : r)
    const s = createTLStore({ shapeUtils })
    s.mergeRemoteChanges(() => { s.put(docRecords) })
    return s
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dynamic viewport expansion: when the user pans/zooms in the panel,
  // expand the visible region and pull in newly-visible shapes from main.
  // Also handles bounds prop changes (e.g. switching to a different theorem).
  useEffect(() => {
    if (!editor || lockCamera) return

    const expandAndSync = () => {
      const cam = editor.getCamera()
      const container = editor.getContainer()
      const vw = container.clientWidth / cam.z
      const vh = container.clientHeight / cam.z
      const viewportMinX = -cam.x - BOUNDS_PADDING
      const viewportMinY = -cam.y - BOUNDS_PADDING
      const viewportMaxX = -cam.x + vw + BOUNDS_PADDING
      const viewportMaxY = -cam.y + vh + BOUNDS_PADDING

      const vr = visibleRegionRef.current
      if (!vr) {
        visibleRegionRef.current = { minX: viewportMinX, minY: viewportMinY, maxX: viewportMaxX, maxY: viewportMaxY }
      } else {
        // Only expand, never shrink — old shapes stay in the store
        const expanded = viewportMinX < vr.minX || viewportMinY < vr.minY ||
          viewportMaxX > vr.maxX || viewportMaxY > vr.maxY
        if (!expanded) return
        vr.minX = Math.min(vr.minX, viewportMinX)
        vr.minY = Math.min(vr.minY, viewportMinY)
        vr.maxX = Math.max(vr.maxX, viewportMaxX)
        vr.maxY = Math.max(vr.maxY, viewportMaxY)
      }

      // Pull in newly-visible shapes
      const toAdd: TLRecord[] = []
      for (const r of mainEditor.store.allRecords()) {
        if (!shouldSyncToCopy(r) || !isKnownShape(r)) continue
        if (store.has(r.id)) continue
        if (readOnly && r.typeName === 'shape') {
          toAdd.push({ ...r, isLocked: true } as TLRecord)
          lockedIdsRef.current.add(r.id)
        } else {
          toAdd.push(r)
        }
      }
      if (toAdd.length > 0) {
        store.mergeRemoteChanges(() => { store.put(toAdd) })
      }
    }

    // Check on mount and whenever camera changes
    expandAndSync()
    const unsub = store.listen(({ changes }) => {
      for (const [, to] of Object.values(changes.updated)) {
        if ((to as any).typeName === 'camera') {
          expandAndSync()
          return
        }
      }
    }, { scope: 'session', source: 'all' })

    return unsub
  }, [editor, mainEditor.store, store, lockCamera, readOnly])

  // Bidirectional sync: main store ↔ copy store (document records only)
  useEffect(() => {
    // fleet-pill shapes are ephemeral drag ghosts — never sync between editors
    const isPill = (r: any) => r.typeName === 'shape' && r.type === 'fleet-pill'

    // main → copy (unlock fleet shapes in HUD so they're draggable)
    const unsubMain = mainEditor.store.listen(({ changes }) => {
      store.mergeRemoteChanges(() => {
        for (const record of Object.values(changes.added)) {
          if (isPill(record) || !isKnownShape(record)) continue
          if (shouldSyncToCopy(record)) {
            if (readOnly && record.typeName === 'shape' && !(record as any).isLocked) {
              store.put([{ ...record, isLocked: true } as any])
              lockedIdsRef.current.add(record.id)
            } else {
              store.put([lockCamera ? lockNonFleetUnlockFleet(record) : record])
            }
          }
        }
        for (const [, to] of Object.values(changes.updated)) {
          if (isPill(to) || !isKnownShape(to)) continue
          if (shouldSyncToCopy(to)) {
            if (readOnly && to.typeName === 'shape' && lockedIdsRef.current.has(to.id)) {
              store.put([{ ...to, isLocked: true } as any])
            } else {
              store.put([lockCamera ? lockNonFleetUnlockFleet(to) : to])
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

    // copy → main (re-lock fleet shapes so they stay locked on main canvas)
    // Skip shapes that were locally faded for emphasis — don't propagate opacity changes back
    // In lockCamera mode (HUD), only sync fleet shapes back — non-fleet shapes (PDF pages,
    // highlights, etc.) are read-only in the HUD and should never propagate changes to main.
    //
    // Important: use source:'user' (not 'all') and skip mergeRemoteChanges so that
    // fleet shape position/size updates reach the TLSyncClient and are persisted to the
    // server. mergeRemoteChanges marks writes as source:'remote', which the sync client
    // ignores — causing HUD moves to be lost on reload. Using source:'user' also
    // naturally breaks the feedback loop: main echoes changes back to HUD via
    // mergeRemoteChanges (source:'remote'), which this listener never sees.
    const isFleetShape = (r: any) =>
      r.typeName === 'shape' && FLEET_TYPES.has(r.type)
    const unsubCopy = store.listen(({ changes }) => {
      for (const record of Object.values(changes.added)) {
        if (isPill(record)) continue
        if (!isDocRecord(record)) continue
        if (lockCamera && !isFleetShape(record)) continue
        mainEditor.store.put([lockCamera ? relockFleetShape(record) : record])
      }
      for (const [, to] of Object.values(changes.updated)) {
        if (isPill(to)) continue
        if (!isDocRecord(to) || emphasizedIdsRef.current.has(to.id) || lockedIdsRef.current.has(to.id)) continue
        if (lockCamera && !isFleetShape(to)) continue
        mainEditor.store.put([lockCamera ? relockFleetShape(to) : to])
      }
      for (const record of Object.values(changes.removed)) {
        if (isPill(record)) continue
        if (!isDocRecord(record)) continue
        // In lockCamera mode: allow all shape deletions (fleet and junk shapes).
        // We block non-fleet UPDATES above to prevent accidental moves, but explicit
        // user deletions (e.g. eraser) should always propagate back to main.
        try { mainEditor.store.remove([record.id]) } catch { /* might not exist */ }
      }
    }, { source: 'user', scope: 'document' })

    return () => { unsubMain(); unsubCopy() }
  }, [mainEditor.store, store, lockCamera, readOnly])

  // Mirror main editor's active tool to the HUD editor so the single tldraw toolbar
  // controls both. When the user picks eraser/select in the main toolbar, the HUD
  // editor switches to the same tool — enabling deletion of fleet shapes (and any
  // stuck non-fleet shapes) without needing a separate HUD toolbar.
  const mainToolId = useValue('mainToolId', () => mainEditor.getCurrentToolId(), [mainEditor])
  useEffect(() => {
    if (!editor || !lockCamera) return
    try { editor.setCurrentTool(mainToolId) } catch { /* tool may not exist in HUD */ }
  }, [editor, mainToolId, lockCamera])

  // In HUD (lockCamera) mode: override tldraw's default file-drop handler so that
  // files dropped over a fleet-chat shape are routed to that chat's input instead
  // of creating canvas image shapes. Falls back to tldraw's default for drops on
  // empty canvas.
  useEffect(() => {
    if (!editor || !lockCamera) return
    const originalHandler = (editor as any).externalContentHandlers.files
    editor.registerExternalContentHandler('files', async (info) => {
      const point = info.point
      const allChats = editor.getCurrentPageShapes()
        .filter(s => (s as any).type === 'fleet-chat')
      let hitChat: any = null
      if (point) {
        for (const chat of allChats) {
          const bounds = editor.getShapePageBounds(chat.id)
          if (bounds &&
            point.x >= bounds.x && point.x <= bounds.x + bounds.w &&
            point.y >= bounds.y && point.y <= bounds.y + bounds.h) {
            hitChat = chat
            break
          }
        }
      }
      if (!hitChat) {
        // Not over a fleet-chat — fall back to tldraw's default (creates image shape on canvas)
        originalHandler?.(info)
        return
      }
      // Route each file to the chat input
      for (const file of info.files) {
        if (file.type.startsWith('image/')) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = reject
            reader.readAsDataURL(file)
          })
          // Store as tldraw asset in main editor (synced to server → persistent across refresh)
          const assetId = `asset:img-${Date.now().toString(36)}`
          mainEditor.store.put([{
            id: assetId as any, typeName: 'asset', type: 'image',
            props: { src: dataUrl, name: file.name, w: 0, h: 0, mimeType: file.type || 'image/png', isAnimated: false },
            meta: {},
          } as any])
          const assetUid = assetId.slice('asset:'.length)
          const token = `«img:${file.name}#${assetUid}»`
          chatInsertBus.dispatchEvent(new CustomEvent('insert', {
            detail: { chatId: hitChat.id, text: token },
          }))
        } else {
          const fileUid = Date.now().toString(36).slice(-4)
          const token = `«file:${file.name}#${fileUid}»`
          chatInsertBus.dispatchEvent(new CustomEvent('insert', {
            detail: { chatId: hitChat.id, text: token },
          }))
        }
      }
    })
    // Override url handler to intercept data:image/ URLs dragged from chat img elements.
    // tldraw's default url handler tries to create a bookmark, but data: URLs aren't
    // valid bookmark URLs → validation crash. Instead, convert the data URL to a File
    // and handle it as an image drop.
    const originalUrlHandler = (editor as any).externalContentHandlers.url
    editor.registerExternalContentHandler('url', async (info) => {
      const { url, point } = info
      if (url?.startsWith('data:image/')) {
        try {
          const res = await fetch(url)
          const blob = await res.blob()
          const ext = blob.type.split('/')[1] || 'png'
          const file = new File([blob], `image.${ext}`, { type: blob.type })
          await editor.putExternalContent({ type: 'files', files: [file], point })
        } catch {}
        return
      }
      // Silently drop file:// and other non-http URLs that can't be bookmarks
      if (!url?.startsWith('http://') && !url?.startsWith('https://')) return
      originalUrlHandler?.(info)
    })

    return () => {
      // Restore originals on unmount
      ;(editor as any).externalContentHandlers.files = originalHandler
      ;(editor as any).externalContentHandlers.url = originalUrlHandler
    }
  }, [editor, lockCamera])

  // Also override the MAIN editor's url handler to intercept data:image/ URLs.
  // When an <img> is dragged from the chat stream and dropped on the main canvas,
  // the browser puts a text/uri-list with the data: URL into the drag transfer.
  // tldraw's default url handler tries to create a bookmark → schema crash.
  // This converts the data URL to a File and re-dispatches as a files drop.
  useEffect(() => {
    const originalMainUrlHandler = (mainEditor as any).externalContentHandlers.url
    mainEditor.registerExternalContentHandler('url', async (info) => {
      const { url, point } = info
      if (url?.startsWith('data:image/')) {
        try {
          const res = await fetch(url)
          const blob = await res.blob()
          const ext = blob.type.split('/')[1] || 'png'
          const file = new File([blob], `image.${ext}`, { type: blob.type })
          await mainEditor.putExternalContent({ type: 'files', files: [file], point })
        } catch {}
        return
      }
      if (!url?.startsWith('http://') && !url?.startsWith('https://')) return
      originalMainUrlHandler?.(info)
    })
    return () => {
      ;(mainEditor as any).externalContentHandlers.url = originalMainUrlHandler
    }
  }, [mainEditor])

  // Also override the MAIN editor's files handler so OS file drops on the main
  // canvas get routed to a fleet-chat when the cursor is over one. Without this,
  // drops from Finder land on the main canvas (not the HUD) and tldraw creates a
  // canvas shape instead of inserting a chip.
  useEffect(() => {
    if (!lockCamera) return
    const originalMainFilesHandler = (mainEditor as any).externalContentHandlers.files
    mainEditor.registerExternalContentHandler('files', async (info) => {
      const point = info.point
      const allChats = mainEditor.getCurrentPageShapes()
        .filter((s: any) => s.type === 'fleet-chat')
      let hitChat: any = null
      if (point) {
        for (const chat of allChats) {
          const bounds = mainEditor.getShapePageBounds(chat.id)
          if (bounds &&
            point.x >= bounds.x && point.x <= bounds.x + bounds.w &&
            point.y >= bounds.y && point.y <= bounds.y + bounds.h) {
            hitChat = chat
            break
          }
        }
      }
      if (!hitChat) {
        originalMainFilesHandler?.(info)
        return
      }
      for (const file of info.files) {
        if (file.type.startsWith('image/')) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = reject
            reader.readAsDataURL(file)
          })
          const assetId = `asset:img-${Date.now().toString(36)}`
          mainEditor.store.put([{
            id: assetId as any, typeName: 'asset', type: 'image',
            props: { src: dataUrl, name: file.name, w: 0, h: 0, mimeType: file.type || 'image/png', isAnimated: false },
            meta: {},
          } as any])
          const assetUid = assetId.slice('asset:'.length)
          const token = `«img:${file.name}#${assetUid}»`
          chatInsertBus.dispatchEvent(new CustomEvent('insert', {
            detail: { chatId: hitChat.id, text: token },
          }))
        } else {
          const fileUid = Date.now().toString(36).slice(-4)
          const token = `«file:${file.name}#${fileUid}»`
          chatInsertBus.dispatchEvent(new CustomEvent('insert', {
            detail: { chatId: hitChat.id, text: token },
          }))
        }
      }
    })
    return () => {
      ;(mainEditor as any).externalContentHandlers.files = originalMainFilesHandler
    }
  }, [mainEditor, lockCamera])

  // Apply camera constraints when bounds change
  // Use clip bounds for initial position, full page extent for scroll range
  const initialBoundsRef = useRef(true)
  const animFrameRef = useRef(0)
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

    // Target camera for these bounds
    const zoom = panelWidth / bounds.w
    const contentScreenH = bounds.h * zoom
    const minScreenH = MIN_VISIBLE_LINES * LINE_HEIGHT_ESTIMATE * zoom
    const viewportH = Math.max(minScreenH, Math.min(contentScreenH, window.innerHeight * DEFAULT_MAX_HEIGHT_FRACTION))
    const yOffset = (viewportH > contentScreenH)
      ? (viewportH - contentScreenH) / (2 * zoom)
      : 0
    const targetCam = { x: -bounds.x, y: -(bounds.y - yOffset), z: zoom }

    if (lockCamera && !initialBoundsRef.current && !liveEdit) {
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
      // First mount, non-locked, or liveEdit: set immediately.
      // Cancel any in-flight animation from a prior bounds change so the
      // snap doesn't fight a running rAF loop.
      cancelAnimationFrame(animFrameRef.current)
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

      // In lockCamera mode, set the new constraints BEFORE the camera. If
      // we set the camera first while the prior frame's constraints are
      // still active, tldraw clamps the new target to the old bounds and
      // we end up with a camera that doesn't match either frame's bounds.
      // Per-frame during a HUD drag, this compounds into blank/garbled
      // content (the prod-build symptom of #22).
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

      editor.setCamera(targetCam)
    }
    initialBoundsRef.current = false

    return () => cancelAnimationFrame(animFrameRef.current)
  }, [editor, bounds, panelWidth, lockCamera, readOnly, liveEdit])

  // Emphasize specific shapes by fading everything else (copy store only, no reverse sync)
  useEffect(() => {
    if (!editor || !emphasizeShapeIds || emphasizeShapeIds.length === 0) return
    const keepSet = new Set(emphasizeShapeIds)
    const FADE_TYPES = new Set(['highlight', 'math-note'])
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
        const dy = e.deltaY / cam.z
        editor.setCamera({ x: cam.x, y: cam.y - dy, z: cam.z })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [editor, lockCamera, mainEditor])

  // Right-click pass-through: prevent TLDraw from entering selection mode on right-click
  // so the browser's native context menu works on HTML content inside fleet shapes.
  // Uses capture-phase listeners so they fire before TLDraw's own handlers on inner elements.
  // stopPropagation on contextmenu prevents main canvas from seeing it; no preventDefault
  // so the browser still shows the native menu.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 2) e.stopPropagation()
    }
    const onContextMenu = (e: Event) => {
      e.stopPropagation()
    }
    el.addEventListener('pointerdown', onPointerDown, { capture: true })
    el.addEventListener('contextmenu', onContextMenu, { capture: true })
    return () => {
      el.removeEventListener('pointerdown', onPointerDown, { capture: true })
      el.removeEventListener('contextmenu', onContextMenu, { capture: true })
    }
  }, [])

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
          onMount={(ed) => {
            setEditor(ed)
            if (lockCamera) {
              ed.user.updateUserPreferences({ isSnapMode: true })
            }
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

const FLEET_TYPES = new Set(['fleet-chat', 'fleet-agents', 'fleet-search'])

function isDocRecord(record: TLRecord): boolean {
  return record.typeName === 'shape' || record.typeName === 'asset' ||
    record.typeName === 'page' || record.typeName === 'document'
}


// Shape types that should always be locked in the HUD (never accidentally moveable).
// svg-page = PDF pages; highlight/draw/dot-annotation = annotation shapes managed separately.
const HUD_ALWAYS_LOCKED = new Set(['svg-page', 'highlight', 'draw', 'dot-annotation'])

/** For lockCamera (HUD): unlock fleet shapes and unknown/junk shapes (so the eraser
 *  can delete them), lock only intentional non-fleet shapes like PDF pages and annotations. */
function lockNonFleetUnlockFleet(record: TLRecord): TLRecord {
  if (record.typeName !== 'shape') return record
  if (FLEET_TYPES.has((record as any).type)) {
    return { ...record, isLocked: false } as TLRecord
  }
  // Always lock PDF pages and annotation shapes — they shouldn't be moveable in HUD
  if (HUD_ALWAYS_LOCKED.has((record as any).type)) {
    return { ...record, isLocked: true } as TLRecord
  }
  // Unknown/junk shapes: leave unlocked so the eraser can select and delete them
  return { ...record, isLocked: false } as TLRecord
}

/** Re-lock fleet shapes when syncing back to main store. */
function relockFleetShape(record: TLRecord): TLRecord {
  if (record.typeName === 'shape' && FLEET_TYPES.has((record as any).type)) {
    return { ...record, isLocked: true } as TLRecord
  }
  return record
}
