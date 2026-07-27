/**
 * useFleetGestures — touch gesture vocabulary for the fleet HUD.
 *
 * Special-case touch ONLY when the fingers are over a fleet shape; otherwise the
 * canvas behaves like standard TLDraw. The vocabulary (Skip's locked design):
 *
 *   1 finger / stylus   → scroll the content under it (not intercepted here —
 *                         the shape's own scroll handling runs)
 *   2 fingers on a shape → move it (translate with the fingers' center) and
 *                         resize it (scale with the fingers' spread) at once
 *   2 fingers spanning shapes → move that cluster (the margin-group), so the
 *                         other margin's cluster stays put
 *   3 fingers           → pan the main canvas from anywhere, with a soft /
 *                         breakable axis lock; zoom stays unchanged
 *
 * Why a capture-phase listener on the HUD wrap: every fleet shape root calls
 * stopEventPropagation on pointerdown, so TLDraw (and bubble-phase handlers)
 * never see the press. We intercept above that, identify the shape under the
 * touch centroid via the overlay (copy) editor, and apply the change to the
 * MAIN editor (window.__tldraw_editor__) — fleet shapes carry real x/y/w/h in
 * Yjs, so a main-editor updateShape persists and the HUD copy re-mirrors it.
 * Writing to the copy editor would be clobbered by the main→copy mirror (that's
 * the "snap-back" the old two-finger move exhibited).
 */
import { useEffect } from 'react'
import type { Editor, TLShape } from 'tldraw'
import { log } from '../logger'
import { FLEET_SHAPE_TYPES, isMyFleetShape } from '../shapes/fleet-utils'
import {
  MOVE_LOCK_ON,
  PAN_AXIS_DECAY,
  PAN_BREAK_RATIO,
  PAN_LOCK_INITIAL,
  PAN_OFFAXIS_DAMP,
  RESIZE_LOCK_AFTER_MOVE,
  RESIZE_LOCK_ON,
  applyShapeResizeAxisLock,
  classifySoftGesture,
  type GestureFrameSelectors,
} from '../wm'
import {
  cornerControlAtPoint as gestureCornerControlAtPoint,
  describeElement,
  elementChainAt,
  getGestureViewportCamera,
  getGestureViewportContainer,
  screenPointToFramePage,
} from '../wm'

const LOG_NS = 'fleet-gesture'

const TOUCH_TELEMETRY_NS = 'fleet-gesture-telemetry'
export const TOUCH_TELEMETRY_BUILD = 'touch56-20260617-hud-state-1'

export const fleetTouchGestureActiveRef = { current: false }

export const CORNER_CONTROL_SELECTORS = [
  '.phone-hl-btn',
  '.phone-hl-slider',
  '.voice-note-btn',
  '.voice-action-slider',
  '.mic-toggle-btn',
  '.fleet-icon-pill-container',
  '.fleet-icon-pill-badge',
  '.fleet-layout-slider',
  '.corner-button-slider',
  '.phone-toc-btn',
  '.fleet-composer-gutter',
] as const

const CORNER_CONTROL_SELECTOR = CORNER_CONTROL_SELECTORS.join(',')

const FLEET_GESTURE_FRAME_SELECTORS: GestureFrameSelectors = {
  viewportRoot: (viewportId) => `[data-viewport-id="${viewportId}"]`,
  viewportCanvas: '.clip-panel-canvas',
  elementChainStopClass: 'fleet-hud-wrap',
}

function screenPointToOverlayPage(overlay: Editor, clientX: number, clientY: number, viewportId?: string) {
  return screenPointToFramePage(overlay, clientX, clientY, {
    viewportId,
    selectors: FLEET_GESTURE_FRAME_SELECTORS,
  })
}

function touchDiagEnabled() {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).has('touchDiag')
  } catch {
    return false
  }
}

function summarizeTouchDiag(msg: string, data: Record<string, unknown>) {
  if (msg === 'fleet hud state') {
    return [
      `expanded=${String(data.expanded)}`,
      `bounds=${String(data.hasFleetBounds)}`,
      `optIn=${String(data.fleetGesturesOptIn)}`,
      `gestures=${String(data.gesturesEnabled)}`,
      `fleet=${String(data.myFleetShapeCount ?? '?')}`,
      `doc=${String(data.docShapeCount ?? '?')}`,
      `hud=${String(data.hasHudRef)}`,
      `overlay=${String(data.hasOverlayEditor)}`,
    ].join(' ')
  }
  if (msg === 'two-touch classification') {
    return [
      `cluster=${String(data.isCluster)}`,
      `dom=${JSON.stringify(data.domSpanIds ?? [])}`,
      `geom=${JSON.stringify(data.geometrySpanIds ?? [])}`,
      `seed=${JSON.stringify(data.clusterSeedIds ?? [])}`,
      `common=${JSON.stringify(data.commonPanel ?? null)}`,
    ].join(' ')
  }
  if (msg === 'gesture start: shape') return `shape=${String(data.id ?? '?')}`
  if (msg === 'gesture start: cluster') return `shapes=${JSON.stringify(data.shapeIds ?? [])}`
  if (msg === 'shape soft gesture active' || msg === 'cluster soft gesture active') {
    return [
      `move=${String(data.moveActive)}`,
      `resize=${String(data.resizeActive)}`,
      `travel=${Math.round(Number(data.travel) || 0)}`,
      `spread=${Math.round(Number(data.spread) || 0)}`,
    ].join(' ')
  }
  if (msg.endsWith('write')) {
    return [
      data.id ? `shape=${String(data.id)}` : `shapes=${JSON.stringify(data.shapeIds ?? [])}`,
      data.dx !== undefined ? `dx=${Math.round(Number(data.dx) || 0)}` : null,
      data.dy !== undefined ? `dy=${Math.round(Number(data.dy) || 0)}` : null,
      data.scale !== undefined ? `scale=${Number(data.scale).toFixed(2)}` : null,
      data.scaleX !== undefined ? `scaleX=${Number(data.scaleX).toFixed(2)}` : null,
      data.scaleY !== undefined ? `scaleY=${Number(data.scaleY).toFixed(2)}` : null,
    ].filter(Boolean).join(' ')
  }
  return ''
}

export function setTouchDiagStatus(msg: string, data: Record<string, unknown> = {}) {
  if (!touchDiagEnabled()) return
  try {
    ;(window as any).__fleetGestureDiagStatus = {
      build: TOUCH_TELEMETRY_BUILD,
      msg,
      data,
      updatedAt: new Date().toISOString(),
    }
    let el = document.getElementById('fleet-gesture-diag')
    if (!el) {
      el = document.createElement('div')
      el.id = 'fleet-gesture-diag'
      el.style.cssText = [
        'position:fixed',
        'left:8px',
        'bottom:8px',
        'z-index:2147483647',
        'max-width:min(760px,calc(100vw - 16px))',
        'padding:6px 8px',
        'border:1px solid rgba(255,255,255,.65)',
        'border-radius:6px',
        'background:rgba(0,0,0,.78)',
        'color:#fff',
        'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
        'white-space:pre-wrap',
        'pointer-events:none',
      ].join(';')
      document.body.appendChild(el)
    }
    const detail = summarizeTouchDiag(msg, data)
    el.textContent = `${TOUCH_TELEMETRY_BUILD}\n${msg}${detail ? `\n${detail}` : ''}`
  } catch {
    // Diagnostic UI must never affect gesture behavior.
  }
}

export function postTouchTelemetry(msg: string, data: Record<string, unknown> = {}) {
  if (typeof window === 'undefined') return
  setTouchDiagStatus(msg, data)
  const payload = {
    ts: new Date().toISOString(),
    level: 'warn',
    ns: TOUCH_TELEMETRY_NS,
    msg,
    session: ((window as any).__fleetGestureTelemetrySession ||= Math.random().toString(36).slice(2, 10)),
    data: {
      build: TOUCH_TELEMETRY_BUILD,
      href: window.location.href,
      userAgent: navigator.userAgent,
      ...data,
    },
  }
  try {
    const body = JSON.stringify(payload)
    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon('/api/log', new Blob([body], { type: 'application/json' }))
      if (ok) return
    }
    void fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    })
  } catch {
    // Telemetry must never affect gesture behavior.
  }
}

function getMainEditor(fallback: Editor): Editor {
  if (typeof window !== 'undefined') {
    const w = (window as any).__tldraw_editor__ as Editor | undefined
    if (w) return w
  }
  return fallback
}

const touchDist = (a: Touch, b: Touch) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
const touchSpan = (a: Touch, b: Touch) => ({
  x: Math.abs(b.clientX - a.clientX),
  y: Math.abs(b.clientY - a.clientY),
})
function touchCenter(ts: Touch[]) {
  let x = 0, y = 0
  for (const t of ts) { x += t.clientX; y += t.clientY }
  return { x: x / ts.length, y: y / ts.length }
}

function rectWidth(r: any): number {
  return r?.w ?? r?.width ?? 0
}

function rectHeight(r: any): number {
  return r?.h ?? r?.height ?? 0
}

function shapeWidth(shape: any): number {
  return shape?.props?.w ?? shape?.w ?? 0
}

function shapeHeight(shape: any): number {
  return shape?.props?.h ?? shape?.h ?? 0
}

function cornerControlAtPoint(clientX: number, clientY: number): Element | null {
  return gestureCornerControlAtPoint(clientX, clientY, CORNER_CONTROL_SELECTOR)
}

type FleetHit = {
  shape: TLShape
  source: 'dom' | 'geometry'
  rawShapeId?: string
  rawShapeType?: string
}

function isMyGestureFleetShape(shape: TLShape | null | undefined): shape is TLShape {
  return !!shape && FLEET_SHAPE_TYPES.has(shape.type as string) && isMyFleetShape(shape)
}

function topLevelFleetShape(overlay: Editor, shape: TLShape): TLShape {
  let cur = shape
  while (cur.parentId) {
    const parent = overlay.getShape(cur.parentId as any)
    if (!parent || !isMyGestureFleetShape(parent)) break
    cur = parent
  }
  return cur
}

// The fleet shape (if any) under a screen point. The rendered DOM is the source
// of truth for "what is visibly under the finger"; overlay geometry is only a
// fallback when the DOM node is culled.
function fleetHitAtScreen(
  overlay: Editor,
  clientX: number,
  clientY: number,
  viewportId?: string,
  opts: { ignoreCornerControls?: boolean } = {},
): FleetHit | null {
  if (!opts.ignoreCornerControls && cornerControlAtPoint(clientX, clientY)) return null
  const el = document.elementFromPoint(clientX, clientY)
  const hudWrap = el?.closest?.('.fleet-hud-wrap') as HTMLElement | null
  if (el && hudWrap) {
    let cur: Element | null = el
    let outerFleetEl: HTMLElement | null = null
    while (cur && cur !== hudWrap.parentElement) {
      if (cur instanceof HTMLElement) {
        const id = cur.getAttribute('data-shape-id')
        const type = cur.getAttribute('data-shape-type')
        if (id && type && FLEET_SHAPE_TYPES.has(type)) outerFleetEl = cur
      }
      if (cur === hudWrap) break
      cur = cur.parentElement
    }
    const domShapeId = outerFleetEl?.getAttribute('data-shape-id')
    const domShapeType = outerFleetEl?.getAttribute('data-shape-type')
    if (domShapeId && domShapeType && FLEET_SHAPE_TYPES.has(domShapeType)) {
      const domShape = overlay.getShape(domShapeId as any)
      if (isMyGestureFleetShape(domShape)) {
        const shape = topLevelFleetShape(overlay, domShape)
        return { shape, source: 'dom', rawShapeId: domShape.id as string, rawShapeType: domShape.type as string }
      }
    }
  }

  const page = screenPointToOverlayPage(overlay, clientX, clientY, viewportId)
  const shape = overlay.getShapeAtPoint(page, { hitInside: true, margin: 0 })
  if (isMyGestureFleetShape(shape)) {
    const top = topLevelFleetShape(overlay, shape)
    return { shape: top, source: 'geometry', rawShapeId: shape.id as string, rawShapeType: shape.type as string }
  }
  // Walk up to a fleet ancestor (e.g. a nested child like a chat inside a container)
  let cur: TLShape | null | undefined = shape as TLShape | null | undefined
  while (cur) {
    const parent = overlay.getShape(cur.parentId as any)
    if (!parent) break
    if (isMyGestureFleetShape(parent)) {
      const top = topLevelFleetShape(overlay, parent)
      return { shape: top, source: 'geometry', rawShapeId: parent.id as string, rawShapeType: parent.type as string }
    }
    cur = parent
  }

  return null
}

function containingFleetPanelsAtPoint(
  overlay: Editor,
  clientX: number,
  clientY: number,
  opts: { ignoreCornerControls?: boolean } = {},
): TLShape[] {
  if (!opts.ignoreCornerControls && cornerControlAtPoint(clientX, clientY)) return []
  const hits: { shape: TLShape; area: number }[] = []
  for (const node of Array.from(document.querySelectorAll('.fleet-hud-wrap [data-shape-id]'))) {
    if (!(node instanceof HTMLElement)) continue
    const id = node.getAttribute('data-shape-id')
    const type = node.getAttribute('data-shape-type')
    if (!id || !type || !FLEET_SHAPE_TYPES.has(type)) continue
    const rect = node.getBoundingClientRect()
    if (!(rect.width > 0) || !(rect.height > 0)) continue
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue
    const shape = overlay.getShape(id as any)
    if (!isMyGestureFleetShape(shape)) continue
    hits.push({ shape: topLevelFleetShape(overlay, shape), area: rect.width * rect.height })
  }
  return hits
    .sort((a, b) => a.area - b.area)
    .map(hit => hit.shape)
}

function commonContainingFleetPanel(overlay: Editor, a: Touch, b: Touch): TLShape | null {
  const aPanels = containingFleetPanelsAtPoint(overlay, a.clientX, a.clientY)
  if (aPanels.length === 0) return null
  const bPanelIds = new Set(containingFleetPanelsAtPoint(overlay, b.clientX, b.clientY).map(shape => shape.id))
  return aPanels.find(shape => bPanelIds.has(shape.id)) ?? null
}

function touchDiagnostics(overlay: Editor | null, touches: Touch[], viewportId?: string) {
  return touches.map((t, index) => {
    const hit = overlay ? fleetHitAtScreen(overlay, t.clientX, t.clientY, viewportId) : null
    const shape = hit?.shape ?? null
    return {
      index,
      identifier: t.identifier,
      clientX: Math.round(t.clientX),
      clientY: Math.round(t.clientY),
      fleetShapeId: shape?.id ?? null,
      fleetShapeType: shape?.type ?? null,
      fleetHitSource: hit?.source ?? null,
      rawFleetShapeId: hit?.rawShapeId ?? null,
      rawFleetShapeType: hit?.rawShapeType ?? null,
      elementChain: elementChainAt(t.clientX, t.clientY, FLEET_GESTURE_FRAME_SELECTORS),
    }
  })
}

function touchHitSummary(overlay: Editor | null, touches: Touch[], viewportId?: string) {
  return touches.map((t, index) => {
    const hit = overlay ? fleetHitAtScreen(overlay, t.clientX, t.clientY, viewportId) : null
    const shape = hit?.shape ?? null
    return {
      index,
      identifier: t.identifier,
      clientX: Math.round(t.clientX),
      clientY: Math.round(t.clientY),
      fleetShapeId: shape?.id ?? null,
      fleetShapeType: shape?.type ?? null,
      fleetHitSource: hit?.source ?? null,
      rawFleetShapeId: hit?.rawShapeId ?? null,
      rawFleetShapeType: hit?.rawShapeType ?? null,
    }
  })
}

function logTouchSnapshot(
  phase: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  e: TouchEvent,
  overlay: Editor | null,
  hudEl: HTMLDivElement,
  stateKind: GestureState['kind'],
) {
  if (!log.isEnabled(LOG_NS, 'debug')) return
  if (phase === 'touchstart' || phase === 'touchmove') {
    log.debug(LOG_NS, phase, {
      touchesLength: e.touches.length,
      changedTouchesLength: e.changedTouches.length,
      stateKind,
      touches: touchHitSummary(overlay, Array.from(e.touches)),
    })
  }
  log.debug(LOG_NS, phase, {
    touchesLength: e.touches.length,
    changedTouchesLength: e.changedTouches.length,
    stateKind,
    target: describeElement(e.target instanceof Element ? e.target : null),
    hudPointerEvents: describeElement(hudEl)?.pointerEvents ?? null,
    touches: touchDiagnostics(overlay, Array.from(e.touches)),
    changedTouches: touchDiagnostics(overlay, Array.from(e.changedTouches)),
  })
}

function consumeTouchEvent(e: TouchEvent) {
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
}

// My fleet shapes that share a margin with the seed shapes. Source the set from
// the OVERLAY editor, not the main store: the overlay holds only my current
// (identity, device) shapes, so other devices' sets and junk-identity orphans —
// which live in the shared room but are NOT in the HUD — can't pollute the
// cluster (the bug where foreign shapes with no HUD element defaulted to "left").
// The split itself is on what the user sees: each panel's on-SCREEN center-x vs
// the document's on-SCREEN center-x (page coords don't line up — the doc is in
// the main-camera frame, the panels in the overlay's override-camera frame).
function clusterOf(overlay: Editor, seedIds: Set<string>, viewportId?: string): TLShape[] {
  const fleet = overlay.getCurrentPageShapes().filter(isMyGestureFleetShape)
  if (fleet.length === 0) return []
  // Document's screen center-x, read from the doc page's actual rendered DOM rect
  // on the main canvas — the SAME getBoundingClientRect frame as the panels below
  // (pageToScreen doesn't line up with where the doc actually paints under the HUD).
  const docEls = Array.from(document.querySelectorAll('[data-shape-type="svg-page"], [data-shape-type="html-page"]'))
    .filter(el => !el.closest('.fleet-hud-wrap'))
  let docScreenMidX = window.innerWidth / 2
  if (docEls.length) {
    const rs = docEls.map(el => el.getBoundingClientRect())
    docScreenMidX = (Math.min(...rs.map(r => r.left)) + Math.max(...rs.map(r => r.right))) / 2
  }
  // Each panel's screen center-x, read from its rendered DOM element (which the
  // override camera has already positioned), so both sides are in screen space.
  // When TLDraw culls the DOM for a visible-in-geometry HUD shape, fall back to
  // the overlay camera and page bounds; this is the same coordinate frame that
  // the gesture hit-test uses.
  const sideOf = (id: string): 'L' | 'R' | null => {
    const el = document.querySelector(`.fleet-hud-wrap [data-shape-id="${id}"]`)
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) return (r.left + r.right) / 2 < docScreenMidX ? 'L' : 'R'
    }
    const shape = overlay.getShape(id as any) as any
    const bounds = overlay.getShapePageBounds(id as any) as any
    if (!shape && !bounds) return null
    const boundsX = bounds?.x ?? shape?.x
    const boundsWidth = rectWidth(bounds) || shapeWidth(shape)
    if (!(boundsWidth > 0)) return null
    const cam = getGestureViewportCamera(overlay, viewportId)
    const containerRect = getGestureViewportContainer(overlay, viewportId, FLEET_GESTURE_FRAME_SELECTORS).getBoundingClientRect()
    const centerX = containerRect.left + (boundsX + boundsWidth / 2 + cam.x) * cam.z
    return centerX < docScreenMidX ? 'L' : 'R'
  }
  const seedSides = new Set([...seedIds].map(id => sideOf(id)).filter(Boolean) as ('L' | 'R')[])
  if (seedSides.size === 0) {
    log.warn(LOG_NS, 'cluster abort: seeds have no resolved margin', {
      seedIds: [...seedIds],
    })
    return []
  }
  return fleet.filter(s => {
    const side = sideOf(s.id)
    return side !== null && seedSides.has(side)
  })
}

// 3-finger pan soft axis lock (Skip's "soft/breakable" choice — cf. the hard-snap
// variant in src/hooks/usePanMode.ts). Engage after a little travel, bias hard to
// the dominant axis but leave a sliver of off-axis motion (soft, not rigid), and
// let a decisive off-axis push re-pick the axis mid-drag (breakable — no pause
// needed). The accumulators decay each move so the axis tracks RECENT travel.

type GestureState =
  | { kind: 'none' }
  | { kind: 'shape'; mode: 'pending' | 'combined'; moveActive: boolean; resizeActive: boolean; id: string; type: string; x0: number; y0: number; w0: number; h0: number; d0: number; sx0: number; sy0: number; relX: number; relY: number; c0: { x: number; y: number }; p0: { x: number; y: number }; resizeAxis: 'x' | 'y' | null; resizeAccX: number; resizeAccY: number; writeCount: number }
  | { kind: 'cluster'; mode: 'pending' | 'combined'; moveActive: boolean; resizeActive: boolean; shapes: { id: string; type: string; x0: number; y0: number; w0: number; h0: number }[]; anchor: { x: number; y: number }; d0: number; sx0: number; sy0: number; c0: { x: number; y: number }; p0: { x: number; y: number }; writeCount: number }
  // 3-finger: pan the main canvas from anywhere (even over the panels). Drive the
  // main camera; the HUD's camera-poll mirrors a main-camera pan onto the HUD.
  // Keep z byte-identical — a z wobble makes the poll skip the HUD update.
  // Integrates incremental deltas (lastC) so a soft axis lock can damp the
  // off-axis without the camera jumping when the lock breaks mid-drag.
  | { kind: 'pan'; z0: number; lastC: { x: number; y: number }; axis: 'x' | 'y' | null; accX: number; accY: number }

export function useFleetGestures(opts: {
  hudRef: React.RefObject<HTMLDivElement | null>
  overlayEditorRef: React.MutableRefObject<Editor | null>
  mainEditor: Editor
  expanded: boolean
  viewportId?: string
}) {
  const { hudRef, overlayEditorRef, mainEditor, expanded, viewportId } = opts

  useEffect(() => {
    if (!expanded) return
    const el = hudRef.current
    if (!el) return

    let state: GestureState = { kind: 'none' }
    fleetTouchGestureActiveRef.current = false
    const w = window as any
    let clearActiveTimer = 0
    const previousCleanup = w.__fleetGestureCleanup as (() => void) | undefined
    if (previousCleanup) {
      log.warn(LOG_NS, 'replacing existing gesture listener singleton', {})
      previousCleanup()
    }
    const mountId = (w.__fleetGestureMountId = (w.__fleetGestureMountId || 0) + 1)
    let disposed = false

    log.warn(LOG_NS, 'gesture listener installed', {
      target: 'hud',
      mountId,
      expanded,
      hudPointerEvents: describeElement(el)?.pointerEvents ?? null,
    })
    postTouchTelemetry('listener installed', {
      target: 'hud',
      mountId,
      expanded,
      hudPointerEvents: describeElement(el)?.pointerEvents ?? null,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        visualWidth: window.visualViewport?.width ?? null,
        visualHeight: window.visualViewport?.height ?? null,
        visualScale: window.visualViewport?.scale ?? null,
      },
    })

    const setGestureActive = (active: boolean, holdMs = 0) => {
      if (clearActiveTimer) {
        window.clearTimeout(clearActiveTimer)
        clearActiveTimer = 0
      }
      if (active || holdMs === 0) {
        if (fleetTouchGestureActiveRef.current !== active) {
          fleetTouchGestureActiveRef.current = active
          window.dispatchEvent(new CustomEvent('fleet-gesture-active-change', { detail: { active } }))
        }
        return
      }
      clearActiveTimer = window.setTimeout(() => {
        clearActiveTimer = 0
        if (state.kind === 'none' && fleetTouchGestureActiveRef.current) {
          fleetTouchGestureActiveRef.current = false
          window.dispatchEvent(new CustomEvent('fleet-gesture-active-change', { detail: { active: false } }))
        }
      }, holdMs)
    }

    const markEventHandled = (e: TouchEvent) => {
      const ww = window as any
      let seen = ww.__fleetGestureSeenEvents as WeakSet<TouchEvent> | undefined
      if (!seen) {
        seen = new WeakSet<TouchEvent>()
        ww.__fleetGestureSeenEvents = seen
      }
      if (seen.has(e)) return true
      seen.add(e)
      return false
    }

    const onTouchStart = (e: TouchEvent) => {
      if (markEventHandled(e)) return
      const overlay = overlayEditorRef.current
      const ts = Array.from(e.touches)
      logTouchSnapshot('touchstart', e, overlay, el, state.kind)
      if (ts.length <= 1 && state.kind !== 'none') {
        log.warn(LOG_NS, 'stale gesture state reset on fresh touchstart', {
          previousKind: state.kind,
          touchesLength: ts.length,
        })
        state = { kind: 'none' }
        setGestureActive(false)
      }
      if (!overlay) return
      const main = getMainEditor(mainEditor)

      if (ts.length === 3) {
        // Three fingers always pan the document canvas, including when the
        // gesture starts over a fleet panel. The HUD camera mirror keeps the
        // document and fleet surface moving together.
        consumeTouchEvent(e)
        setGestureActive(true)
        const cam = main.getCamera()
        state = { kind: 'pan', z0: cam.z, lastC: touchCenter(ts), axis: null, accX: 0, accY: 0 }
        log.info(LOG_NS, 'gesture start: pan', { touchesLength: ts.length, z: cam.z })
        return
      }

      if (ts.length === 2) {
        const hit0 = fleetHitAtScreen(overlay, ts[0].clientX, ts[0].clientY, viewportId)
        const hit1 = fleetHitAtScreen(overlay, ts[1].clientX, ts[1].clientY, viewportId)
        const s0 = hit0?.shape ?? null
        const s1 = hit1?.shape ?? null
        postTouchTelemetry('two-touch start', {
          touches: ts.map(t => ({
            identifier: t.identifier,
            clientX: Math.round(t.clientX),
            clientY: Math.round(t.clientY),
          })),
          target: describeElement(e.target instanceof Element ? e.target : null),
          hudPointerEvents: describeElement(el)?.pointerEvents ?? null,
        })
        log.warn(LOG_NS, 'two-touch hit-test', {
          first: s0 ? { id: s0.id, type: s0.type, source: hit0?.source, rawId: hit0?.rawShapeId, rawType: hit0?.rawShapeType } : null,
          second: s1 ? { id: s1.id, type: s1.type, source: hit1?.source, rawId: hit1?.rawShapeId, rawType: hit1?.rawShapeType } : null,
        })
        postTouchTelemetry('two-touch hit-test', {
          first: s0 ? { id: s0.id, type: s0.type, source: hit0?.source, rawId: hit0?.rawShapeId, rawType: hit0?.rawShapeType } : null,
          second: s1 ? { id: s1.id, type: s1.type, source: hit1?.source, rawId: hit1?.rawShapeId, rawType: hit1?.rawShapeType } : null,
        })
        if (!s0 && !s1) {
          log.debug(LOG_NS, 'gesture pass-through: no fleet shape under either touch', {})
          state = { kind: 'none' }
          setGestureActive(false)
          return // not on a fleet shape → let TLDraw pan/zoom
        }
        const commonPanel = commonContainingFleetPanel(overlay, ts[0], ts[1])
        const domSpanIds = new Set(
          [hit0, hit1]
            .filter((hit): hit is FleetHit => !!hit && hit.source === 'dom')
            .map(hit => hit.shape.id),
        )
        const geometrySpanIds = new Set([s0?.id, s1?.id].filter(Boolean) as string[])
        const clusterSeedIds = commonPanel
          ? new Set([commonPanel.id])
          : domSpanIds.size > 1
            ? domSpanIds
            : domSpanIds
        const isCluster = clusterSeedIds.size > 1
        log.warn(LOG_NS, 'two-touch classification', {
          domSpanIds: [...domSpanIds],
          geometrySpanIds: [...geometrySpanIds],
          clusterSeedIds: [...clusterSeedIds],
          isCluster,
          commonPanel: commonPanel ? { id: commonPanel.id, type: commonPanel.type } : null,
        })
        postTouchTelemetry('two-touch classification', {
          domSpanIds: [...domSpanIds],
          geometrySpanIds: [...geometrySpanIds],
          clusterSeedIds: [...clusterSeedIds],
          isCluster,
          commonPanel: commonPanel ? { id: commonPanel.id, type: commonPanel.type } : null,
        })

        if (!isCluster) {
          // At least one finger is on a single fleet shape → move/pinch that shape.
          // If the second finger lands just outside the panel, do NOT promote this
          // to a margin-cluster gesture; that makes single-panel drags move a group.
          const shape = (commonPanel ?? (hit0?.source === 'dom' ? s0 : hit1?.source === 'dom' ? s1 : s0 ?? s1))!
          const b = overlay.getShapePageBounds(shape.id)
          if (!b) {
            log.warn(LOG_NS, 'gesture abort: no overlay bounds for shape', { id: shape.id, type: shape.type })
            setGestureActive(false)
            return
          }
          const w0 = rectWidth(b) || shapeWidth(shape)
          const height0 = rectHeight(b) || shapeHeight(shape)
          if (!(w0 > 0) || !(height0 > 0)) {
            log.warn(LOG_NS, 'gesture abort: unresolved overlay bounds for shape', {
              id: shape.id,
              type: shape.type,
              bounds: b,
              props: (shape as any).props ?? null,
            })
            setGestureActive(false)
            return
          }
          consumeTouchEvent(e)
          setGestureActive(true)
          main.markHistoryStoppingPoint()
          const mainShape = (main.getShape(shape.id as any) ?? overlay.getShape(shape.id as any)) as any
          const c0 = touchCenter(ts)
          const pivotPage = screenPointToOverlayPage(overlay, c0.x, c0.y, viewportId)
          const boundsAny = b as any
          const boundsX = boundsAny?.x ?? 0
          const boundsY = boundsAny?.y ?? 0
          const relX = w0 * Math.max(0, Math.min(1, w0 > 0 ? (pivotPage.x - boundsX) / w0 : 0.5))
          const relY = height0 * Math.max(0, Math.min(1, height0 > 0 ? (pivotPage.y - boundsY) / height0 : 0.5))
          const span0 = touchSpan(ts[0], ts[1])
          state = {
            kind: 'shape', mode: 'pending', moveActive: false, resizeActive: false, id: shape.id, type: shape.type as string,
            x0: mainShape.x, y0: mainShape.y,
            w0, h0: height0, d0: touchDist(ts[0], ts[1]), sx0: span0.x, sy0: span0.y, relX, relY, c0, p0: pivotPage,
            resizeAxis: null, resizeAccX: 0, resizeAccY: 0, writeCount: 0,
          }
          log.warn(LOG_NS, 'gesture start: shape', {
            id: shape.id,
            type: shape.type,
            bounds: { w: w0, h: height0 },
            distance: touchDist(ts[0], ts[1]),
            center: c0,
            localPivot: { x: relX, y: relY },
            overlayPivot: pivotPage,
            overlayBounds: { x: boundsX, y: boundsY, w: w0, h: height0 },
          })
          postTouchTelemetry('gesture start: shape', {
            id: shape.id,
            type: shape.type,
            bounds: { w: w0, h: height0 },
            distance: touchDist(ts[0], ts[1]),
            center: c0,
            localPivot: { x: relX, y: relY },
            overlayPivot: pivotPage,
            overlayBounds: { x: boundsX, y: boundsY, w: w0, h: height0 },
          })
        } else {
          // Fingers positively span >1 shape → move OR pinch-resize that margin's cluster.
          const shapes = clusterOf(overlay, clusterSeedIds, viewportId).map(s => {
            const m = (main.getShape(s.id as any) ?? overlay.getShape(s.id as any)) as any
            const b = overlay.getShapePageBounds(s.id)
            return {
              id: s.id,
              type: s.type as string,
              x0: m.x,
              y0: m.y,
              w0: (b ? rectWidth(b) : 0) || shapeWidth(m),
              h0: (b ? rectHeight(b) : 0) || shapeHeight(m),
            }
          })
          const validShapes = shapes.filter(s => s.w0 > 0 && s.h0 > 0)
          if (validShapes.length === 0) {
            log.warn(LOG_NS, 'gesture abort: empty cluster', { seedIds: [...clusterSeedIds], shapes })
            setGestureActive(false)
            return
          }
          consumeTouchEvent(e)
          setGestureActive(true)
          main.markHistoryStoppingPoint()
          // Scale pivot = centroid of the panels' own positions+sizes. Computed
          // from the shapes (never a {0,0} fallback) — these page coords can be
          // huge, so a wrong pivot would fling them off into space.
          const cx = validShapes.reduce((a, s) => a + s.x0 + s.w0 / 2, 0) / validShapes.length
          const cy = validShapes.reduce((a, s) => a + s.y0 + s.h0 / 2, 0) / validShapes.length
          const span0 = touchSpan(ts[0], ts[1])
          const c0 = touchCenter(ts)
          state = { kind: 'cluster', mode: 'pending', moveActive: false, resizeActive: false, shapes: validShapes, anchor: { x: cx, y: cy }, d0: touchDist(ts[0], ts[1]), sx0: span0.x, sy0: span0.y, c0, p0: screenPointToOverlayPage(overlay, c0.x, c0.y, viewportId), writeCount: 0 }
          log.warn(LOG_NS, 'gesture start: cluster', {
            seedIds: [...clusterSeedIds],
            shapeIds: validShapes.map(s => s.id),
            anchor: { x: cx, y: cy },
            distance: touchDist(ts[0], ts[1]),
            center: touchCenter(ts),
          })
          postTouchTelemetry('gesture start: cluster', {
            seedIds: [...clusterSeedIds],
            shapeIds: validShapes.map(s => s.id),
            anchor: { x: cx, y: cy },
            distance: touchDist(ts[0], ts[1]),
            center: touchCenter(ts),
          })
        }
      }
      // 1 finger: not intercepted — the shape's own scroll handling runs.
    }

    const onTouchMove = (e: TouchEvent) => {
      if (markEventHandled(e)) return
      const overlay = overlayEditorRef.current
      logTouchSnapshot('touchmove', e, overlay, el, state.kind)
      if (state.kind === 'none') return
      if (!overlay) return
      const main = getMainEditor(mainEditor)
      const ts = Array.from(e.touches)

      if (state.kind === 'pan') {
        consumeTouchEvent(e)
        const c = touchCenter(ts)
        const idx = c.x - state.lastC.x // incremental delta since last move
        const idy = c.y - state.lastC.y
        state.lastC = c
        // Soft, breakable axis lock. Decay the accumulators so the axis is chosen
        // from RECENT travel: once past the threshold, lock to the dominant axis;
        // a decisive off-axis push (the other axis out-travels the locked one by
        // PAN_BREAK_RATIO) flips the lock mid-drag, no pause needed.
        state.accX = state.accX * PAN_AXIS_DECAY + Math.abs(idx)
        state.accY = state.accY * PAN_AXIS_DECAY + Math.abs(idy)
        if (state.accX + state.accY >= PAN_LOCK_INITIAL) {
          if (state.axis === null) state.axis = state.accY >= state.accX ? 'y' : 'x'
          else if (state.axis === 'y' && state.accX > state.accY * PAN_BREAK_RATIO) state.axis = 'x'
          else if (state.axis === 'x' && state.accY > state.accX * PAN_BREAK_RATIO) state.axis = 'y'
        }
        // Damp (not zero) the off-axis component — soft, not rigid.
        let mx = idx, my = idy
        if (state.axis === 'y') mx *= PAN_OFFAXIS_DAMP
        else if (state.axis === 'x') my *= PAN_OFFAXIS_DAMP
        // Integrate into the live camera. z written byte-identical (z0) every
        // frame — a z wobble makes the HUD camera-poll skip the pan mirror.
        const cam = main.getCamera()
        main.setCamera(
          { x: cam.x + mx / state.z0, y: cam.y + my / state.z0, z: state.z0 },
          { animation: { duration: 0 } },
        )
        return
      }

      if (state.kind === 'shape' && ts.length >= 2) {
        consumeTouchEvent(e)
        const c = touchCenter(ts)
        const d = touchDist(ts[0], ts[1])
        const span = touchSpan(ts[0], ts[1])
        const travel = Math.hypot(c.x - state.c0.x, c.y - state.c0.y) // center slide
        const spanDx = Math.abs(span.x - state.sx0)
        const spanDy = Math.abs(span.y - state.sy0)
        const spread = Math.max(Math.abs(d - state.d0), spanDx, spanDy) // pinch amount
        const { moveActive: nextMoveActive, resizeActive: nextResizeActive } = classifySoftGesture({
          moveActive: state.moveActive,
          resizeActive: state.resizeActive,
          travel,
          spread,
        })
        if (!nextMoveActive && !nextResizeActive && !state.moveActive && !state.resizeActive) return
        const activationChanged = nextMoveActive !== state.moveActive || nextResizeActive !== state.resizeActive
        state.mode = 'combined'
        state.moveActive = nextMoveActive
        state.resizeActive = nextResizeActive
        if (activationChanged) {
          log.warn(LOG_NS, 'shape soft gesture active', {
            id: state.id,
            moveActive: state.moveActive,
            resizeActive: state.resizeActive,
            travel,
            spread,
            moveThreshold: MOVE_LOCK_ON,
            resizeThreshold: RESIZE_LOCK_ON,
            resizeAfterMoveThreshold: RESIZE_LOCK_AFTER_MOVE,
          })
          postTouchTelemetry('shape soft gesture active', {
            id: state.id,
            moveActive: state.moveActive,
            resizeActive: state.resizeActive,
            travel,
            spread,
            moveThreshold: MOVE_LOCK_ON,
            resizeThreshold: RESIZE_LOCK_ON,
            resizeAfterMoveThreshold: RESIZE_LOCK_AFTER_MOVE,
          })
        }
        const pageCenter = screenPointToOverlayPage(overlay, c.x, c.y, viewportId)
        const dx = state.moveActive ? pageCenter.x - state.p0.x : 0
        const dy = state.moveActive ? pageCenter.y - state.p0.y : 0
        const scale = state.resizeActive && state.d0 > 0 ? d / state.d0 : 1
        let scaleX = state.resizeActive ? (state.sx0 >= 8 ? span.x / state.sx0 : scale) : 1
        let scaleY = state.resizeActive ? (state.sy0 >= 8 ? span.y / state.sy0 : scale) : 1
        if (state.resizeActive) {
          const locked = applyShapeResizeAxisLock({
            enabled: state.sx0 >= 8 && state.sy0 >= 8,
            axis: state.resizeAxis,
            accX: state.resizeAccX,
            accY: state.resizeAccY,
            spanDx,
            spanDy,
            scaleX,
            scaleY,
          })
          state.resizeAxis = locked.axis
          state.resizeAccX = locked.accX
          state.resizeAccY = locked.accY
          scaleX = locked.scaleX
          scaleY = locked.scaleY
        }
        const pivotX = state.x0 + state.relX + dx
        const pivotY = state.y0 + state.relY + dy
        const nextX = state.resizeActive ? pivotX - state.relX * scaleX : state.x0 + dx
        const nextY = state.resizeActive ? pivotY - state.relY * scaleY : state.y0 + dy
        const newW = Math.max(80, state.w0 * scaleX)
        const newH = Math.max(60, state.h0 * scaleY)
        main.updateShape({
          id: state.id as any,
          type: state.type as any,
          x: nextX,
          y: nextY,
          props: { w: newW, h: newH } as any,
        })
        state.writeCount += 1
        return
      }

      if (state.kind === 'cluster' && ts.length >= 2) {
        consumeTouchEvent(e)
        const c = touchCenter(ts)
        const d = touchDist(ts[0], ts[1])
        const span = touchSpan(ts[0], ts[1])
        const travel = Math.hypot(c.x - state.c0.x, c.y - state.c0.y)
        const spanDx = Math.abs(span.x - state.sx0)
        const spanDy = Math.abs(span.y - state.sy0)
        const spread = Math.max(Math.abs(d - state.d0), spanDx, spanDy)
        const { moveActive: nextMoveActive, resizeActive: nextResizeActive } = classifySoftGesture({
          moveActive: state.moveActive,
          resizeActive: state.resizeActive,
          travel,
          spread,
        })
        if (!nextMoveActive && !nextResizeActive && !state.moveActive && !state.resizeActive) return
        const activationChanged = nextMoveActive !== state.moveActive || nextResizeActive !== state.resizeActive
        state.mode = 'combined'
        state.moveActive = nextMoveActive
        state.resizeActive = nextResizeActive
        if (activationChanged) {
          log.warn(LOG_NS, 'cluster soft gesture active', {
            shapeIds: state.shapes.map(s => s.id),
            moveActive: state.moveActive,
            resizeActive: state.resizeActive,
            travel,
            spread,
            moveThreshold: MOVE_LOCK_ON,
            resizeThreshold: RESIZE_LOCK_ON,
            resizeAfterMoveThreshold: RESIZE_LOCK_AFTER_MOVE,
          })
          postTouchTelemetry('cluster soft gesture active', {
            shapeIds: state.shapes.map(s => s.id),
            moveActive: state.moveActive,
            resizeActive: state.resizeActive,
            travel,
            spread,
            moveThreshold: MOVE_LOCK_ON,
            resizeThreshold: RESIZE_LOCK_ON,
            resizeAfterMoveThreshold: RESIZE_LOCK_AFTER_MOVE,
          })
        }
        const pageCenter = screenPointToOverlayPage(overlay, c.x, c.y, viewportId)
        const dx = state.moveActive ? pageCenter.x - state.p0.x : 0
        const dy = state.moveActive ? pageCenter.y - state.p0.y : 0
        // Scale the whole cluster about its pivot, then translate it by the
        // finger center. Clamp so a wild pinch can't fling the panels.
        const raw = state.resizeActive && state.d0 > 0 ? d / state.d0 : 1
        const scale = Math.max(0.3, Math.min(3, raw))
        const scaleX = state.resizeActive ? Math.max(0.3, Math.min(3, state.sx0 >= 8 ? span.x / state.sx0 : scale)) : 1
        const scaleY = state.resizeActive ? Math.max(0.3, Math.min(3, state.sy0 >= 8 ? span.y / state.sy0 : scale)) : 1
        for (const s of state.shapes) {
          const baseX = state.anchor.x + (s.x0 - state.anchor.x) * scaleX
          const baseY = state.anchor.y + (s.y0 - state.anchor.y) * scaleY
          const newW = Math.max(80, s.w0 * scaleX)
          const newH = Math.max(60, s.h0 * scaleY)
          main.updateShape({
            id: s.id as any, type: s.type as any,
            x: baseX + dx,
            y: baseY + dy,
            props: { w: newW, h: newH } as any,
          })
        }
        state.writeCount += 1
        return
      }
    }

    const reset = (e: TouchEvent) => {
      if (markEventHandled(e)) return
      const overlay = overlayEditorRef.current
      logTouchSnapshot(e.type === 'touchcancel' ? 'touchcancel' : 'touchend', e, overlay, el, state.kind)
      if (state.kind !== 'none' && e.touches.length < 2) {
        log.debug(LOG_NS, 'gesture reset', { previousKind: state.kind, remainingTouches: e.touches.length, eventType: e.type })
      }
      if (e.touches.length < 2) state = { kind: 'none' }
      if (e.touches.length < 2) setGestureActive(false, 250)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false, capture: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
    el.addEventListener('touchend', reset, { capture: true })
    el.addEventListener('touchcancel', reset, { capture: true })
    const cleanup = () => {
      if (disposed) return
      disposed = true
      setGestureActive(false)
      if ((window as any).__fleetGestureCleanup === cleanup) {
        delete (window as any).__fleetGestureCleanup
      }
      log.warn(LOG_NS, 'gesture listener removed', { target: 'hud' })
      el.removeEventListener('touchstart', onTouchStart, true)
      el.removeEventListener('touchmove', onTouchMove, true)
      el.removeEventListener('touchend', reset, true)
      el.removeEventListener('touchcancel', reset, true)
    }
    w.__fleetGestureCleanup = cleanup
    return cleanup
  }, [expanded, hudRef, overlayEditorRef, mainEditor, viewportId])
}
