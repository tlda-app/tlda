// invalidation-graph.mjs — structural (dependency-graph) invalidation.
//
// The vetting model is a graph of proof nodes (theorem / lemma / prop / …), each
// anchored to a source line range, with dependency edges: a pair P "depends on"
// label L when P's proof \refs/\eqrefs L. If L's source changes, P's vetting
// rested on an L that is no longer that L — so P is invalidated. That propagates
// transitively along the edges (the cascade the linear ribbon structurally can't
// do: edit Lemma B → B stale → Theorem A that uses B stale too).
//
// This module is the engine. Given an edit (a source line range), it returns:
//   - directlyStale: pairs whose OWN statement the edit changed
//   - cascadeStale:  pairs that depend (transitively) on a directly-changed node
// Run on a *proposed* edit without committing, it's the dry-run. Change-detection
// against committed history uses git/the shadow repo elsewhere (build-1); here the
// edit range is the change, so the engine is pure graph + interval logic.
//
// Data source: proof-info.json `pairs[]` (id = label, statementLines, proofLines,
// dependencies[].label), produced by scripts/compute-proof-pairing.mjs.

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/** Inclusive interval overlap. */
function overlaps(aLo, aHi, bLo, bHi) {
  return aLo <= bHi && aHi >= bLo
}

function normRange(range) {
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
export function buildReverseGraph(pairs) {
  const reverse = new Map()
  for (const p of pairs) {
    for (const d of p.dependencies || []) {
      if (!d?.label) continue
      if (!reverse.has(d.label)) reverse.set(d.label, [])
      const arr = reverse.get(d.label)
      if (!arr.includes(p.id)) arr.push(p.id)
    }
  }
  return reverse
}

/**
 * Entry nodes for an edit: pairs whose STATEMENT source range intersects the
 * edited range. Statement (not proof) because the statement is what others
 * depend on — changing a node's proof invalidates only its own vetting, not its
 * dependents. v1 treats statementLines as main-file-relative (see callers).
 */
export function entryLabelsForEdit(pairs, fromLine, toLine) {
  const lo = Math.min(fromLine, toLine)
  const hi = Math.max(fromLine, toLine)
  const out = []
  for (const p of pairs) {
    const r = normRange(p.statementLines)
    if (!r) continue
    if (overlaps(r[0], r[1], lo, hi)) out.push(p.id)
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
export function cascade(changedLabels, reverse, pairsById) {
  const invalidated = new Map() // id → { depth, via }
  const seen = new Set(changedLabels)
  let frontier = changedLabels.map((label) => ({ label, depth: 0 }))
  while (frontier.length) {
    const next = []
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
  return [...invalidated.entries()].map(([id, m]) => ({
    id,
    depth: m.depth,
    via: m.via,
    pair: pairsById.get(id) || null,
  }))
}

function summarize(pair) {
  if (!pair) return null
  return {
    id: pair.id,
    type: pair.type,
    title: pair.title,
    statementLines: pair.statementLines,
    proofLines: pair.proofLines,
  }
}

/**
 * Dry-run the structural invalidation of a proposed edit.
 * @param {object} proofInfo  parsed proof-info.json ({ pairs, ... })
 * @param {number} fromLine   1-indexed start of the edited range
 * @param {number} toLine     1-indexed end of the edited range
 * @returns {{ directlyStale: object[], cascadeStale: object[] }}
 *   directlyStale: nodes whose own statement the edit touched
 *   cascadeStale:  transitively dependent nodes (with depth + via), sorted by depth
 */
export function dryRunInvalidation(proofInfo, fromLine, toLine) {
  const pairs = proofInfo?.pairs || []
  const pairsById = new Map(pairs.map((p) => [p.id, p]))
  const reverse = buildReverseGraph(pairs)
  const entry = entryLabelsForEdit(pairs, fromLine, toLine)
  const directlyStale = entry.map((id) => summarize(pairsById.get(id))).filter(Boolean)
  const cascadeStale = cascade(entry, reverse, pairsById)
    .sort((a, b) => a.depth - b.depth)
    .map((c) => ({ ...summarize(c.pair), depth: c.depth, via: c.via }))
  return { directlyStale, cascadeStale }
}

/** Find and parse the *-proof-info.json in a project's output dir (or null). */
export function loadProofInfo(outputDir) {
  let entries
  try { entries = readdirSync(outputDir) } catch { return null }
  const f = entries.find((n) => n.endsWith('-proof-info.json'))
  if (!f) return null
  try { return JSON.parse(readFileSync(join(outputDir, f), 'utf8')) } catch { return null }
}
