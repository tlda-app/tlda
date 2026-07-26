import type { Editor, TLShape, TLViewportId } from 'tldraw'
import { createShapeId } from 'tldraw'
// @ts-ignore — vanilla JS module
import { getHumanId, getDeviceId, whenDeviceReady } from '../fleet/fleet-data.mjs'
// @ts-ignore — vanilla JS module
import { pretty_name_plain_text } from '../../shared/pretty_name.mjs'
import { isDocumentPageShape } from './document-pages'
import { dispatchFleetHudReset, getHudEditor, markMainEditorHistoryStoppingPoint } from '../wm/editor-host-bridge'
import { FLEET_HUD_VIEWPORT_ID } from '../wm/fleet-hud-layer'
import { clientPointToPage } from '../wm/viewport-coordinates'
import {
  FLEET_SHAPE_TYPES,
  fleetPanelDefaultProps,
} from './fleet-panel-registry'
import {
  getAnchorIdForOwnerKey,
  getMyAnchorId,
  isFleetShapeForOwnerKey,
} from './fleet-ownership'
import {
  buildFleetLayoutPlanInput,
  getDocumentPageBounds,
} from './fleet-layout-context'
import { laneDy, layoutOffset } from './fleet-layout-geometry'
import { planFleetLayoutShapes, type FleetLayoutVariant } from './fleet-layout-plan'
import { enterFleetLayoutMode, withFleetLayoutSelectionIntent } from '../overlays/fleet-layout-mode'

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
export { ensureMyLaneDisjoint, laneDy, layoutOffset } from './fleet-layout-geometry'
export { planFleetLayoutShapes, type FleetLayoutPlan, type FleetLayoutShapePlan, type FleetLayoutVariant } from './fleet-layout-plan'
export { defaultFleetLayoutChatFilters, type FleetChatFilter } from './fleet-layout-seeding'

const nativeSnapModeStack = new WeakMap<Editor, boolean[]>()
export function beginNativeSnapDrag(editor: Editor) {
  const stack = nativeSnapModeStack.get(editor) ?? []
  stack.push(editor.user.getIsSnapMode())
  nativeSnapModeStack.set(editor, stack)
  editor.user.updateUserPreferences({ isSnapMode: true })
}

export function endNativeSnapDrag(editor: Editor) {
  const stack = nativeSnapModeStack.get(editor)
  const previous = stack?.pop()
  if (previous === undefined) return
  editor.user.updateUserPreferences({ isSnapMode: previous })
  if (stack && stack.length === 0) nativeSnapModeStack.delete(editor)
}

const fleetSnapModeStack = new WeakMap<Editor, boolean[]>()
export function beginFleetDragWithoutSnap(editor: Editor) {
  const stack = fleetSnapModeStack.get(editor) ?? []
  stack.push(editor.user.getIsSnapMode())
  fleetSnapModeStack.set(editor, stack)
  editor.user.updateUserPreferences({ isSnapMode: false })
}

export function endFleetDragWithoutSnap(editor: Editor) {
  const stack = fleetSnapModeStack.get(editor)
  const previous = stack?.pop()
  if (previous === undefined) return
  editor.user.updateUserPreferences({ isSnapMode: previous })
  if (stack && stack.length === 0) fleetSnapModeStack.delete(editor)
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
  editor.setCurrentTool('select')
  editor.select(id as any)
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
export function selectFleetShapeForLayout(editor: Editor, shape: TLShape) {
  if (shape.isLocked) editor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
  withFleetLayoutSelectionIntent(shape.id, () => {
    editor.setCurrentTool('select')
    editor.select(shape.id)
    if (typeof document !== 'undefined' && FLEET_SHAPE_TYPES.has(shape.type as string)) {
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

export async function createFleetLayout(editor: Editor, agents: any[], variant: FleetLayoutVariant = '3-col'): Promise<boolean> {
  const result = await createFleetLayoutDetailed(editor, agents, variant)
  return result.created
}

export async function createFleetLayoutDetailed(editor: Editor, agents: any[], variant: FleetLayoutVariant = '3-col'): Promise<FleetLayoutCreateResult> {
  await whenDeviceReady()
  const myId = getHumanId()
  if (!myId) return makeFleetLayoutResult(editor, variant, 'identity-missing', myId, getDeviceId())
  const myDevice = getDeviceId()
  if (!myDevice) return makeFleetLayoutResult(editor, variant, 'device-missing', myId, myDevice)
  if (_layoutInFlight) return makeFleetLayoutResult(editor, variant, 'layout-in-flight', myId, myDevice)
  _layoutInFlight = true

  try {
    return _createFleetLayoutInner(editor, agents, variant, myId, myDevice)
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

function _createFleetLayoutInner(editor: Editor, agents: any[], variant: string, myId: string, myDevice: string): FleetLayoutCreateResult {
  const docBounds = getDocumentPageBounds(editor)
  if (!docBounds) {
    console.warn('[FleetLayout] Refusing to create default layout before document page bounds are ready')
    return makeFleetLayoutResult(editor, variant, 'document-bounds-missing', myId, myDevice)
  }

  const existing = editor.getCurrentPageShapes().filter(s => isFleetShapeForOwnerKey(s, myId, myDevice))
  editor.run(() => {
    if (existing.length > 0) forceDeleteShapes(editor, existing.map(s => s.id as string))

    const anchorId = getAnchorIdForOwnerKey(myId, myDevice)
    try {
      const anchor = editor.getShape(anchorId as any)
      if (anchor) {
        if (anchor.isLocked) editor.updateShape({ id: anchorId as any, type: 'geo', isLocked: false })
        editor.deleteShape(anchorId as any)
      }
    } catch {}
    try {
      const proxy = editor.getCurrentPageShapes().find(s => s.id === 'shape:fleet-hud-proxy')
      if (proxy) editor.deleteShape(proxy.id)
    } catch {}

    const layoutPlan = planFleetLayoutShapes(buildFleetLayoutPlanInput({
      editor,
      agents,
      variant,
      myId,
      myDevice,
      docBounds,
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
