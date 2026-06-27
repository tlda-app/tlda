import type { Editor } from 'tldraw'
import { createShapeId } from 'tldraw'
// @ts-ignore — vanilla JS module
import { getHumanId, getHumanName, getDeviceId, getEvents, isDeviceReady, whenDeviceReady } from '../fleet/fleet-data.mjs'
// @ts-ignore — vanilla JS module
import { baseName } from '../../shared/lineage-name.mjs'
// @ts-ignore — vanilla JS module
import { recentChatTargetAgents } from '../fleet/layout-targets.mjs'
import { getPref } from '../preferences'
import { isDocumentPageShape } from './document-pages'

/** Canonical list of fleet shape types — the single source of truth for
 *  ownership filtering, visibility, copy gating, and hit-test exclusion.
 *  Import this everywhere instead of defining local copies. */
export const FLEET_SHAPE_TYPES = new Set([
  'fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview', 'fleet-reaper', 'fleet-inbox', 'fleet-touch-inbox', 'fleet-notifications',
])

export const FLEET_SHAPE_SELECTOR = [...FLEET_SHAPE_TYPES]
  .map(type => `[data-shape-type="${type}"]`)
  .join(', ')

export const FLEET_INTERACTION_SHAPE_SELECTOR = `${FLEET_SHAPE_SELECTOR}, [data-shape-type="fleet-pill"]`

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

/**
 * The display name for an agent — the single source of truth used everywhere a
 * name is shown (agents panel, chat target chip, nicks). Lineage is purely a
 * naming convention: the agent's friendly_name IS its identity. The phase is
 * encoded in the name as a ":day"/":dusk" suffix (dawn is bare), so display
 * strips that suffix and shows the base name; the phase is conveyed only by the
 * icon. Never derive the name from any server "phase" — there is no such field.
 */
export function agentDisplayName(agent: any, _allAgents?: any[]): string {
  if (!agent) return '[unknown]'
  return baseName(agent.friendly_name) || (agent.id || '').replace('fleet:', '')
}

export const FLEET_HUD_ANCHOR_ID = 'shape:fleet-hud-anchor' as const

export function getMyAnchorId(): string {
  const uid = getHumanId()
  if (!uid) return FLEET_HUD_ANCHOR_ID
  // Per-(identity, device): the anchor stores this device's pan/camera offsets,
  // so the same identity on two devices doesn't share — and fight over — one
  // anchor.
  const dev = getDeviceId()
  return getAnchorIdForOwnerKey(uid, dev)
}

export function getAnchorIdForOwnerKey(userId: string, deviceId: string): string {
  if (!userId || !deviceId) return FLEET_HUD_ANCHOR_ID
  return `shape:fleet-hud-anchor--${userId.replace('fleet:', '')}--${deviceId}`
}

export function isFleetShapeForOwnerKey(s: any, userId: string, deviceId: string): boolean {
  if (!FLEET_SHAPE_TYPES.has(s.type as string)) return false
  const uid = s.props?.userId
  const dev = s.props?.deviceId
  return !!uid && uid === userId && !!dev && dev === deviceId
}

/**
 * A fleet shape belongs to the current session iff BOTH its userId (identity)
 * and deviceId match this browser. The layout is keyed by (identity, device):
 * the same human on two devices (Mac + iPad) gets two distinct layouts, and
 * each session only renders/manages its own — so two devices never stack on or
 * fight over one shared set of shapes.
 *
 * Shapes with an empty/missing userId OR deviceId belong to NO ONE — orphans
 * created before identity resolved (or by a pre-(identity,device) session) —
 * and must never be shown to or claimed by anyone.
 *
 * Single source of truth for fleet-shape ownership — both the HUD (what to
 * render) and createFleetLayout (what to delete/replace) use it, so the two
 * can never disagree.
 */
export function isMyFleetShape(s: any): boolean {
  if (!isDeviceReady()) return false
  const myId = getHumanId()
  const myDevice = getDeviceId()
  return isFleetShapeForOwnerKey(s, myId, myDevice)
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
export async function createFleetShape(
  editor: Editor,
  type: string,
  x: number,
  y: number,
  props: Record<string, any>,
): Promise<string | null> {
  await whenDeviceReady()
  const myId = getHumanId()
  if (!myId) return null
  const myDevice = getDeviceId()
  if (!myDevice) return null
  const id = createShapeId()
  // Isolate this creation as its own undo step. createFleetShape is THE choke
  // point for fleet-shape creation, and it can run on the main editor directly
  // (e.g. a tool/agent-drag on the main canvas) — without a mark, the new shape
  // glues onto whatever the user did just before (a move/resize), so one undo
  // wrongly reverses that prior operation. Mark the main editor (undo routes
  // there) regardless of which editor this create runs on.
  const me = (typeof window !== 'undefined' && (window as any).__tldraw_editor__) || editor
  me.markHistoryStoppingPoint?.()
  editor.createShape({
    id,
    type: type as any,
    x,
    y,
    props: { ...props, userId: myId, deviceId: myDevice },
  })
  return id as unknown as string
}

/** Panel dimensions per fleet tool — the single source of truth shared by the
 *  tools (what they create) and the cursor ghost preview (what it previews). */
export const FLEET_TOOL_DIMS: Record<string, { w: number; h: number }> = {
  'fleet-chat': { w: 400, h: 600 },
  'fleet-agents': { w: 400, h: 500 },
  'fleet-search': { w: 400, h: 300 },
  'fleet-inbox': { w: 360, h: 560 },
  'fleet-touch-inbox': { w: 380, h: 680 },
  'fleet-notifications': { w: 360, h: 220 },
  'fleet-reaper': { w: 480, h: 360 },
}

/**
 * Drop a fleet shape at the cursor, HUD-aware, then select it.
 *
 * When the HUD is active the shape must land in HUD space (where the user
 * clicked), not main-document space — the doc canvas is panned far off to the
 * side, so a page-coord placement drops the panel off-screen and it "vanishes."
 * Translate the screen point through the HUD camera so it lands under the
 * cursor. Falls back to page coords when there's no HUD. Centers the shape on
 * the cursor (matching ReaperTool). Returns the new shape id, or null if
 * identity is unresolved (no shape created).
 */
export async function placeFleetShapeAtCursor(
  editor: Editor,
  type: string,
  w: number,
  h: number,
  extraProps: Record<string, any> = {},
): Promise<string | null> {
  const hudEditor = (typeof window !== 'undefined' && (window as any).__tldraw_hud_editor__) || null
  let x: number, y: number
  if (hudEditor) {
    const screen = editor.inputs.currentScreenPoint
    const cam = hudEditor.getCamera()
    x = screen.x / cam.z - cam.x - w / 2
    y = screen.y / cam.z - cam.y - h / 2
  } else {
    const point = editor.inputs.currentPagePoint
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
  | 'phone-target-missing'
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

/** Deterministic shape ID for a fleet layout slot. Same (user, device, slot)
 *  always produces the same ID, so concurrent creates are idempotent AND two
 *  devices of the same identity get distinct IDs (no shared/contested shapes). */
function slotId(userId: string, deviceId: string, slot: string) {
  return createShapeId(`fleet-${slot}-${userId.replace('fleet:', '')}-${deviceId}`)
}

/** Horizontal offset for an (identity, device) layout. PURE (no room context) so
 *  the HUD can recompute the identical dx from (identity, device) alone and
 *  compensate it — the viewer's own layout then renders in its canonical
 *  horizontal screen position regardless of which zone it physically occupies.
 *  This handles only X (cosmetic horizontal spreading); the spatial *non-overlap*
 *  guarantee between owners is enforced entirely by the vertical lane (laneDy),
 *  which is unique per owner — so two owners can never overlap regardless of dx.
 *  dy is 0 here: vertical placement is owned by laneDy, not this function. */
export function layoutOffset(userId: string, deviceId: string): { dx: number; dy: number } {
  if (!userId || !deviceId) return { dx: 0, dy: 0 }
  const key = `${userId}|${deviceId}`
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0
  const col = Math.abs(hash) % 16
  return { dx: -col * 4000, dy: 0 }
}

/** Vertical spacing between two owners' fleet layouts. Far larger than any
 *  single layout's height — even heavily resized — so two different owners can
 *  never occupy the same vertical band. This is the spatial guarantee that keeps
 *  a foreign owner's shapes from ever sitting under this viewer's fingers,
 *  independent of visibility and independent of which touch system (TLDraw
 *  hit-testing, the HUD gesture handler, raw DOM) processes the gesture. */
const LANE_STEP = 20000

/** The y a lane-0 layout would anchor at: doc top minus the standard top pad.
 *  All sessions compute the same value from the shared document pages, so every
 *  owner's lane index maps to the same absolute band. */
function canonicalBaseY(editor: Editor): number {
  const pages = editor.getCurrentPageShapes().filter(isDocumentPageShape)
  let minTop = Infinity
  for (const p of pages) {
    const b = editor.getShapePageBounds(p.id)
    if (b && b.y < minTop) minTop = b.y
  }
  return isFinite(minTop) ? minTop - 1200 : 0
}

/** Lane indices currently occupied by OTHER owners' fleet shapes, plus the
 *  shared base. "Mine" (this identity+device, AND my pre-device legacy shapes
 *  about to be claimed) is excluded so it never blocks itself; a different
 *  device of the same identity IS a distinct owner and counts as occupied. */
function occupiedLanes(editor: Editor, myId: string, myDevice: string): { base: number; occupied: Set<number> } {
  const base = canonicalBaseY(editor)
  const isMineOrLegacy = (s: any) =>
    s.props?.userId === myId && (s.props?.deviceId === myDevice || !s.props?.deviceId)
  const ownerMinY = new Map<string, number>()
  for (const s of editor.getCurrentPageShapes()) {
    if (!FLEET_SHAPE_TYPES.has(s.type as string)) continue
    if (isMineOrLegacy(s)) continue
    const uid = (s as any).props?.userId, dev = (s as any).props?.deviceId
    if (!uid || !dev) continue // unowned orphan — belongs to no lane
    const key = `${uid}::${dev}`
    const y = (s as any).y
    const cur = ownerMinY.get(key)
    if (cur === undefined || y < cur) ownerMinY.set(key, y)
  }
  const occupied = new Set<number>()
  for (const y of ownerMinY.values()) occupied.add(Math.round((y - base) / LANE_STEP))
  return { base, occupied }
}

/** Guaranteed-disjoint VERTICAL offset (dy) for THIS (identity, device) layout.
 *  The lane is the lowest index not already occupied by another owner present in
 *  the room, so as owners accumulate they pack into distinct bands and their
 *  shapes can never overlap — collision-free by construction, not a hash that
 *  "rarely" collides. The HUD needs no knowledge of the lane: cameraY derives
 *  from this layout's actual shape bounds, so any dy renders canonically. */
export function laneDy(editor: Editor, myId: string, myDevice: string): number {
  if (!myId || !myDevice) return 0
  const { occupied } = occupiedLanes(editor, myId, myDevice)
  let lane = 0
  while (occupied.has(lane)) lane++
  return lane * LANE_STEP
}

/** Shift my whole layout to a free lane if it currently overlaps another owner.
 *  Runs on load (after legacy adoption) so a room that accumulated overlapping
 *  layouts under the old hash self-heals: each session, when it opens, slides
 *  its own shapes out of any collision into the lowest free lane. Only ever
 *  moves MY shapes; other owners are untouched. Returns the number moved. */
export function ensureMyLaneDisjoint(editor: Editor, myId: string, myDevice: string): number {
  if (!isDeviceReady()) return 0
  if (!myId || !myDevice) return 0
  const mine = editor.getCurrentPageShapes().filter(isMyFleetShape)
  if (mine.length === 0) return 0
  const bbox = (shapes: any[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of shapes) {
      const b = editor.getShapePageBounds(s.id)
      if (!b) continue
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
    }
    return isFinite(minX) ? { minX, minY, maxX, maxY } : null
  }
  const myBox = bbox(mine)
  if (!myBox) return 0
  // Other owners' boxes.
  const others = new Map<string, any[]>()
  for (const s of editor.getCurrentPageShapes()) {
    if (!FLEET_SHAPE_TYPES.has(s.type as string)) continue
    if (isMyFleetShape(s)) continue
    const uid = (s as any).props?.userId, dev = (s as any).props?.deviceId
    if (!uid || !dev) continue
    const key = `${uid}::${dev}`
    if (!others.has(key)) others.set(key, [])
    others.get(key)!.push(s)
  }
  const intersects = (a: any, b: any) =>
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
  // Yield only to lower-sorting owners: if two owners load at once and overlap,
  // exactly one (the higher key) moves, so they can't both jump and re-collide.
  const myKey = `${myId}::${myDevice}`
  let collides = false
  for (const [key, arr] of others) {
    const ob = bbox(arr)
    if (ob && intersects(myBox, ob) && key < myKey) { collides = true; break }
  }
  if (!collides) return 0
  const { base } = occupiedLanes(editor, myId, myDevice)
  const targetDy = laneDy(editor, myId, myDevice)
  const currentDy = Math.round((myBox.minY - base) / LANE_STEP) * LANE_STEP
  const delta = targetDy - currentDy
  if (delta === 0) return 0
  editor.run(() => {
    for (const s of mine) {
      editor.updateShape({ id: s.id, type: s.type, x: (s as any).x, y: (s as any).y + delta } as any)
    }
  }, { history: 'ignore' })
  return mine.length
}

export async function createFleetLayout(editor: Editor, agents: any[], variant: '2col' | '3col' | 'wide' | 'grid' | 'touch' | 'phone' = '3col'): Promise<boolean> {
  const result = await createFleetLayoutDetailed(editor, agents, variant)
  return result.created
}

export async function createFleetLayoutDetailed(editor: Editor, agents: any[], variant: '2col' | '3col' | 'wide' | 'grid' | 'touch' | 'phone' = '3col'): Promise<FleetLayoutCreateResult> {
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

function getDocumentPageBounds(editor: Editor) {
  const pageShapes = editor.getCurrentPageShapes().filter(isDocumentPageShape)
  let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity
  const pagesWithBounds: any[] = []
  for (const ps of pageShapes) {
    const b = editor.getShapePageBounds(ps.id)
    if (!b) continue
    pagesWithBounds.push(ps)
    if (b.x < minLeft) minLeft = b.x
    if (b.y < minTop) minTop = b.y
    if (b.x + b.w > maxRight) maxRight = b.x + b.w
  }
  if (pagesWithBounds.length === 0 || !isFinite(minLeft) || !isFinite(minTop) || !isFinite(maxRight)) return null
  return { pageShapes: pagesWithBounds, minLeft, minTop, maxRight }
}

function getPhoneLayoutTarget(editor: Editor, pageShapes: any[], vp: ReturnType<Editor['getViewportScreenBounds']>) {
  let target: { x: number; y: number; w: number; h: number; pageX: number } | null = null
  let bestArea = -1
  const sortedPages = [...pageShapes].sort((a: any, b: any) => (a.y ?? 0) - (b.y ?? 0))
  for (const ps of sortedPages) {
    const pb = editor.getShapePageBounds(ps.id)
    if (!pb) continue
    const tl = editor.pageToScreen({ x: pb.x, y: pb.y })
    const br = editor.pageToScreen({ x: pb.x + pb.w, y: pb.y + pb.h })
    const pageRect = {
      x: Math.min(tl.x, br.x),
      y: Math.min(tl.y, br.y),
      w: Math.abs(br.x - tl.x),
      h: Math.abs(br.y - tl.y),
      pageX: pb.x,
    }
    const clipped = {
      x: Math.max(pageRect.x, vp.x),
      y: Math.max(pageRect.y, vp.y),
      w: Math.max(0, Math.min(pageRect.x + pageRect.w, vp.x + vp.w) - Math.max(pageRect.x, vp.x)),
      h: Math.max(0, Math.min(pageRect.y + pageRect.h, vp.y + vp.h) - Math.max(pageRect.y, vp.y)),
    }
    const area = clipped.w * clipped.h
    if (area > bestArea) {
      bestArea = area
      target = pageRect
    }
  }
  return target
}

function _createFleetLayoutInner(editor: Editor, agents: any[], variant: string, myId: string, myDevice: string): FleetLayoutCreateResult {
  const docBounds = getDocumentPageBounds(editor)
  if (!docBounds) {
    console.warn('[FleetLayout] Refusing to create default layout before document page bounds are ready')
    return makeFleetLayoutResult(editor, variant, 'document-bounds-missing', myId, myDevice)
  }

  const existing = editor.getCurrentPageShapes().filter(s => isFleetShapeForOwnerKey(s, myId, myDevice))
  const existingChatFilters = existing
    .filter(s => (s.type as string) === 'fleet-chat')
    .map(s => (s as any).props?.filter as [string, string][][] | undefined)
  const vp = editor.getViewportScreenBounds()
  const phoneTarget = variant === 'phone' ? getPhoneLayoutTarget(editor, docBounds.pageShapes, vp) : null
  if (variant === 'phone' && !phoneTarget) {
    console.warn('[FleetLayout] Refusing to create phone layout before document page bounds are usable')
    return makeFleetLayoutResult(editor, variant, 'phone-target-missing', myId, myDevice)
  }

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

    const humanId = getHumanId()
    const nonHuman = agents.filter((a: any) => a.id !== humanId && !a.human)
    const sorted = [...nonHuman].sort((a: any, b: any) => {
      const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0
      const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0
      return tb - ta
    })
    const seenNames = new Set<string>()
    const deduped = sorted.filter((a: any) => {
      const name = a.friendly_name as string | undefined
      if (!name || seenNames.has(name)) return false
      seenNames.add(name)
      return true
    })
    const panelCount = variant === 'grid' ? 4 : (variant === 'wide' || variant === 'phone') ? 1 : 2
    const recentChatAgents = recentChatTargetAgents(getEvents(), deduped, humanId, getHumanName(), panelCount)
    const recentIds = new Set(recentChatAgents.map((a: any) => a.id || a.friendly_name))
    const topAgents = [
      ...recentChatAgents,
      ...deduped.filter((a: any) => !recentIds.has(a.id || a.friendly_name)),
    ].slice(0, panelCount)
    const makeFilter = (i: number): [string, string][][] => {
      if (existingChatFilters[i]) return existingChatFilters[i]!
      const name = topAgents[i]?.friendly_name as string | undefined
      return name ? [[['from', name]], [['to', name]]] : []
    }
    const filter1 = makeFilter(0)
    const filter2 = makeFilter(1)
    const filter3 = makeFilter(2)
    const filter4 = makeFilter(3)

    const leftW = getPref('layout-rail-width')
    const gap = 10
    const chatW3 = getPref('layout-chat-width')
    const marginGap = getPref('layout-margin-gap')
    const rightW = chatW3 * 2 + gap
    // HUD renders fleet shapes via a z=1 camera (see FleetHUD.tsx), so page units
    // map 1:1 to screen px — size off the raw viewport, not the main-camera zoom.
    const totalH = Math.round(vp.h * getPref('layout-height-frac'))
    const agentsH = 330
    const searchH = totalH - gap - agentsH
    const rightChatH = Math.round(totalH * 0.75)
    const docviewH = totalH - gap - rightChatH

    // Width of the content that sits in the LEFT margin (rail + its chat
    // columns). Its right edge is anchored marginGap to the left of the
    // document; the rest stacks outward (further left). The 2-col layout also
    // places one chat in the RIGHT margin, at docRight + marginGap (below).
    // Everything is laid out relative to the document edges — never relative to
    // the HUD position, which is a separate offset (the anchor shape).
    const leftContentW =
      variant === 'wide' ? leftW + gap + Math.round(chatW3 * 2)
      : variant === '2col' ? leftW + gap + Math.round(chatW3 * 1.5)
      : leftW + gap + rightW

    const { minLeft, minTop, maxRight } = docBounds
    let anchorX = minLeft - marginGap - leftContentW
    let anchorY = minTop - 1200
    const docMaxRight = maxRight

    // Push this (identity, device)'s whole layout into its own guaranteed-free
    // vertical lane so two owners' shapes can never overlap. dy bands owners
    // vertically by a lane index chosen to miss every other owner present in the
    // room (laneDy); dx is a cosmetic horizontal spread the HUD compensates. My
    // HUD view is unaffected — its camera follows my own shapes' bounds — so this
    // only separates the underlying canvas shapes, which is what keeps a foreign
    // layout from overlapping mine.
    const { dx } = layoutOffset(myId, myDevice)
    const dy = laneDy(editor, myId, myDevice)
    anchorX += dx
    anchorY += dy

    // Phone layout: three horizontal, screen-sized lanes.
    // Left lane: agents over inbox/filter surface.
    // Middle lane: chat.
    // Right lane: the document page itself.
    // The fleet lanes are TLDraw/HUD shapes placed immediately to the left of
    // the document page; PhoneHandTool snaps the main camera between these
    // three document-left screen offsets.
    if (variant === 'phone') {
      const target = phoneTarget!

      const screenW = Math.round(vp.w)
      const screenH = Math.round(vp.h)
      const chatW = screenW
      const chatH = screenH
      const colW = screenW
      const phoneAgentsH = Math.min(Math.round(screenH * 0.42), Math.max(160, Math.round(screenH * 0.38)))
      const phoneInboxH = Math.max(160, chatH - gap - phoneAgentsH)
      const chatX = target.pageX - chatW + dx
      const colX = target.pageX - chatW - colW + dx
      editor.createShapes([
        {
          id: slotId(myId, myDevice, 'agents'),
          type: 'fleet-agents' as any,
          x: colX, y: anchorY,
          isLocked: false,
          props: { w: colW, h: phoneAgentsH, userId: myId, deviceId: myDevice },
        },
        {
          id: slotId(myId, myDevice, 'inbox'),
          type: 'fleet-inbox' as any,
          x: colX, y: anchorY + phoneAgentsH + gap,
          isLocked: false,
          props: { w: colW, h: phoneInboxH, userId: myId, deviceId: myDevice },
        },
        {
          id: slotId(myId, myDevice, 'chat-0'),
          type: 'fleet-chat' as any,
          x: chatX, y: anchorY,
          isLocked: false,
          props: { w: chatW, h: chatH, filter: filter1, userId: myId, deviceId: myDevice },
        },
      ])
      try { window.dispatchEvent(new CustomEvent('fleet-hud-reset')) } catch {}
      return
    }

    // Touch layout: a single container (inbox strip + nested chat), one column.
    // The container auto-creates its own fleet-chat child, so no other shapes.
    if (variant === 'touch') {
      const touchW = chatW3
      editor.createShapes([{
        id: slotId(myId, myDevice, 'touch-inbox'),
        type: 'fleet-touch-inbox' as any,
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: touchW, h: totalH, userId: myId, deviceId: myDevice },
      }])
      return
    }

    const shapes: any[] = [
      {
        id: slotId(myId, myDevice, 'inbox'),
        type: 'fleet-inbox' as any,
        x: anchorX - leftW - gap, y: anchorY,
        isLocked: false,
        props: { w: leftW, h: agentsH + gap + searchH },
      },
      {
        id: slotId(myId, myDevice, 'agents'),
        type: 'fleet-agents' as any,
        x: anchorX, y: anchorY,
        isLocked: false,
        props: { w: leftW, h: agentsH },
      },
      {
        id: slotId(myId, myDevice, 'search'),
        type: 'fleet-search' as any,
        x: anchorX, y: anchorY + agentsH + gap,
        isLocked: false,
        props: { w: leftW, h: searchH },
      },
    ]
    if (variant === 'wide') {
      const chatWide = Math.round(chatW3 * 2)
      shapes.push(
        {
          id: slotId(myId, myDevice, 'chat-0'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap, y: anchorY,
          isLocked: false,
          props: { w: chatWide, h: rightChatH, filter: filter1 },
        },
        {
          id: slotId(myId, myDevice, 'docview'),
          type: 'fleet-docview' as any,
          x: anchorX + leftW + gap, y: anchorY + rightChatH + gap,
          isLocked: false,
          props: { w: chatWide, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
        },
      )
    } else if (variant === 'grid') {
      const gridChatW = chatW3
      const gridChatH = Math.round((totalH - gap) / 2)
      const gridRightChatH = Math.round(gridChatH * 0.75)
      const gridDocviewH = gridChatH - gap - gridRightChatH
      shapes.push(
        {
          id: slotId(myId, myDevice, 'chat-0'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap, y: anchorY,
          isLocked: false,
          props: { w: gridChatW, h: gridChatH, filter: filter1 },
        },
        {
          id: slotId(myId, myDevice, 'chat-1'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap + gridChatW + gap, y: anchorY,
          isLocked: false,
          props: { w: gridChatW, h: gridChatH, filter: filter2 },
        },
        {
          id: slotId(myId, myDevice, 'chat-2'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap, y: anchorY + gridChatH + gap,
          isLocked: false,
          props: { w: gridChatW, h: gridChatH, filter: filter3 },
        },
        {
          id: slotId(myId, myDevice, 'chat-3'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap + gridChatW + gap, y: anchorY + gridChatH + gap,
          isLocked: false,
          props: { w: gridChatW, h: gridRightChatH, filter: filter4 },
        },
        {
          id: slotId(myId, myDevice, 'docview'),
          type: 'fleet-docview' as any,
          x: anchorX + leftW + gap + gridChatW + gap, y: anchorY + gridChatH + gap + gridRightChatH + gap,
          isLocked: false,
          props: { w: gridChatW, h: gridDocviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
        },
      )
    } else if (variant === '3col') {
      shapes.push(
        {
          id: slotId(myId, myDevice, 'chat-0'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap, y: anchorY,
          isLocked: false,
          props: { w: chatW3, h: totalH, filter: filter1 },
        },
        {
          id: slotId(myId, myDevice, 'chat-1'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap + chatW3 + gap, y: anchorY,
          isLocked: false,
          props: { w: chatW3, h: rightChatH, filter: filter2 },
        },
        {
          id: slotId(myId, myDevice, 'docview'),
          type: 'fleet-docview' as any,
          x: anchorX + leftW + gap + chatW3 + gap, y: anchorY + rightChatH + gap,
          isLocked: false,
          props: { w: chatW3, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
        },
      )
    } else {
      const chatWide = Math.round(chatW3 * 1.5)
      // Left group's right edge already sits marginGap left of the document
      // (via anchorX). The right-margin chat's left edge sits marginGap right
      // of the document — both in page coords, so the HUD maps them 1:1. Add the
      // same dx so the WHOLE layout translates as one rigid unit (the HUD then
      // compensates that dx, rendering every shape in its canonical position).
      const rightChatX = docMaxRight + marginGap + dx

      shapes.push(
        {
          id: slotId(myId, myDevice, 'chat-0'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap, y: anchorY,
          isLocked: false,
          props: { w: chatWide, h: rightChatH, filter: filter1 },
        },
        {
          id: slotId(myId, myDevice, 'docview'),
          type: 'fleet-docview' as any,
          x: anchorX + leftW + gap, y: anchorY + rightChatH + gap,
          isLocked: false,
          props: { w: chatWide, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
        },
        {
          id: slotId(myId, myDevice, 'chat-1'),
          type: 'fleet-chat' as any,
          x: rightChatX, y: anchorY,
          isLocked: false,
          props: { w: chatWide, h: totalH, filter: filter2 },
        },
      )
    }
    for (const s of shapes) { s.props.userId = myId; s.props.deviceId = myDevice }
    editor.createShapes(shapes)
  })

  try { window.dispatchEvent(new CustomEvent('fleet-hud-reset')) } catch {}
  const result = makeFleetLayoutResult(editor, variant, 'created', myId, myDevice)
  return result.ownedFleetShapeCount > 0
    ? result
    : makeFleetLayoutResult(editor, variant, 'no-owned-shapes-created', myId, myDevice)
}
