import type { Editor } from 'tldraw'
import { createShapeId } from 'tldraw'
// @ts-ignore — vanilla JS module
import { getHumanId, getHumanIdMaybe } from '../fleet/fleet-data.mjs'

const FLEET_SHAPE_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview', 'fleet-reaper']

export const FLEET_HUD_ANCHOR_ID = 'shape:fleet-hud-anchor' as const

export function getMyAnchorId(): string {
  const uid = getHumanIdMaybe()
  return uid ? `shape:fleet-hud-anchor--${uid.replace('fleet:', '')}` : FLEET_HUD_ANCHOR_ID
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
 * Nuke all fleet shapes and recreate the default 3-column layout.
 * Also clears the HUD position override and proxy shape so a wedged HUD
 * (off-canvas, broken size, etc.) gets fully reset. This is the
 * emergency-recovery escape hatch from any layout-mode mess.
 *
 * agents: list of agent objects from useFleetAgents() — used to pre-fill chat filters.
 */
export function createFleetLayout(editor: Editor, agents: any[], variant: '2col' | '3col' | 'wide' | 'grid' = '3col') {
  const myId = getHumanIdMaybe() ?? ''
  const isMyShape = (s: any) => {
    if (!FLEET_SHAPE_TYPES.includes(s.type as string)) return false
    const uid = s.props?.userId
    if (!uid) return !myId  // legacy shapes: only claim if no user logged in
    return uid === myId
  }
  const existing = editor.getCurrentPageShapes().filter(isMyShape)
  const existingChatFilters = existing
    .filter(s => (s.type as string) === 'fleet-chat')
    .map(s => (s as any).props?.filter as [string, string][][] | undefined)

  if (existing.length > 0) forceDeleteShapes(editor, existing.map(s => s.id as string))

  const anchorId = getMyAnchorId()
  try {
    const anchor = editor.getShape(anchorId as any)
    if (anchor) {
      if (anchor.isLocked) editor.updateShape({ id: anchorId as any, type: 'geo', isLocked: false })
      editor.deleteShape(anchorId as any)
    }
  } catch {}
  // Force a global reload of the FleetHUD's hudOverride state. The simplest
  // signal: dispatch a custom event the FleetHUD listens for. We also nuke
  // any leftover proxy shape from a half-finished layout-mode entry.
  try {
    const proxy = editor.getCurrentPageShapes().find(s => s.id === 'shape:fleet-hud-proxy')
    if (proxy) editor.deleteShape(proxy.id)
  } catch {}
  try { window.dispatchEvent(new CustomEvent('fleet-hud-reset')) } catch {}

  // Fall back to most-recently-active agents only if no existing filter to restore
  const humanId = getHumanIdMaybe()
  const nonHuman = agents.filter((a: any) => a.id !== humanId && !a.human)
  const sorted = [...nonHuman].sort((a: any, b: any) => {
    const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0
    const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0
    return tb - ta
  })
  // Deduplicate by friendly_name — same agent can appear multiple times if they
  // re-registered (new session = new DB row). First occurrence wins since sorted
  // descending by last_seen, so we keep the most recently active entry.
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
  // Rightmost chat is shortened to make room for a docview beneath it.
  const rightChatH = Math.round(totalH * 0.75)
  const docviewH = totalH - gap - rightChatH

  // Anchor: just left of the doc's left margin. All three columns sit
  // together in the left margin as a contiguous block.
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
      id: createShapeId(),
      type: 'fleet-agents' as any,
      x: anchorX, y: anchorY,
      isLocked: false,
      props: { w: leftW, h: agentsH },
    },
    {
      id: createShapeId(),
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
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: chatWide, h: rightChatH, filter: filter1 },
      },
      {
        id: createShapeId(),
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
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: gridChatW, h: gridChatH, filter: filter1 },
      },
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap + gridChatW + gap, y: anchorY,
        isLocked: false,
        props: { w: gridChatW, h: gridChatH, filter: filter2 },
      },
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap, y: anchorY + gridChatH + gap,
        isLocked: false,
        props: { w: gridChatW, h: gridChatH, filter: filter3 },
      },
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap + gridChatW + gap, y: anchorY + gridChatH + gap,
        isLocked: false,
        props: { w: gridChatW, h: gridRightChatH, filter: filter4 },
      },
      {
        id: createShapeId(),
        type: 'fleet-docview' as any,
        x: anchorX + leftW + gap + gridChatW + gap, y: anchorY + gridChatH + gap + gridRightChatH + gap,
        isLocked: false,
        props: { w: gridChatW, h: gridDocviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
      },
    )
  } else if (variant === '3col') {
    // Full-height chat (middle) + 75%-height chat (right) + docview (bottom-right)
    shapes.push(
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: chatW3, h: totalH, filter: filter1 },
      },
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap + chatW3 + gap, y: anchorY,
        isLocked: false,
        props: { w: chatW3, h: rightChatH, filter: filter2 },
      },
      {
        id: createShapeId(),
        type: 'fleet-docview' as any,
        x: anchorX + leftW + gap + chatW3 + gap, y: anchorY + rightChatH + gap,
        isLocked: false,
        props: { w: chatW3, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
      },
    )
  } else {
    // Split L/R: left margin has agents+search + wide chat (3/4) + docview (1/4).
    // Right margin has a wide chat (full height). Chats are 1.5x wider than 3-col.
    const chatWide = Math.round(chatW3 * 1.5) // 615
    // The left group right edge (in page coords) is what the overlay camera
    // uses to compute its X offset. We need to place the right-margin chat
    // at a page X such that, under the overlay camera, it appears at the
    // right edge of the screen.
    //
    // Overlay camera X will be: docLeftScreen - MARGIN_GAP - leftGroupRightEdge
    // where leftGroupRightEdge = anchorX + leftW + gap + chatWide
    // Screen position of right chat = rightChatPageX + camX
    // We want it at: screenW - chatWide - MARGIN_GAP
    //
    // So: rightChatPageX = (screenW - chatWide - MARGIN_GAP) - camX
    //   = (screenW - chatWide - MARGIN_GAP) - (docLeftScreen - MARGIN_GAP - leftGroupRight)
    //   = screenW - chatWide - docLeftScreen + leftGroupRight
    const leftGroupRight = anchorX + leftW + gap + chatWide
    const MARGIN_GAP = 20
    // Find document right edge on screen to position the right-margin chat
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
    // Camera X will be: docLeftScreen - MARGIN_GAP - leftGroupRight
    // Right chat screen position = rightChatX + camX
    // We want right chat left edge at: docRightScreen + MARGIN_GAP
    // So: rightChatX = docRightScreen + MARGIN_GAP - camX
    const camX = docLeftScreen - MARGIN_GAP - leftGroupRight
    const rightChatX = docRightScreen + MARGIN_GAP - camX

    shapes.push(
      // Left margin: wide chat (3/4 height) + docview (1/4 height)
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: chatWide, h: rightChatH, filter: filter1 },
      },
      {
        id: createShapeId(),
        type: 'fleet-docview' as any,
        x: anchorX + leftW + gap, y: anchorY + rightChatH + gap,
        isLocked: false,
        props: { w: chatWide, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
      },
      // Right margin: wide chat (full height)
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: rightChatX, y: anchorY,
        isLocked: false,
        props: { w: chatWide, h: totalH, filter: filter2 },
      },
    )
  }
  const uid = getHumanId()   // throws if called pre-login; the toolbar entry that fires createFleetLayout is gated by the login screen so this should be unreachable from the UI
  for (const s of shapes) s.props.userId = uid
  editor.createShapes(shapes)

  // Don't center the main canvas on fleet shapes — that disrupts the user's
  // document position. The HUD overlay handles fleet shape visibility
  // independently via its own camera.
}
