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
import { isDocumentPageShape } from '../shapes/document-pages'
import {
  MOVE_LOCK_ON,
  PAN_AXIS_DECAY,
  PAN_BREAK_RATIO,
  PAN_LOCK_INITIAL,
  PAN_OFFAXIS_DAMP,
  PHONE_LANE_SNAP_DURATION,
  RESIZE_LOCK_AFTER_MOVE,
  RESIZE_LOCK_ON,
  applyShapeResizeAxisLock,
  classifySoftGesture,
  phoneLaneDragDecision,
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
  '.voice-note-btn',
  '.mic-toggle-btn',
  '.fleet-icon-pill-container',
  '.fleet-icon-pill-badge',
  '.phone-toc-btn',
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

function touchRecordingEnabled() {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).has('touchRecord')
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

const touchDist = (a: Touch | RecordedTouchPoint, b: Touch | RecordedTouchPoint) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
const touchSpan = (a: Touch | RecordedTouchPoint, b: Touch | RecordedTouchPoint) => ({
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
// fallback for replay / culled DOM cases.
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

function fleetShapeAtScreen(overlay: Editor, clientX: number, clientY: number, viewportId?: string): TLShape | null {
  return fleetHitAtScreen(overlay, clientX, clientY, viewportId)?.shape ?? null
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

function stopTouchEvent(e: TouchEvent) {
  e.stopPropagation()
  e.stopImmediatePropagation()
}

function finishPhoneLaneGesture(main: Editor, state: Extract<GestureState, { kind: 'phone-lane' }>) {
  if (state.mode === 'dragging') {
    const screenW = main.getViewportScreenBounds().w
    const commit = phoneLaneCommitPx(screenW)
    const dir = state.lastDx > 0 ? 1 : state.lastDx < 0 ? -1 : 0
    // Static-until-threshold: the camera never moved during the drag, so on
    // release we either transition one lane (past the commit distance) or stay put.
    if (dir !== 0 && Math.abs(state.lastDx) >= commit && phoneLaneExistsInDirection(main, state.docLeftPage, dir)) {
      snapPhoneLaneDirectional(main, state.docLeftPage, dir)
    } else {
      // Re-settle exactly onto the current lane (no-op if already aligned).
      snapPhoneLane(main, state.docLeftPage)
    }
  }
  setPhoneLaneDrag(PHONE_LANE_DRAG_IDLE)
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

function isPhoneMode() {
  return typeof document !== 'undefined' && document.body.classList.contains('phone-mode')
}

function getPrimaryDocumentLeft(editor: Editor): number | null {
  const pages = editor.getCurrentPageShapes().filter(isDocumentPageShape)
  if (pages.length === 0) return null
  const viewport = editor.getViewportPageBounds()
  const midY = viewport.minY + viewport.height / 2
  let best: { x: number; d: number } | null = null
  for (const page of pages) {
    const bounds = editor.getShapePageBounds(page.id)
    if (!bounds) continue
    const d = Math.abs((bounds.y + bounds.h / 2) - midY)
    if (!best || d < best.d) best = { x: bounds.x, d }
  }
  return best?.x ?? null
}

// Settle onto the current lane (no transition). Uses the explicit lane index so a
// settle mid-animation can't drift the camera to a wrong stop.
function snapPhoneLane(editor: Editor, docLeftPage: number) {
  snapToPhoneLaneIndex(editor, docLeftPage, phoneLaneIndexFromCamera(editor, docLeftPage))
}

// --- Phone lane transition: big fill-up arrow, ~75%-screen deliberate swipe ---
// Within ONE continuous drag, a horizontal move fills a big center-screen arrow;
// crossing PHONE_LANE_COMMIT (fraction of screen width) transitions to the
// adjacent lane on release. The large threshold means short/choppy pans never
// fill it — you interact naturally, only a deliberate swipe changes lane. The
// arrow overlay (PhoneLaneArrow) reads this signal. Shared with PhoneHandTool so
// the document lane behaves the same (it pans AND fills at once).
const PHONE_LANE_COMMIT_FRAC = 0.75
const PHONE_LANE_COMMIT_MIN = 120

export type PhoneLaneDragState = { active: boolean; progress: number; dir: -1 | 0 | 1; armed: boolean }
export const PHONE_LANE_DRAG_IDLE: PhoneLaneDragState = { active: false, progress: 0, dir: 0, armed: false }
let phoneLaneDragState: PhoneLaneDragState = PHONE_LANE_DRAG_IDLE
const phoneLaneDragListeners = new Set<(s: PhoneLaneDragState) => void>()
export function subscribePhoneLaneDrag(cb: (s: PhoneLaneDragState) => void): () => void {
  phoneLaneDragListeners.add(cb)
  cb(phoneLaneDragState)
  return () => { phoneLaneDragListeners.delete(cb) }
}
export function setPhoneLaneDrag(next: PhoneLaneDragState) {
  if (
    next.active === phoneLaneDragState.active &&
    next.dir === phoneLaneDragState.dir &&
    next.armed === phoneLaneDragState.armed &&
    Math.abs(next.progress - phoneLaneDragState.progress) < 0.02
  ) return
  phoneLaneDragState = next
  phoneLaneDragListeners.forEach(cb => cb(next))
}

export function phoneLaneCommitPx(screenW: number): number {
  let referenceW = screenW
  if (typeof window !== 'undefined') {
    const vv = window.visualViewport
    const w = Number(vv?.width || window.innerWidth || screenW)
    const h = Number(vv?.height || window.innerHeight || screenW)
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      referenceW = Math.min(w, h)
    }
  }
  return Math.max(PHONE_LANE_COMMIT_MIN, referenceW * PHONE_LANE_COMMIT_FRAC)
}

// Explicit lane index — 0 = document, 1 = chat, 2 = agents/inbox (docLeftScreen =
// index * screenW). Fast repeated swipes read the camera MID snap-animation
// (between stops); measuring "which lane am I on" off that drifts a little each
// time and accumulates (agents ends up not-far-enough-left). So we keep an
// explicit index and only re-sync it from the camera when it's settled ON a stop.
let phoneLaneIndex = 1

// Current lane index. Re-syncs from the camera only when settled near a stop;
// mid-animation it trusts the stored index (the intended target of the last snap).
export function phoneLaneIndexFromCamera(editor: Editor, docLeftPage: number): number {
  const cam = editor.getCamera()
  const screenW = editor.getViewportScreenBounds().w
  if (!screenW || !Number.isFinite(screenW)) return phoneLaneIndex
  const cur = (docLeftPage + cam.x) * cam.z
  const nearest = Math.max(0, Math.min(2, Math.round(cur / screenW)))
  if (Math.abs(cur - nearest * screenW) < screenW * 0.2) phoneLaneIndex = nearest
  return phoneLaneIndex
}

export function snapToPhoneLaneIndex(editor: Editor, docLeftPage: number, index: number) {
  const cam = editor.getCamera()
  const screenW = editor.getViewportScreenBounds().w
  if (!screenW || !Number.isFinite(screenW)) return
  phoneLaneIndex = Math.max(0, Math.min(2, index))
  const x = (phoneLaneIndex * screenW) / cam.z - docLeftPage
  editor.setCamera({ ...cam, x }, { animation: { duration: PHONE_LANE_SNAP_DURATION } })
}

export function snapToCurrentPhoneLaneIndex(editor: Editor, docLeftPage: number, animationDuration = PHONE_LANE_SNAP_DURATION) {
  const cam = editor.getCamera()
  const screenW = editor.getViewportScreenBounds().w
  if (!screenW || !Number.isFinite(screenW)) return
  const index = phoneLaneIndexFromCamera(editor, docLeftPage)
  phoneLaneIndex = Math.max(0, Math.min(2, index))
  const x = (phoneLaneIndex * screenW) / cam.z - docLeftPage
  editor.setCamera({ ...cam, x }, { animation: { duration: animationDuration } })
}

// dir +1 pulls toward the agents/inbox lane, -1 toward the document lane. A lane
// exists in that direction unless we're already at an end.
export function phoneLaneExistsInDirection(editor: Editor, docLeftPage: number, dir: number): boolean {
  if (dir === 0) return false
  const next = phoneLaneIndexFromCamera(editor, docLeftPage) + dir
  return next >= 0 && next <= 2
}

export function snapPhoneLaneDirectional(editor: Editor, docLeftPage: number, dir: number) {
  snapToPhoneLaneIndex(editor, docLeftPage, phoneLaneIndexFromCamera(editor, docLeftPage) + dir)
}

type GestureState =
  | { kind: 'none' }
  | { kind: 'shape'; mode: 'pending' | 'combined'; moveActive: boolean; resizeActive: boolean; id: string; type: string; x0: number; y0: number; w0: number; h0: number; d0: number; sx0: number; sy0: number; relX: number; relY: number; c0: { x: number; y: number }; p0: { x: number; y: number }; resizeAxis: 'x' | 'y' | null; resizeAccX: number; resizeAccY: number; writeCount: number }
  | { kind: 'cluster'; mode: 'pending' | 'combined'; moveActive: boolean; resizeActive: boolean; shapes: { id: string; type: string; x0: number; y0: number; w0: number; h0: number }[]; anchor: { x: number; y: number }; d0: number; sx0: number; sy0: number; c0: { x: number; y: number }; p0: { x: number; y: number }; writeCount: number }
  | { kind: 'phone-lane'; mode: 'pending' | 'dragging'; x0: number; y0: number; cameraX0: number; z0: number; docLeftPage: number; lastDx: number }
  // 3-finger: pan the main canvas from anywhere (even over the panels). Drive the
  // main camera; the HUD's camera-poll mirrors a main-camera pan onto the HUD.
  // Keep z byte-identical — a z wobble makes the poll skip the HUD update.
  // Integrates incremental deltas (lastC) so a soft axis lock can damp the
  // off-axis without the camera jumping when the lock breaks mid-drag.
  | { kind: 'pan'; z0: number; lastC: { x: number; y: number }; axis: 'x' | 'y' | null; accX: number; accY: number }

type RecordedTouchPoint = {
  identifier: number
  clientX: number
  clientY: number
}

type RecordedTouchFrame = {
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel'
  dt: number
  touches: RecordedTouchPoint[]
  changedTouches: RecordedTouchPoint[]
  stateKind: GestureState['kind']
  hits: ReturnType<typeof touchHitSummary>
  overlayCamera: ReturnType<Editor['getCamera']> | null
  mainCamera: ReturnType<Editor['getCamera']>
}

type RecordedGesture = {
  id: string
  caseName?: GestureLibraryCase
  meta?: Record<string, unknown>
  startedAt: string
  durationMs: number
  frameCount: number
  frames: RecordedTouchFrame[]
}

type GestureLibraryCase =
  | 'shape-move'
  | 'shape-resize'
  | 'shape-move-resize'
  | 'shape-anisotropic-resize'
  | 'cluster-move'
  | 'canvas-pass-through'
  | 'three-finger-pan'

const MAX_RECORDED_GESTURES = 12
const MAX_RECORDED_FRAMES = 900

function compactTouch(t: Touch): RecordedTouchPoint {
  return {
    identifier: t.identifier,
    clientX: t.clientX,
    clientY: t.clientY,
  }
}

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
    const recordings = (w.__fleetGestureRecordings ||= []) as RecordedGesture[]
    let activeRecording: (Omit<RecordedGesture, 'durationMs' | 'frameCount'> & { startMs: number }) | null = null
    let replaying = false
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

    const finishRecording = () => {
      if (!activeRecording) return
      const finished: RecordedGesture = {
        id: activeRecording.id,
        startedAt: activeRecording.startedAt,
        durationMs: Math.round(performance.now() - activeRecording.startMs),
        frameCount: activeRecording.frames.length,
        frames: activeRecording.frames,
      }
      activeRecording = null
      recordings.push(finished)
      while (recordings.length > MAX_RECORDED_GESTURES) recordings.shift()
      try {
        window.localStorage.setItem('__fleetGestureRecordings', JSON.stringify(recordings.slice(-MAX_RECORDED_GESTURES)))
      } catch {
        // Logging still carries the trace if storage quota/private mode blocks localStorage.
      }
      log.info(LOG_NS, 'gesture recording complete', {
        id: finished.id,
        startedAt: finished.startedAt,
        durationMs: finished.durationMs,
        frameCount: finished.frameCount,
        frames: finished.frames,
      })
    }

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

    const recordTouchFrame = (e: TouchEvent, overlay: Editor | null, main: Editor, stateKind: GestureState['kind']) => {
      if (!touchRecordingEnabled()) return
      if (replaying) return
      const eventType = e.type as RecordedTouchFrame['type']
      if (!activeRecording && (eventType === 'touchstart' || e.touches.length >= 2)) {
        const startMs = performance.now()
        activeRecording = {
          id: `gesture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          startedAt: new Date().toISOString(),
          startMs,
          frames: [],
        }
      }
      if (!activeRecording) return
      if (activeRecording.frames.length >= MAX_RECORDED_FRAMES) {
        finishRecording()
        return
      }
      activeRecording.frames.push({
        type: eventType,
        dt: Math.round(performance.now() - activeRecording.startMs),
        touches: Array.from(e.touches).map(compactTouch),
        changedTouches: Array.from(e.changedTouches).map(compactTouch),
        stateKind,
        hits: touchHitSummary(overlay, Array.from(e.touches)),
        overlayCamera: overlay ? getGestureViewportCamera(overlay, viewportId) as any : null,
        mainCamera: main.getCamera(),
      })
      if ((eventType === 'touchend' || eventType === 'touchcancel') && e.touches.length < 2) {
        finishRecording()
      }
    }

    const simulateShapeMove = (opts?: { id?: string; dx?: number; dy?: number }) => {
      const overlay = overlayEditorRef.current
      if (!overlay) {
        log.warn(LOG_NS, 'debug simulate shape move abort: no overlay editor', {})
        return false
      }
      const main = getMainEditor(mainEditor)
      const shape = opts?.id
        ? overlay.getShape(opts.id as any)
        : overlay.getCurrentPageShapes().find(isMyGestureFleetShape)
      if (!isMyGestureFleetShape(shape)) {
        log.warn(LOG_NS, 'debug simulate shape move abort: no fleet shape', { requestedId: opts?.id ?? null })
        return false
      }
      const mainShape = main.getShape(shape.id as any) as any
      if (!mainShape) {
        log.warn(LOG_NS, 'debug simulate shape move abort: shape missing in main editor', { id: shape.id, type: shape.type })
        return false
      }
      const dx = opts?.dx ?? 24
      const dy = opts?.dy ?? 16
      setGestureActive(true)
      const before = { x: mainShape.x, y: mainShape.y }
      main.updateShape({ id: shape.id as any, type: shape.type as any, x: mainShape.x + dx, y: mainShape.y + dy })
      const afterShape = main.getShape(shape.id as any) as any
      log.info(LOG_NS, 'debug simulate shape move write', {
        id: shape.id,
        type: shape.type,
        dx,
        dy,
        mainBefore: before,
        mainAfter: afterShape ? { x: afterShape.x, y: afterShape.y } : null,
      })
      window.setTimeout(() => {
        setGestureActive(false)
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        log.info(LOG_NS, 'debug simulate shape move finished', { id: shape.id, type: shape.type })
      }, 120)
      return true
    }

    const pointToReplayTouch = (p: RecordedTouchPoint) => ({
      identifier: p.identifier,
      clientX: p.clientX,
      clientY: p.clientY,
    }) as Touch

    const replayEvent = (frame: RecordedTouchFrame): TouchEvent => ({
      type: frame.type,
      touches: frame.touches.map(pointToReplayTouch),
      changedTouches: frame.changedTouches.map(pointToReplayTouch),
      target: el,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    }) as any as TouchEvent

    const replay = async (recording?: RecordedGesture, speed = 1) => {
      const rec = recording ?? recordings[recordings.length - 1]
      if (!rec) {
        log.warn(LOG_NS, 'gesture replay abort: no recording', {})
        return false
      }
      replaying = true
      state = { kind: 'none' }
      setGestureActive(false)
      log.info(LOG_NS, 'gesture replay start', { id: rec.id, frameCount: rec.frames.length, speed })
      try {
        let prevDt = 0
        for (const frame of rec.frames) {
          const wait = Math.max(0, (frame.dt - prevDt) / Math.max(0.01, speed))
          prevDt = frame.dt
          if (wait > 0) await new Promise(resolve => window.setTimeout(resolve, wait))
          const ev = replayEvent(frame)
          if (frame.type === 'touchstart') onTouchStart(ev)
          else if (frame.type === 'touchmove') onTouchMove(ev)
          else reset(ev)
        }
      } finally {
        replaying = false
      }
      log.info(LOG_NS, 'gesture replay complete', { id: rec.id })
      return true
    }

    const makeReplayFrame = (
      main: Editor,
      overlay: Editor | null,
      type: RecordedTouchFrame['type'],
      dt: number,
      touches: RecordedTouchPoint[],
      changedTouches = touches,
    ): RecordedTouchFrame => ({
      type,
      dt,
      touches,
      changedTouches,
      stateKind: state.kind,
      hits: overlay ? touchHitSummary(overlay, touches.map(pointToReplayTouch)) : [],
      overlayCamera: overlay ? getGestureViewportCamera(overlay, viewportId) as any : null,
      mainCamera: main.getCamera(),
    })

    const makeReplayGesture = (
      name: GestureLibraryCase,
      frames: RecordedTouchFrame[],
      meta: Record<string, unknown> = {},
    ): RecordedGesture => {
      const rec = {
        id: `library-${name}-${Date.now().toString(36)}`,
        caseName: name,
        meta,
        startedAt: new Date().toISOString(),
        durationMs: frames[frames.length - 1]?.dt ?? 0,
        frameCount: frames.length,
        frames,
      }
      log.info(LOG_NS, 'gesture library case generated', { name, id: rec.id, frameCount: rec.frameCount, ...meta })
      return rec
    }

    const fleetDomTargets = () => {
      const overlay = overlayEditorRef.current
      if (!overlay) return []
      const containerRect = getGestureViewportContainer(overlay, viewportId, FLEET_GESTURE_FRAME_SELECTORS).getBoundingClientRect()
      const camera = getGestureViewportCamera(overlay, viewportId)
      return overlay.getCurrentPageShapes()
        .filter(isMyGestureFleetShape)
        .map(shape => {
          const dom = Array.from(document.querySelectorAll('.fleet-hud-wrap [data-shape-id]'))
            .find(node => node.getAttribute('data-shape-id') === shape.id)
          let rect: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null = null
          if (dom) {
            const domRect = dom.getBoundingClientRect()
            if (domRect.width > 0 && domRect.height > 0) rect = domRect
          }
          if (!rect) {
            const s = shape as any
            const bounds = overlay.getShapePageBounds(shape.id) as any
            const boundsX = bounds?.x ?? s.x
            const boundsY = bounds?.y ?? s.y
            const boundsWidth = rectWidth(bounds) || shapeWidth(s)
            const boundsHeight = rectHeight(bounds) || shapeHeight(s)
            if (!(boundsWidth > 0) || !(boundsHeight > 0)) return null
            const left = containerRect.left + (boundsX + camera.x) * camera.z
            const top = containerRect.top + (boundsY + camera.y) * camera.z
            const width = boundsWidth * camera.z
            const height = boundsHeight * camera.z
            rect = { left, top, right: left + width, bottom: top + height, width, height }
          }
          return {
            id: shape.id,
            type: shape.type as string,
            rect,
            center: { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 },
          }
        })
        .filter(Boolean)
        .sort((a, b) => (a!.rect.left - b!.rect.left) || (a!.rect.top - b!.rect.top)) as {
          id: string
          type: string
          rect: { left: number; top: number; right: number; bottom: number; width: number; height: number }
          center: { x: number; y: number }
        }[]
    }

    const findCanvasPoint = (overlay: Editor, avoid?: { x: number; y: number }) => {
      const xs = [0.50, 0.42, 0.58, 0.35, 0.65, 0.25, 0.75, 0.12, 0.88].map(v => window.innerWidth * v)
      const ys = [0.50, 0.42, 0.58, 0.35, 0.65, 0.25, 0.75, 0.04, 0.10, 0.16, 0.88].map(v => window.innerHeight * v)
      for (const y of ys) {
        for (const x of xs) {
          if (avoid && Math.hypot(x - avoid.x, y - avoid.y) < 90) continue
          if (!fleetShapeAtScreen(overlay, x, y)) return { x, y }
        }
      }
      return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    }

    const twoTouchFrames = (
      main: Editor,
      overlay: Editor | null,
      startA: RecordedTouchPoint,
      startB: RecordedTouchPoint,
      endA: RecordedTouchPoint,
      endB: RecordedTouchPoint,
      steps = 8,
    ) => {
      const frames = [makeReplayFrame(main, overlay, 'touchstart', 0, [startA, startB], [startA, startB])]
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const a = {
          identifier: startA.identifier,
          clientX: startA.clientX + (endA.clientX - startA.clientX) * t,
          clientY: startA.clientY + (endA.clientY - startA.clientY) * t,
        }
        const b = {
          identifier: startB.identifier,
          clientX: startB.clientX + (endB.clientX - startB.clientX) * t,
          clientY: startB.clientY + (endB.clientY - startB.clientY) * t,
        }
        frames.push(makeReplayFrame(main, overlay, 'touchmove', i * 16, [a, b], [a, b]))
      }
      frames.push(makeReplayFrame(main, overlay, 'touchend', (steps + 1) * 16, [], [endA, endB]))
      return frames
    }

    const makeLibraryGesture = (name: GestureLibraryCase): RecordedGesture | null => {
      const overlay = overlayEditorRef.current
      if (!overlay) {
        log.warn(LOG_NS, 'gesture library abort: no overlay editor', { name })
        return null
      }
      const main = getMainEditor(mainEditor)
      const targets = fleetDomTargets()
      const p = (identifier: number, clientX: number, clientY: number): RecordedTouchPoint => ({ identifier, clientX, clientY })

      if (name === 'canvas-pass-through') {
        const a = findCanvasPoint(overlay)
        const b = findCanvasPoint(overlay, a)
        return makeReplayGesture(name, twoTouchFrames(main, overlay, p(1, a.x, a.y), p(2, b.x, b.y), p(1, a.x + 80, a.y + 20), p(2, b.x + 80, b.y + 20)), {
          start: [a, b],
          expectedState: 'none',
        })
      }

      if (name === 'three-finger-pan') {
        const a = findCanvasPoint(overlay)
        const touches = [p(1, a.x - 50, a.y), p(2, a.x, a.y + 35), p(3, a.x + 50, a.y)]
        const moved = touches.map(t => ({ ...t, clientX: t.clientX + 90, clientY: t.clientY + 45 }))
        const frames = [makeReplayFrame(main, overlay, 'touchstart', 0, touches, touches)]
        for (let i = 1; i <= 8; i++) {
          const t = i / 8
          const step = touches.map((start, index) => ({
            identifier: start.identifier,
            clientX: start.clientX + (moved[index].clientX - start.clientX) * t,
            clientY: start.clientY + (moved[index].clientY - start.clientY) * t,
          }))
          frames.push(makeReplayFrame(main, overlay, 'touchmove', i * 16, step, step))
        }
        frames.push(makeReplayFrame(main, overlay, 'touchend', 144, [], moved))
        return makeReplayGesture(name, frames, { start: touches })
      }

      const target = targets[0]
      if (!target) {
        log.warn(LOG_NS, 'gesture library abort: no fleet DOM target', { name })
        return null
      }
      const targetLocalPivot = () => {
        const bounds = overlay.getShapePageBounds(target.id as any) as any
        const pivot = screenPointToOverlayPage(overlay, target.center.x, target.center.y, viewportId)
        const bw = rectWidth(bounds)
        const bh = rectHeight(bounds)
        const fx = bw > 0 ? Math.max(0, Math.min(1, (pivot.x - (bounds?.x ?? 0)) / bw)) : 0.5
        const fy = bh > 0 ? Math.max(0, Math.min(1, (pivot.y - (bounds?.y ?? 0)) / bh)) : 0.5
        return { expectedLocalPivotFraction: { x: fx, y: fy } }
      }

      if (name === 'shape-move') {
        const sep = Math.min(80, Math.max(24, target.rect.width * 0.22))
        const a = p(1, target.center.x - sep / 2, target.center.y)
        const b = p(2, target.center.x + sep / 2, target.center.y)
        const z = getGestureViewportCamera(overlay, viewportId).z || 1
        return makeReplayGesture(name, twoTouchFrames(main, overlay, a, b, p(1, a.clientX + 100, a.clientY + 45), p(2, b.clientX + 100, b.clientY + 45)), {
          target: { id: target.id, type: target.type },
          expectedPageDelta: { x: 100 / z, y: 45 / z },
        })
      }

      if (name === 'shape-resize') {
        const sep = Math.min(70, Math.max(24, target.rect.width * 0.18))
        const a = p(1, target.center.x - sep / 2, target.center.y)
        const b = p(2, target.center.x + sep / 2, target.center.y)
        return makeReplayGesture(name, twoTouchFrames(main, overlay, a, b, p(1, target.center.x - sep * 1.5, target.center.y), p(2, target.center.x + sep * 1.5, target.center.y)), {
          target: { id: target.id, type: target.type },
          expectedScale: 3,
          ...targetLocalPivot(),
        })
      }

      if (name === 'shape-move-resize') {
        const sep = Math.min(70, Math.max(24, target.rect.width * 0.18))
        const a = p(1, target.center.x - sep / 2, target.center.y)
        const b = p(2, target.center.x + sep / 2, target.center.y)
        const z = getGestureViewportCamera(overlay, viewportId).z || 1
        return makeReplayGesture(name, twoTouchFrames(main, overlay, a, b, p(1, target.center.x - sep * 1.5 + 100, target.center.y + 45), p(2, target.center.x + sep * 1.5 + 100, target.center.y + 45)), {
          target: { id: target.id, type: target.type },
          expectedPageDelta: { x: 100 / z, y: 45 / z },
          expectedScale: 3,
          ...targetLocalPivot(),
        })
      }

      if (name === 'shape-anisotropic-resize') {
        const sepX = Math.min(90, Math.max(36, target.rect.width * 0.22))
        const sepY = Math.min(120, Math.max(40, target.rect.height * 0.24))
        const a = p(1, target.center.x - sepX / 2, target.center.y - sepY / 2)
        const b = p(2, target.center.x + sepX / 2, target.center.y + sepY / 2)
        const z = getGestureViewportCamera(overlay, viewportId).z || 1
        return makeReplayGesture(name, twoTouchFrames(main, overlay, a, b, p(1, target.center.x - sepX * 1.5 + 80, target.center.y - sepY * 0.75 + 35), p(2, target.center.x + sepX * 1.5 + 80, target.center.y + sepY * 0.75 + 35)), {
          target: { id: target.id, type: target.type },
          expectedPageDelta: { x: 80 / z, y: 35 / z },
          expectedScaleX: 3,
          expectedScaleY: 1.5,
          ...targetLocalPivot(),
        })
      }

      const docMidX = window.innerWidth / 2
      const bySide = targets.reduce((acc, t) => {
        const side = t.center.x < docMidX ? 'left' : 'right'
        ;(acc[side] ||= []).push(t)
        return acc
      }, {} as Record<'left' | 'right', typeof targets>)
      const pair = (bySide.left?.length ?? 0) >= 2 ? bySide.left.slice(0, 2) : (bySide.right?.length ?? 0) >= 2 ? bySide.right.slice(0, 2) : targets.slice(0, 2)
      if (pair.length < 2) {
        log.warn(LOG_NS, 'gesture library abort: cluster case needs two fleet targets', { name, targetCount: targets.length })
        return null
      }
      const a = p(1, pair[0].center.x, pair[0].center.y)
      const b = p(2, pair[1].center.x, pair[1].center.y)
      const clusterIds = clusterOf(overlay, new Set(pair.map(t => t.id, viewportId))).map(s => s.id)
      const z = getGestureViewportCamera(overlay, viewportId).z || 1
      return makeReplayGesture(name, twoTouchFrames(main, overlay, a, b, p(1, a.clientX + 90, a.clientY + 40), p(2, b.clientX + 90, b.clientY + 40)), {
        targets: pair.map(t => ({ id: t.id, type: t.type })),
        clusterIds,
        expectedPageDelta: { x: 90 / z, y: 40 / z },
      })
    }

    const library = () => ([
      'cluster-move',
      'shape-move',
      'canvas-pass-through',
      'three-finger-pan',
      'shape-anisotropic-resize',
      'shape-resize',
      'shape-move-resize',
    ] as GestureLibraryCase[])

    const replayLibrary = async (name: GestureLibraryCase, speed = 1) => {
      const rec = makeLibraryGesture(name)
      if (!rec) return false
      recordings.push(rec)
      while (recordings.length > MAX_RECORDED_GESTURES) recordings.shift()
      return replay(rec, speed)
    }

    const replayLibraryAll = async (speed = 20) => {
      const results: Record<string, boolean> = {}
      for (const name of library()) {
        results[name] = await replayLibrary(name, speed)
      }
      log.info(LOG_NS, 'gesture library replay all complete', { results })
      return results
    }

    const status = () => ({
      expanded,
      mountId,
      active: fleetTouchGestureActiveRef.current,
      stateKind: state.kind,
      hasHud: !!hudRef.current,
      hasOverlay: !!overlayEditorRef.current,
      hudPointerEvents: describeElement(el)?.pointerEvents ?? null,
    })

    const describeFleetHit = (hit: FleetHit | null) => hit ? ({
      id: hit.shape.id,
      type: hit.shape.type as string,
      source: hit.source,
      rawShapeId: hit.rawShapeId ?? null,
      rawShapeType: hit.rawShapeType ?? null,
    }) : null

    const describeFleetShape = (shape: TLShape) => ({
      id: shape.id,
      type: shape.type as string,
    })

    const hitTestAt = (clientX: number, clientY: number) => {
      const overlay = overlayEditorRef.current
      if (!overlay) return { hasOverlay: false }
      return {
        hasOverlay: true,
        cornerControl: describeElement(cornerControlAtPoint(clientX, clientY)),
        guardedHit: describeFleetHit(fleetHitAtScreen(overlay, clientX, clientY, viewportId)),
        rawHit: describeFleetHit(fleetHitAtScreen(overlay, clientX, clientY, viewportId, { ignoreCornerControls: true })),
        guardedContainingPanels: containingFleetPanelsAtPoint(overlay, clientX, clientY).map(describeFleetShape),
        rawContainingPanels: containingFleetPanelsAtPoint(overlay, clientX, clientY, { ignoreCornerControls: true }).map(describeFleetShape),
        elementChain: elementChainAt(clientX, clientY, FLEET_GESTURE_FRAME_SELECTORS),
      }
    }

    const shapeSnapshot = (editor: Editor | null) => {
      if (!editor) return {}
      const out: Record<string, { id: string; type: string; x: number; y: number; w: number | null; h: number | null }> = {}
      for (const shape of editor.getCurrentPageShapes()) {
        if (!isMyGestureFleetShape(shape)) continue
        const s = shape as any
        out[shape.id] = {
          id: shape.id,
          type: shape.type as string,
          x: s.x,
          y: s.y,
          w: typeof s.props?.w === 'number' ? s.props.w : null,
          h: typeof s.props?.h === 'number' ? s.props.h : null,
        }
      }
      return out
    }

    const domSnapshot = () => {
      const out: Record<string, { left: number; top: number; width: number; height: number }> = {}
      for (const node of Array.from(document.querySelectorAll('.fleet-hud-wrap [data-shape-id]'))) {
        const id = node.getAttribute('data-shape-id')
        if (!id) continue
        const r = node.getBoundingClientRect()
        out[id] = { left: r.left, top: r.top, width: r.width, height: r.height }
      }
      return out
    }

    const snapshot = () => {
      const overlay = overlayEditorRef.current
      const main = getMainEditor(mainEditor)
      return {
        at: new Date().toISOString(),
        status: status(),
        mainCamera: main.getCamera(),
        overlayCamera: overlay ? getGestureViewportCamera(overlay, viewportId) as any : null,
        mainFleet: shapeSnapshot(main),
        overlayFleet: shapeSnapshot(overlay),
        domRects: domSnapshot(),
      }
    }

    const waitMs = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))
    const close = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance
    const sizeOf = (s: { w: number | null; h: number | null } | undefined) => ({
      w: s?.w ?? 0,
      h: s?.h ?? 0,
    })

    const assertIdle = (failures: string[], settled: ReturnType<typeof snapshot>) => {
      if (settled.status.stateKind !== 'none') failures.push(`state leaked: ${settled.status.stateKind}`)
      if (settled.status.active) failures.push('active flag leaked after settle')
      if (!settled.status.hasHud) failures.push('HUD missing after replay')
      if (!settled.status.hasOverlay) failures.push('overlay editor missing after replay')
      if (settled.status.mountId !== mountId) failures.push(`gesture listener remounted during replay: ${settled.status.mountId} !== ${mountId}`)
    }

    const assertLibrary = async (name: GestureLibraryCase, speed = 20) => {
      const rec = makeLibraryGesture(name)
      if (!rec) {
        return { ok: false, name, failures: ['could not generate library gesture'], before: snapshot(), after: null, settled: null, recording: null }
      }
      recordings.push(rec)
      while (recordings.length > MAX_RECORDED_GESTURES) recordings.shift()
      const before = snapshot()
      const replayed = await replay(rec, speed)
      const after = snapshot()
      await waitMs(350)
      const settled = snapshot()
      const failures: string[] = []
      if (!replayed) failures.push('replay returned false')
      assertIdle(failures, settled)

      const target = rec.meta?.target as { id?: string } | undefined
      const expectedPageDelta = rec.meta?.expectedPageDelta as { x?: number; y?: number } | undefined
      const expectedScale = rec.meta?.expectedScale as number | undefined
      const expectedScaleX = (rec.meta?.expectedScaleX as number | undefined) ?? expectedScale
      const expectedScaleY = (rec.meta?.expectedScaleY as number | undefined) ?? expectedScale
      const expectedLocalPivotFraction = (rec.meta?.expectedLocalPivotFraction as { x?: number; y?: number } | undefined) ?? { x: 0.5, y: 0.5 }

      if (name === 'shape-move') {
        const id = target?.id
        if (!id) failures.push('missing target metadata')
        else {
          const b = before.mainFleet[id]
          const s = settled.mainFleet[id]
          if (!b || !s) failures.push(`target missing in snapshot: ${id}`)
          else {
            if (!expectedPageDelta) failures.push('missing expected delta metadata')
            else {
              if (!close(s.x - b.x, expectedPageDelta.x ?? 0, 2)) failures.push(`target x delta ${s.x - b.x} != ${expectedPageDelta.x}`)
              if (!close(s.y - b.y, expectedPageDelta.y ?? 0, 2)) failures.push(`target y delta ${s.y - b.y} != ${expectedPageDelta.y}`)
            }
            if (!close(sizeOf(s).w, sizeOf(b).w, 1) || !close(sizeOf(s).h, sizeOf(b).h, 1)) failures.push('shape move changed target size')
          }
        }
      } else if (name === 'shape-resize') {
        const id = target?.id
        if (!id) failures.push('missing target metadata')
        else {
          const b = before.mainFleet[id]
          const s = settled.mainFleet[id]
          if (!b || !s) failures.push(`target missing in snapshot: ${id}`)
          else {
            const bw = sizeOf(b).w
            const bh = sizeOf(b).h
            const relX = bw * (expectedLocalPivotFraction.x ?? 0.5)
            const relY = bh * (expectedLocalPivotFraction.y ?? 0.5)
            const expectedX = b.x + relX - relX * (expectedScaleX ?? 1)
            const expectedY = b.y + relY - relY * (expectedScaleY ?? 1)
            if (!close(s.x, expectedX, 2)) failures.push(`shape resize x ${s.x} != local-pivot ${expectedX}`)
            if (!close(s.y, expectedY, 2)) failures.push(`shape resize y ${s.y} != local-pivot ${expectedY}`)
            if (bw > 0 && !close(sizeOf(s).w, Math.max(80, bw * (expectedScale ?? 1)), 3)) failures.push('shape resize width did not match expected scale')
            if (bh > 0 && !close(sizeOf(s).h, Math.max(60, bh * (expectedScale ?? 1)), 3)) failures.push('shape resize height did not match expected scale')
            if (sizeOf(s).w < 80 || sizeOf(s).h < 60) failures.push('shape resize violated minimum size clamp')
          }
        }
      } else if (name === 'shape-move-resize' || name === 'shape-anisotropic-resize') {
        const id = target?.id
        if (!id) failures.push('missing target metadata')
        else {
          const b = before.mainFleet[id]
          const s = settled.mainFleet[id]
          if (!b || !s) failures.push(`target missing in snapshot: ${id}`)
          else {
            const bw = sizeOf(b).w
            const bh = sizeOf(b).h
            if (!expectedPageDelta) failures.push('missing expected delta metadata')
            else {
              const relX = bw * (expectedLocalPivotFraction.x ?? 0.5)
              const relY = bh * (expectedLocalPivotFraction.y ?? 0.5)
              const expectedX = b.x + relX + (expectedPageDelta.x ?? 0) - relX * (expectedScaleX ?? 1)
              const expectedY = b.y + relY + (expectedPageDelta.y ?? 0) - relY * (expectedScaleY ?? 1)
              if (!close(s.x, expectedX, 2)) failures.push(`shape move+resize x ${s.x} != local-pivot ${expectedX}`)
              if (!close(s.y, expectedY, 2)) failures.push(`shape move+resize y ${s.y} != local-pivot ${expectedY}`)
            }
            if (bw > 0 && !close(sizeOf(s).w, Math.max(80, bw * (expectedScaleX ?? 1)), 3)) failures.push('shape move+resize width did not match expected scale')
            if (bh > 0 && !close(sizeOf(s).h, Math.max(60, bh * (expectedScaleY ?? 1)), 3)) failures.push('shape move+resize height did not match expected scale')
            if (sizeOf(s).w < 80 || sizeOf(s).h < 60) failures.push('shape move+resize violated minimum size clamp')
          }
        }
      } else if (name === 'cluster-move') {
        const clusterIds = (rec.meta?.clusterIds as string[] | undefined) ?? []
        if (clusterIds.length < 2) failures.push('cluster metadata has fewer than two shapes')
        if (!expectedPageDelta) failures.push('missing expected delta metadata')
        for (const id of clusterIds) {
          const b = before.mainFleet[id]
          const s = settled.mainFleet[id]
          if (!b || !s) {
            failures.push(`cluster shape missing in snapshot: ${id}`)
            continue
          }
          if (expectedPageDelta) {
            if (!close(s.x - b.x, expectedPageDelta.x ?? 0, 2)) failures.push(`cluster ${id} x delta ${s.x - b.x} != ${expectedPageDelta.x}`)
            if (!close(s.y - b.y, expectedPageDelta.y ?? 0, 2)) failures.push(`cluster ${id} y delta ${s.y - b.y} != ${expectedPageDelta.y}`)
          }
          if (!close(sizeOf(s).w, sizeOf(b).w, 1) || !close(sizeOf(s).h, sizeOf(b).h, 1)) failures.push(`cluster move changed size for ${id}`)
        }
      } else if (name === 'canvas-pass-through') {
        for (const [id, b] of Object.entries(before.mainFleet)) {
          const s = settled.mainFleet[id]
          if (!s) failures.push(`fleet shape disappeared during pass-through: ${id}`)
          else if (!close(s.x, b.x, 1) || !close(s.y, b.y, 1) || !close(sizeOf(s).w, sizeOf(b).w, 1) || !close(sizeOf(s).h, sizeOf(b).h, 1)) {
            failures.push(`fleet shape changed during pass-through: ${id}`)
          }
        }
      } else if (name === 'three-finger-pan') {
        if (Object.keys(before.mainFleet).some(id => {
          const b = before.mainFleet[id]
          const s = settled.mainFleet[id]
          return !s || !close(s.x, b.x, 1) || !close(s.y, b.y, 1) || !close(sizeOf(s).w, sizeOf(b).w, 1) || !close(sizeOf(s).h, sizeOf(b).h, 1)
        })) failures.push('fleet shape geometry changed during three-finger pan')
        if (settled.mainCamera.z !== before.mainCamera.z) failures.push('three-finger pan changed camera zoom')
        if (close(settled.mainCamera.x, before.mainCamera.x, 1) && close(settled.mainCamera.y, before.mainCamera.y, 1)) failures.push('three-finger pan did not move camera')
      }

      for (const id of Object.keys(settled.mainFleet)) {
        const mainShape = settled.mainFleet[id]
        const overlayShape = settled.overlayFleet[id]
        if (overlayShape && (!close(overlayShape.x, mainShape.x, 2) || !close(overlayShape.y, mainShape.y, 2))) {
          failures.push(`overlay did not converge to main position for ${id}`)
        }
      }

      const report = { ok: failures.length === 0, name, failures, before, after, settled, recording: rec }
      log.info(LOG_NS, 'gesture library assertion complete', {
        name,
        ok: report.ok,
        failureCount: failures.length,
        failures,
      })
      return report
    }

    const assertLibraryAll = async (speed = 20) => {
      const reports = []
      for (const name of library()) {
        reports.push(await assertLibrary(name, speed))
      }
      const ok = reports.every(r => r.ok)
      log.info(LOG_NS, 'gesture library assertion suite complete', {
        ok,
        failures: reports.flatMap(r => r.failures.map(f => `${r.name}: ${f}`)),
      })
      return { ok, reports }
    }

    ;(window as any).__fleetGestureDebug = {
      simulateShapeMove,
      recordings: () => recordings,
      library,
      targets: fleetDomTargets,
      makeLibraryGesture,
      snapshot,
      assertLibrary,
      assertLibraryAll,
      replay,
      replayLibrary,
      replayLibraryAll,
      replayLast: (speed?: number) => replay(undefined, speed),
      status,
      hitTestAt,
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
      recordTouchFrame(e, overlay, getMainEditor(mainEditor), state.kind)
      logTouchSnapshot('touchstart', e, overlay, el, state.kind)
      if (state.kind === 'phone-lane' && ts.length > 1) {
        const main = getMainEditor(mainEditor)
        consumeTouchEvent(e)
        finishPhoneLaneGesture(main, state)
        state = { kind: 'none' }
        setGestureActive(false, 250)
        log.debug(LOG_NS, 'phone lane cancelled by multitouch', { touchesLength: ts.length })
        return
      }
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

      if (ts.length === 3 && isPhoneMode()) {
        // Phone only: pan the doc from anywhere — even over the panels — with the
        // soft breakable axis-lock below. Confined to the phone layout so every
        // other layout gets plain TLDraw touch behavior (no phone-ish "almost-pan").
        consumeTouchEvent(e)
        setGestureActive(true)
        const cam = main.getCamera()
        state = { kind: 'pan', z0: cam.z, lastC: touchCenter(ts), axis: null, accX: 0, accY: 0 }
        log.info(LOG_NS, 'gesture start: pan', { touchesLength: ts.length, z: cam.z })
        return
      }

      if (ts.length === 1 && isPhoneMode()) {
        const hit = fleetHitAtScreen(overlay, ts[0].clientX, ts[0].clientY, viewportId)
        if (hit?.shape) {
          const docLeftPage = getPrimaryDocumentLeft(main)
          if (docLeftPage !== null) {
            state = {
              kind: 'phone-lane',
              mode: 'pending',
              x0: ts[0].clientX,
              y0: ts[0].clientY,
              cameraX0: main.getCamera().x,
              z0: main.getCamera().z,
              docLeftPage,
              lastDx: 0,
            }
            log.debug(LOG_NS, 'phone lane pending', {
              shape: { id: hit.shape.id, type: hit.shape.type },
              x: Math.round(ts[0].clientX),
              y: Math.round(ts[0].clientY),
            })
          }
        }
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
            : replaying && geometrySpanIds.size > 1
              ? geometrySpanIds
              : domSpanIds
        const isCluster = clusterSeedIds.size > 1
        log.warn(LOG_NS, 'two-touch classification', {
          domSpanIds: [...domSpanIds],
          geometrySpanIds: [...geometrySpanIds],
          clusterSeedIds: [...clusterSeedIds],
          isCluster,
          replaying,
          commonPanel: commonPanel ? { id: commonPanel.id, type: commonPanel.type } : null,
        })
        postTouchTelemetry('two-touch classification', {
          domSpanIds: [...domSpanIds],
          geometrySpanIds: [...geometrySpanIds],
          clusterSeedIds: [...clusterSeedIds],
          isCluster,
          replaying,
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
      recordTouchFrame(e, overlay, getMainEditor(mainEditor), state.kind)
      logTouchSnapshot('touchmove', e, overlay, el, state.kind)
      if (state.kind === 'none') return
      if (!overlay) return
      const main = getMainEditor(mainEditor)
      const ts = Array.from(e.touches)

      if (state.kind === 'phone-lane') {
        if (ts.length !== 1) {
          consumeTouchEvent(e)
          finishPhoneLaneGesture(main, state)
          state = { kind: 'none' }
          setGestureActive(false, 250)
          log.debug(LOG_NS, 'phone lane ended by touch-count change', { touchesLength: ts.length })
          return
        }
        const dx = ts[0].clientX - state.x0
        const dy = ts[0].clientY - state.y0
        state.lastDx = dx
        if (state.mode === 'pending') {
          const decision = phoneLaneDragDecision(dx, dy)
          if (decision === 'abort') {
            state = { kind: 'none' }
            return
          }
          if (decision === 'pending') return
          state.mode = 'dragging'
          setGestureActive(true)
          log.debug(LOG_NS, 'phone lane drag start', { dx: Math.round(dx), dy: Math.round(dy) })
        }
        consumeTouchEvent(e)
        // Static panes: do NOT move the camera while dragging. Instead report how
        // close this drag is to the commit threshold so the fill-up arrow shows the
        // impending transition; the actual lane switch happens on release.
        const screenW = main.getViewportScreenBounds().w
        const commit = phoneLaneCommitPx(screenW)
        const dir: -1 | 0 | 1 = dx > 0 ? 1 : dx < 0 ? -1 : 0
        const hasLane = phoneLaneExistsInDirection(main, state.docLeftPage, dir)
        const progress = hasLane ? Math.min(1, Math.abs(dx) / commit) : 0
        setPhoneLaneDrag({ active: true, progress, dir: hasLane ? dir : 0, armed: progress >= 1 })
        return
      }

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
      recordTouchFrame(e, overlay, getMainEditor(mainEditor), state.kind)
      logTouchSnapshot(e.type === 'touchcancel' ? 'touchcancel' : 'touchend', e, overlay, el, state.kind)
      if (state.kind === 'phone-lane') {
        if (state.mode === 'dragging') {
          stopTouchEvent(e)
          finishPhoneLaneGesture(getMainEditor(mainEditor), state)
        }
        state = { kind: 'none' }
        setGestureActive(false, 250)
        return
      }
      if (state.kind !== 'none' && e.touches.length < 2) {
        log.debug(LOG_NS, 'gesture reset', { previousKind: state.kind, remainingTouches: e.touches.length, eventType: e.type })
      }
      if (e.touches.length < 2) state = { kind: 'none' }
      if (e.touches.length < 2) setGestureActive(false, 250)
    }

    const onGlobalThreeFingerStart = (e: TouchEvent) => {
      if (!isPhoneMode() || e.touches.length !== 3) return
      onTouchStart(e)
    }

    const onGlobalThreeFingerMove = (e: TouchEvent) => {
      if (state.kind !== 'pan') return
      onTouchMove(e)
    }

    const onGlobalThreeFingerEnd = (e: TouchEvent) => {
      if (state.kind !== 'pan') return
      reset(e)
    }

    const onGlobalPhoneLaneStart = (e: TouchEvent) => {
      if (!isPhoneMode() || e.touches.length !== 1) return
      onTouchStart(e)
    }

    const onGlobalPhoneLaneMove = (e: TouchEvent) => {
      if (state.kind !== 'phone-lane') return
      onTouchMove(e)
    }

    const onGlobalPhoneLaneEnd = (e: TouchEvent) => {
      if (state.kind !== 'phone-lane') return
      reset(e)
    }

    window.addEventListener('touchstart', onGlobalThreeFingerStart, { passive: false, capture: true })
    window.addEventListener('touchmove', onGlobalThreeFingerMove, { passive: false, capture: true })
    window.addEventListener('touchend', onGlobalThreeFingerEnd, { capture: true })
    window.addEventListener('touchcancel', onGlobalThreeFingerEnd, { capture: true })
    window.addEventListener('touchstart', onGlobalPhoneLaneStart, { passive: false, capture: true })
    window.addEventListener('touchmove', onGlobalPhoneLaneMove, { passive: false, capture: true })
    window.addEventListener('touchend', onGlobalPhoneLaneEnd, { capture: true })
    window.addEventListener('touchcancel', onGlobalPhoneLaneEnd, { capture: true })
    el.addEventListener('touchstart', onTouchStart, { passive: false, capture: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
    el.addEventListener('touchend', reset, { capture: true })
    el.addEventListener('touchcancel', reset, { capture: true })
    const cleanup = () => {
      if (disposed) return
      disposed = true
      setGestureActive(false)
      if ((window as any).__fleetGestureDebug?.simulateShapeMove === simulateShapeMove) {
        delete (window as any).__fleetGestureDebug
      }
      if ((window as any).__fleetGestureCleanup === cleanup) {
        delete (window as any).__fleetGestureCleanup
      }
      log.warn(LOG_NS, 'gesture listener removed', { target: 'hud' })
      window.removeEventListener('touchstart', onGlobalThreeFingerStart, true)
      window.removeEventListener('touchmove', onGlobalThreeFingerMove, true)
      window.removeEventListener('touchend', onGlobalThreeFingerEnd, true)
      window.removeEventListener('touchcancel', onGlobalThreeFingerEnd, true)
      window.removeEventListener('touchstart', onGlobalPhoneLaneStart, true)
      window.removeEventListener('touchmove', onGlobalPhoneLaneMove, true)
      window.removeEventListener('touchend', onGlobalPhoneLaneEnd, true)
      window.removeEventListener('touchcancel', onGlobalPhoneLaneEnd, true)
      el.removeEventListener('touchstart', onTouchStart, true)
      el.removeEventListener('touchmove', onTouchMove, true)
      el.removeEventListener('touchend', reset, true)
      el.removeEventListener('touchcancel', reset, true)
    }
    w.__fleetGestureCleanup = cleanup
    return cleanup
  }, [expanded, hudRef, overlayEditorRef, mainEditor, viewportId])
}
