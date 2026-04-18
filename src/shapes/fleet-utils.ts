import type { Editor } from 'tldraw'
import { createShapeId } from 'tldraw'
// @ts-ignore — vanilla JS module
import { getHumanId } from '../fleet/fleet-data.mjs'

const FLEET_SHAPE_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview']

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
export function createFleetLayout(editor: Editor, agents: any[], variant: '2col' | '3col' = '3col') {
  // Preserve existing chat filters before nuking — so Fleet button restores geometry
  // without losing filters the user has set by dragging agents.
  const existing = editor.getCurrentPageShapes().filter(s => FLEET_SHAPE_TYPES.includes(s.type as string))
  const existingChatFilters = existing
    .filter(s => (s.type as string) === 'fleet-chat')
    .map(s => (s as any).props?.filter as [string, string][][] | undefined)

  if (existing.length > 0) forceDeleteShapes(editor, existing.map(s => s.id as string))

  // Clear HUD position override so the wrap reverts to auto-layout. Without
  // this the HUD might still render at a wedged position even after the
  // shapes are recreated.
  try { localStorage.removeItem('fleet-hud-override') } catch {}
  // Force a global reload of the FleetHUD's hudOverride state. The simplest
  // signal: dispatch a custom event the FleetHUD listens for. We also nuke
  // any leftover proxy shape from a half-finished layout-mode entry.
  try {
    const proxy = editor.getCurrentPageShapes().find(s => s.id === 'shape:fleet-hud-proxy')
    if (proxy) editor.deleteShape(proxy.id)
  } catch {}
  try { window.dispatchEvent(new CustomEvent('fleet-hud-reset')) } catch {}

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
  // 3-col: two chats at 410 each → rightW 830.
  // 2-col: one chat at 1.5x width (615) → rightW 615. Narrower overall.
  const chatW3 = 410
  const chatW2 = Math.round(chatW3 * 1.5)
  const chatW = variant === '2col' ? chatW2 : chatW3
  const rightW = variant === '2col' ? chatW2 : chatW3 * 2 + gap
  const totalH = 640
  const agentsH = 330
  const searchH = totalH - gap - agentsH
  const totalW = leftW + gap + rightW
  // Rightmost chat is shortened to make room for a docview beneath it.
  const rightChatH = Math.round(totalH * 0.75)
  const docviewH = totalH - gap - rightChatH

  // Anchor: just left of the doc's left margin
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
  if (variant === '3col') {
    // Full-height chat (middle) + 75%-height chat (right) + docview (bottom-right)
    shapes.push(
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: chatW, h: totalH, filter: filter1 },
      },
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap + chatW + gap, y: anchorY,
        isLocked: false,
        props: { w: chatW, h: rightChatH, filter: filter2 },
      },
      {
        id: createShapeId(),
        type: 'fleet-docview' as any,
        x: anchorX + leftW + gap + chatW + gap, y: anchorY + rightChatH + gap,
        isLocked: false,
        props: { w: chatW, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
      },
    )
  } else {
    // 2-col: single wider chat (75% height) + docview beneath it
    shapes.push(
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: chatW, h: rightChatH, filter: filter1 },
      },
      {
        id: createShapeId(),
        type: 'fleet-docview' as any,
        x: anchorX + leftW + gap, y: anchorY + rightChatH + gap,
        isLocked: false,
        props: { w: chatW, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
      },
    )
  }
  editor.createShapes(shapes)

  editor.centerOnPoint(
    { x: anchorX + totalW / 2, y: anchorY + totalH / 2 },
    { animation: { duration: 300 } }
  )
}
