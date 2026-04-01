import type { Editor } from 'tldraw'
import { createShapeId } from 'tldraw'

const FLEET_SHAPE_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-pill']

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
 * agents: list of agent objects from useFleetAgents() — used to pre-fill chat filters.
 */
export function createFleetLayout(editor: Editor, agents: any[]) {
  // Preserve existing chat filters before nuking — so Fleet button restores geometry
  // without losing filters the user has set by dragging agents.
  const existing = editor.getCurrentPageShapes().filter(s => FLEET_SHAPE_TYPES.includes(s.type as string))
  const existingChatFilters = existing
    .filter(s => (s.type as string) === 'fleet-chat')
    .map(s => (s as any).props?.filter as [string, string][][] | undefined)

  if (existing.length > 0) forceDeleteShapes(editor, existing.map(s => s.id as string))

  // Fall back to most-recently-active agents only if no existing filter to restore
  const nonHuman = agents.filter((a: any) => a.id !== 'fleet:skip' && a.friendly_name !== 'skip')
  const sorted = [...nonHuman].sort((a: any, b: any) => {
    const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0
    const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0
    return tb - ta
  })
  const [agent1, agent2] = sorted.slice(0, 2)
  const name1 = (agent1?.friendly_name || agent1?.id) as string | undefined
  const name2 = (agent2?.friendly_name || agent2?.id) as string | undefined
  const filter1: [string, string][][] = existingChatFilters[0] ?? (name1 ? [[['from', name1]], [['to', name1]]] : [])
  const filter2: [string, string][][] = existingChatFilters[1] ?? (name2 ? [[['from', name2]], [['to', name2]]] : [])

  const leftW = 340
  const gap = 10
  const chatW = 410               // 2x the previous 205
  const rightW = chatW * 2 + gap  // 830
  const totalH = 640
  const agentsH = 330
  const searchH = totalH - gap - agentsH  // 300
  const totalW = leftW + gap + rightW     // 1180

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

  editor.createShapes([
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
      props: { w: chatW, h: totalH, filter: filter2 },
    },
  ])

  editor.centerOnPoint(
    { x: anchorX + totalW / 2, y: anchorY + totalH / 2 },
    { animation: { duration: 300 } }
  )
}
