/**
 * FleetHUD — toggle pill in bottom-left that expands to a full-viewport
 * transparent overlay showing fleet shapes via CanvasClipPanel.
 *
 * The overlay covers the entire screen. Fleet shapes render at their canvas
 * positions mapped to screen via a camera with z=1. Horizontal position tracks
 * the main canvas (pans with the document); vertical position is fixed.
 * Pointer events pass through to the main canvas for non-fleet areas.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { react } from 'tldraw'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { useFleetAgents, useFleetIdentity } from '../fleet-data-adapter'
// @ts-ignore — vanilla JS module
import { getHumanId, getDeviceId } from '../fleet/fleet-data.mjs'
import { getMyAnchorId, isMyFleetShape, FLEET_INTERACTION_SHAPE_SELECTOR, FLEET_SHAPE_TYPES, adoptLegacyFleetShapes, layoutOffset, ensureMyLaneDisjoint } from '../shapes/fleet-utils'
import { fleetTouchGestureActiveRef, postTouchTelemetry, setTouchDiagStatus, useFleetGestures } from './useFleetGestures'
import { SuggestionTip } from '../shapes/FleetChatShape'
import { log } from '../logger'
import { computeFleetBoundsFromShapes, createFleetBoundsTracker, type FleetBoundsResult } from './fleet-bounds'
import { createFleetHudOverlayLayer } from '../wm/fleet-hud-layer'
import type { FleetHudLayerState } from '../wm/fleet-hud-layer'
import './FleetHUD.css'

declare global {
  interface Window {
    __tlda_wm_hud__?: FleetHudLayerState
    __tldraw_hud_editor__?: Editor
  }
}

function saveAnchorOffsets(editor: Editor, panOffset: number, cameraY: number) {
  // Never persist a HUD anchor without a resolved identity — getMyAnchorId()
  // falls back to the bare `shape:fleet-hud-anchor` id, which becomes a global
  // orphan shared across users.
  if (!getHumanId()) return
  const anchorId = getMyAnchorId()
  // Pure UI bookkeeping — the anchor stores pan/camera offsets, not document
  // content. Keep it off the user's undo stack (run with history:'ignore').
  editor.run(() => {
    const existing = editor.getShape(anchorId as any)
    if (existing) {
      if (existing.isLocked) {
        editor.updateShape({ id: anchorId as any, type: 'geo', isLocked: false })
      }
      editor.updateShape({
        id: anchorId as any,
        type: 'geo',
        meta: { ...existing.meta, panOffset, cameraY },
        isLocked: true,
      })
    } else {
      editor.createShape({
        id: anchorId as any,
        type: 'geo',
        x: 0, y: 0,
        opacity: 0,
        isLocked: true,
        props: { w: 1, h: 1, geo: 'rectangle' as const },
        meta: { panOffset, cameraY },
      })
    }
  }, { history: 'ignore' })
}

/** Mutable flag: true when the HUD overlay is expanded. Read by
 *  getShapeVisibility on the main editor to hide fleet shapes from
 *  hit-testing (they're rendered by the overlay instead). */
export const fleetHudOpenRef = { current: false }

/** True when layout mode is active (fleet shapes are selectable/draggable).
 *  Read by BrowseIdle's _deselHandler to skip selectNone during layout.
 *  Separate from the CSS class to avoid circular dependency. */
export const fleetLayoutActiveRef = { current: false }

interface FleetHUDProps {
  mainEditor: Editor
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
}

/**
 * Repack remaining fleet shapes into a clean grid after a deletion.
 * Sorts shapes in reading order, computes a grid from the existing bounding
 * box, and resizes + repositions each shape to fill a cell.
 */
/** Anisotropic scale: normalize each shape's position and size relative to the
 *  current bounding box, then apply to the target bounding box. Preserves
 *  each shape's proportional position and size — no packing, no uniform cells. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function repackFleetShapes(editor: Editor, targetBounds?: { x: number; y: number; w: number; h: number }) {
  const shapes = editor.getCurrentPageShapes()
    .filter(isMyFleetShape)
  if (shapes.length === 0) return

  // Current bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of shapes) {
    const b = editor.getShapePageBounds(s.id)
    if (!b) continue
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  if (!isFinite(minX)) return

  const srcW = maxX - minX || 1
  const srcH = maxY - minY || 1
  const tgt = targetBounds || { x: minX, y: minY, w: srcW, h: srcH }

  const updates: any[] = []
  for (const s of shapes) {
    const b = editor.getShapePageBounds(s.id)
    if (!b) continue
    const relX = (b.x - minX) / srcW
    const relY = (b.y - minY) / srcH
    const relW = b.w / srcW
    const relH = b.h / srcH
    updates.push({
      id: s.id,
      type: s.type,
      x: tgt.x + relX * tgt.w,
      y: tgt.y + relY * tgt.h,
      props: { w: Math.round(relW * tgt.w), h: Math.round(relH * tgt.h) },
    })
  }

  editor.updateShapes(updates)
}

// Returns the page-space bounding box of all of MY fleet shapes, or null when
// there are none. A null return makes the HUD render nothing (FleetHUD `if
// (!fleetBounds) return null`), so a *transient* null — shapes present but their
// page bounds momentarily uncomputable mid-update — would blank/remount the whole
// HUD. We log both null reasons (kept permanently): they're the signal to look
// for if the fleet panels ever flash/blank. `fleet-hud` namespace; grep
// client.log for it.
function isFleetShapeForOwner(s: any, humanId: string, deviceId: string): boolean {
  if (!FLEET_SHAPE_TYPES.has(s.type as string)) return false
  const uid = s.props?.userId
  const dev = s.props?.deviceId
  return !!uid && uid === humanId && !!dev && dev === deviceId
}

function ownerFleetPredicate() {
  const humanId = getHumanId()
  const deviceId = getDeviceId()
  return (shape: any) => isFleetShapeForOwner(shape, humanId, deviceId)
}

function logFleetBoundsResult(result: FleetBoundsResult): void {
  if (result.shapeCount === 0) {
    log.debug('fleet-hud', 'getFleetBounds → null: no fleet shapes on page', {})
    return
  }
  if (result.bounds) {
    if (result.noBounds.length > 0) {
      log.debug('fleet-hud', 'getFleetBounds ok; some shapes lacked bounds (excluded)', { noBounds: result.noBounds, shapeCount: result.shapeCount })
    }
    return
  }
  // Transient-null: shapes exist but NONE had computable page bounds this
  // frame. This is the dangerous case — it blanks/remounts the HUD. warn.
  log.warn('fleet-hud', 'getFleetBounds → null despite present shapes (uncomputable bounds — HUD will blank)', {
    shapeCount: result.shapeCount,
    shapes: result.shapeLabels,
    noBounds: result.noBounds,
  })
}

function getFleetBounds(editor: Editor): ClipBounds | null {
  const isMine = ownerFleetPredicate()
  const result = computeFleetBoundsFromShapes(
    editor.getCurrentPageShapes().filter(isMine),
    id => editor.getShapePageBounds(id as any),
  )
  logFleetBoundsResult(result)
  return result.bounds
}

function isPhoneFleetLayout(editor: Editor): boolean {
  type FleetLayoutShape = {
    type: string
    x: number
    props?: { w?: number; h?: number }
  }
  const shapes = editor.getCurrentPageShapes().filter(isMyFleetShape) as unknown as FleetLayoutShape[]
  const agents = shapes.find(s => s.type === 'fleet-agents')
  const inbox = shapes.find(s => s.type === 'fleet-inbox')
  const chat = shapes.find(s => s.type === 'fleet-chat')
  if (!agents || !inbox || !chat) return false
  if (shapes.some(s => s.type === 'fleet-search' || s.type === 'fleet-docview' || s.type === 'fleet-touch-inbox')) return false
  const gap = 10
  const stackedHeight = (agents.props?.h || 0) + gap + (inbox.props?.h || 0)
  const chatH = chat.props?.h || 0
  const chatX = (agents.x || 0) + (agents.props?.w || 0) + gap
  return Math.abs(stackedHeight - chatH) <= 2 && Math.abs((chat.x || 0) - chatX) <= 2
}

function getFleetHudDiagnostic(editor: Editor) {
  const humanId = getHumanId()
  const deviceId = getDeviceId()
  const myAnchorId = getMyAnchorId()
  const shapes = editor.getCurrentPageShapes()
  const fleetShapes: any[] = []
  const sameUserOtherDevice: any[] = []
  const sameUserDevicesSet = new Set<string>()
  let myFleetShapeCount = 0
  let orphanFleetShapeCount = 0
  let sameUserAnchorCount = 0
  let docShapeCount = 0

  for (const s of shapes as any[]) {
    const type = s.type as string
    if (type === 'svg-page' || type === 'html-page') docShapeCount += 1
    if (s.id === myAnchorId || String(s.id).startsWith(`shape:fleet-hud-anchor--${humanId?.replace('fleet:', '') || ''}--`)) {
      sameUserAnchorCount += 1
    }
    if (!FLEET_SHAPE_TYPES.has(type)) continue
    fleetShapes.push(s)
    if (isFleetShapeForOwner(s, humanId, deviceId)) myFleetShapeCount += 1
    if (!s.props?.userId || !s.props?.deviceId) orphanFleetShapeCount += 1
    if (
      !!humanId &&
      s.props?.userId === humanId &&
      !!s.props?.deviceId &&
      s.props.deviceId !== deviceId
    ) {
      sameUserOtherDevice.push(s)
      sameUserDevicesSet.add(String(s.props.deviceId))
    }
  }
  return {
    humanId: humanId || '',
    deviceId: deviceId || '',
    myAnchorId,
    anchorExists: !!editor.getShape(myAnchorId as any),
    sameUserAnchorCount,
    totalFleetShapeCount: fleetShapes.length,
    myFleetShapeCount,
    sameUserOtherDeviceCount: sameUserOtherDevice.length,
    sameUserDevices: [...sameUserDevicesSet].sort(),
    orphanFleetShapeCount,
    docShapeCount,
  }
}

function FleetHudEmptyDiagnostic({
  diagnostic,
}: {
  diagnostic: ReturnType<typeof getFleetHudDiagnostic>
}) {
  const devices = diagnostic.sameUserDevices.length > 0
    ? diagnostic.sameUserDevices.join(', ')
    : 'none'

  return (
    <div className="fleet-hud-diagnostic-wrap">
      <div className="fleet-hud-diagnostic" role="status" aria-live="polite">
        <div className="fleet-hud-diagnostic-title">Fleet shapes are not visible on this device</div>
        <div className="fleet-hud-diagnostic-body">
          <p>
            This browser has no owned fleet layout. TLDraw is loaded, but fleet
            shapes are scoped by identity and device so another device's panels
            are hidden instead of sharing touch targets.
          </p>
          <p>
            Choose a default fleet layout from the fleet button to create panels
            for this device.
          </p>
          <dl>
            <div><dt>identity</dt><dd>{diagnostic.humanId || 'unresolved'}</dd></div>
            <div><dt>device</dt><dd>{diagnostic.deviceId || 'unresolved'}</dd></div>
            <div><dt>owned fleet shapes</dt><dd>{diagnostic.myFleetShapeCount}</dd></div>
            <div><dt>same-user other-device shapes</dt><dd>{diagnostic.sameUserOtherDeviceCount}</dd></div>
            <div><dt>other devices</dt><dd>{devices}</dd></div>
            <div><dt>anchor exists</dt><dd>{diagnostic.anchorExists ? 'yes' : 'no'}</dd></div>
            <div><dt>same-user anchors</dt><dd>{diagnostic.sameUserAnchorCount}</dd></div>
            <div><dt>orphan fleet shapes</dt><dd>{diagnostic.orphanFleetShapeCount}</dd></div>
          </dl>
        </div>
      </div>
    </div>
  )
}

export function FleetHUD({
  mainEditor,
  shapeUtils,
  tools,
  licenseKey,
}: FleetHUDProps) {
  const { id: identityId } = useFleetIdentity()
  const [expanded, setExpanded] = useState(() => localStorage.getItem('fleet-hud-expanded') === '1')
  const [fleetBounds, setFleetBounds] = useState<ClipBounds | null>(() => identityId ? getFleetBounds(mainEditor) : null)
  // Camera tick used to recompute canvas→screen for the render on camera change
  const [cameraTick, setCameraTick] = useState(0)
  // True once document page shapes are present — panOffset must not be computed before this.
  // On browser restore, fleet shapes may load before SVG pages, causing panOffset to use
  // the window.innerWidth/2 fallback and place fleet shapes inside the document text.
  const [docShapesReady, setDocShapesReady] = useState(() => {
    const s = mainEditor.getCurrentPageShapes()
    return s.some(s => (s.type as string) === 'svg-page' || (s.type as string) === 'html-page')
  })
  const agents = useFleetAgents()
  const hudRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const overlayEditorRef = useRef<Editor | null>(null)
  const viewportId = useMemo(() => `fleet-hud-${Math.random().toString(36).slice(2, 9)}`, [])
  const lastHudDiagSigRef = useRef('')
  const fleetBoundsTrackerRef = useRef<ReturnType<typeof createFleetBoundsTracker<any>> | null>(null)
  const gesturesEnabled = expanded && !!fleetBounds && docShapesReady

  const resetFleetBoundsTracker = useCallback((): ClipBounds | null => {
    const tracker = createFleetBoundsTracker<any>({
      isFleetShape: ownerFleetPredicate(),
      getShapePageBounds: id => mainEditor.getShapePageBounds(id as any),
    })
    const result = tracker.reset(mainEditor.getCurrentPageShapes() as any[])
    fleetBoundsTrackerRef.current = tracker
    logFleetBoundsResult(result)
    return result.bounds
  }, [mainEditor])

  const readMaintainedFleetBounds = useCallback((): ClipBounds | null => {
    const result = fleetBoundsTrackerRef.current?.getResult()
    if (result) return result.bounds
    return resetFleetBoundsTracker()
  }, [resetFleetBoundsTracker])

  useEffect(() => {
    if (!identityId) return
    // Claim any pre-(identity,device) fleet shapes for this device BEFORE
    // computing bounds, else the device-scoped isMyFleetShape would orphan a
    // user's existing hand-built layout on first load after the upgrade.
    adoptLegacyFleetShapes(mainEditor)
    // Self-heal accumulation: if my layout overlaps another owner (e.g. shapes
    // placed under the old hash that collided), slide my whole layout into a free
    // lane so different owners' shapes never overlap. Only moves MY shapes.
    ensureMyLaneDisjoint(mainEditor, getHumanId(), getDeviceId())
    setFleetBounds(resetFleetBoundsTracker())
  }, [identityId, mainEditor, resetFleetBoundsTracker])

  useEffect(() => {
    const shapes = mainEditor.getCurrentPageShapes()
    const fleetShapes = shapes.filter(isMyFleetShape)
    const docShapes = shapes.filter(s => (s.type as string) === 'svg-page' || (s.type as string) === 'html-page')
    const state = {
      expanded,
      hasIdentity: !!identityId,
      hasFleetBounds: !!fleetBounds,
      gesturesEnabled,
      fleetGesturesOptIn: true,
      fleetBounds,
      docShapesReady,
      shapeCount: shapes.length,
      myFleetShapeCount: fleetShapes.length,
      docShapeCount: docShapes.length,
      hasHudRef: !!hudRef.current,
      hasOverlayEditor: !!overlayEditorRef.current,
      localExpanded: typeof window !== 'undefined' ? window.localStorage.getItem('fleet-hud-expanded') : null,
      localGestures: null,
    }
    const sig = JSON.stringify({
      expanded: state.expanded,
      hasIdentity: state.hasIdentity,
      hasFleetBounds: state.hasFleetBounds,
      gesturesEnabled: state.gesturesEnabled,
      fleetGesturesOptIn: state.fleetGesturesOptIn,
      docShapesReady: state.docShapesReady,
      myFleetShapeCount: state.myFleetShapeCount,
      docShapeCount: state.docShapeCount,
      hasHudRef: state.hasHudRef,
      hasOverlayEditor: state.hasOverlayEditor,
      localExpanded: state.localExpanded,
      localGestures: state.localGestures,
    })
    if (sig === lastHudDiagSigRef.current) return
    lastHudDiagSigRef.current = sig
    setTouchDiagStatus('fleet hud state', state)
    postTouchTelemetry('fleet hud state', state)
  }, [mainEditor, expanded, identityId, fleetBounds, docShapesReady, gesturesEnabled])

  // Touch gesture vocabulary on the HUD (move/resize shapes, pass-through pan/zoom).
  useFleetGestures({ hudRef, overlayEditorRef, mainEditor, expanded: gesturesEnabled, viewportId })

  useEffect(() => {
    const shapes = mainEditor.getCurrentPageShapes()
    const fleetShapes = shapes.filter(isMyFleetShape)
    const docShapes = shapes.filter(s => (s.type as string) === 'svg-page' || (s.type as string) === 'html-page')
    log.debug('fleet-gesture', 'fleet hud load state', {
      expanded,
      hasIdentity: !!identityId,
      hasFleetBounds: !!fleetBounds,
      gesturesEnabled,
      fleetBounds,
      docShapesReady,
      shapeCount: shapes.length,
      myFleetShapeCount: fleetShapes.length,
      docShapeCount: docShapes.length,
      panOffset: panOffsetRef.current,
      cameraY: cameraYRef.current,
      mainCamera: mainEditor.getCamera(),
      devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : null,
      visualViewport: typeof window !== 'undefined' && window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            scale: window.visualViewport.scale,
            offsetLeft: window.visualViewport.offsetLeft,
            offsetTop: window.visualViewport.offsetTop,
          }
        : null,
    })
  }, [mainEditor, expanded, identityId, fleetBounds, docShapesReady, gesturesEnabled])

  // Track whether any fleet shapes are selected in the HUD editor (layout mode).
  // When active, the HUD canvas gets pointer-events: auto so drag-box select works.
  // Toggled via CSS class on the wrap div — see .fleet-hud-wrap.hud-layout-active in FleetHUD.css.

  // Camera offsets: initialized once on first expand, then frozen.
  // panOffsetRef (X): only updated by pan deltas, not zoom or shape moves.
  // cameraYRef (Y): set once, never updated by shape moves.
  // Persisted via an invisible anchor shape in Yjs (survives across sessions/devices).
  const TOP_PAD = 80
  const LEFT_PAD = 20
  const panOffsetRef = useRef<number | null>(null)
  const cameraYRef = useRef<number | null>(null)
  const ignoreSavedAnchorRef = useRef(false)
  // True once the user has deliberately panned this session. Guards the
  // adopt-anchor-on-late-arrival listener so a late-syncing anchor can't
  // snap the HUD back after the user has intentionally moved it.
  const userPannedRef = useRef(false)
  if (!ignoreSavedAnchorRef.current && panOffsetRef.current === null && cameraYRef.current === null) {
    const anchor = mainEditor.getShape(getMyAnchorId() as any) as any
    if (anchor?.meta?.panOffset !== undefined) {
      panOffsetRef.current = anchor.meta.panOffset
      cameraYRef.current = anchor.meta.cameraY
    }
  }

  const recenterHudForBounds = useCallback((bounds: ClipBounds | null): boolean => {
    if (!bounds || !docShapesReady) return false
    const docShapes = mainEditor.getCurrentPageShapes().filter(s =>
      (s.type as string) === 'html-page' || (s.type as string) === 'svg-page')
    if (docShapes.length === 0) return false
    let minPageX = Infinity
    for (const s of docShapes) {
      const b = mainEditor.getShapePageBounds(s.id)
      if (b && b.x < minPageX) minPageX = b.x
    }
    if (!isFinite(minPageX)) return false
    const docLeftScreen = mainEditor.pageToScreen({ x: minPageX, y: 0 }).x
    const off = layoutOffset(getHumanId(), getDeviceId())
    panOffsetRef.current = docLeftScreen - minPageX - off.dx
    const projectedLeft = bounds.x + panOffsetRef.current
    const projectedRight = projectedLeft + bounds.w
    if (!isPhoneFleetLayout(mainEditor) && (projectedRight < window.innerWidth * 0.25 || projectedLeft > window.innerWidth * 0.75)) {
      panOffsetRef.current = LEFT_PAD - bounds.x
    }
    cameraYRef.current = TOP_PAD - bounds.y
    userPannedRef.current = false
    setCameraTick(t => t + 1)
    return true
  }, [docShapesReady, mainEditor])

  // Reactively update fleet bounds when shapes change.
  //
  // Position updates: freeze during USER drag (so the auto-zoom panel doesn't
  // thrash mid-resize), recalculate on pointerup. Updates from remote sync
  // (Yjs from another tab or the server) recalculate IMMEDIATELY — those
  // aren't drags and deferring them caused a nasty bug where the HUD would
  // appear to "spontaneously zoom" minutes later when the user happened to
  // click anywhere on the page (which fired the deferred handler).
  useEffect(() => {
    setFleetBounds(resetFleetBoundsTracker())

    const unsub = mainEditor.store.listen(({ changes }) => {
      const humanId = getHumanId()
      const deviceId = getDeviceId()
      const isFleetChange = (record: any) =>
        record.typeName === 'shape' && isFleetShapeForOwner(record, humanId, deviceId)
      // Immediate: add/remove always recalculates
      const hasAddition = Object.values(changes.added).some(isFleetChange)
      const hasRemoval = Object.values(changes.removed).some(isFleetChange)
      const hasAddOrRemove = hasAddition || hasRemoval

      if (hasAddOrRemove) {
        log.debug('fleet-hud', 'bounds recompute (fleet shape add/remove)', {
          added: Object.values(changes.added).filter(isFleetChange).map((r: any) => `${r.type}:${r.id}`),
          removed: Object.values(changes.removed).filter(isFleetChange).map((r: any) => `${r.type}:${r.id}`),
        })
        draggingRef.current = false
        const result = fleetBoundsTrackerRef.current?.applyChanges(changes)
        if (result) logFleetBoundsResult(result)
        setFleetBounds(result?.bounds ?? readMaintainedFleetBounds())
        // Auto-reflow disabled — it was making things worse, not better.
        // TODO: reimplement add+delete-as-identity later. For now shapes
        // stay where they are on add/remove; user drags manually.
        return
      }

      // Position/size updates
      const hasUpdate = Object.values(changes.updated)
        .some(([from, to]) => isFleetChange(from) || isFleetChange(to))

      if (!hasUpdate) return

      // Only defer if the user is actively dragging (pointer is down inside
      // tldraw). For programmatic/remote updates, recalc immediately so the
      // HUD reflects the new bounds at the moment they change.
      const isUserDragging = !!mainEditor.inputs?.isPointing
      if (isUserDragging) {
        const updatedFleet = Object.values(changes.updated)
          .filter(([from, to]: any) => isFleetChange(from) || isFleetChange(to))
          .map(([from, to]: any) => ({
            id: to.id,
            type: to.type,
            from: { x: from.x, y: from.y },
            to: { x: to.x, y: to.y },
            changedProps: Object.keys(to.props || {}).filter(k => (from.props || {})[k] !== to.props[k]),
          }))
        log.debug('fleet-gesture', 'fleet update deferred during user drag', { updatedFleet })
        draggingRef.current = true
      } else {
        const result = fleetBoundsTrackerRef.current?.applyChanges(changes)
        if (result) logFleetBoundsResult(result)
        const updatedFleet = Object.values(changes.updated)
          .filter(([from, to]: any) => isFleetChange(from) || isFleetChange(to))
          .map(([from, to]: any) => {
            const changedProps = Object.keys(to.props || {}).filter(k => (from.props || {})[k] !== to.props[k])
            return { id: to.id, type: to.type, moved: from.x !== to.x || from.y !== to.y, changedProps }
          })
        log.debug('fleet-gesture', 'fleet bounds recompute after shape update', {
          isUserDragging,
          updatedFleet,
          previousBounds: fleetBounds,
          nextBounds: result?.bounds ?? readMaintainedFleetBounds(),
        })
        log.debug('fleet-hud', 'bounds recompute (fleet shape update)', { updatedFleet })
        draggingRef.current = false
        setFleetBounds(result?.bounds ?? readMaintainedFleetBounds())
      }
    }, { source: 'all', scope: 'document' })

    const handlePointerUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false
        setFleetBounds(resetFleetBoundsTracker())
      }
    }
    window.addEventListener('pointerup', handlePointerUp, true)

    return () => {
      unsub()
      window.removeEventListener('pointerup', handlePointerUp, true)
    }
  }, [mainEditor, readMaintainedFleetBounds, resetFleetBoundsTracker])

  // Watch for SVG/HTML page shapes to arrive (async on browser restore).
  // If no saved panOffset exists, reset so it recomputes with real shape bounds.
  // If a saved panOffset exists (from a previous session), keep it — that's the user's position.
  useEffect(() => {
    if (docShapesReady) return
    const unsub = mainEditor.store.listen(({ changes }) => {
      const hasPage = Object.values(changes.added).some((r: any) =>
        r.typeName === 'shape' && (r.type === 'svg-page' || r.type === 'html-page'))
      if (hasPage) {
        setDocShapesReady(true)
        // Only force recompute if we don't have a saved position
        const anchor = mainEditor.getShape(getMyAnchorId() as any) as any
        if (anchor?.meta?.panOffset === undefined) {
          panOffsetRef.current = null
        }
      }
    }, { source: 'all', scope: 'document' })
    return unsub
  }, [mainEditor, docShapesReady])

  // In the copy-store HUD, opening the HUD hides fleet shapes in the main
  // editor because CanvasClipPanel renders separate copies. The fork viewport
  // HUD renders the same editor/store, so that global visibility switch would
  // also hide the fleet shapes from the WM viewport itself.
  //
  // Body class + visibility ref (no shape updates here — that causes loops
  // since updating shapes triggers fleetBounds recalc which re-runs this effect)
  useEffect(() => {
    const isOpen = !!(expanded && fleetBounds)
    fleetHudOpenRef.current = isOpen
    if (isOpen) {
      document.body.classList.add('fleet-hud-open')
    } else {
      document.body.classList.remove('fleet-hud-open')
    }
    return () => {
      document.body.classList.remove('fleet-hud-open')
      fleetHudOpenRef.current = false
    }
  }, [expanded, fleetBounds])

  // A saved HUD anchor is only a camera offset. After a fresh layout selection
  // the fleet shapes can move to a new page-space lane while a stale camera
  // still points at the old lane, leaving every HUD panel far off-screen. Make
  // the HUD self-heal from the authoritative current fleet bounds instead of
  // depending only on external reset event timing.
  useEffect(() => {
    if (!expanded || !fleetBounds || !docShapesReady) return
    if (panOffsetRef.current === null || cameraYRef.current === null) return
    const latestBounds = readMaintainedFleetBounds() || fleetBounds
    const hasFreshBounds =
      latestBounds.x !== fleetBounds.x ||
      latestBounds.y !== fleetBounds.y ||
      latestBounds.w !== fleetBounds.w ||
      latestBounds.h !== fleetBounds.h
    if (hasFreshBounds) setFleetBounds(latestBounds)
    const projectedTop = latestBounds.y + cameraYRef.current
    const projectedBottom = projectedTop + latestBounds.h
    const verticallyVisible = projectedBottom > 0 && projectedTop < window.innerHeight
    if (verticallyVisible) return
    if (userPannedRef.current) return
    ignoreSavedAnchorRef.current = true
    recenterHudForBounds(latestBounds)
  }, [expanded, fleetBounds?.x, fleetBounds?.y, fleetBounds?.w, fleetBounds?.h, docShapesReady, mainEditor, readMaintainedFleetBounds, recenterHudForBounds])

  // Touch fleet shapes to invalidate getShapeVisibility cache — only when
  // expanded state actually changes, not on every fleetBounds update.
  const prevExpandedRef = useRef(false)
  useEffect(() => {
    const isOpen = !!(expanded && fleetBounds)
    if (isOpen === prevExpandedRef.current) return
    prevExpandedRef.current = isOpen
    const fleetShapes = mainEditor.getCurrentPageShapes().filter(isMyFleetShape)
    if (fleetShapes.length > 0) {
      const tick = Date.now()
      // Cache-invalidation meta touch on HUD open/close — not a document edit,
      // keep it off the undo stack.
      mainEditor.run(() => {
        mainEditor.updateShapes(fleetShapes.map(s => ({
          id: s.id, type: s.type, meta: { ...s.meta, _visTick: tick },
        })))
      }, { history: 'ignore' })
    }
  }, [expanded, fleetBounds, mainEditor])

  // Track main camera for pan: update panOffsetRef by screen-pixel deltas
  // when the user pans (cam.z unchanged). Zoom changes are ignored (fleet
  // shapes stay at their current screen positions).
  useEffect(() => {
    if (!expanded) return
    let rafId: number
    let lastCamX = mainEditor.getCamera().x
    let lastCamZ = mainEditor.getCamera().z
    const readinessWindow = window as Window & {
      __tldaCameraRestoredAt?: number
      __tldaPhoneCameraSettlingUntil?: number
    }
    let cameraRestored = !!readinessWindow.__tldaCameraRestoredAt
    const onCameraRestored = () => { cameraRestored = true }
    window.addEventListener('camera-restored', onCameraRestored)
    const fallbackTimer = setTimeout(() => { cameraRestored = true }, 5000)
    const poll = () => {
      const cam = mainEditor.getCamera()
      if (cam.x !== lastCamX || cam.z !== lastCamZ) {
        const phoneSettlingUntil = Number(readinessWindow.__tldaPhoneCameraSettlingUntil || 0)
        if (!cameraRestored || (phoneSettlingUntil && Date.now() < phoneSettlingUntil)) {
          // Wait for camera restore / phone startup fit, then treat later
          // same-zoom camera changes as deliberate pan.
        } else if (cam.z === lastCamZ && panOffsetRef.current !== null) {
          panOffsetRef.current += (cam.x - lastCamX) * cam.z
          userPannedRef.current = true
          ignoreSavedAnchorRef.current = false
          saveAnchorOffsets(mainEditor, panOffsetRef.current, cameraYRef.current!)
        }
        lastCamX = cam.x
        lastCamZ = cam.z
        setCameraTick(t => t + 1)
      }
      rafId = requestAnimationFrame(poll)
    }
    rafId = requestAnimationFrame(poll)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('camera-restored', onCameraRestored)
      clearTimeout(fallbackTimer)
    }
  }, [mainEditor, expanded])

  // Adopt the saved anchor when it arrives in the store — even if panOffsetRef
  // is already set to a provisional recomputed default. In large multi-machine
  // rooms the anchor record can sync AFTER the fleet shapes, so the first render
  // recomputes a flush-left default; when the real anchor lands we replace it.
  // Guarded by userPannedRef so a late anchor can't undo a deliberate user pan.
  useEffect(() => {
    const unsub = mainEditor.store.listen(({ changes }) => {
      if (userPannedRef.current) return
      if (ignoreSavedAnchorRef.current) return
      const myAnchorId = getMyAnchorId()
      const isMyAnchor = (r: any) => r?.typeName === 'shape' && r.id === myAnchorId
      const arrivals = [
        ...Object.values(changes.added),
        ...Object.values(changes.updated).map((pair: any) => pair[1]),
      ]
      for (const r of arrivals as any[]) {
        if (isMyAnchor(r) && r.meta?.panOffset !== undefined) {
          if (panOffsetRef.current !== r.meta.panOffset || cameraYRef.current !== r.meta.cameraY) {
            panOffsetRef.current = r.meta.panOffset
            cameraYRef.current = r.meta.cameraY
            setCameraTick(t => t + 1)
          }
          break
        }
      }
    }, { source: 'all', scope: 'document' })
    return unsub
  }, [mainEditor, recenterHudForBounds])

  // Block HTML5 file/chip drops on fleet shapes (except chat input areas).
  // With the full-viewport overlay, we check if the drop target is inside
  // an actual fleet shape, not the HUD bounding rect.
  // Drops onto chat input areas are allowed (file attachments).
  // Drops on empty canvas (not on a fleet shape) pass through to tldraw.
  useEffect(() => {
    if (!expanded) return
    const isInsideFleetShape = (clientX: number, clientY: number) => {
      const target = document.elementFromPoint(clientX, clientY)
      if (!target) return false
      return !!target.closest(FLEET_INTERACTION_SHAPE_SELECTOR)
    }
    const isInsideChatInput = (e: DragEvent): boolean => {
      const target = document.elementFromPoint(e.clientX, e.clientY)
      if (!target) return false
      if (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'hidden')) return true
      return !!target.closest('.fleet-chat-input-area')
    }
    const onDragOver = (e: DragEvent) => {
      if (!isInsideFleetShape(e.clientX, e.clientY)) return
      if (isInsideChatInput(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    const onDrop = (e: DragEvent) => {
      if (!isInsideFleetShape(e.clientX, e.clientY)) return
      if (isInsideChatInput(e)) return
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    return () => {
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('drop', onDrop, true)
    }
  }, [expanded])

  // When the main editor is in a drawing/erasing tool, make fleet shapes
  // pointer-events:none so the tool can operate over them directly instead of
  // being intercepted by the chat's interactive elements. CSS uses the
  // .tool-passes-through class on .fleet-hud-wrap to flip pointer-events.
  useEffect(() => {
    const el = hudRef.current
    if (!el) return
    // Tool-based pass-through trades one problem for another: when the user is
    // in eraser/highlight, they can brush over chat — but they also lose the
    // ability to interact with chat without switching tools. Skip judged the
    // tradeoff bad. Reverting until we have a drag-only or pointer-down-only
    // gate that keeps chat interactive on tap.
    void react
    el.classList.remove('tool-passes-through')
  }, [mainEditor])

  // Raise-on-interaction: pointer-down on a fleet shape in the HUD brings it to
  // the front so an overlapping fleet shape's controls/body are grabbable.
  // Scoped to the HUD wrap (never the main canvas) and to fleet shape types only
  // — non-fleet shapes and TLDraw's default stacking are untouched. Capture phase
  // so it fires before inner elements stopPropagation. Guarded to skip when the
  // shape is already frontmost, so it doesn't spam undo/Yjs writes on every tap.
  useEffect(() => {
    if (!expanded) return
    const el = hudRef.current
    if (!el) return
    const onPointerDownCapture = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      const shapeEl = target?.closest?.('.tl-shape[data-shape-id]') as HTMLElement | null
      if (!shapeEl) return
      const type = shapeEl.getAttribute('data-shape-type') || ''
      if (!FLEET_SHAPE_TYPES.has(type)) return
      const shapeId = shapeEl.getAttribute('data-shape-id')
      if (!shapeId) return
      // Only ever raise MY OWN fleet shapes. Scoping by type alone would let a
      // foreign (identity, device)'s panel — present in the shared store but not
      // in my HUD — be the frontmost and get raised into my interaction, which
      // is the click/filter hijack this fix exists to kill.
      const fleetSorted = mainEditor.getCurrentPageShapesSorted().filter(isMyFleetShape)
      const frontmost = fleetSorted[fleetSorted.length - 1]
      if (frontmost && frontmost.id === shapeId) return
      // Raising on tap is a focus/compositing affordance, not a document edit —
      // keep it off the undo stack (still source:'user', so it syncs/persists).
      mainEditor.run(() => mainEditor.bringToFront([shapeId as any]), { history: 'ignore' })
    }
    el.addEventListener('pointerdown', onPointerDownCapture, true)
    return () => el.removeEventListener('pointerdown', onPointerDownCapture, true)
  }, [expanded, mainEditor])

  // Route undo/redo to the MAIN editor when working inside the HUD. The HUD runs
  // a second (copy-store) editor with its OWN history that is ephemeral and
  // unmarked — so a Cmd+Z aimed at it lumps several operations into one step.
  // The main editor's history is the marked, persistent one (create/delete/move
  // each their own step), so intercept the key here and drive main.undo/redo
  // instead of the copy editor's throwaway stack.
  useEffect(() => {
    if (!expanded) return
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      const wrap = hudRef.current
      if (!wrap) return
      const t = e.target as Node | null
      const inHud = (t && wrap.contains(t)) || (document.activeElement instanceof Node && wrap.contains(document.activeElement))
      if (!inHud) return // main-canvas undo keeps its normal path
      e.preventDefault()
      e.stopImmediatePropagation()
      const redo = k === 'y' || (k === 'z' && e.shiftKey)
      if (redo) mainEditor.redo()
      else mainEditor.undo()
    }
    window.addEventListener('keydown', onKeyDownCapture, true)
    return () => window.removeEventListener('keydown', onKeyDownCapture, true)
  }, [expanded, mainEditor])

  // Toggle .hud-layout-active on the wrap div when fleet shapes are selected
  // in the HUD editor. This enables pointer-events on .tl-canvas so drag-box
  // select works — but ONLY when the user has already clicked ⊞ to enter layout
  // mode. Normal browsing (nothing selected) keeps the canvas pointer-events: none
  // so empty-area clicks pass through to the main canvas as always.
  useEffect(() => {
    if (!expanded) return
    const el = hudRef.current
    if (!el) return

    const checkSelection = () => {
      const editor = overlayEditorRef.current
      if (!editor) return
      const hasFleetSelected = editor.getSelectedShapeIds().some(id => {
        const s = editor.getShape(id as any)
        return s && isMyFleetShape(s)
      })
      if (hasFleetSelected) {
        // ADD immediately — user selected a fleet shape, enable interaction
        fleetLayoutActiveRef.current = true
        el.classList.add('hud-layout-active')
      }
      // Removal is handled by BrowseIdle.onEnter.
      // Removing from this listener races with TLDraw's state machine and
      // kills pointer-events mid-interaction.
    }

    // Poll via RAF until overlayEditorRef is set, then switch to store listener
    let rafId: number
    let unsub: (() => void) | null = null
    const onPointerUp = () => checkSelection()
    // HACK: Safety valve — if pointer-events:none was restored mid-drag
    // (e.g. class removed by a React re-render), TLDraw never sees pointerup
    // and stays stuck in brushing/pointing_canvas with isPointing=true.
    // On any window pointerup, if the overlay editor is still "pointing" AND
    // the canvas is blocked (pointer-events:none), force-dispatch pointer_up.
    // Guard: if the canvas is pointer-events:auto (hud-layout-active), TLDraw
    // will receive the native pointerup itself — dispatching here causes a
    // double pointer_up that fires selectOnCanvasPointerUp in idle state,
    // clearing the brush selection immediately after it completes.
    const onWindowPointerUp = (e: PointerEvent) => {
      const editor = overlayEditorRef.current
      if (!editor) return
      if (!editor.inputs.isPointing) return
      const canvas = el.querySelector('.tl-canvas')
      if (canvas && getComputedStyle(canvas).pointerEvents !== 'none') return
      editor.dispatch({
        type: 'pointer', name: 'pointer_up', target: 'canvas',
        pointerId: e.pointerId, point: { x: e.clientX, y: e.clientY, z: 0.5 },
        shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey,
        metaKey: e.metaKey, button: e.button, buttons: e.buttons,
      } as any)
    }
    const trySubscribe = () => {
      if (overlayEditorRef.current) {
        checkSelection()
        unsub = overlayEditorRef.current.store.listen(({ changes }) => {
          for (const [, to] of Object.values(changes.updated)) {
            const typeName = (to as any).typeName
            if (typeName === 'instance_page_state') {
              checkSelection()
              return
            }
            if (typeName === 'instance' && (to as any).brush == null) {
              checkSelection()
              return
            }
          }
        }, { scope: 'session', source: 'all' })
        el.addEventListener('pointerup', onPointerUp, true)
        window.addEventListener('pointerup', onWindowPointerUp, true)
      } else {
        rafId = requestAnimationFrame(trySubscribe)
      }
    }
    trySubscribe()

    return () => {
      cancelAnimationFrame(rafId)
      unsub?.()
      el.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointerup', onWindowPointerUp, true)
      // Only clear layout mode when the HUD is actually closing (expanded going false).
      if (!expanded) {
        fleetLayoutActiveRef.current = false
        el.classList.remove('hud-layout-active')
      }
    }
  }, [expanded])

  const aliveCount = useMemo(() => agents.filter((a: any) => !a.dead && !a.human).length, [agents])
  void aliveCount

  // Reset camera refs when fleet layout code recreates shapes and emits
  // `fleet-hud-reset`, so the overlay re-centers on the new shape bounds.
  useEffect(() => {
    const onReset = (e: Event) => {
      // preserveAnchor (plain reload): a missing anchor may just be unsynced or
      // identity-unresolved. Reset the refs so the HUD recomputes a provisional
      // default, but do NOT delete the saved anchor — deleting it here is what
      // destroyed the user's position when the anchor synced late (drift Path A).
      // The adopt-on-arrival listener restores the real position once it lands.
      // Destructive callers (layout switch, emergency recovery) omit the flag.
      const preserveAnchor = !!(e as CustomEvent)?.detail?.preserveAnchor
      panOffsetRef.current = null
      cameraYRef.current = null
      if (!preserveAnchor) ignoreSavedAnchorRef.current = true
      if (!preserveAnchor) {
        try {
          const myAnchorId = getMyAnchorId()
          const anchor = mainEditor.getShape(myAnchorId as any)
          if (anchor) {
            // Anchor lifecycle is UI bookkeeping — keep off the undo stack.
            mainEditor.run(() => {
              if (anchor.isLocked) mainEditor.updateShape({ id: myAnchorId as any, type: 'geo', isLocked: false })
              mainEditor.deleteShape(myAnchorId as any)
            }, { history: 'ignore' })
          }
        } catch {}
      }
      const nextBounds = resetFleetBoundsTracker()
      recenterHudForBounds(nextBounds)
      setFleetBounds(nextBounds)
    }
    // Toggle: FleetIconPill click dispatches fleet-hud-toggle
    const onToggle = (e: Event) => {
      setExpanded(prev => {
        const requested = (e as CustomEvent)?.detail?.expanded
        const next = typeof requested === 'boolean' ? requested : !prev
        localStorage.setItem('fleet-hud-expanded', next ? '1' : '0')
        return next
      })
    }
    window.addEventListener('fleet-hud-reset', onReset)
    window.addEventListener('fleet-hud-toggle', onToggle)
    return () => {
      window.removeEventListener('fleet-hud-reset', onReset)
      window.removeEventListener('fleet-hud-toggle', onToggle)
    }
  }, [mainEditor, recenterHudForBounds, resetFleetBoundsTracker])

  // Fail loud instead of silently rendering an empty HUD. A common phi/iPad
  // failure mode is a new browser device id: same-user fleet shapes exist in
  // the room, but none are owned by this (identity, device), so the main canvas
  // hides them and the HUD has no bounds to render.
  if (!fleetBounds) {
    if (expanded) {
      return (
        <FleetHudEmptyDiagnostic
          diagnostic={getFleetHudDiagnostic(mainEditor)}
        />
      )
    }
    return null
  }

  // Collapsed: nothing — FleetIconPill in the build-pills-row handles show/hide
  if (!expanded) {
    return null
  }

  const activeFleetBounds = readMaintainedFleetBounds() || fleetBounds

  // Fleet shapes rendered at z=1 (fixed size). X position computed dynamically
  // from document's screen position each render. Y frozen on first expand.
  void cameraTick

  // Camera offsets: computed once on first expand from the document's
  // current screen position, then frozen. X tracks pan only (no zoom).
  // Y is fixed after initial layout.
  if (panOffsetRef.current === null) {
    // Position the overlay so the page-space placement set by createFleetLayout
    // shows through 1:1. The whole layout (margins, widths, gaps) lives in those
    // page coords; the HUD offset is purely "where the document's left edge sits
    // on screen" and reads NO layout parameter — layout sizing and HUD position
    // are completely independent.
    // Guard: if SVG/HTML page shapes haven't loaded yet (browser restore path),
    // defer until docShapesReady — avoids the window.innerWidth/2 fallback that
    // placed fleet shapes in the middle of the document text.
    if (!docShapesReady) return null
    const docShapes = mainEditor.getCurrentPageShapes().filter(s =>
      (s.type as string) === 'html-page' || (s.type as string) === 'svg-page')
    if (docShapes.length === 0) return null
    let minPageX = Infinity
    for (const s of docShapes) {
      const b = mainEditor.getShapePageBounds(s.id)
      if (b && b.x < minPageX) minPageX = b.x
    }
    const docLeftScreen = mainEditor.pageToScreen({ x: minPageX, y: 0 }).x
    // Compensate this (identity, device)'s horizontal layout offset so the
    // viewer's OWN shapes render in their canonical doc-relative position no
    // matter which horizontal zone they physically occupy. The VERTICAL offset
    // (the disjoint lane that keeps owners from overlapping) needs no
    // compensation here — cameraY below derives from fleetBounds.y (this layout's
    // actual top), so the HUD pins my layout to TOP_PAD regardless of its lane.
    const off = layoutOffset(getHumanId(), getDeviceId())
    panOffsetRef.current = docLeftScreen - minPageX - off.dx
    cameraYRef.current = TOP_PAD - activeFleetBounds.y
    // This is a *derived default*, not a user-chosen position. Do NOT persist it:
    // a saved anchor may simply be unsynced (large multi-machine rooms deliver it
    // in a later chunk), and saving the default here would overwrite the real
    // position. The anchor is persisted only on a real user pan (see pan tracking
    // above); if a saved anchor arrives late, the adopt-on-arrival listener picks
    // it up and replaces this provisional value.
  }

  if (panOffsetRef.current !== null && cameraYRef.current !== null) {
    const projectedTop = activeFleetBounds.y + cameraYRef.current
    const projectedBottom = projectedTop + activeFleetBounds.h
    const projectedLeft = activeFleetBounds.x + panOffsetRef.current
    const projectedRight = projectedLeft + activeFleetBounds.w
    const verticallyVisible = projectedBottom > 0 && projectedTop < window.innerHeight
    const horizontallyVisible = projectedRight > 0 && projectedLeft < window.innerWidth
    if (!userPannedRef.current && (!verticallyVisible || !horizontallyVisible)) {
      const docShapes = mainEditor.getCurrentPageShapes().filter(s =>
        (s.type as string) === 'html-page' || (s.type as string) === 'svg-page')
      let minPageX = Infinity
      for (const s of docShapes) {
        const b = mainEditor.getShapePageBounds(s.id)
        if (b && b.x < minPageX) minPageX = b.x
      }
      if (isFinite(minPageX)) {
        const docLeftScreen = mainEditor.pageToScreen({ x: minPageX, y: 0 }).x
        const off = layoutOffset(getHumanId(), getDeviceId())
        panOffsetRef.current = docLeftScreen - minPageX - off.dx
        const nextProjectedLeft = activeFleetBounds.x + panOffsetRef.current
        const nextProjectedRight = nextProjectedLeft + activeFleetBounds.w
        if (!isPhoneFleetLayout(mainEditor) && (nextProjectedRight < window.innerWidth * 0.25 || nextProjectedLeft > window.innerWidth * 0.75)) {
          panOffsetRef.current = LEFT_PAD - activeFleetBounds.x
        }
        cameraYRef.current = TOP_PAD - activeFleetBounds.y
        ignoreSavedAnchorRef.current = true
        userPannedRef.current = false
      }
    }
  }

  const overlayLayer = createFleetHudOverlayLayer({
    panOffset: panOffsetRef.current!,
    cameraY: cameraYRef.current!,
    layout: { axis: 'vertical', spacing: 0 },
  })
  const overlayCam = overlayLayer.camera
  if (import.meta.env.DEV || (typeof navigator !== 'undefined' && navigator.webdriver)) {
    window.__tlda_wm_hud__ = overlayLayer
  }

  return (
    <>
      <div
        className="fleet-hud-wrap"
        ref={hudRef}
        style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }}
      >
        <CanvasClipPanel
          mainEditor={mainEditor}
          viewportId={viewportId}
          bounds={activeFleetBounds}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={licenseKey}
          panelWidth={window.innerWidth}
          maxHeightFraction={1}
          lockCamera={true}
          liveEdit={true}
          cameraOverride={overlayCam}
          fullViewport={true}
          identityId={identityId}
          customGestureActiveRef={fleetTouchGestureActiveRef}
          onEditorMount={(e) => {
            overlayEditorRef.current = e
            if (e) window.__tldraw_hud_editor__ = e
            else delete window.__tldraw_hud_editor__
          }}
          className="fleet-hud"
        />
        {/* Suggestion-chip tooltip: rendered here, ABOVE the shapes and outside
            any (dimmed) shape, so it stays fully opaque. Driven by the chip's
            hover store. Not a portal. */}
        <SuggestionTip />
      </div>
    </>
  )
}
