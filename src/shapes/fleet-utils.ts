import type { Editor } from 'tldraw'
import { createShapeId } from 'tldraw'
// @ts-ignore — vanilla JS module
import { getHumanId, getDeviceId } from '../fleet/fleet-data.mjs'
// @ts-ignore — vanilla JS module
import { baseName } from '../../shared/lineage-name.mjs'
import { getPref } from '../preferences'

/** Canonical list of fleet shape types — the single source of truth for
 *  ownership filtering, visibility, copy gating, and hit-test exclusion.
 *  Import this everywhere instead of defining local copies. */
export const FLEET_SHAPE_TYPES = new Set([
  'fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview', 'fleet-reaper', 'fleet-inbox', 'fleet-touch-inbox',
])

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
  return `shape:fleet-hud-anchor--${uid.replace('fleet:', '')}--${dev}`
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
  if (!FLEET_SHAPE_TYPES.has(s.type as string)) return false
  const uid = s.props?.userId
  const dev = s.props?.deviceId
  return !!uid && uid === getHumanId() && !!dev && dev === getDeviceId()
}

/**
 * One-time migration to the (identity, device) key. Fleet shapes created before
 * this scheme have my userId but NO deviceId, so the device-scoped
 * isMyFleetShape would orphan them — wiping a user's hand-built layout on first
 * load after the upgrade. Claim them for THIS device by stamping deviceId
 * (preserving every other prop, incl. filters) AND translating them by this
 * (identity, device)'s layoutOffset, so adopted shapes share the exact same
 * offset as freshly-created ones. That uniformity is what lets the HUD undo the
 * offset with a single camera compensation and render every own shape — adopted
 * or created — in its canonical screen position. The legacy pre-device anchor is
 * dropped (the HUD recomputes the correct camera; carrying its stale pan/cameraY
 * would override the offset compensation). Run once on identity resolve;
 * history-ignored. A real migration, NOT an "empty deviceId means mine" shim.
 */
export function adoptLegacyFleetShapes(editor: Editor): number {
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

  const { dx, dy } = layoutOffset(myId, myDevice)
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
export function createFleetShape(
  editor: Editor,
  type: string,
  x: number,
  y: number,
  props: Record<string, any>,
): string | null {
  const myId = getHumanId()
  if (!myId) return null
  const myDevice = getDeviceId()
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
export function placeFleetShapeAtCursor(
  editor: Editor,
  type: string,
  w: number,
  h: number,
  extraProps: Record<string, any> = {},
): string | null {
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
  const id = createFleetShape(editor, type, x, y, { w, h, ...extraProps })
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

/** Deterministic shape ID for a fleet layout slot. Same (user, device, slot)
 *  always produces the same ID, so concurrent creates are idempotent AND two
 *  devices of the same identity get distinct IDs (no shared/contested shapes). */
function slotId(userId: string, deviceId: string, slot: string) {
  return createShapeId(`fleet-${slot}-${userId.replace('fleet:', '')}-${deviceId}`)
}

/** Deterministic canvas offset for an (identity, device) layout, so no two
 *  sessions' shapes stack on the same spot. The HUD camera follows my own
 *  shapes' bounds (getFleetBounds filters to isMyFleetShape), so shifting my
 *  shapes by a constant just moves the underlying canvas position — my HUD view
 *  is unchanged. Nobody looks at the raw canvas shapes; this only keeps foreign
 *  layouts from physically overlapping.
 *
 *  The offset tiles into a 2D grid (columns extend left into the margin, rows
 *  extend down) keyed on a hash of (identity, device). The grid is large (32
 *  rows × 16 cols = 512 cells) so a collision — two distinct (identity,device)
 *  pairs landing on the same cell — is rare for realistic session counts. A
 *  collision is only cosmetic regardless: ownership (isMyFleetShape) is an exact
 *  (identity,device) match, so even fully-overlapping foreign shapes never enter
 *  a viewer's HUD or intercept their filtering. */
export function layoutOffset(userId: string, deviceId: string): { dx: number; dy: number } {
  if (!userId || !deviceId) return { dx: 0, dy: 0 }
  const key = `${userId}|${deviceId}`
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0
  const h = Math.abs(hash)
  // Fixed cell steps (NOT derived from layout/viewport) so the HUD can recompute
  // the identical offset from (identity, device) alone and compensate it — the
  // viewer's own layout then renders in its canonical screen position regardless
  // of which zone its shapes physically occupy. Steps are large enough to clear
  // any layout's footprint. 16 cols × 32 rows = 512 cells → collisions rare.
  const col = h % 16
  const row = (h >> 4) % 32
  return { dx: -col * 4000, dy: row * 2500 }
}

export function createFleetLayout(editor: Editor, agents: any[], variant: '2col' | '3col' | 'wide' | 'grid' | 'touch' | 'phone' = '3col') {
  const myId = getHumanId()
  if (!myId) return
  const myDevice = getDeviceId()
  if (!myDevice) return
  if (_layoutInFlight) return
  _layoutInFlight = true

  try {
    _createFleetLayoutInner(editor, agents, variant, myId, myDevice)
  } finally {
    _layoutInFlight = false
  }
}

function _createFleetLayoutInner(editor: Editor, agents: any[], variant: string, myId: string, myDevice: string) {
  const existing = editor.getCurrentPageShapes().filter(isMyFleetShape)
  const existingChatFilters = existing
    .filter(s => (s.type as string) === 'fleet-chat')
    .map(s => (s as any).props?.filter as [string, string][][] | undefined)

  editor.run(() => {
    if (existing.length > 0) forceDeleteShapes(editor, existing.map(s => s.id as string))

    const anchorId = getMyAnchorId()
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
    const panelCount = variant === 'grid' ? 4 : variant === 'wide' ? 1 : 2
    const topAgents = deduped.slice(0, panelCount)
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
    const vp = editor.getViewportScreenBounds()
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

    const pageShapes = editor.getCurrentPageShapes().filter(s =>
      (s.type as string) === 'html-page' || (s.type as string) === 'svg-page')
    let anchorX = 0, anchorY = 0
    let docMaxRight = 0
    if (pageShapes.length > 0) {
      let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity
      for (const ps of pageShapes) {
        const b = editor.getShapePageBounds(ps.id)
        if (b) {
          if (b.x < minLeft) minLeft = b.x
          if (b.y < minTop) minTop = b.y
          if (b.x + b.w > maxRight) maxRight = b.x + b.w
        }
      }
      anchorX = minLeft - marginGap - leftContentW
      anchorY = minTop - 1200
      docMaxRight = maxRight
    } else {
      const vb = editor.getViewportScreenBounds()
      const cam = editor.getCamera()
      anchorX = (-cam.x + (vb.x + vb.w / 2) / cam.z) - leftContentW / 2
      anchorY = -cam.y + (vb.y + vb.h / 2) / cam.z
      docMaxRight = anchorX + leftContentW
    }

    // Push this (identity, device)'s whole layout to its own canvas slot so two
    // sessions never stack on the same spot. dx is 0 (layouts share the margin
    // column); dy bands them vertically. My HUD view is unaffected — its camera
    // follows my own shapes' bounds — so this only separates the underlying
    // canvas shapes, which is what keeps a foreign layout from overlapping mine.
    const { dx, dy } = layoutOffset(myId, myDevice)
    anchorX += dx
    anchorY += dy

    // Phone layout: the simplest usable thing — a short agents strip (to filter
    // the chat) on top, and one chat filling the rest of the screen. No inbox,
    // search, or docview. Sized to the viewport so it fills the phone; positions
    // are a first cut and meant to be hand-adjusted (anisotropic resize). Early
    // return — these two shapes are the whole layout.
    if (variant === 'phone') {
      // Size to ONE document page at its CURRENT on-screen size (Skip's
      // principle: everything relative to the page's current size). The page's
      // on-screen size = its page-coord bounds × the current camera zoom, so the
      // layout scales with the page — zoom the page small, the layout is small.
      // (HUD shapes render at z=1 / screen px, so we pre-multiply by the zoom.)
      const camZ = editor.getCamera().z || 1
      const pb = pageShapes[0] ? editor.getShapePageBounds(pageShapes[0].id) : null
      const w = pb ? pb.width * camZ : Math.max(160, vp.w - 12)
      const pageH = pb ? pb.height * camZ : Math.max(200, vp.h - 12)
      const agentsHp = Math.min(150, Math.round(pageH * 0.14))
      // Right edge sits marginGap to the left of the page — same gap the other
      // layouts use. anchorX + leftContentW == page-left - marginGap, so place
      // the shape so its right edge lands there.
      const phoneX = anchorX + leftContentW - w
      editor.createShapes([
        {
          id: slotId(myId, myDevice, 'agents'),
          type: 'fleet-agents' as any,
          x: phoneX, y: anchorY,
          isLocked: false,
          props: { w, h: agentsHp, userId: myId, deviceId: myDevice },
        },
        {
          id: slotId(myId, myDevice, 'chat-0'),
          type: 'fleet-chat' as any,
          x: phoneX, y: anchorY + agentsHp + gap,
          isLocked: false,
          props: { w, h: Math.max(200, pageH - agentsHp - gap), filter: filter1, userId: myId, deviceId: myDevice },
        },
        // Reference pane: a ¾-page docview hung off the RIGHT margin — mirror of
        // the chat on the left, same marginGap from the page edge, scaled to ¾ so
        // it reads as secondary. The phone pans between chat (left) / doc (center)
        // / reference (right); only one is on screen at a time.
        {
          id: slotId(myId, myDevice, 'docview'),
          type: 'fleet-docview' as any,
          x: docMaxRight + marginGap + dx, y: anchorY,
          isLocked: false,
          props: { w: Math.round(w * 0.75), h: Math.round(pageH * 0.75), mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '', userId: myId, deviceId: myDevice },
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
}
