import type { Editor } from 'tldraw'
import { createShapeId } from 'tldraw'
// @ts-ignore — vanilla JS module
import { getHumanId } from '../fleet/fleet-data.mjs'

const FLEET_SHAPE_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview']

export const FLEET_HUD_ANCHOR_ID = 'shape:fleet-hud-anchor' as const

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
 * Also creates the HUD anchor shape (shape:fleet-hud-anchor) encoding the
 * desired screen position of the fleet overlay. The anchor replaces the old
 * localStorage panOffset/cameraY system — it's an invisible 1×1 geo shape
 * whose page coordinates are updated by FleetHUD to track camera changes.
 *
 * agents: list of agent objects from useFleetAgents() — used to pre-fill chat filters.
 */
export function createFleetLayout(editor: Editor, agents: any[], variant: '2col' | '3col' | 'wide' | 'grid' = '3col') {
  // Preserve existing chat filters before nuking — so Fleet button restores geometry
  // without losing filters the user has set by dragging agents.
  const existing = editor.getCurrentPageShapes().filter(s => FLEET_SHAPE_TYPES.includes(s.type as string))
  const existingChatFilters = existing
    .filter(s => (s.type as string) === 'fleet-chat')
    .map(s => (s as any).props?.filter as [string, string][][] | undefined)

  if (existing.length > 0) forceDeleteShapes(editor, existing.map(s => s.id as string))

  // Fall back to most-recently-active agents only if no existing filter to restore
  const humanId = getHumanId()
  const nonHuman = agents.filter((a: any) => a.id !== humanId && !a.human)
  const sorted = [...nonHuman].sort((a: any, b: any) => {
    const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0
    const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0
    return tb - ta
  })
  const [agent1, agent2] = sorted.slice(0, 2)
  const name1 = agent1?.friendly_name as string | undefined
  const name2 = agent2?.friendly_name as string | undefined
  const filter1: [string, string][][] = existingChatFilters[0] ?? (name1 ? [[['from', name1]], [['to', name1]]] : [])
  const filter2: [string, string][][] = existingChatFilters[1] ?? (name2 ? [[['from', name2]], [['to', name2]]] : [])

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
  // Resolve up to 4 filters for grid layout
  const filter3: [string, string][][] = existingChatFilters[2] ?? []
  const filter4: [string, string][][] = existingChatFilters[3] ?? []

  if (variant === 'wide') {
    // Agents+search left, one wide chat right
    const chatWide = Math.round(chatW3 * 2)
    shapes.push({
      id: createShapeId(),
      type: 'fleet-chat' as any,
      x: anchorX + leftW + gap, y: anchorY,
      isLocked: false,
      props: { w: chatWide, h: totalH, filter: filter1 },
    })
  } else if (variant === 'grid') {
    // Agents+search left, 2x2 chat grid right
    const gridChatW = chatW3
    const gridChatH = Math.round((totalH - gap) / 2)
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
        props: { w: gridChatW, h: gridChatH, filter: filter4 },
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
  editor.createShapes(shapes)

  // Create/update the HUD anchor shape encoding the desired fleet overlay position.
  // The anchor is an invisible 1×1 geo shape. Its page coordinates are updated by
  // FleetHUD on camera changes to keep pageToScreen(anchor) constant — which keeps
  // the overlay at a fixed screen position. On reload, Yjs restores the anchor and
  // the correct overlayCam is derived without any localStorage/delta accumulation.
  _createHudAnchor(editor, anchorX, anchorY, pageShapes)

  // Don't center the main canvas on fleet shapes — that disrupts the user's
  // document position. The HUD overlay handles fleet shape visibility
  // independently via its own camera.
}

/**
 * Create or update the HUD anchor shape at the correct position for the current layout.
 * The anchor's pageToScreen() gives the desired screen position of fleetBounds.x (left
 * clip edge of the overlay). FleetHUD derives overlayCam from it:
 *   overlayCam.x = pageToScreen(anchor).x - fleetBounds.x
 *   overlayCam.y = pageToScreen(anchor).y - fleetBounds.y
 */
function _createHudAnchor(editor: Editor, fleetAnchorX: number, fleetAnchorY: number, pageShapes: any[]) {
  const cam = editor.getCamera()
  const PAD = 20
  const MARGIN_GAP = 20
  const TOP_PAD = 80

  // fleetBounds.x = fleetAnchorX - PAD (the left clip edge including padding)
  const fleetBoundsX = fleetAnchorX - PAD
  const fleetBoundsY = fleetAnchorY - PAD

  // Compute the desired overlayCam.x using the same logic as the old FleetHUD init:
  // the right edge of the left fleet group sits MARGIN_GAP px left of the document.
  let overlayCamX: number
  if (pageShapes.length > 0) {
    let minPageX = Infinity
    for (const ps of pageShapes) {
      const b = editor.getShapePageBounds(ps.id)
      if (b && b.x < minPageX) minPageX = b.x
    }
    const docLeftScreen = editor.pageToScreen({ x: minPageX, y: 0 }).x
    // Compute leftGroupRight from fleet shapes (variant-agnostic)
    const fleetShapes = editor.getCurrentPageShapes()
      .filter(s => ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview'].includes(s.type as string))
    let leftGroupRight = fleetBoundsX + (editor.getShapePageBounds(fleetShapes[0]?.id)?.w ?? 1000) + PAD
    if (fleetShapes.length > 0) {
      const rights = fleetShapes.map(s => {
        const b = editor.getShapePageBounds(s.id)
        return b ? b.x + b.w : 0
      }).sort((a, b) => a - b)
      // Left group = shapes whose right edge is within 1500px of the leftmost fleet shape
      const leftGroupShapes = rights.filter(r => r - fleetBoundsX < 1500)
      if (leftGroupShapes.length > 0) leftGroupRight = Math.max(...leftGroupShapes)
    }
    overlayCamX = docLeftScreen - MARGIN_GAP - leftGroupRight
  } else {
    // No page shapes yet — place fleet group centered in viewport
    overlayCamX = 0
  }

  // overlayCam.y: fleet group top at TOP_PAD on screen
  const overlayCamY = TOP_PAD - fleetBoundsY

  // TLDraw: screenX = (pageX + cam.x) * cam.z  →  pageX = screenX / cam.z - cam.x
  const anchorScreenX = overlayCamX + fleetBoundsX
  const anchorScreenY = overlayCamY + fleetBoundsY  // = TOP_PAD
  const anchorShapeX = anchorScreenX / cam.z - cam.x
  const anchorShapeY = anchorScreenY / cam.z - cam.y

  const existing = editor.getShape(FLEET_HUD_ANCHOR_ID as any)
  if (existing) {
    editor.updateShape({ id: FLEET_HUD_ANCHOR_ID as any, type: 'geo', isLocked: false })
    editor.updateShape({
      id: FLEET_HUD_ANCHOR_ID as any, type: 'geo', isLocked: true,
      x: anchorShapeX, y: anchorShapeY,
      meta: { cameraX: cam.x, cameraY: cam.y, cameraZ: cam.z },
    })
  } else {
    editor.createShape({
      id: FLEET_HUD_ANCHOR_ID as any,
      type: 'geo',
      x: anchorShapeX,
      y: anchorShapeY,
      opacity: 0,
      isLocked: true,
      meta: { cameraX: cam.x, cameraY: cam.y, cameraZ: cam.z },
      props: { w: 1, h: 1, geo: 'rectangle' },
    })
  }
}
