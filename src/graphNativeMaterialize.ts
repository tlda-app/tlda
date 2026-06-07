/**
 * Materialize a chain into native tldraw shapes — the skeleton of implications.
 *   - steps        -> a vertical SPINE of compact claim-nodes (authored order).
 *   - assumptions  -> leaf claim-nodes on the LEFT, beside the step they feed.
 *   - edges        -> native bound arrows (re-route on drag). The inference's
 *                     substance (`detail`) rides in meta for the side panel; a
 *                     tiny `rule` tag shows on the arrow via GraphEdgeLabels.
 * Surface holds NO prose — only claims + arrows. Layout computed once; then it's
 * native (drag, arrows follow). Content is source of truth; positions aren't saved.
 */
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { Chain } from './graphDemoData'

const STEP_W = 250
const STEPS_CX = 760       // center x of the step (layered DAG) area
const COL_DX = 290         // horizontal spacing between siblings in a depth band
const BAND_DY = 150        // vertical spacing between dependency-depth bands
const ASSUMP_X = 70        // x of the assumptions column (left edge)
const ASSUMP_W = 300
const TOP_Y = 60

type Pos = { x: number; y: number; w: number; h: number }

// Estimate a claim card's height so it isn't clipped. Inline math eats room, so
// wrap conservatively.
function estimateH(claim: string, w: number) {
  const cpl = Math.max(16, Math.round((w - 28) / 8.6))
  const lines = String(claim || '').split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / cpl)), 0)
  return Math.max(46, 22 + lines * 21)
}

export function materializeChain(editor: Editor, chain: Chain) {
  const byId = Object.fromEntries(chain.nodes.map((n) => [n.id, n]))
  const idOf: Record<string, TLShapeId> = {}
  const pos: Record<string, Pos> = {}

  const steps = chain.nodes.filter((n) => n.kind !== 'assumption')
  const stepSet = new Set(steps.map((n) => n.id))
  const assumptions = chain.nodes.filter((n) => n.kind === 'assumption')

  // --- step layout: layered DAG by dependency depth (reveals parallelism &
  // convergence; arrows become short hops, not one fake spine line) ---
  const sIncoming: Record<string, string[]> = {}
  for (const e of chain.edges) if (stepSet.has(e.from) && stepSet.has(e.to)) (sIncoming[e.to] ||= []).push(e.from)
  const depthMemo: Record<string, number> = {}
  const depth = (id: string, seen = new Set<string>()): number => {
    if (id in depthMemo) return depthMemo[id]
    if (seen.has(id)) return 0
    seen.add(id)
    const ps = sIncoming[id] || []
    const d = ps.length ? Math.max(...ps.map((p) => depth(p, seen))) + 1 : 0
    return (depthMemo[id] = d)
  }
  steps.forEach((n) => depth(n.id))
  const bands: string[][] = []
  // seed each band in authored order, then barycenter-order deeper bands so a
  // step sits under the steps it depends on (aligns convergences, cuts crossings)
  for (const n of steps) (bands[depthMemo[n.id]] ||= []).push(n.id)
  const cx: Record<string, number> = {}
  const rowYof: Record<string, number> = {}
  let bandTop = TOP_Y
  bands.forEach((band, d) => {
    if (d > 0) {
      band.sort((a, b) => {
        const bc = (id: string) => { const ps = (sIncoming[id] || []).filter((p) => cx[p] != null); return ps.length ? ps.reduce((s, p) => s + cx[p], 0) / ps.length : STEPS_CX }
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

  // --- assumptions: left column, aligned to the step they feed; de-overlapped ---
  for (const a of assumptions) {
    const fed = chain.edges.find((e) => e.from === a.id && stepSet.has(e.to))
    const targetY = fed && rowYof[fed.to] != null ? rowYof[fed.to] : TOP_Y
    const h = estimateH(a.claim, ASSUMP_W)
    pos[a.id] = { x: ASSUMP_X, y: targetY, w: ASSUMP_W, h }
  }
  const assumpSorted = assumptions.slice().sort((x, z) => pos[x.id].y - pos[z.id].y)
  for (let i = 1; i < assumpSorted.length; i++) {
    const prev = pos[assumpSorted[i - 1].id]
    const cur = pos[assumpSorted[i].id]
    const minY = prev.y + prev.h + 22
    if (cur.y < minY) cur.y = minY
  }

  // any unplaced node — stack far right
  let spare = 0
  for (const n of chain.nodes) if (!pos[n.id]) { pos[n.id] = { x: STEPS_CX + STEP_W, y: TOP_Y + spare * 120, w: STEP_W, h: 80 }; spare++ }

  editor.run(() => {
    // node cards
    for (const n of chain.nodes) {
      const id = createShapeId()
      idOf[n.id] = id
      const p = pos[n.id]
      editor.createShape({ id, type: 'graph-node' as any, x: p.x, y: p.y, props: { w: p.w, h: p.h, claim: n.claim, kind: n.kind } })
    }

    // bound arrows. The inference substance (detail) + tiny rule tag ride in meta.
    for (const e of chain.edges) {
      const a = idOf[e.from], b = idOf[e.to]
      if (!a || !b) continue
      const pa = pos[e.from], pb = pos[e.to]
      const arrowId = createShapeId()
      const lb = e.weight === 'load-bearing'
      const fromAssump = byId[e.from]?.kind === 'assumption'
      editor.createShape({
        id: arrowId, type: 'arrow',
        meta: { graphEdge: true, rule: e.rule || '', detail: e.detail || '', lb, showTag: fromAssump },
        props: {
          start: { x: pa.x + pa.w / 2, y: pa.y + pa.h / 2 },
          end: { x: pb.x + pb.w / 2, y: pb.y + pb.h / 2 },
          color: lb ? 'violet' : 'grey',
          size: 's',
          arrowheadEnd: 'arrow', arrowheadStart: 'none',
          scale: 0.8,
        },
      })
      // assumptions enter from the left; spine steps connect centre-to-centre
      const startAnchor = fromAssump ? { x: 1, y: 0.5 } : { x: 0.5, y: 0.5 }
      const endAnchor = fromAssump ? { x: 0, y: 0.5 } : { x: 0.5, y: 0.5 }
      editor.createBindings([
        { fromId: arrowId, toId: a, type: 'arrow', props: { terminal: 'start', normalizedAnchor: startAnchor, isExact: false, isPrecise: fromAssump, snap: 'none' } },
        { fromId: arrowId, toId: b, type: 'arrow', props: { terminal: 'end', normalizedAnchor: endAnchor, isExact: false, isPrecise: fromAssump, snap: 'none' } },
      ])
    }
  })

  // Fit the skeleton into the viewport, leaving a right gutter for the detail
  // panel so it never occludes the graph.
  const b = editor.getCurrentPageBounds()
  const vsb = editor.getViewportScreenBounds()
  if (b && vsb) {
    const pad = 48
    const gutter = 360
    const z = Math.max(0.1, Math.min((vsb.w - gutter - pad) / b.w, (vsb.h - pad * 2) / b.h, 1))
    editor.setCamera({ x: pad / z - b.x, y: pad / z - b.y, z }, { animation: { duration: 0 } })
  } else {
    editor.zoomToFit({ animation: { duration: 0 } })
  }
}
