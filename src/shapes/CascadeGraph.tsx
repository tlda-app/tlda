/**
 * CascadeGraph — renders the current structural-invalidation cascade as an actual
 * directed graph (the "render it as a cascade" view). Roots are directly-stale
 * proof nodes (own statement changed); edges follow the dependency cascade down
 * to the nodes that rest on them. Approving a root re-vets it and clears
 * everything reachable below it (approve-upstream-clears-downstream).
 *
 * Self-contained SVG-in-HTML (boxes as HTML for crisp KaTeX-free text, arrows as
 * SVG), laid out in dependency bands top→bottom — the same layered-DAG shape the
 * argument GraphShape uses, scoped here to the invalidated subgraph.
 */
import { stopEventPropagation, useUniqueSafeId } from 'tldraw'
import { useMemo } from 'react'

export interface CascadeGraphNode {
  id: string
  title: string
  stale: 'direct' | 'cascade'
  depth?: number       // direct = 0; cascade = hops from a changed node
  via?: string         // cascade only — immediate upstream node id
}

const AMBER = '#c8965a'
const VIOLET = '#9a86c8'
const DIM = 'rgba(140,140,150,0.5)'

const BOX_H = 30
const BAND_H = 64
const PAD_TOP = 12
const PAD_X = 12

interface Pos { cx: number; top: number; w: number }

function layout(nodes: CascadeGraphNode[], width: number) {
  const byDepth = new Map<number, CascadeGraphNode[]>()
  for (const n of nodes) {
    const d = n.stale === 'direct' ? 0 : Math.max(1, n.depth || 1)
    if (!byDepth.has(d)) byDepth.set(d, [])
    byDepth.get(d)!.push(n)
  }
  const maxDepth = Math.max(0, ...byDepth.keys())
  const pos = new Map<string, Pos>()
  for (let d = 0; d <= maxDepth; d++) {
    const band = byDepth.get(d) || []
    const slotW = (width - PAD_X * 2) / Math.max(1, band.length)
    band.forEach((n, i) => {
      pos.set(n.id, { cx: PAD_X + slotW * i + slotW / 2, top: PAD_TOP + d * BAND_H, w: Math.max(86, Math.min(slotW - 12, 200)) })
    })
  }
  return { pos, totalH: PAD_TOP + (maxDepth + 1) * BAND_H + 6 }
}

export function CascadeGraph({ nodes, width, onApprove }: {
  nodes: CascadeGraphNode[]
  width: number
  onApprove: (id: string) => void
}) {
  const arrowId = useUniqueSafeId('cg-arrow')
  const innerW = Math.max(160, width - 4)
  const { pos, totalH } = useMemo(() => layout(nodes, innerW), [nodes, innerW])
  // Edges: each cascade node draws an arrow up from its immediate upstream `via`,
  // but only when that upstream is itself in the rendered set (it always is — the
  // cascade is computed from the same roots).
  const edges = useMemo(
    () => nodes.filter((n) => n.stale === 'cascade' && n.via && pos.has(n.via)).map((n) => ({ from: n.via!, to: n.id })),
    [nodes, pos],
  )

  if (nodes.length === 0) {
    return <div className="cascade-graph-empty">no stale proof nodes — nothing to re-vet</div>
  }

  return (
    <div className="cascade-graph" style={{ position: 'relative', width: '100%', height: totalH }} onPointerDown={(e) => stopEventPropagation(e)}>
      <svg width="100%" height={totalH} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <defs>
          <marker id={arrowId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill={DIM} />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const a = pos.get(e.from)!, b = pos.get(e.to)!
          const x1 = a.cx, y1 = a.top + BOX_H, x2 = b.cx, y2 = b.top
          const my = (y1 + y2) / 2
          return (
            <path key={i} className="cascade-graph-edge" data-from={e.from} data-to={e.to}
              d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 2}`}
              fill="none" stroke={DIM} strokeWidth={1.3} markerEnd={`url(#${arrowId})`} />
          )
        })}
      </svg>
      {nodes.map((n) => {
        const p = pos.get(n.id)!
        const root = n.stale === 'direct'
        const color = root ? AMBER : VIOLET
        return (
          <div
            key={n.id}
            className={`cascade-graph-node ${root ? 'root' : 'cascade'}`}
            data-id={n.id}
            data-stale={n.stale}
            title={root ? 'statement changed — approve to re-vet (clears downstream)' : `depends on ${n.via || ''}`}
            style={{ position: 'absolute', left: p.cx - p.w / 2, top: p.top, width: p.w, minHeight: BOX_H, borderColor: `${color}88` }}
            onPointerUp={root ? (e) => { stopEventPropagation(e); onApprove(n.id) } : undefined}
          >
            <span className="cascade-graph-node-title" style={{ color }}>{n.title}</span>
            {root && <span className="cascade-graph-node-approve" title="Re-vet — clears downstream">approve ↓</span>}
          </div>
        )
      })}
    </div>
  )
}
