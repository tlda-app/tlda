/**
 * Materialize a chain (content) into NATIVE tldraw shapes (approach B):
 *   - each node  -> a `graph-node` shape (KaTeX label, kind-styled)
 *   - each group -> a `frame` (box); nested groups -> nested frames
 *   - each edge  -> a native `arrow` bound to the two node shapes (re-routes on drag)
 *
 * Layout is computed once here for a sensible initial arrangement; after that it
 * is native (drag the nodes, arrows follow). Content is the source of truth; the
 * positions we set are not persisted back (non-layout / usability-first).
 */
import { createShapeId, toRichText, type Editor, type TLShapeId } from 'tldraw'
import type { Chain } from './graphDemoData'

const NODE_W = 210
const NODE_H = 58
const TOOL_W = 156
const TOOL_H = 46
const ROADMAP_W = 520
const ROADMAP_H = 38
const COL_X = 680          // x-center of the group column
const TOOL_X = 70          // x-center of the left tool column
const NODE_GAP = 80        // horizontal gap between members in a band
const BAND_Y0 = 170        // first move-box band y-center
const BAND_GAP = 270       // vertical gap between move bands
const FRAME_PAD = 26
const ARROW_SCALE = 0.7    // shrink arrow labels + heads

type Pos = { x: number; y: number; w: number; h: number }

export function materializeChain(editor: Editor, chain: Chain) {
  const byId = Object.fromEntries(chain.nodes.map((n) => [n.id, n]))
  const idOf: Record<string, TLShapeId> = {}
  const pos: Record<string, Pos> = {}

  const topGroups = chain.groups.filter((g) => !g.parent)
  const groupOfNode: Record<string, string> = {}
  for (const g of chain.groups) for (const nid of g.nodeIds) if (!chain.groups.some((x) => x.parent === g.id && x.nodeIds.includes(nid))) groupOfNode[nid] = g.id

  // --- 1. positions ---
  const roadmap = chain.nodes.find((n) => n.kind === 'roadmap')
  if (roadmap) pos[roadmap.id] = { x: COL_X - ROADMAP_W / 2, y: 40, w: ROADMAP_W, h: ROADMAP_H }

  // top-level move boxes stacked vertically; members laid in a row inside
  topGroups.forEach((g, gi) => {
    const members = g.nodeIds
    const bandY = BAND_Y0 + gi * BAND_GAP
    const rowW = members.length * NODE_W + (members.length - 1) * NODE_GAP
    members.forEach((nid, mi) => {
      pos[nid] = { x: COL_X - rowW / 2 + mi * (NODE_W + NODE_GAP), y: bandY, w: NODE_W, h: NODE_H }
    })
  })

  // tools (objects, ungrouped) in a left column, aligned to the band of the box they feed
  const tools = chain.nodes.filter((n) => n.kind === 'object')
  tools.forEach((t) => {
    const fedEdge = chain.edges.find((e) => e.from === t.id)
    const targetGroup = fedEdge ? groupOfNode[fedEdge.to] : undefined
    const gi = targetGroup ? topGroups.findIndex((g) => g.id === targetGroup) : 0
    const bandY = BAND_Y0 + Math.max(0, gi) * BAND_GAP
    pos[t.id] = { x: TOOL_X - TOOL_W / 2, y: bandY + (NODE_H - TOOL_H) / 2, w: TOOL_W, h: TOOL_H }
  })

  // ungrouped sink states (e.g. the output) below the last band
  const sink = chain.nodes.find((n) => n.kind === 'state' && !groupOfNode[n.id])
  if (sink) pos[sink.id] = { x: COL_X - NODE_W / 2, y: BAND_Y0 + topGroups.length * BAND_GAP, w: NODE_W, h: NODE_H }

  // any node still unplaced — stack at far right so nothing is lost
  let spare = 0
  for (const n of chain.nodes) if (!pos[n.id]) { pos[n.id] = { x: COL_X + 360, y: 80 + spare * (NODE_H + 20), w: NODE_W, h: NODE_H }; spare++ }

  editor.run(() => {
    // --- 2. node shapes ---
    for (const n of chain.nodes) {
      const id = createShapeId()
      idOf[n.id] = id
      const p = pos[n.id]
      editor.createShape({ id, type: 'graph-node', x: p.x, y: p.y, props: { w: p.w, h: p.h, label: n.label, kind: n.kind } })
    }

    // --- 3. frames for groups (top-level first, then nested) ---
    const frameIdOf: Record<string, TLShapeId> = {}
    const makeFrame = (gid: string, label: string, memberNodeIds: string[]) => {
      const ps = memberNodeIds.map((nid) => pos[nid]).filter(Boolean)
      if (!ps.length) return
      const minX = Math.min(...ps.map((p) => p.x)) - FRAME_PAD
      const minY = Math.min(...ps.map((p) => p.y)) - FRAME_PAD - 6
      const maxX = Math.max(...ps.map((p) => p.x + p.w)) + FRAME_PAD
      const maxY = Math.max(...ps.map((p) => p.y + p.h)) + FRAME_PAD
      const fid = createShapeId()
      frameIdOf[gid] = fid
      editor.createShape({ id: fid, type: 'frame', x: minX, y: minY, props: { w: maxX - minX, h: maxY - minY, name: label } })
      editor.reparentShapes(memberNodeIds.map((nid) => idOf[nid]), fid)
    }
    for (const g of chain.groups.filter((x) => !x.parent)) makeFrame(g.id, g.label, g.nodeIds)
    for (const g of chain.groups.filter((x) => x.parent)) {
      makeFrame(g.id, g.label, g.nodeIds)
      if (frameIdOf[g.id] && g.parent && frameIdOf[g.parent]) editor.reparentShapes([frameIdOf[g.id]], frameIdOf[g.parent])
    }

    // --- 4. bound arrows ---
    for (const e of chain.edges) {
      const a = idOf[e.from], b = idOf[e.to]
      if (!a || !b) continue
      const pa = pos[e.from], pb = pos[e.to]
      const arrowId = createShapeId()
      const lb = e.weight === 'load-bearing'
      editor.createShape({
        id: arrowId, type: 'arrow',
        props: {
          start: { x: pa.x + pa.w / 2, y: pa.y + pa.h / 2 },
          end: { x: pb.x + pb.w / 2, y: pb.y + pb.h / 2 },
          richText: toRichText(e.property),
          color: lb ? 'violet' : 'grey',
          size: 's',
          arrowheadEnd: 'arrow', arrowheadStart: 'none',
          font: 'sans',
          labelColor: lb ? 'violet' : 'grey',
          scale: ARROW_SCALE,
        },
      })
      editor.createBindings([
        { fromId: arrowId, toId: a, type: 'arrow', props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } },
        { fromId: arrowId, toId: b, type: 'arrow', props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } },
      ])
    }
  })

  editor.zoomToFit({ animation: { duration: 0 } })
}
