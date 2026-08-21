import type { Editor, TLBaseBoxShape, TLResizeInfo, TLShape, TLShapeId, TLShapePartial, TLViewportId } from 'tldraw'
import { createShapeId, resizeBox } from 'tldraw'
// @ts-ignore — vanilla JS module
import { getHumanId, getHumanName, getDeviceId, whenDeviceReady } from '../fleet/fleet-data.mjs'
// @ts-ignore — vanilla JS module
import { pretty_name_plain_text } from '../../shared/pretty_name.mjs'
import { isDocumentPageShape } from './document-pages'
import { setFleetNudgeGuides, clearFleetNudgeGuides } from './fleet-nudge-guides'
import { completeFleetNudgeGuides, highlightFleetNudgeGuides, type FleetNudgeGridGuide } from './fleet-nudge-grid'
import { getFleetNudgeStrengthPx } from '../readabilityProfile'
import { dispatchFleetHudReset, getHudEditor, markMainEditorHistoryStoppingPoint } from '../wm/editor-host-bridge'
import { FLEET_HUD_VIEWPORT_ID } from '../wm/fleet-hud-layer'
import { clientPointToPage } from '../wm/viewport-coordinates'
import {
  FLEET_SHAPE_TYPES,
  fleetPanelDefaultProps,
} from './fleet-panel-registry'
import { shouldRepairFleetPanelOwnership, type FleetOwnerProps } from './fleet-owner-repair'
import {
  getAnchorIdForOwnerKey,
  getMyAnchorId,
  isFleetShapeForOwnerKey,
  isMyFleetShape,
} from './fleet-ownership'
import {
  buildFleetLayoutPlanInput,
  getDocumentPageBounds,
} from './fleet-layout-context'
import { laneDy, layoutOffset } from './fleet-layout-geometry'
import { planFleetLayoutShapes, type FleetLayoutVariant } from './fleet-layout-plan'
import type { FleetChatFilter } from './fleet-layout-seeding'
import {
  enterFleetLayoutMode,
  syncFleetLayoutSelectionViewport,
  withFleetLayoutSelectionIntent,
} from '../overlays/fleet-layout-mode'

export {
  FLEET_INTERACTION_SHAPE_SELECTOR,
  FLEET_PANEL_DEFINITIONS,
  FLEET_PANEL_REGISTRY,
  FLEET_SHAPE_SELECTOR,
  FLEET_SHAPE_TYPES,
  FLEET_TOOL_DIMS,
  fleetPanelDefaultProps,
  type FleetPanelDefinition,
  type FleetPanelType,
} from './fleet-panel-registry'
export {
  FLEET_HUD_ANCHOR_ID,
  getAnchorIdForOwnerKey,
  getMyAnchorId,
  isFleetShapeForOwnerKey,
  isMyFleetShape,
} from './fleet-ownership'
export {
  buildFleetLayoutPlanInput,
  fleetLayoutPanelCount,
  getDocumentPageBounds,
  type DocumentPageBounds,
} from './fleet-layout-context'
export { laneDy, layoutOffset } from './fleet-layout-geometry'
export { planFleetLayoutShapes, type FleetLayoutPlan, type FleetLayoutShapePlan, type FleetLayoutVariant } from './fleet-layout-plan'
export { defaultFleetLayoutChatFilters, type FleetChatFilter } from './fleet-layout-seeding'

type FleetNudgeRect = {
  id: TLShapeId
  left: number
  right: number
  top: number
  bottom: number
}

/** The page-space line a nudge is pulling toward, for drawing the guide. */
export type FleetNudgeGuide = FleetNudgeGridGuide

/**
 * The feature of the dragged rect a match pulls. Translate moves all four edges; a
 * resize moves only the edges the grabbed handle carries, which is the whole
 * difference between the two paths.
 */
type FleetNudgeFeature = 'left' | 'right' | 'top' | 'bottom'

type FleetNudgeMatch = FleetNudgeGuide & { delta: number; feature: FleetNudgeFeature }

const ALL_FLEET_NUDGE_FEATURES: ReadonlySet<FleetNudgeFeature> = new Set<FleetNudgeFeature>([
  'left', 'right', 'top', 'bottom',
])

function overlapSize(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

function sameBandOnY(a: FleetNudgeRect, b: FleetNudgeRect): boolean {
  return overlapSize(a.top, a.bottom, b.top, b.bottom) > Math.min(a.bottom - a.top, b.bottom - b.top) * 0.35
}

function sameBandOnX(a: FleetNudgeRect, b: FleetNudgeRect): boolean {
  return overlapSize(a.left, a.right, b.left, b.right) > Math.min(a.right - a.left, b.right - b.left) * 0.35
}

function keepClosest(match: FleetNudgeMatch, current: FleetNudgeMatch | null): FleetNudgeMatch | null {
  if (match.delta === 0) return current
  if (current === null || Math.abs(match.delta) < Math.abs(current.delta)) return match
  return current
}

/**
 * Inside the capture zone the panel goes to the line. Outside it, nothing
 * happens. There is no third state: a match that is taken is drawn, and a match
 * that is drawn is taken, which is why this single test decides both.
 *
 * It used to move a fixed 35% of the way and never accumulate — every frame
 * recomputes the dragged rect from the pointer, so the partial is never fed
 * back. The panel therefore settled 65% short of the guide it had just been
 * shown, however long you held it: "the places the fucking shape jumps to are
 * not aligned with the fucking lines". A pull worth drawing a guide for is worth
 * completing.
 */
function takenMatch(match: FleetNudgeMatch | null, threshold: number): FleetNudgeMatch | null {
  if (match === null || Math.abs(match.delta) > threshold) return null
  return match
}

function fleetNudgeRectForBox(id: TLShapeId, x: number, y: number, w: number, h: number): FleetNudgeRect {
  const left = x
  const top = y
  const right = left + w
  const bottom = top + h
  return {
    id,
    left,
    right,
    top,
    bottom,
  }
}

function fleetNudgeRectForShape(editor: Editor, shape: TLShape): FleetNudgeRect | null {
  const bounds = editor.getShapePageBounds(shape.id)
  if (!bounds) return null
  return fleetNudgeRectForBox(shape.id, bounds.x, bounds.y, bounds.w, bounds.h)
}

function fleetNudgeRectForCurrentShape(shape: TLShape): FleetNudgeRect | null {
  const panel = shape as TLShape & { x: number; y: number; props?: { w?: number; h?: number } }
  const w = panel.props?.w
  const h = panel.props?.h
  if (typeof w !== 'number' || typeof h !== 'number') return null
  return fleetNudgeRectForBox(shape.id, panel.x, panel.y, w, h)
}

function collectFleetPanelNudgeCandidates(editor: Editor, current: TLShape): FleetNudgeRect[] {
  const selectedIds = new Set(editor.getSelectedShapeIds())
  return editor.getCurrentPageShapes()
    .filter(shape => shape.id !== current.id && !selectedIds.has(shape.id) && isMyFleetShape(shape))
    // Add a group restriction here if fleet-panel nudging becomes group-scoped.
    .map(shape => fleetNudgeRectForShape(editor, shape))
    .filter((rect): rect is FleetNudgeRect => rect !== null)
}

/**
 * One rule for every match, alignment and equal-gap alike: the guide marks the
 * page coordinate the dragged feature is being pulled to, and spans both the
 * shape being dragged and the one it is lining up with.
 */
function matchOnX(target: number, feature: 'left' | 'right', dragged: FleetNudgeRect, candidate: FleetNudgeRect): FleetNudgeMatch {
  return {
    axis: 'x',
    feature,
    delta: target - dragged[feature],
    line: target,
    spanFrom: Math.min(dragged.top, candidate.top),
    spanTo: Math.max(dragged.bottom, candidate.bottom),
  }
}

function matchOnY(target: number, feature: 'top' | 'bottom', dragged: FleetNudgeRect, candidate: FleetNudgeRect): FleetNudgeMatch {
  return {
    axis: 'y',
    feature,
    delta: target - dragged[feature],
    line: target,
    spanFrom: Math.min(dragged.left, candidate.left),
    spanTo: Math.max(dragged.right, candidate.right),
  }
}

/**
 * `live` names the features that are free to move. A translate hands over all
 * four; a resize hands over only the ones its handle carries, so the pull can
 * never be offered on an edge that is standing still — which is the same
 * taken-is-drawn invariant `takenMatch` keeps, one step earlier.
 */
function closestFleetPanelNudge(
  dragged: FleetNudgeRect,
  candidates: FleetNudgeRect[],
  threshold: number,
  live: ReadonlySet<FleetNudgeFeature> = ALL_FLEET_NUDGE_FEATURES,
): { dx: FleetNudgeMatch | null; dy: FleetNudgeMatch | null } {
  let dx: FleetNudgeMatch | null = null
  let dy: FleetNudgeMatch | null = null
  const on = (match: FleetNudgeMatch, current: FleetNudgeMatch | null) =>
    live.has(match.feature) ? keepClosest(match, current) : current

  for (const candidate of candidates) {
    dx = on(matchOnX(candidate.left, 'left', dragged, candidate), dx)
    dx = on(matchOnX(candidate.right, 'right', dragged, candidate), dx)

    dy = on(matchOnY(candidate.top, 'top', dragged, candidate), dy)
    dy = on(matchOnY(candidate.bottom, 'bottom', dragged, candidate), dy)
  }

  // An edge that lines up wins outright. Equal-gap spacing is only
  // consulted on an axis that has no alignment to offer.
  //
  // These are not comparable by distance. Alignment gives at most six lines per
  // panel; equal-gap gives two per panel per DISTINCT GAP IN THE SCENE, so with
  // a screen of panels it is thousands of lines and one of them is nearly always
  // nearer than the alignment you were reaching for. Taking the closest of the
  // union means the obvious position loses to a spacing coincidence — which is
  // "it doesn't wanna fucking snap there, despite everything being perfectly
  // aligned" and "it wants to snap to a bunch of weird shit" in one behaviour.
  const alignedX = dx && Math.abs(dx.delta) <= threshold ? dx : null
  const alignedY = dy && Math.abs(dy.delta) <= threshold ? dy : null
  if (alignedX && alignedY) return { dx: alignedX, dy: alignedY }

  const horizontalGaps = new Set<number>()
  const verticalGaps = new Set<number>()
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]
      const b = candidates[j]
      if (!alignedX && sameBandOnY(a, b)) {
        const gap = Math.max(a.left, b.left) - Math.min(a.right, b.right)
        if (gap > 0) horizontalGaps.add(gap)
      }
      if (!alignedY && sameBandOnX(a, b)) {
        const gap = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)
        if (gap > 0) verticalGaps.add(gap)
      }
    }
  }

  for (const candidate of candidates) {
    if (!alignedX && sameBandOnY(dragged, candidate)) {
      for (const gap of horizontalGaps) {
        dx = on(matchOnX(candidate.right + gap, 'left', dragged, candidate), dx)
        dx = on(matchOnX(candidate.left - gap, 'right', dragged, candidate), dx)
      }
    }
    if (!alignedY && sameBandOnX(dragged, candidate)) {
      for (const gap of verticalGaps) {
        dy = on(matchOnY(candidate.bottom + gap, 'top', dragged, candidate), dy)
        dy = on(matchOnY(candidate.top - gap, 'bottom', dragged, candidate), dy)
      }
    }
  }

  return { dx: alignedX ?? dx, dy: alignedY ?? dy }
}

/** The guide is the taken match and nothing else, on both paths. */
function drawFleetNudgeGuides(
  editor: Editor,
  taken: (FleetNudgeMatch | null)[],
  grid: FleetNudgeGuide[],
  additional: FleetNudgeGuide[] = [],
  isActive?: () => boolean,
) {
  setFleetNudgeGuides(editor, [
    ...highlightFleetNudgeGuides(grid, taken),
    ...additional.map(guide => ({ ...guide, highlighted: true })),
  ], isActive)
}

/**
 * The capture zone in page units: how close the feature has to be before the
 * snap takes. The strength is screen px, so it is the same apparent distance at
 * any zoom. Zero (the preference turned off) has no capture zone at all.
 */
function fleetNudgeThreshold(editor: Editor): number | null {
  const strength = getFleetNudgeStrengthPx()
  if (strength <= 0) return null
  return strength / (editor.getZoomLevel() || 1)
}

export function nudgeFleetPanelTranslate(
  editor: Editor,
  _initial: TLShape,
  current: TLShape,
  options: { isActive?: () => boolean } = {},
): TLShapePartial | void {
  // Every exit clears. A guide left standing outlives the drag that drew it and
  // then points at nothing.
  if (current.parentId !== editor.getCurrentPageId()) return clearFleetNudgeGuides()
  if (!isMyFleetShape(current)) return clearFleetNudgeGuides()

  const candidates = collectFleetPanelNudgeCandidates(editor, current)
  if (candidates.length === 0) return clearFleetNudgeGuides()

  const dragged = fleetNudgeRectForCurrentShape(current)
  if (!dragged) return clearFleetNudgeGuides()

  const threshold = fleetNudgeThreshold(editor)
  if (threshold === null) return clearFleetNudgeGuides()

  const { dx, dy } = closestFleetPanelNudge(dragged, candidates, threshold)
  const grid = completeFleetNudgeGuides(dragged, candidates)

  // One decision, read twice. The guide and the move cannot disagree about
  // whether a match was taken, because they are the same value.
  const takenX = takenMatch(dx, threshold)
  const takenY = takenMatch(dy, threshold)

  drawFleetNudgeGuides(editor, [takenX, takenY], grid, [], options.isActive)

  if (!takenX && !takenY) return

  return {
    id: current.id,
    type: current.type,
    x: current.x + (takenX ? takenX.delta : 0),
    y: current.y + (takenY ? takenY.delta : 0),
  } as TLShapePartial
}

/**
 * The features a resize handle actually moves. Grab the right edge and the left
 * one stands still, so only `right` may be offered a pull. An edge handle locks
 * the other axis outright. A flipped drag (negative scale) turns the grabbed
 * edge into the opposite one, so that axis sits the pull out rather than
 * snapping to a line it would land past.
 */
function liveFleetResizeFeatures(handle: string, scaleX: number, scaleY: number): Set<FleetNudgeFeature> {
  const live = new Set<FleetNudgeFeature>()
  if (scaleX > 0) {
    if (handle.includes('left')) live.add('left')
    if (handle.includes('right')) live.add('right')
  }
  if (scaleY > 0) {
    if (handle.includes('top')) live.add('top')
    if (handle.includes('bottom')) live.add('bottom')
  }
  return live
}

/**
 * Turn a match on a moving feature into the axis the resize should land on. The
 * edge you did not grab is the anchor: pulling the grabbed edge by `delta` moves
 * it by `delta`. A pull that would invert the panel is refused, and refusing it
 * here is what stops a guide being
 * drawn for a move that will not happen.
 */
function pullResizedAxis(
  match: FleetNudgeMatch | null,
  start: number,
  size: number,
  startIsMoving: boolean,
): { start: number; size: number } | null {
  if (match === null) return null
  const edgeDelta = match.delta
  const next = startIsMoving
    ? { start: start + edgeDelta, size: size - edgeDelta }
    : { start, size: size + edgeDelta }
  return next.size >= 1 ? next : null
}

/**
 * The resize twin of `nudgeFleetPanelTranslate`, and the reason it is a separate
 * function rather than the same one: a translate moves the whole rect, so a
 * single delta applies to the shape, while a resize moves only the edge you
 * grabbed, so the pull has to change `w`/`h` and not `x`/`y` alone. Everything
 * that decides *whether* to pull — the matcher, the capture zone, the guides —
 * is the one shared with translate.
 *
 * Returns the ordinary `resizeBox` result whenever nothing is pulling, so this
 * is a drop-in for the `BaseBoxShapeUtil.onResize` it replaces.
 */
export function nudgeFleetPanelResize<T extends TLBaseBoxShape>(
  editor: Editor,
  shape: T,
  info: TLResizeInfo<T>,
  options: { additionalGuides?: FleetNudgeGuide[]; isActive?: () => boolean } = {},
): T {
  // `resizeBox` builds a fresh record with fresh props every call, so the pull
  // is written onto it rather than spread into another copy.
  const box = resizeBox(shape, info)
  const resized = () => {
    if (options.additionalGuides?.length) {
      setFleetNudgeGuides(editor, options.additionalGuides, options.isActive)
    } else {
      clearFleetNudgeGuides()
    }
    return box
  }

  if (shape.parentId !== editor.getCurrentPageId()) return resized()
  if (!isMyFleetShape(shape)) return resized()
  // 'scale_shape' is a whole selection being scaled at once; the panels inside it
  // are moving relative to each other's neighbours, not lining up with them.
  if (info.mode !== 'resize_bounds') return resized()

  const live = liveFleetResizeFeatures(info.handle, info.scaleX, info.scaleY)
  if (live.size === 0) return resized()

  const candidates = collectFleetPanelNudgeCandidates(editor, shape)
  if (candidates.length === 0) return resized()

  const threshold = fleetNudgeThreshold(editor)
  if (threshold === null) return resized()

  const dragged = fleetNudgeRectForBox(shape.id, box.x, box.y, box.props.w, box.props.h)
  const { dx, dy } = closestFleetPanelNudge(dragged, candidates, threshold, live)
  const grid = completeFleetNudgeGuides(dragged, candidates)

  const takenX = takenMatch(dx, threshold)
  const takenY = takenMatch(dy, threshold)
  const pullX = pullResizedAxis(takenX, dragged.left, box.props.w, info.handle.includes('left'))
  const pullY = pullResizedAxis(takenY, dragged.top, box.props.h, info.handle.includes('top'))

  // Drawn only where the pull survived, so a refused pull leaves no line behind.
  drawFleetNudgeGuides(
    editor,
    [pullX ? takenX : null, pullY ? takenY : null],
    grid,
    options.additionalGuides,
    options.isActive,
  )

  if (pullX) {
    box.x = pullX.start
    box.props.w = pullX.size
  }
  if (pullY) {
    box.y = pullY.start
    box.props.h = pullY.size
  }
  return box
}

/** Display-only label. Do not use this as a filter or routing value. */
export function agentDisplayLabel(agent: any, _allAgents?: any[]): string {
  if (!agent) return '[unknown]'
  return (pretty_name_plain_text(agent.pretty_name ?? agent.friendly_name) || agent.id || '').replace(/^fleet:/, '')
}

/** Exact current name for filters, DMs, and routing. */
export function agentExactName(agent: any): string {
  if (!agent) return ''
  return agent.friendly_name || (agent.id || '').replace('fleet:', '')
}

/**
 * One-time migration to the (identity, device) key. Fleet shapes created before
 * this scheme have my userId but NO deviceId, so the device-scoped
 * isMyFleetShape would orphan them — wiping a user's hand-built layout on first
 * load after the upgrade. Claim them for THIS device by stamping deviceId
 * (preserving every other prop, incl. filters) AND translating them by this
 * (identity, device)'s laneOffset, so adopted shapes share the exact same
 * offset as freshly-created ones. That uniformity is what lets the HUD undo the
 * offset with a single camera compensation and render every own shape — adopted
 * or created — in its canonical screen position. The legacy pre-device anchor is
 * dropped (the HUD recomputes the correct camera; carrying its stale pan/cameraY
 * would override the offset compensation). Run once on identity resolve;
 * history-ignored. A real migration, NOT an "empty deviceId means mine" shim.
 */
export async function adoptLegacyFleetShapes(editor: Editor): Promise<number> {
  await whenDeviceReady()
  const myId = getHumanId()
  const myDevice = getDeviceId()
  if (!myId || !myDevice) return 0
  const legacy = editor.getCurrentPageShapes().filter(
    (s: any) => FLEET_SHAPE_TYPES.has(s.type as string) && s.props?.userId === myId && !s.props?.deviceId,
  )
  const legacyAnchorId = `shape:fleet-hud-anchor--${myId.replace('fleet:', '')}`
  const newAnchorId = getMyAnchorId()
  const legacyAnchor = legacyAnchorId !== newAnchorId ? (editor.getShape(legacyAnchorId as any) as any) : null
  if (legacy.length === 0 && !legacyAnchor) return 0

  const { dx } = layoutOffset(myId, myDevice)
  const dy = laneDy(editor, myId, myDevice)
  editor.run(() => {
    for (const s of legacy) {
      editor.updateShape({
        id: s.id, type: s.type, x: (s as any).x + dx, y: (s as any).y + dy,
        props: { ...(s as any).props, deviceId: myDevice },
      } as any)
    }
    if (legacyAnchor) {
      if (legacyAnchor.isLocked) editor.updateShape({ id: legacyAnchorId as any, type: 'geo', isLocked: false })
      editor.deleteShape(legacyAnchorId as any)
    }
  }, { history: 'ignore' })
  return legacy.length
}

/** Create a fleet shape with ownership stamped. Returns the shape id, or null
 *  if identity is unresolved (shape not created). Every fleet-shape creation
 *  MUST go through this so unowned shapes can never enter the store. */
export type OwnedFleetPanelCreateInput = {
  type: string
  x: number
  y: number
  props: Record<string, any>
  id?: any
  parentId?: any
  isLocked?: boolean
  markHistoryStoppingPoint?: boolean
}

export async function createOwnedFleetPanelShape(
  editor: Editor,
  input: OwnedFleetPanelCreateInput,
): Promise<string | null> {
  await whenDeviceReady()
  const myId = getHumanId()
  if (!myId) return null
  const myDevice = getDeviceId()
  if (!myDevice) return null
  const id = input.id ?? createShapeId()
  // Isolate this creation as its own undo step. The owned-panel creation path
  // can run on the main editor directly (e.g. a tool/agent-drag on the main
  // canvas) — without a mark, the new shape glues onto whatever the user did
  // just before (a move/resize), so one undo wrongly reverses that prior
  // operation. Mark the main editor (undo routes there) regardless of which
  // editor this create runs on.
  if (input.markHistoryStoppingPoint !== false) markMainEditorHistoryStoppingPoint(editor)
  editor.createShape({
    id,
    type: input.type as any,
    parentId: input.parentId,
    x: input.x,
    y: input.y,
    isLocked: input.isLocked,
    props: { ...fleetPanelDefaultProps(input.type), ...input.props, userId: myId, deviceId: myDevice },
  } as any)
  return id as unknown as string
}

export async function createFleetShape(
  editor: Editor,
  type: string,
  x: number,
  y: number,
  props: Record<string, any>,
): Promise<string | null> {
  return createOwnedFleetPanelShape(editor, { type, x, y, props })
}

/**
 * Drop a fleet shape at the cursor, HUD-aware, then select it.
 *
 * When the HUD is active the shape must land in HUD space (where the user
 * clicked), not main-document space — the doc canvas is panned far off to the
 * side, so a page-coord placement drops the panel off-screen and it "vanishes."
 * Translate the screen point through the HUD camera so it lands under the
 * cursor. Falls back to page coords when there's no HUD. Centers the shape on
 * the cursor. Returns the new shape id, or null if
 * identity is unresolved (no shape created).
 */
export async function placeFleetShapeAtCursor(
  editor: Editor,
  type: string,
  w: number,
  h: number,
  extraProps: Record<string, any> = {},
): Promise<string | null> {
  const screen = editor.inputs.currentScreenPoint
  return placeFleetShapeAtScreenPoint(editor, type, screen.x, screen.y, w, h, extraProps)
}

export async function placeFleetShapeAtScreenPoint(
  editor: Editor,
  type: string,
  screenX: number,
  screenY: number,
  w: number,
  h: number,
  extraProps: Record<string, any> = {},
  options: { select?: boolean } = {},
): Promise<string | null> {
  const hudEditor = getHudEditor()
  let x: number, y: number
  if (hudEditor) {
    const point = clientPointToPage(editor, { x: screenX, y: screenY }, FLEET_HUD_VIEWPORT_ID as TLViewportId)
    x = point.x - w / 2
    y = point.y - h / 2
  } else {
    const point = editor.screenToPage({ x: screenX, y: screenY })
    x = point.x - w / 2
    y = point.y - h / 2
  }
  const id = await createFleetShape(editor, type, x, y, { w, h, ...extraProps })
  if (!id) return null
  if (options.select !== false) {
    editor.setCurrentTool('select')
    editor.select(id as TLShapeId)
  }
  return id
}

/** Delete shapes even if locked (unlock first, then delete). */
export function forceDeleteShapes(editor: Editor, ids: string[]) {
  for (const id of ids) {
    const s = editor.getShape(id as any)
    if (s?.isLocked) editor.updateShape({ id: s.id, type: s.type, isLocked: false })
  }
  editor.deleteShapes(ids as any)
}

/** Enter TLDraw select mode for direct resize/move of a fleet panel. */
export async function selectFleetShapeForLayout(editor: Editor, shape: TLShape) {
  await whenDeviceReady()
  const currentShape = editor.getShape(shape.id) ?? shape
  const myId = getHumanId()
  const myDevice = getDeviceId()
  const currentProps = ((currentShape as TLShape & { props?: FleetOwnerProps }).props ?? {}) as FleetOwnerProps
  const missingOwner = shouldRepairFleetPanelOwnership(FLEET_SHAPE_TYPES.has(currentShape.type as string), currentProps)
  if (missingOwner && myId && myDevice) {
    editor.updateShape({
      id: currentShape.id,
      type: currentShape.type,
      props: { ...currentProps, userId: myId, deviceId: myDevice },
    } as TLShapePartial)
  }
  if (currentShape.isLocked) editor.updateShape({ id: currentShape.id, type: currentShape.type, isLocked: false })
  syncFleetLayoutSelectionViewport(editor)
  withFleetLayoutSelectionIntent(currentShape.id, () => {
    editor.setCurrentTool('select')
    editor.select(currentShape.id)
    if (typeof document !== 'undefined' && FLEET_SHAPE_TYPES.has(currentShape.type as string)) {
      enterFleetLayoutMode()
    }
  })
}

/**
 * Nuke all fleet shapes and recreate the default layout.
 *
 * Idempotent by design: shapes get deterministic IDs based on user + slot,
 * so concurrent invocations (reconnect races, repeated fleet-hud-reset events)
 * target the same IDs and overwrite instead of duplicating.
 *
 * agents: list of agent objects from useFleetAgents() — used to pre-fill chat filters.
 */
let _layoutInFlight = false

export type FleetLayoutCreateReason =
  | 'created'
  | 'identity-missing'
  | 'device-missing'
  | 'layout-in-flight'
  | 'document-bounds-missing'
  | 'cleanup-failed'
  | 'no-owned-shapes-created'

export type FleetLayoutCreateResult = {
  created: boolean
  reason: FleetLayoutCreateReason
  variant: string
  userId: string
  deviceId: string
  shapeCount: number
  ownedFleetShapeCount: number
  documentPageCount: number
  documentPagesWithBounds: number
}

/** Deterministic TLDraw shape ID for a fleet layout slot. The app adapter owns
 *  TLDraw's ID factory; the layout planner only asks for slot IDs. */
function layoutSlotId(userId: string, deviceId: string, slot: string) {
  return createShapeId(`fleet-${slot}-${userId.replace('fleet:', '')}-${deviceId}`) as unknown as string
}

export async function createFleetLayout(editor: Editor, agents: any[], variant: FleetLayoutVariant = '3-col', events: any[] = []): Promise<boolean> {
  const result = await createFleetLayoutDetailed(editor, agents, variant, events)
  return result.created
}

export async function createFleetLayoutDetailed(editor: Editor, agents: any[], variant: FleetLayoutVariant = '3-col', events: any[] = []): Promise<FleetLayoutCreateResult> {
  await whenDeviceReady()
  const myId = getHumanId()
  if (!myId) return makeFleetLayoutResult(editor, variant, 'identity-missing', myId, getDeviceId())
  const myDevice = getDeviceId()
  if (!myDevice) return makeFleetLayoutResult(editor, variant, 'device-missing', myId, myDevice)
  if (_layoutInFlight) return makeFleetLayoutResult(editor, variant, 'layout-in-flight', myId, myDevice)
  _layoutInFlight = true

  try {
    return _createFleetLayoutInner(editor, agents, variant, myId, myDevice, events)
  } finally {
    _layoutInFlight = false
  }
}

function makeFleetLayoutResult(
  editor: Editor,
  variant: string,
  reason: FleetLayoutCreateReason,
  userId = getHumanId(),
  deviceId = getDeviceId(),
): FleetLayoutCreateResult {
  const shapes = editor.getCurrentPageShapes()
  const documentPages = shapes.filter(isDocumentPageShape)
  let pagesWithBounds = 0
  for (const page of documentPages) {
    if (editor.getShapePageBounds(page.id)) pagesWithBounds++
  }
  const ownedFleetShapeCount = userId && deviceId
    ? shapes.filter(s => isFleetShapeForOwnerKey(s, userId, deviceId)).length
    : 0
  return {
    created: reason === 'created',
    reason,
    variant,
    userId: userId || '',
    deviceId: deviceId || '',
    shapeCount: shapes.length,
    ownedFleetShapeCount,
    documentPageCount: documentPages.length,
    documentPagesWithBounds: pagesWithBounds,
  }
}

function _createFleetLayoutInner(editor: Editor, agents: any[], variant: string, myId: string, myDevice: string, events: any[] = []): FleetLayoutCreateResult {
  const docBounds = getDocumentPageBounds(editor)
  if (!docBounds) {
    console.warn('[FleetLayout] Refusing to create default layout before document page bounds are ready')
    return makeFleetLayoutResult(editor, variant, 'document-bounds-missing', myId, myDevice)
  }

  const existing = editor.getCurrentPageShapes().filter(s => isFleetShapeForOwnerKey(s, myId, myDevice))
  const existingChatFilters = existing
    .filter(shape => String(shape.type) === 'fleet-chat')
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map(shape => (shape.props as { filter?: FleetChatFilter }).filter || [])
  try {
    editor.run(() => {
      if (existing.length > 0) forceDeleteShapes(editor, existing.map(s => s.id as string))

      const anchorId = getAnchorIdForOwnerKey(myId, myDevice)
      const anchor = editor.getShape(anchorId as any)
      if (anchor) {
        if (anchor.isLocked) editor.updateShape({ id: anchorId as any, type: 'geo', isLocked: false })
        editor.deleteShape(anchorId as any)
      }
      const proxy = editor.getCurrentPageShapes().find(s => s.id === 'shape:fleet-hud-proxy')
      if (proxy) editor.deleteShape(proxy.id)
    }, { history: 'ignore' })
  } catch (e) {
    console.warn('[FleetLayout] Refusing to create default layout after cleanup failed', e)
    return makeFleetLayoutResult(editor, variant, 'cleanup-failed', myId, myDevice)
  }

  editor.run(() => {
    const layoutPlan = planFleetLayoutShapes(buildFleetLayoutPlanInput({
      editor,
      agents,
      variant,
      myId,
      myName: getHumanName(),
      myDevice,
      docBounds,
      events,
      existingChatFilters,
      makeSlotId: slot => layoutSlotId(myId, myDevice, slot),
    }))
    editor.createShapes(layoutPlan.shapes as any)
    if (layoutPlan.dispatchHudReset) {
      dispatchFleetHudReset()
    }
  })

  dispatchFleetHudReset()
  const result = makeFleetLayoutResult(editor, variant, 'created', myId, myDevice)
  return result.ownedFleetShapeCount > 0
    ? result
    : makeFleetLayoutResult(editor, variant, 'no-owned-shapes-created', myId, myDevice)
}
