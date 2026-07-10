// invalidationGraph.ts — structural (dependency-graph) invalidation for the
// viewer's live proof-vetting inbox/provenance surfaces.
//
// The vetting model is a graph of proof nodes (theorem / lemma / prop / …), each
// anchored to a source line range, with dependency edges: a pair P "depends on"
// label L when P's proof \refs/\eqrefs L. If L's source changes, P's vetting
// rested on an L that is no longer that L — so P is invalidated, and that
// propagates transitively along the edges (the cascade the linear ribbon
// structurally can't do: edit Lemma B → B stale → Theorem A that uses B stale).
//
// The changed ranges come from the live ribbon's stale spans, so the viewer
// projects the cascade onto the inbox with no server round-trip.

export interface ProofPairLite {
  id: string
  type?: string
  title?: string
  statementLines?: [number, number] | number[]
  proofLines?: [number, number] | number[]
  dependencies?: { label?: string }[]
}

export interface CascadeNode {
  id: string
  type?: string
  title?: string
  statementLines?: number[]
  depth: number      // shortest dependency distance from a changed node (≥1)
  via: string        // the upstream label that reached this node
}

export interface DirectNode {
  id: string
  type?: string
  title?: string
  statementLines?: number[]
}

/** Inclusive interval overlap. */
function overlaps(aLo: number, aHi: number, bLo: number, bHi: number): boolean {
  return aLo <= bHi && aHi >= bLo
}

function normRange(range: number[] | undefined): [number, number] | null {
  if (!Array.isArray(range) || range.length < 2) return null
  const lo = Math.min(range[0], range[1])
  const hi = Math.max(range[0], range[1])
  return [lo, hi]
}

/**
 * Reverse dependency graph: label → [pairId, …] of pairs that DEPEND ON it.
 * (Forward edge is pair → dependency-label; reversing it gives "who breaks when
 * this label changes", which is the direction invalidation flows.)
 */
export function buildReverseGraph(pairs: ProofPairLite[]): Map<string, string[]> {
  const reverse = new Map<string, string[]>()
  for (const p of pairs) {
    for (const d of p.dependencies || []) {
      if (!d?.label) continue
      if (!reverse.has(d.label)) reverse.set(d.label, [])
      const arr = reverse.get(d.label)!
      if (!arr.includes(p.id)) arr.push(p.id)
    }
  }
  return reverse
}

/**
 * Entry nodes for a set of edited line ranges: pairs whose STATEMENT source
 * range intersects any edited range. Statement (not proof) because the statement
 * is what others depend on — changing a node's own proof invalidates only its
 * own vetting, not its dependents.
 */
export function entryLabelsForRanges(
  pairs: ProofPairLite[],
  ranges: Array<{ lo: number; hi: number }>,
): string[] {
  const out: string[] = []
  for (const p of pairs) {
    const r = normRange(p.statementLines as number[])
    if (!r) continue
    if (ranges.some((e) => overlaps(r[0], r[1], e.lo, e.hi))) out.push(p.id)
  }
  return out
}

/**
 * Transitive cascade from a set of changed labels along the reverse edges.
 * Breadth-first so `depth` is the shortest dependency distance from a changed
 * node; `via` is the upstream label that reached it. The changed labels seed the
 * visited set, so an entry node is never also reported as cascade-stale, and
 * cycles terminate.
 */
export function cascade(
  changedLabels: string[],
  reverse: Map<string, string[]>,
  pairsById: Map<string, ProofPairLite>,
): CascadeNode[] {
  const invalidated = new Map<string, { depth: number; via: string }>()
  const seen = new Set<string>(changedLabels)
  let frontier = changedLabels.map((label) => ({ label, depth: 0 }))
  while (frontier.length) {
    const next: Array<{ label: string; depth: number }> = []
    for (const { label, depth } of frontier) {
      for (const depId of reverse.get(label) || []) {
        if (seen.has(depId)) continue
        seen.add(depId)
        invalidated.set(depId, { depth: depth + 1, via: label })
        next.push({ label: depId, depth: depth + 1 })
      }
    }
    frontier = next
  }
  return [...invalidated.entries()].map(([id, m]) => {
    const pair = pairsById.get(id)
    return {
      id,
      type: pair?.type,
      title: pair?.title,
      statementLines: pair?.statementLines as number[] | undefined,
      depth: m.depth,
      via: m.via,
    }
  })
}

/**
 * Project structural invalidation of a set of changed line ranges onto the
 * proof-dependency graph.
 * @returns directlyStale — pairs whose own statement a changed range touched;
 *          cascadeStale  — transitively dependent pairs (with depth + via),
 *          sorted by depth (nearest first).
 */
export function invalidationFromRanges(
  proofInfo: { pairs?: ProofPairLite[] } | null | undefined,
  ranges: Array<{ lo: number; hi: number }>,
): { directlyStale: DirectNode[]; cascadeStale: CascadeNode[] } {
  const pairs = proofInfo?.pairs || []
  if (pairs.length === 0 || ranges.length === 0) {
    return { directlyStale: [], cascadeStale: [] }
  }
  const pairsById = new Map(pairs.map((p) => [p.id, p]))
  const reverse = buildReverseGraph(pairs)
  const entry = entryLabelsForRanges(pairs, ranges)
  const directlyStale: DirectNode[] = entry
    .map((id) => {
      const p = pairsById.get(id)!
      return { id, type: p.type, title: p.title, statementLines: p.statementLines as number[] | undefined }
    })
  const cascadeStale = cascade(entry, reverse, pairsById).sort((a, b) => a.depth - b.depth)
  return { directlyStale, cascadeStale }
}
