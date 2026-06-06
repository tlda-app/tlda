import type { Editor } from 'tldraw'
import { createShapeId } from 'tldraw'
// @ts-ignore — vanilla JS module
import { getHumanId } from '../fleet/fleet-data.mjs'
// @ts-ignore — vanilla JS module
import { baseName } from '../../shared/lineage-name.mjs'

/** Canonical list of fleet shape types — the single source of truth for
 *  ownership filtering, visibility, copy gating, and hit-test exclusion.
 *  Import this everywhere instead of defining local copies. */
export const FLEET_SHAPE_TYPES = new Set([
  'fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview', 'fleet-reaper',
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
  return uid ? `shape:fleet-hud-anchor--${uid.replace('fleet:', '')}` : FLEET_HUD_ANCHOR_ID
}

/**
 * A fleet shape belongs to the current user iff its userId matches.
 * Shapes with an empty/missing userId belong to NO ONE — they are orphans
 * created before identity resolved (or by a session with no identity), and
 * must never be shown to or claimed by anyone. Treating empty userId as
 * "global/legacy" is what let orphan shapes pollute every user's layout while
 * no layout-switch would clean them up.
 *
 * Single source of truth for fleet-shape ownership — both the HUD (what to
 * render) and createFleetLayout (what to delete/replace) use it, so the two
 * can never disagree.
 */
export function isMyFleetShape(s: any): boolean {
  if (!FLEET_SHAPE_TYPES.has(s.type as string)) return false
  const uid = s.props?.userId
  return !!uid && uid === getHumanId()
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
  const id = createShapeId()
  editor.createShape({
    id,
    type: type as any,
    x,
    y,
    props: { ...props, userId: myId },
  })
  return id as unknown as string
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

/** Deterministic shape ID for a fleet layout slot. Same user + same slot
 *  always produces the same ID, so concurrent creates are idempotent. */
function slotId(userId: string, slot: string) {
  return createShapeId(`fleet-${slot}-${userId.replace('fleet:', '')}`)
}

export function createFleetLayout(editor: Editor, agents: any[], variant: '2col' | '3col' | 'wide' | 'grid' = '3col') {
  const myId = getHumanId()
  if (!myId) return
  if (_layoutInFlight) return
  _layoutInFlight = true

  try {
    _createFleetLayoutInner(editor, agents, variant, myId)
  } finally {
    _layoutInFlight = false
  }
}

function _createFleetLayoutInner(editor: Editor, agents: any[], variant: string, myId: string) {
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

    const leftW = 340
    const gap = 10
    const chatW3 = 410
    const rightW = chatW3 * 2 + gap
    const vp = editor.getViewportScreenBounds()
    const totalH = Math.round((vp.h / editor.getCamera().z) * 0.7)
    const agentsH = 330
    const searchH = totalH - gap - agentsH
    const totalW = leftW + gap + rightW
    const rightChatH = Math.round(totalH * 0.75)
    const docviewH = totalH - gap - rightChatH

    const pageShapes = editor.getCurrentPageShapes().filter(s =>
      (s.type as string) === 'html-page' || (s.type as string) === 'svg-page')
    let anchorX = 0, anchorY = 0
    if (pageShapes.length > 0) {
      let minLeft = Infinity, minTop = Infinity
      for (const ps of pageShapes) {
        const b = editor.getShapePageBounds(ps.id)
        if (b) {
          if (b.x < minLeft) minLeft = b.x
          if (b.y < minTop) minTop = b.y
        }
      }
      anchorX = minLeft - 40 - totalW
      anchorY = minTop - 1200
    } else {
      const vb = editor.getViewportScreenBounds()
      const cam = editor.getCamera()
      anchorX = (-cam.x + (vb.x + vb.w / 2) / cam.z) - totalW / 2
      anchorY = -cam.y + (vb.y + vb.h / 2) / cam.z
    }

    const shapes: any[] = [
      {
        id: slotId(myId, 'agents'),
        type: 'fleet-agents' as any,
        x: anchorX, y: anchorY,
        isLocked: false,
        props: { w: leftW, h: agentsH },
      },
      {
        id: slotId(myId, 'search'),
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
          id: slotId(myId, 'chat-0'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap, y: anchorY,
          isLocked: false,
          props: { w: chatWide, h: rightChatH, filter: filter1 },
        },
        {
          id: slotId(myId, 'docview'),
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
          id: slotId(myId, 'chat-0'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap, y: anchorY,
          isLocked: false,
          props: { w: gridChatW, h: gridChatH, filter: filter1 },
        },
        {
          id: slotId(myId, 'chat-1'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap + gridChatW + gap, y: anchorY,
          isLocked: false,
          props: { w: gridChatW, h: gridChatH, filter: filter2 },
        },
        {
          id: slotId(myId, 'chat-2'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap, y: anchorY + gridChatH + gap,
          isLocked: false,
          props: { w: gridChatW, h: gridChatH, filter: filter3 },
        },
        {
          id: slotId(myId, 'chat-3'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap + gridChatW + gap, y: anchorY + gridChatH + gap,
          isLocked: false,
          props: { w: gridChatW, h: gridRightChatH, filter: filter4 },
        },
        {
          id: slotId(myId, 'docview'),
          type: 'fleet-docview' as any,
          x: anchorX + leftW + gap + gridChatW + gap, y: anchorY + gridChatH + gap + gridRightChatH + gap,
          isLocked: false,
          props: { w: gridChatW, h: gridDocviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
        },
      )
    } else if (variant === '3col') {
      shapes.push(
        {
          id: slotId(myId, 'chat-0'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap, y: anchorY,
          isLocked: false,
          props: { w: chatW3, h: totalH, filter: filter1 },
        },
        {
          id: slotId(myId, 'chat-1'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap + chatW3 + gap, y: anchorY,
          isLocked: false,
          props: { w: chatW3, h: rightChatH, filter: filter2 },
        },
        {
          id: slotId(myId, 'docview'),
          type: 'fleet-docview' as any,
          x: anchorX + leftW + gap + chatW3 + gap, y: anchorY + rightChatH + gap,
          isLocked: false,
          props: { w: chatW3, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
        },
      )
    } else {
      const chatWide = Math.round(chatW3 * 1.5)
      const leftGroupRight = anchorX + leftW + gap + chatWide
      const MARGIN_GAP = 20
      let docRightScreen = window.innerWidth / 2
      if (pageShapes.length > 0) {
        let maxPageRight = -Infinity
        for (const ps of pageShapes) {
          const b = editor.getShapePageBounds(ps.id)
          if (b) { const r = b.x + b.w; if (r > maxPageRight) maxPageRight = r }
        }
        docRightScreen = editor.pageToScreen({ x: maxPageRight, y: 0 }).x
      }
      let docLeftScreen = window.innerWidth / 2
      if (pageShapes.length > 0) {
        let minPageX = Infinity
        for (const ps of pageShapes) {
          const b = editor.getShapePageBounds(ps.id)
          if (b && b.x < minPageX) minPageX = b.x
        }
        docLeftScreen = editor.pageToScreen({ x: minPageX, y: 0 }).x
      }
      const camX = docLeftScreen - MARGIN_GAP - leftGroupRight
      const rightChatX = docRightScreen + MARGIN_GAP - camX

      shapes.push(
        {
          id: slotId(myId, 'chat-0'),
          type: 'fleet-chat' as any,
          x: anchorX + leftW + gap, y: anchorY,
          isLocked: false,
          props: { w: chatWide, h: rightChatH, filter: filter1 },
        },
        {
          id: slotId(myId, 'docview'),
          type: 'fleet-docview' as any,
          x: anchorX + leftW + gap, y: anchorY + rightChatH + gap,
          isLocked: false,
          props: { w: chatWide, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
        },
        {
          id: slotId(myId, 'chat-1'),
          type: 'fleet-chat' as any,
          x: rightChatX, y: anchorY,
          isLocked: false,
          props: { w: chatWide, h: totalH, filter: filter2 },
        },
      )
    }
    for (const s of shapes) s.props.userId = myId
    editor.createShapes(shapes)
  })

  try { window.dispatchEvent(new CustomEvent('fleet-hud-reset')) } catch {}
}
