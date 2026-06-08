// Server-side materialization of an argument graph into a doc's Yjs room.
//
// graph_draw used to broadcast a fire-and-forget signal that only materialized in
// a *connected viewer* — so an agent drawing with no viewer open created nothing
// (the bug). This writes the shapes + bound arrows DIRECTLY into the room store
// (the same `room.storage.transaction` mechanism `putShape` uses), so the graph
// persists immediately, no viewer required. A viewer then just loads it.
//
// No Editor is involved (the Editor is a browser/React object). We construct the
// records by hand; the room's schema (which includes `graph-node`) validates them.
import { createShapeId, createBindingId, toRichText } from '@tldraw/tlschema'
import { getIndices } from '@tldraw/utils'
import { getOrCreateRoom } from './sync-rooms.mjs'

// --- pure layout (ported from src/graphNativeMaterialize.ts) ---
// Kept compact on purpose: the whole graph must fit on screen at once beside the
// page. Wider spreads push the rightmost boxes off the viewport.
const STEP_W = 180
const STEPS_CX = 470
const COL_DX = 200
const BAND_DY = 135
const ASSUMP_X = 30
const ASSUMP_W = 220
const TOP_Y = 45

// Native arrow labels are plain text (no KaTeX), so render the short verb with unicode
// math symbols instead of LaTeX control sequences.
function ruleLabel(rule) {
  return String(rule || '')
    .replace(/\$\{\}\^\*\$|\$\^\*\$|\{\}\^\*|\^\*/g, '*')
    .replace(/\$/g, '')
    .replace(/\\dim/g, 'dim')
    .replace(/\\infty/g, '∞')
    .replace(/\\rho/g, 'ρ')
    .replace(/\\chi/g, 'χ')
    .replace(/\\nabla/g, '∇')
    .replace(/\\Pi/g, 'Π')
    .replace(/\\perp/g, '⊥')
    .replace(/\\hat\\gamma/g, 'γ̂')
    .replace(/\\gamma/g, 'γ')
    .replace(/\\to/g, '→')
    .replace(/\\le/g, '≤')
    .replace(/L_K\^?⊥|L_K\^\{?⊥\}?/g, 'L_K⊥')
    .replace(/[{}]/g, '')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function estimateH(claim, w) {
  const cpl = Math.max(16, Math.round((w - 28) / 8.6))
  const lines = String(claim || '').split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / cpl)), 0)
  return Math.max(46, 22 + lines * 21)
}

// Returns { pos: {nodeId:{x,y,w,h}} } for every node in the chain.
function computeLayout(chain) {
  const byId = Object.fromEntries(chain.nodes.map((n) => [n.id, n]))
  const steps = chain.nodes.filter((n) => n.kind !== 'assumption')
  const stepSet = new Set(steps.map((n) => n.id))
  const assumptions = chain.nodes.filter((n) => n.kind === 'assumption')
  const pos = {}

  // step depth by longest path through step->step edges
  const sIncoming = {}
  for (const e of chain.edges) if (stepSet.has(e.from) && stepSet.has(e.to)) (sIncoming[e.to] ||= []).push(e.from)
  const depthMemo = {}
  const depth = (id, seen = new Set()) => {
    if (id in depthMemo) return depthMemo[id]
    if (seen.has(id)) return 0
    seen.add(id)
    const ps = sIncoming[id] || []
    const d = ps.length ? Math.max(...ps.map((p) => depth(p, seen))) + 1 : 0
    return (depthMemo[id] = d)
  }
  steps.forEach((n) => depth(n.id))
  const bands = []
  for (const n of steps) (bands[depthMemo[n.id]] ||= []).push(n.id)
  const cx = {}
  const rowYof = {}
  let bandTop = TOP_Y
  bands.forEach((band, d) => {
    if (d > 0) {
      band.sort((a, b) => {
        const bc = (id) => { const ps = (sIncoming[id] || []).filter((p) => cx[p] != null); return ps.length ? ps.reduce((s, p) => s + cx[p], 0) / ps.length : STEPS_CX }
        return bc(a) - bc(b)
      })
    }
    const n = band.length
    band.forEach((id, i) => {
      const x = STEPS_CX - ((n - 1) * COL_DX) / 2 + i * COL_DX - STEP_W / 2
      const h = estimateH(byId[id].claim, STEP_W)
      pos[id] = { x, y: bandTop, w: STEP_W, h }
      cx[id] = x + STEP_W / 2
      rowYof[id] = bandTop
    })
    bandTop += BAND_DY
  })

  // assumptions: left column aligned to the step they feed, de-overlapped
  for (const a of assumptions) {
    const fed = chain.edges.find((e) => e.from === a.id && stepSet.has(e.to))
    const targetY = fed && rowYof[fed.to] != null ? rowYof[fed.to] : TOP_Y
    pos[a.id] = { x: ASSUMP_X, y: targetY, w: ASSUMP_W, h: estimateH(a.claim, ASSUMP_W) }
  }
  const aSorted = assumptions.slice().sort((x, z) => pos[x.id].y - pos[z.id].y)
  for (let i = 1; i < aSorted.length; i++) {
    const prev = pos[aSorted[i - 1].id], cur = pos[aSorted[i].id]
    const minY = prev.y + prev.h + 22
    if (cur.y < minY) cur.y = minY
  }
  return { pos, byId }
}

/**
 * Materialize `chain` into doc `docName`'s room as native records.
 * @returns {{nodes:number, edges:number}}
 */
export async function materializeGraph(docName, chain, { replace = true } = {}) {
  const room = await getOrCreateRoom(docName)
  const records = room.getCurrentSnapshot().documents.map((d) => d.state)
  const page = records.find((r) => r.typeName === 'page')
  const pageId = page ? page.id : 'page:page'

  const { pos, byId } = computeLayout(chain)

  // --- graph-local bounds + a CONTAINER FRAME placed in the doc's right margin ---
  const ps = Object.values(pos)
  const gMinX = Math.min(...ps.map((p) => p.x))
  const gMinY = Math.min(...ps.map((p) => p.y))
  const gMaxX = Math.max(...ps.map((p) => p.x + p.w))
  const gMaxY = Math.max(...ps.map((p) => p.y + p.h))
  const PAD = 30
  const EXPLAIN_H = 150 // explanation zone at the bottom of the container
  const EXPLAIN_GAP = 18
  const graphH = gMaxY - gMinY
  const frameW = (gMaxX - gMinX) + PAD * 2
  const frameH = graphH + PAD * 2 + EXPLAIN_GAP + EXPLAIN_H

  // doc content (the pages) → place the frame to their right
  // Place beside the document page column — use svg-page shapes only. (Earlier this
  // counted the fleet HUD shapes as content and shoved the frame to the doc's far
  // top-left corner.) The caller can then reposition Y to sit beside the relevant proof.
  const pages = records.filter((r) => r.typeName === 'shape' && r.type === 'svg-page')
  let FX = 900, FY = 60
  if (pages.length) {
    FX = Math.max(...pages.map((r) => (r.x || 0) + (r.props?.w || 0))) + 40
    FY = Math.min(...pages.map((r) => r.y || 0))
  }

  // Frame labels are plain text (no KaTeX), so a math-heavy goal claim renders as
  // raw LaTeX. Keep the frame name a clean, fixed label; the goal node states the
  // conclusion (rendered) inside the frame.
  const frameName = 'Argument graph'

  // records to write
  const shapeIds = {} // chain node id -> TLShapeId
  const indices = getIndices(chain.nodes.length + chain.edges.length + 3).slice(1) // +frame +explain
  let ix = 0
  const toSet = []

  const frameId = createShapeId()
  toSet.push({
    id: frameId, typeName: 'shape', type: 'frame',
    x: FX, y: FY, rotation: 0, index: indices[ix++], parentId: pageId,
    isLocked: false, opacity: 1,
    props: { w: frameW, h: frameH, name: frameName, color: 'grey' },
    meta: { graphFrame: true },
  })

  // node + arrow coords are RELATIVE to the frame (children of it)
  for (const n of chain.nodes) {
    const id = createShapeId()
    shapeIds[n.id] = id
    const p = pos[n.id]
    toSet.push({
      id, typeName: 'shape', type: 'graph-node',
      x: (p.x - gMinX) + PAD, y: (p.y - gMinY) + PAD, rotation: 0, index: indices[ix++], parentId: frameId,
      isLocked: false, opacity: 1,
      props: { w: p.w, h: p.h, claim: n.claim, kind: n.kind },
      meta: { graphNode: true },
    })
  }

  // explanation zone: a canvas shape at the bottom of the container that reactively
  // shows the hovered/selected arrow's `detail` (the long reason). Part of the shape,
  // so it pans with the graph.
  toSet.push({
    id: createShapeId(), typeName: 'shape', type: 'graph-explain',
    x: PAD, y: graphH + PAD + EXPLAIN_GAP, rotation: 0, index: indices[ix++], parentId: frameId,
    isLocked: false, opacity: 1,
    props: { w: frameW - PAD * 2, h: EXPLAIN_H },
    meta: { graphExplain: true },
  })

  const bindings = []
  for (const e of chain.edges) {
    const a = shapeIds[e.from], b = shapeIds[e.to]
    if (!a || !b) continue
    const arrowId = createShapeId()
    const lb = e.weight === 'load-bearing'
    const fromAssump = byId[e.from]?.kind === 'assumption'
    toSet.push({
      id: arrowId, typeName: 'shape', type: 'arrow',
      x: 0, y: 0, rotation: 0, index: indices[ix++], parentId: frameId,
      isLocked: false, opacity: 0.5, // faint so they don't disrupt the skeleton
      props: {
        // size 's' + scale 0.6 keeps the native canvas label SMALL (label font is tied to
        // size); hover still lands via tldraw's hit tolerance. Don't bump size for thickness
        // or the label balloons.
        kind: 'arc', elbowMidPoint: 0.5, dash: 'solid', size: 's', fill: 'none',
        color: lb ? 'violet' : 'grey', labelColor: lb ? 'violet' : 'grey', bend: 0,
        start: { x: 0, y: 0 }, end: { x: 2, y: 0 },
        arrowheadStart: 'none', arrowheadEnd: 'arrow',
        richText: toRichText(ruleLabel(e.rule)), labelPosition: 0.5, font: 'sans', scale: 0.6,
      },
      meta: { graphEdge: true, rule: e.rule || '', detail: e.detail || '', lb, showTag: true },
    })
    const startAnchor = fromAssump ? { x: 1, y: 0.5 } : { x: 0.5, y: 0.5 }
    const endAnchor = fromAssump ? { x: 0, y: 0.5 } : { x: 0.5, y: 0.5 }
    bindings.push(
      { id: createBindingId(), typeName: 'binding', type: 'arrow', fromId: arrowId, toId: a, meta: {}, props: { terminal: 'start', normalizedAnchor: startAnchor, isExact: false, isPrecise: fromAssump, snap: 'none' } },
      { id: createBindingId(), typeName: 'binding', type: 'arrow', fromId: arrowId, toId: b, meta: {}, props: { terminal: 'end', normalizedAnchor: endAnchor, isExact: false, isPrecise: fromAssump, snap: 'none' } },
    )
  }

  // ids to delete on replace: existing graph frames + shapes + arrows + their bindings
  const toDelete = []
  if (replace) {
    const oldShapeIds = new Set(records.filter((r) => r.typeName === 'shape' && (r.type === 'graph-node' || r.type === 'graph-explain' || r.meta?.graphEdge || r.meta?.graphNode || r.meta?.graphFrame || r.meta?.graphExplain)).map((r) => r.id))
    for (const id of oldShapeIds) toDelete.push(id)
    for (const r of records) if (r.typeName === 'binding' && (oldShapeIds.has(r.fromId) || oldShapeIds.has(r.toId))) toDelete.push(r.id)
  }

  room.storage.transaction((txn) => {
    for (const id of toDelete) txn.delete(id)
    for (const rec of toSet) txn.set(rec.id, rec)
    for (const bnd of bindings) txn.set(bnd.id, bnd)
  })

  return { nodes: chain.nodes.length, edges: chain.edges.length, frame: frameId }
}
