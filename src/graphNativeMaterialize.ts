/**
 * Materialize a chain into native tldraw shapes — spine-primary, readable cards.
 *   - steps        -> a vertical SPINE of cards (topological order), one per row,
 *                     each sized to its claim + justification text.
 *   - assumptions  -> leaf cards on the LEFT, beside the step they feed.
 *   - edges        -> native bound arrows (re-route on drag); a short `via` tag
 *                     renders via the GraphEdgeLabels overlay where present.
 * Layout is computed once for a sane start; then it's native (drag, arrows
 * follow). Content is source of truth; positions are not persisted.
 */
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { Chain } from './graphDemoData'

const SPINE_X = 620        // x of the step column (left edge of step cards)
const STEP_W = 430
const ASSUMP_X = 70        // x of the assumptions column (left edge)
const ASSUMP_W = 300
const TOP_Y = 60
const ROW_GAP = 46         // vertical gap between cards
const CHARS_PER_LINE = 52  // rough wrap width for height estimate

type Pos = { x: number; y: number; w: number; h: number }

// Estimate a card's height from its text so it isn't clipped. Inline math eats
// horizontal room, so wrap conservatively (fewer chars/line) and leave margin.
function estimateH(claim: string, justification: string, w: number, hasBadge: boolean) {
  const cpl = Math.max(18, Math.round((w - 32) / 8.8))
  const lines = (s: string) => s.split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / cpl)), 0)
  const claimLines = claim ? lines(claim) : 1
  const justLines = justification ? lines(justification) : 0
  let h = 30 + claimLines * 22 + (justLines ? justLines * 18 + 8 : 0)
  if (hasBadge) h += 16
  return Math.max(60, h)
}

export function materializeChain(editor: Editor, chain: Chain) {
  const byId = Object.fromEntries(chain.nodes.map((n) => [n.id, n]))
  const idOf: Record<string, TLShapeId> = {}
  const pos: Record<string, Pos> = {}

  const steps = chain.nodes.filter((n) => n.kind !== 'assumption')
  const stepSet = new Set(steps.map((n) => n.id))
  const assumptions = chain.nodes.filter((n) => n.kind === 'assumption')

  // Spine order = the AUTHORED step order. The author writes steps in proof
  // order (already dependency-valid), and that reads far more naturally than an
  // arbitrary Kahn topo sort, which would interleave parallel sub-arguments.
  const order: string[] = steps.map((n) => n.id)

  // --- place step cards down the spine ---
  let y = TOP_Y
  const rowYof: Record<string, number> = {}
  for (const id of order) {
    const n = byId[id]
    const h = estimateH(n.claim, n.justification || '', STEP_W, n.kind === 'goal')
    pos[id] = { x: SPINE_X, y, w: STEP_W, h }
    rowYof[id] = y
    y += h + ROW_GAP
  }

  // --- place assumption cards on the left, beside the step they feed ---
  for (const a of assumptions) {
    const fed = chain.edges.find((e) => e.from === a.id && stepSet.has(e.to))
    const targetY = fed ? rowYof[fed.to] : TOP_Y
    const h = estimateH(a.claim, '', ASSUMP_W, true)
    pos[a.id] = { x: ASSUMP_X, y: targetY, w: ASSUMP_W, h }
  }
  // de-overlap assumption column (they can collide if two feed nearby steps)
  const assumpSorted = assumptions.slice().sort((x, z) => pos[x.id].y - pos[z.id].y)
  for (let i = 1; i < assumpSorted.length; i++) {
    const prev = pos[assumpSorted[i - 1].id]
    const cur = pos[assumpSorted[i].id]
    const minY = prev.y + prev.h + 24
    if (cur.y < minY) cur.y = minY
  }

  // any unplaced node — stack far right
  let spare = 0
  for (const n of chain.nodes) if (!pos[n.id]) { pos[n.id] = { x: SPINE_X + STEP_W + 200, y: TOP_Y + spare * 120, w: STEP_W, h: 80 }; spare++ }

  editor.run(() => {
    // node cards
    for (const n of chain.nodes) {
      const id = createShapeId()
      idOf[n.id] = id
      const p = pos[n.id]
      editor.createShape({ id, type: 'graph-node', x: p.x, y: p.y, props: { w: p.w, h: p.h, claim: n.claim, justification: n.justification || '', kind: n.kind } })
    }

    // bound arrows (bare spine; short `via` tag carried in meta for the overlay)
    for (const e of chain.edges) {
      const a = idOf[e.from], b = idOf[e.to]
      if (!a || !b) continue
      const pa = pos[e.from], pb = pos[e.to]
      const arrowId = createShapeId()
      const lb = e.weight === 'load-bearing'
      const fromAssump = byId[e.from]?.kind === 'assumption'
      editor.createShape({
        id: arrowId, type: 'arrow',
        meta: { graphEdge: true, via: e.via || '', lb },
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

  editor.zoomToFit({ animation: { duration: 0 } })
}
