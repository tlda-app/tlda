// Argument-graph (arrow-chain) layer for the outline tool.
//
// Where `model.mjs` is a RESTRUCTURING instrument over a verbatim partition
// (move frozen tokens, never author), this module is a CONSTRUCTION instrument:
// it represents an argument as a directed graph of objects/states connected by
// labeled, weighted transitions, with authored per-arrow justification prose.
// Nodes, labels and justifications are AUTHORED — they are not verbatim source
// slices — so the chain lives OUTSIDE the partition invariant, as its own
// artifact (`<slug>.chain.json`), with its own open/apply surface. This keeps
// `outline_apply` cleanly move-only (the D12 authorship boundary).
//
// The shape (validated by Skip, 2026-06-06 duality+SLB thread):
//   (γ_j) --coercive--> bounded --totally convex--> Cauchy --complete--> converges
// every property spent at the arrow it powers; one justification per arrow;
// only the load-bearing arrow getting real work.
//
//   chain = {
//     sourceLeafIds: ["l7"],                       // the bag atom this replaces
//     nodes: [{ id, kind, label, gloss? }],        // kind: object|state|roadmap
//     edges: [{ id, from, to, property,            // property: the driving prop
//               weight, justification? }],          // weight: load-bearing|one-liner
//   }
//
// Pure module: no I/O, no MCP, no source mutation. Persistence and the
// chain_open/chain_apply routes wrap these functions elsewhere.

const NODE_KINDS = ['object', 'state', 'roadmap']
const EDGE_WEIGHTS = ['load-bearing', 'one-liner']

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// ---------- emit: chain -> the id-tagged markdown an agent edits --------------
// Canonical, round-trippable editing surface. Node/edge ids are the handles;
// kind/label/property/weight live on the dash line, authored prose (gloss /
// justify) on indented continuation lines under the owning item.
export function emitChainMarkdown(chain) {
  const c = chain || {}
  const src = (c.sourceLeafIds || []).join(', ')
  const lines = []
  lines.push(`## chain${src ? ` (source: ${src})` : ''}`)
  lines.push('')
  lines.push('### nodes')
  for (const n of c.nodes || []) {
    lines.push(`- [${n.id}] ${n.kind || 'state'} | ${norm(n.label)}`)
    if (n.gloss) lines.push(`  gloss: ${norm(n.gloss)}`)
  }
  lines.push('')
  lines.push('### edges')
  for (const e of c.edges || []) {
    lines.push(`- [${e.id}] ${e.from} -> ${e.to} | ${norm(e.property)} | ${e.weight || 'one-liner'}`)
    if (e.justification) lines.push(`  justify: ${norm(e.justification)}`)
  }
  return lines.join('\n') + '\n'
}

// ---------- parse: edited markdown -> chain -----------------------------------
// Tolerant of extra whitespace/blank lines; canonical on emit. `gloss:` /
// `justify:` continuation lines attach to the most recently parsed node/edge.
export function parseChainMarkdown(md) {
  const chain = { sourceLeafIds: [], nodes: [], edges: [] }
  let section = null
  let lastNode = null
  let lastEdge = null
  for (const raw of String(md || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const trimmed = line.trim()
    if (!trimmed) continue

    const srcM = trimmed.match(/^##\s+chain\b(?:\s*\(source:\s*([^)]*)\))?/i)
    if (srcM) {
      chain.sourceLeafIds = (srcM[1] || '').split(/[\s,]+/).filter(Boolean)
      section = null; lastNode = null; lastEdge = null
      continue
    }
    if (/^###\s+nodes\b/i.test(trimmed)) { section = 'nodes'; continue }
    if (/^###\s+edges\b/i.test(trimmed)) { section = 'edges'; continue }

    // continuation lines (authored prose) — attach to the current item
    const contM = trimmed.match(/^(gloss|justify):\s*(.*)$/i)
    if (contM) {
      const key = contM[1].toLowerCase()
      const val = norm(contM[2])
      if (key === 'gloss' && lastNode) lastNode.gloss = val
      else if (key === 'justify' && lastEdge) lastEdge.justification = val
      continue
    }

    const itemM = trimmed.match(/^-\s+\[([^\]]+)\]\s*(.*)$/)
    if (!itemM) continue
    const id = itemM[1].trim()
    const rest = itemM[2]

    if (section === 'edges') {
      // [id] from -> to | property | weight
      const em = rest.match(/^(\S+)\s*->\s*(\S+)\s*\|\s*([^|]*)(?:\|\s*(.*))?$/)
      if (em) {
        const edge = {
          id,
          from: em[1].trim(),
          to: em[2].trim(),
          property: norm(em[3]),
          weight: norm(em[4]) || 'one-liner',
        }
        chain.edges.push(edge)
        lastEdge = edge; lastNode = null
      }
    } else {
      // nodes (default section): [id] kind | label
      const parts = rest.split('|')
      const node = {
        id,
        kind: parts.length > 1 ? (norm(parts[0]) || 'state') : 'state',
        label: parts.length > 1 ? norm(parts.slice(1).join('|')) : norm(rest),
      }
      chain.nodes.push(node)
      lastNode = node; lastEdge = null
    }
  }
  return chain
}

// ---------- pretty arrow render (display only) --------------------------------
// The motion view Skip validated. Used for the note / chat card, NOT for editing.
// Follows the longest path through the graph; load-bearing arrows marked with **.
export function renderChainArrows(chain) {
  const c = chain || {}
  const byId = Object.fromEntries((c.nodes || []).map((n) => [n.id, n]))
  const roadmap = (c.nodes || []).find((n) => n.kind === 'roadmap')
  const order = topoOrder(c)
  const segs = []
  for (let i = 0; i < order.length; i++) {
    const n = byId[order[i]]
    if (!n || n.kind === 'roadmap') continue
    segs.push(norm(n.label))
    const e = (c.edges || []).find((x) => x.from === order[i])
    if (e) {
      const mark = e.weight === 'load-bearing' ? `**${norm(e.property)}**` : norm(e.property)
      segs.push(`--${mark}-->`)
    }
  }
  const arrows = segs.join(' ')
  return roadmap ? `*${norm(roadmap.label)}*\n\n${arrows}` : arrows
}

// ---------- validate: structural soundness of a chain ------------------------
// Catches the malformed-graph cases (dangling edge endpoints, bad kind/weight,
// duplicate ids, cycles). Returns { ok, errors:[], warnings:[] }. This is the
// graph-shape gate; the rubric-level checks (every property assigned, exactly
// one load-bearing arrow) live in the stage graders, not here.
export function validateChain(chain) {
  const c = chain || {}
  const errors = []
  const warnings = []
  const nodes = c.nodes || []
  const edges = c.edges || []

  const nodeIds = new Set()
  for (const n of nodes) {
    if (!n.id) { errors.push('node with missing id'); continue }
    if (nodeIds.has(n.id)) errors.push(`duplicate node id [${n.id}]`)
    nodeIds.add(n.id)
    if (!NODE_KINDS.includes(n.kind)) errors.push(`node [${n.id}] bad kind "${n.kind}" (want ${NODE_KINDS.join('|')})`)
    if (!norm(n.label)) errors.push(`node [${n.id}] has empty label`)
  }

  const edgeIds = new Set()
  for (const e of edges) {
    if (!e.id) { errors.push('edge with missing id'); continue }
    if (edgeIds.has(e.id)) errors.push(`duplicate edge id [${e.id}]`)
    edgeIds.add(e.id)
    if (!nodeIds.has(e.from)) errors.push(`edge [${e.id}] from unknown node "${e.from}"`)
    if (!nodeIds.has(e.to)) errors.push(`edge [${e.id}] to unknown node "${e.to}"`)
    if (e.from === e.to) errors.push(`edge [${e.id}] is a self-loop (${e.from})`)
    if (!EDGE_WEIGHTS.includes(e.weight)) errors.push(`edge [${e.id}] bad weight "${e.weight}" (want ${EDGE_WEIGHTS.join('|')})`)
    if (!norm(e.property)) errors.push(`edge [${e.id}] has no driving property — every arrow must name the property it spends`)
  }

  if (hasCycle(c)) errors.push('chain has a cycle — an argument-graph must be acyclic')

  return { ok: errors.length === 0, errors, warnings }
}

// ---------- flows-by-outline conformance check (item 6, grader hook) ---------
// Does a written prose blob REALIZE the chain skeleton? These signals are
// NECESSARY, NOT SUFFICIENT: a `mechanical-glue` proof (the "so… so… so" ladder
// Skip flagged as the anti-target) passes all four. Glue-vs-genuine-motion is a
// register judgment only the LLM judge can make — do NOT add a glue detector
// here; hand these structural signals to the judge and let it own that call.
// Four signals, mirroring the rubric's `flows-by-outline`:
//   - coverage : every edge's property is spent in the prose
//   - order    : properties appear in chain order (the prose follows the arc)
//   - fusion   : each property sits near the object it produces (the to-node),
//                not in a list up front (the re-bagged failure)
//   - weight   : the load-bearing arrow gets more text than the one-liners
// `opts.fusionWindow` (default 160 chars) is how close property and produced
// object must sit to count as fused.
export function flowsByCheck(chain, prose, opts = {}) {
  const c = chain || {}
  const text = norm(prose).toLowerCase()
  const fusionWindow = opts.fusionWindow ?? 160
  const proseWords = tokenize(text)
  const byId = Object.fromEntries((c.nodes || []).map((n) => [n.id, n]))
  const order = topoOrder(c)
  const orderedEdges = order
    .map((nid) => (c.edges || []).find((e) => e.from === nid))
    .filter(Boolean)

  const edgeReport = []
  let lastIdx = -1
  let orderOk = true
  for (const e of orderedEdges) {
    const propHits = matchPositions(proseWords, contentWords(e.property))
    const present = propHits.length > 0
    const propIdx = present ? propHits[0] : -1

    const toNode = byId[e.to]
    const nodeHits = toNode ? matchPositions(proseWords, contentWords(toNode.label)) : []
    // fused if SOME property mention sits within the window of SOME mention of
    // the object it produces — catches "coercivity keeps (γ_j) bounded" while
    // rejecting a property listed up front far from its object.
    const fused = present && nodeHits.some((n) => propHits.some((p) => Math.abs(p - n) <= fusionWindow))

    if (present) {
      if (propIdx < lastIdx) orderOk = false
      lastIdx = propIdx
    }
    edgeReport.push({
      edge: e.id,
      property: e.property,
      to: e.to,
      weight: e.weight,
      present,
      fused,
      span: spanFor(propHits, nodeHits, fusionWindow, text.length),
    })
  }

  const coverage = edgeReport.every((r) => r.present)
  const fusion = edgeReport.every((r) => r.fused)

  // weight: the load-bearing arrow should command more prose than the mean
  // one-liner. Compare authored spans of text around each transition.
  const load = edgeReport.filter((r) => r.weight === 'load-bearing')
  const ones = edgeReport.filter((r) => r.weight === 'one-liner')
  const meanOne = ones.length ? ones.reduce((a, r) => a + r.span, 0) / ones.length : 0
  const weightOk = load.length === 0 || load.every((r) => r.span >= meanOne)

  const checks = [
    { name: 'coverage', pass: coverage, detail: coverage ? 'every property spent in the prose' : `missing: ${edgeReport.filter((r) => !r.present).map((r) => r.property).join(', ')}` },
    { name: 'order', pass: orderOk, detail: orderOk ? 'properties appear in chain order' : 'properties out of chain order — prose does not follow the arc' },
    { name: 'fusion', pass: fusion, detail: fusion ? 'each property fused to the object it produces' : `not fused (listed up front?): ${edgeReport.filter((r) => !r.fused).map((r) => r.property).join(', ')}` },
    { name: 'weight', pass: weightOk, detail: weightOk ? 'load-bearing arrow gets the real work' : 'load-bearing arrow no longer than the one-liners — work not proportioned' },
  ]
  return { ok: checks.every((c) => c.pass), checks, edges: edgeReport }
}

// ---------- internals --------------------------------------------------------

// Topological node order following edges (chain order). Falls back to node
// declaration order for any nodes not reachable from the edge graph.
function topoOrder(chain) {
  const c = chain || {}
  const nodes = (c.nodes || []).filter((n) => n.kind !== 'roadmap')
  const ids = nodes.map((n) => n.id)
  const indeg = Object.fromEntries(ids.map((id) => [id, 0]))
  const out = {}
  for (const e of c.edges || []) {
    if (!(e.from in indeg) || !(e.to in indeg)) continue
    indeg[e.to]++
    ;(out[e.from] ||= []).push(e.to)
  }
  const queue = ids.filter((id) => indeg[id] === 0)
  const seen = new Set()
  const result = []
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    for (const nxt of out[id] || []) { if (--indeg[nxt] === 0) queue.push(nxt) }
  }
  for (const id of ids) if (!seen.has(id)) result.push(id) // cycle remnant / unreachable
  return result
}

function hasCycle(chain) {
  const c = chain || {}
  const ids = (c.nodes || []).map((n) => n.id)
  const out = {}
  for (const e of c.edges || []) (out[e.from] ||= []).push(e.to)
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = Object.fromEntries(ids.map((id) => [id, WHITE]))
  const visit = (id) => {
    if (color[id] === undefined) return false
    color[id] = GRAY
    for (const nxt of out[id] || []) {
      if (color[nxt] === GRAY) return true
      if (color[nxt] === WHITE && visit(nxt)) return true
    }
    color[id] = BLACK
    return false
  }
  return ids.some((id) => color[id] === WHITE && visit(id))
}

// Content words for lenient matching: lowercase, drop stopwords & math.
const STOP = new Set(['the', 'a', 'an', 'is', 'of', 'to', 'and', 'so', 'it', 'its', 'we', 'that', 'this', 'are', 'be', 'by', 'as', 'on', 'in', 'with', 'then', 'thus', 'hence', 'therefore'])
function contentWords(s) {
  return norm(s)
    .toLowerCase()
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
}
// Prose words with their char offsets, in order.
function tokenize(text) {
  const out = []
  const re = /[a-z0-9]+/g
  let m
  while ((m = re.exec(text))) out.push({ w: m[0], i: m.index })
  return out
}
function commonPrefix(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}
// Two words match if one is a prefix of the other (handles "convex"⊂"convexity",
// "complete"⊂"completeness") OR they share a 6-char prefix (handles
// "coercive"~"coercivity"). The 6-char floor is what keeps "convex" from
// matching "converges" (common prefix only 5 — "conve").
function wordMatch(a, b) {
  const lcp = commonPrefix(a, b)
  return lcp === a.length || lcp === b.length || lcp >= 6
}
// Char offsets of every prose word matching any of the content words, ascending.
function matchPositions(proseWords, cws) {
  const hits = []
  for (const pw of proseWords) {
    if (cws.some((cw) => wordMatch(cw, pw.w))) hits.push(pw.i)
  }
  return hits
}
// Rough size of the prose region a transition commands: from its property's
// first mention to the produced object's mention (a proxy for "how much work
// this arrow gets"). Used only to compare load-bearing vs one-liner.
function spanFor(propHits, nodeHits, fusionWindow, textLen) {
  if (!propHits.length) return 0
  const here = propHits[0]
  const node = nodeHits.find((n) => n > here)
  const end = node != null ? node + fusionWindow : here + fusionWindow
  return Math.max(0, Math.min(textLen, end) - here)
}
