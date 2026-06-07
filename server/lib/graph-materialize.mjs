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
const STEP_W = 250
const STEPS_CX = 760
const COL_DX = 290
const BAND_DY = 150
const ASSUMP_X = 70
const ASSUMP_W = 300
const TOP_Y = 60

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

  // records to write
  const shapeIds = {} // chain node id -> TLShapeId
  const indices = getIndices(chain.nodes.length + chain.edges.length + 1).slice(1)
  let ix = 0
  const toSet = []

  for (const n of chain.nodes) {
    const id = createShapeId()
    shapeIds[n.id] = id
    const p = pos[n.id]
    toSet.push({
      id, typeName: 'shape', type: 'graph-node',
      x: p.x, y: p.y, rotation: 0, index: indices[ix++], parentId: pageId,
      isLocked: false, opacity: 1,
      props: { w: p.w, h: p.h, claim: n.claim, kind: n.kind },
      meta: { graphNode: true },
    })
  }

  const bindings = []
  for (const e of chain.edges) {
    const a = shapeIds[e.from], b = shapeIds[e.to]
    if (!a || !b) continue
    const arrowId = createShapeId()
    const lb = e.weight === 'load-bearing'
    const fromAssump = byId[e.from]?.kind === 'assumption'
    toSet.push({
      id: arrowId, typeName: 'shape', type: 'arrow',
      x: 0, y: 0, rotation: 0, index: indices[ix++], parentId: pageId,
      isLocked: false, opacity: 1,
      props: {
        kind: 'arc', elbowMidPoint: 0.5, dash: 'solid', size: 's', fill: 'none',
        color: lb ? 'violet' : 'grey', labelColor: lb ? 'violet' : 'grey', bend: 0,
        start: { x: 0, y: 0 }, end: { x: 2, y: 0 },
        arrowheadStart: 'none', arrowheadEnd: 'arrow',
        richText: toRichText(''), labelPosition: 0.5, font: 'sans', scale: 0.8,
      },
      meta: { graphEdge: true, rule: e.rule || '', detail: e.detail || '', lb, showTag: fromAssump },
    })
    const startAnchor = fromAssump ? { x: 1, y: 0.5 } : { x: 0.5, y: 0.5 }
    const endAnchor = fromAssump ? { x: 0, y: 0.5 } : { x: 0.5, y: 0.5 }
    bindings.push(
      { id: createBindingId(), typeName: 'binding', type: 'arrow', fromId: arrowId, toId: a, meta: {}, props: { terminal: 'start', normalizedAnchor: startAnchor, isExact: false, isPrecise: fromAssump, snap: 'none' } },
      { id: createBindingId(), typeName: 'binding', type: 'arrow', fromId: arrowId, toId: b, meta: {}, props: { terminal: 'end', normalizedAnchor: endAnchor, isExact: false, isPrecise: fromAssump, snap: 'none' } },
    )
  }

  // ids to delete on replace: existing graph shapes + arrows + their bindings
  const toDelete = []
  if (replace) {
    const oldShapeIds = new Set(records.filter((r) => r.typeName === 'shape' && (r.type === 'graph-node' || r.meta?.graphEdge || r.meta?.graphNode)).map((r) => r.id))
    for (const id of oldShapeIds) toDelete.push(id)
    for (const r of records) if (r.typeName === 'binding' && (oldShapeIds.has(r.fromId) || oldShapeIds.has(r.toId))) toDelete.push(r.id)
  }

  room.storage.transaction((txn) => {
    for (const id of toDelete) txn.delete(id)
    for (const rec of toSet) txn.set(rec.id, rec)
    for (const bnd of bindings) txn.set(bnd.id, bnd)
  })

  return { nodes: chain.nodes.length, edges: chain.edges.length }
}
