/**
 * GraphShape — a dedicated canvas shape for the argument graph (the chain).
 *
 * Prototype (2026-06-07). Graph-first: the PRIMARY representation of a proof's
 * structure is a directed acyclic graph of claims (nodes) connected by labeled,
 * weighted dependency arrows (edges) — fetched from GET /:doc/chain?slug, the
 * same <slug>.chain.json an agent authors over MCP (chain_open / chain_apply).
 *
 * Two views of one artifact:
 *   - graph   : the DAG laid out in dependency layers (top → bottom), arrows
 *               carry the driving property; the load-bearing arrow is bold.
 *               This is the reading surface — "what does the agent prove, and
 *               what depends on what."
 *   - outline : a PROJECTION of the graph, not a view of it — a chosen
 *               topological linearization into reading order. The order is real
 *               extra state (a total order consistent with the graph's partial
 *               order); when several linearizations exist we say so.
 *
 * Read-focused: structure is authored over MCP (chain_apply), so the shape never
 * mutates the graph — it renders it and projects it.
 */
import { BaseBoxShapeUtil, HTMLContainer, stopEventPropagation, useUniqueSafeId } from 'tldraw'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { graphProps } from '../../shared/shapes/graph-schema.mjs'
import { renderMarkdownMath } from './MathNoteShape'

// Render a label's inline $…$ math through the app's shared KaTeX+markdown
// renderer (same path MathNoteShape uses), stripping the single wrapping <p>
// so a short label stays inline inside a node box / bullet.
function renderMath(s: string): { __html: string } {
  const html = renderMarkdownMath(String(s ?? '')).replace(/^<p>([\s\S]*?)<\/p>\s*$/, '$1')
  return { __html: html }
}

type GNode = { id: string; kind: 'object' | 'state' | 'roadmap'; label: string; gloss?: string }
type GEdge = { id: string; from: string; to: string; property: string; weight: 'load-bearing' | 'one-liner'; justification?: string }
type Chain = { sourceLeafIds: string[]; nodes: GNode[]; edges: GEdge[] }

// Parse the id-tagged chain markdown the server returns (emitChainMarkdown
// format) into structured nodes/edges. Mirrors server parseChainMarkdown; the
// markdown is the canonical artifact, so the client reads it the same way the
// OutlineShape reads the outline-model markdown (parseOutlineMd).
function parseChainMd(md: string): Chain {
  const chain: Chain = { sourceLeafIds: [], nodes: [], edges: [] }
  let section: 'nodes' | 'edges' | null = null
  let lastNode: GNode | null = null
  let lastEdge: GEdge | null = null
  for (const raw of String(md || '').split('\n')) {
    const trimmed = raw.replace(/\r$/, '').trim()
    if (!trimmed) continue
    const srcM = trimmed.match(/^##\s+chain\b(?:\s*\(source:\s*([^)]*)\))?/i)
    if (srcM) { chain.sourceLeafIds = (srcM[1] || '').split(/[\s,]+/).filter(Boolean); section = null; lastNode = null; lastEdge = null; continue }
    if (/^###\s+nodes\b/i.test(trimmed)) { section = 'nodes'; continue }
    if (/^###\s+edges\b/i.test(trimmed)) { section = 'edges'; continue }
    const contM = trimmed.match(/^(gloss|justify):\s*(.*)$/i)
    if (contM) {
      const val = contM[2].trim()
      if (contM[1].toLowerCase() === 'gloss' && lastNode) lastNode.gloss = val
      else if (contM[1].toLowerCase() === 'justify' && lastEdge) lastEdge.justification = val
      continue
    }
    const itemM = trimmed.match(/^-\s+\[([^\]]+)\]\s*(.*)$/)
    if (!itemM) continue
    const id = itemM[1].trim(); const rest = itemM[2]
    if (section === 'edges') {
      const em = rest.match(/^(\S+)\s*->\s*(\S+)\s*\|\s*([^|]*)(?:\|\s*(.*))?$/)
      if (em) {
        const edge: GEdge = { id, from: em[1].trim(), to: em[2].trim(), property: em[3].trim(), weight: (em[4]?.trim() === 'load-bearing' ? 'load-bearing' : 'one-liner') }
        chain.edges.push(edge); lastEdge = edge; lastNode = null
      }
    } else {
      const parts = rest.split('|')
      const kindRaw = parts.length > 1 ? parts[0].trim() : 'state'
      const kind: GNode['kind'] = kindRaw === 'object' || kindRaw === 'roadmap' ? kindRaw : 'state'
      const node: GNode = { id, kind, label: parts.length > 1 ? parts.slice(1).join('|').trim() : rest.trim() }
      chain.nodes.push(node); lastNode = node; lastEdge = null
    }
  }
  return chain
}

const ACCENT = '#7c3aed'
const DIM = 'rgba(127,127,127,0.55)'

// ---- layered DAG layout (vertical, top → bottom by dependency depth) --------
type Pos = { x: number; cy: number; top: number; boxW: number }
const BOX_H = 40
const BAND_H = 90
const PAD_TOP = 14
const PAD_X = 14

function layoutGraph(chain: Chain, width: number) {
  const nodes = (chain.nodes || []).filter((n) => n.kind !== 'roadmap')
  const ids = new Set(nodes.map((n) => n.id))
  const edges = (chain.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to))
  const incoming: Record<string, string[]> = {}
  for (const e of edges) (incoming[e.to] ||= []).push(e.from)

  const depthMemo: Record<string, number> = {}
  const depth = (id: string, seen = new Set<string>()): number => {
    if (id in depthMemo) return depthMemo[id]
    if (seen.has(id)) return 0
    seen.add(id)
    const parents = incoming[id] || []
    const d = parents.length ? Math.max(...parents.map((p) => depth(p, seen))) + 1 : 0
    depthMemo[id] = d
    return d
  }
  for (const n of nodes) depth(n.id)

  const bands: Record<number, GNode[]> = {}
  for (const n of nodes) (bands[depthMemo[n.id]] ||= []).push(n)
  const maxDepth = Math.max(0, ...Object.keys(bands).map(Number))

  const positions: Record<string, Pos> = {}
  for (let d = 0; d <= maxDepth; d++) {
    const band = bands[d] || []
    const slotW = (width - PAD_X * 2) / Math.max(1, band.length)
    band.forEach((n, i) => {
      const cx = PAD_X + slotW * i + slotW / 2
      positions[n.id] = { x: cx, cy: 0, top: PAD_TOP + d * BAND_H, boxW: Math.max(90, Math.min(slotW - 14, 230)) }
    })
  }
  const totalH = PAD_TOP + (maxDepth + 1) * BAND_H
  return { positions, totalH, nodes, edges }
}

// ---- topological projection (Kahn) — the outline linearization --------------
function topoProjection(chain: Chain) {
  const nodes = (chain.nodes || []).filter((n) => n.kind !== 'roadmap')
  const ids = nodes.map((n) => n.id)
  const idSet = new Set(ids)
  const edges = (chain.edges || []).filter((e) => idSet.has(e.from) && idSet.has(e.to))
  const indeg: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]))
  const out: Record<string, string[]> = {}
  for (const e of edges) { indeg[e.to]++; (out[e.from] ||= []).push(e.to) }
  let queue = ids.filter((id) => indeg[id] === 0)
  let branchy = false
  const order: string[] = []
  const seen = new Set<string>()
  while (queue.length) {
    if (queue.length > 1) branchy = true // a choice point → several linearizations
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
    for (const nxt of out[id] || []) if (--indeg[nxt] === 0) queue.push(nxt)
    queue = queue.slice()
  }
  for (const id of ids) if (!seen.has(id)) order.push(id)
  return { order, branchy }
}

export function GraphComponent({ shape }: { shape: any }) {
  const arrowId = useUniqueSafeId('g-arrow')
  const loadBearingArrowId = useUniqueSafeId('g-arrow-lb')
  const doc = shape.props.doc as string
  const slug = shape.props.slug as string
  const w = shape.props.w as number
  const [chain, setChain] = useState<Chain | null>(null)
  const [validation, setValidation] = useState<any>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [view, setView] = useState<'graph' | 'outline'>('graph')

  const load = useCallback(() => {
    setStatus('loading')
    fetch(`/api/projects/${encodeURIComponent(doc)}/chain?slug=${encodeURIComponent(slug)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`chain ${r.status}`)
        const j = await r.json()
        setChain(parseChainMd(j.markdown || ''))
        setValidation(j.validation || null)
        setStatus('ready')
      })
      .catch((e) => { setStatus('error'); setErrMsg(String(e?.message || e)) })
  }, [doc, slug])
  useEffect(() => { load() }, [load])

  const innerW = Math.max(160, w - 2)
  const lay = useMemo(() => (chain ? layoutGraph(chain, innerW) : null), [chain, innerW])
  const proj = useMemo(() => (chain ? topoProjection(chain) : null), [chain])
  const roadmap = chain?.nodes?.find((n) => n.kind === 'roadmap')
  const byId = useMemo(() => Object.fromEntries((chain?.nodes || []).map((n) => [n.id, n])), [chain])

  return (
    <HTMLContainer style={{ width: '100%', height: '100%', pointerEvents: 'all' }}>
      <style>{`
        .graph-shape .g-tab.active { color: var(--text,#1a1a1a); border-bottom: 1px solid currentColor; }
        .graph-shape .g-node:hover { box-shadow: 0 0 0 1px ${ACCENT}55; }
      `}</style>
      <div
        className="graph-shape"
        onPointerDown={(e) => stopEventPropagation(e)}
        onWheel={(e) => e.stopPropagation()}
        style={{
          width: '100%', height: '100%', boxSizing: 'border-box',
          background: 'var(--note-bg,#fbfbfa)', border: '1px solid rgba(127,127,127,0.18)',
          borderRadius: 6, display: 'flex', flexDirection: 'column',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: 13, color: 'var(--text,#1a1a1a)', overflow: 'hidden',
        }}
      >
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,0.12)', flexShrink: 0, fontSize: 11, color: DIM }}>
          <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>ARGUMENT</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, opacity: 0.7 }} title={slug}>{slug || '(no slug)'}</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <span className={`g-tab ${view === 'graph' ? 'active' : ''}`} style={{ cursor: 'pointer' }} onPointerDown={(e) => { stopEventPropagation(e); setView('graph') }}>graph</span>
            <span className={`g-tab ${view === 'outline' ? 'active' : ''}`} style={{ cursor: 'pointer' }} onPointerDown={(e) => { stopEventPropagation(e); setView('outline') }}>outline</span>
          </span>
        </div>

        {/* body */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {status === 'loading' && <div style={{ padding: 12, color: DIM }}>loading…</div>}
          {status === 'error' && <div style={{ padding: 12, color: '#c55' }}>no chain for this slug<br /><span style={{ fontSize: 11, opacity: 0.7 }}>{errMsg}</span></div>}

          {status === 'ready' && roadmap && (
            <div style={{ padding: '7px 10px 3px', fontStyle: 'italic', color: DIM, fontSize: 12 }} title={roadmap.gloss || ''} dangerouslySetInnerHTML={renderMath(roadmap.label)} />
          )}

          {/* ---- GRAPH view ---- */}
          {status === 'ready' && view === 'graph' && lay && (
            <div style={{ position: 'relative', width: '100%', height: lay.totalH, minHeight: 60 }}>
              <svg width="100%" height={lay.totalH} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                <defs>
                  <marker id={arrowId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" fill={DIM} />
                  </marker>
                  <marker id={loadBearingArrowId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" fill={ACCENT} />
                  </marker>
                </defs>
                {lay.edges.map((e) => {
                  const a = lay.positions[e.from], b = lay.positions[e.to]
                  if (!a || !b) return null
                  const x1 = a.x, y1 = a.top + BOX_H, x2 = b.x, y2 = b.top
                  const my = (y1 + y2) / 2
                  const lb = e.weight === 'load-bearing'
                  const spans = Math.abs(b.top - a.top) > BAND_H + 1 // crosses an intervening band
                  // Long edges hug the source's x down most of the gap, then cut
                  // into the target — so they route past intervening nodes instead
                  // of through them.
                  const d = spans
                    ? `M${x1},${y1} C${x1},${y2 - BAND_H * 0.5} ${x1},${y2 - 8} ${x2},${y2 - 2}`
                    : `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 2}`
                  return (
                    <path key={e.id} d={d}
                      fill="none" stroke={lb ? ACCENT : DIM} strokeWidth={lb ? 2.4 : 1.2}
                      markerEnd={lb ? `url(#${loadBearingArrowId})` : `url(#${arrowId})`} />
                  )
                })}
              </svg>
              {/* edge labels (HTML for crisp text) */}
              {lay.edges.map((e) => {
                const a = lay.positions[e.from], b = lay.positions[e.to]
                if (!a || !b) return null
                const lb = e.weight === 'load-bearing'
                const spans = Math.abs(b.top - a.top) > BAND_H + 1
                // For long edges put the label just under the source (in the gap
                // by the source node) so it never lands on an intervening node.
                const lx = spans ? a.x : (a.x + b.x) / 2
                const ly = spans ? a.top + BOX_H + 16 : (a.top + BOX_H + b.top) / 2
                return (
                  <div key={e.id} title={e.justification || ''}
                    style={{ position: 'absolute', left: lx, top: ly, transform: 'translate(-50%,-50%)', maxWidth: 130, textAlign: 'center', pointerEvents: 'auto', background: 'var(--note-bg,#fbfbfa)', padding: '0 3px', fontSize: 10.5, lineHeight: 1.15, color: lb ? ACCENT : DIM, fontWeight: lb ? 600 : 400 }}>
                    {e.property}
                  </div>
                )
              })}
              {/* node boxes */}
              {lay.nodes.map((n) => {
                const p = lay.positions[n.id]
                if (!p) return null
                const isObj = n.kind === 'object'
                return (
                  <div key={n.id} className="g-node" title={n.gloss || ''}
                    style={{ position: 'absolute', left: p.x - p.boxW / 2, top: p.top, width: p.boxW, minHeight: BOX_H, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '4px 8px', borderRadius: 7, fontSize: 12, lineHeight: 1.2, background: isObj ? `${ACCENT}14` : 'rgba(127,127,127,0.07)', border: `1px solid ${isObj ? `${ACCENT}66` : 'rgba(127,127,127,0.3)'}`, color: 'var(--text,#1a1a1a)' }}>
                    <span dangerouslySetInnerHTML={renderMath(n.label)} />
                  </div>
                )
              })}
            </div>
          )}

          {/* ---- OUTLINE projection view ---- */}
          {status === 'ready' && view === 'outline' && proj && chain && (
            <div style={{ padding: '4px 0' }}>
              <div style={{ padding: '2px 10px 6px', fontSize: 10.5, color: DIM }}>
                projection — topological order{proj.branchy ? ' (one of several linearizations)' : ''}
              </div>
              {proj.order.map((id, i) => {
                const n = byId[id]
                if (!n) return null
                const next = proj.order[i + 1]
                const connector = chain.edges.find((e) => e.from === id && e.to === next)
                const sideEdges = chain.edges.filter((e) => e.from === id && e.to !== next)
                return (
                  <div key={id}>
                    <div style={{ display: 'flex', gap: 6, padding: '1px 10px', alignItems: 'baseline' }}>
                      <span style={{ color: n.kind === 'object' ? ACCENT : DIM }}>•</span>
                      <span style={{ flex: 1, lineHeight: '18px' }} dangerouslySetInnerHTML={renderMath(n.label)} />
                    </div>
                    {sideEdges.map((e) => (
                      <div key={e.id} style={{ padding: '0 10px 0 26px', fontSize: 10.5, color: DIM }} title={e.justification || ''}>
                        ↘ {e.property} → <span dangerouslySetInnerHTML={renderMath(byId[e.to]?.label || e.to)} />
                      </div>
                    ))}
                    {connector && (
                      <div style={{ padding: '0 10px 0 22px', fontSize: 10.5, color: connector.weight === 'load-bearing' ? ACCENT : DIM, fontWeight: connector.weight === 'load-bearing' ? 600 : 400 }} title={connector.justification || ''}>
                        │ {connector.property} ▼
                      </div>
                    )}
                  </div>
                )
              })}
              {proj.order.length === 0 && <div style={{ padding: 12, color: DIM }}>empty graph</div>}
            </div>
          )}
        </div>

        {/* footer */}
        <div style={{ flexShrink: 0, borderTop: '1px solid rgba(127,127,127,0.12)', padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: DIM }}>
          <span style={{ cursor: 'pointer' }} onPointerDown={(e) => { stopEventPropagation(e); load() }} title="Reload chain">↻ reset</span>
          <span style={{ flex: 1 }} />
          {chain && <span style={{ opacity: 0.7 }}>{(chain.nodes || []).filter((n) => n.kind !== 'roadmap').length} nodes · {(chain.edges || []).length} arrows</span>}
          {validation && (validation.ok
            ? <span style={{ color: '#4a9' }}>✓ valid</span>
            : <span style={{ color: '#c55' }} title={(validation.errors || []).join('\n')}>✕ {validation.errors?.length || 0}</span>)}
        </div>
      </div>
    </HTMLContainer>
  )
}

export class GraphShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'graph' as const
  static override props = graphProps

  getDefaultProps() {
    return { w: 420, h: 520, doc: '', slug: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override isAspectRatioLocked = () => false

  component(shape: any) {
    return <GraphComponent shape={shape} />
  }

  getIndicatorPath(shape: any) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={6} ry={6} />
  }
}
