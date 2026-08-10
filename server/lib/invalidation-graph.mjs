// invalidation-graph.mjs — structural (dependency-graph) invalidation.
//
// The vetting model is a graph of proof nodes (theorem / lemma / prop / …), each
// anchored to a source line range, with dependency edges: a pair P "depends on"
// label L when P's proof \refs/\eqrefs L. If L's source changes, P's vetting
// rested on an L that is no longer that L, so P is invalidated. That propagates
// transitively along the edges.
//
// Data source: proof-info.json `pairs[]` (id = label, statementAnchor,
// proofDependencies[].label), produced by scripts/compute-proof-pairing.mjs.
//
// NOT `dependencies[]`, which looks like the same thing and is not: it is
// derived over the STATEMENT range with a pattern that cannot see \Cref, and it
// prunes anything on a nearby page. That is correct for what it feeds — the
// reader-facing off-page dependency thumbnails — and empty for this. Measured on
// bregman-lower-bound.tex, `dependencies[]` yields 0 invalidation edges across
// all 59 theorem/proof pairs; `proofDependencies[]` yields 90.
//
// Line coordinates are file-relative, via each pair's `statementAnchor`.
// `statementLines` are indices into the \input-EXPANDED document — 1873 lines
// off for lem:duality-general in that paper — so an edit range from any caller
// that knows a real file would silently anchor to the wrong result.

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
 * Reverse dependency graph: label -> [pairId, ...] of pairs that DEPEND ON it.
 * Forward edge is pair -> dependency-label; reversing it gives "who breaks when
 * this label changes", which is the direction invalidation flows.
 */
export function buildReverseGraph(pairs) {
  const reverse = new Map()
  for (const p of pairs) {
    for (const d of p.proofDependencies || []) {
      if (!d?.label) continue
      if (!reverse.has(d.label)) reverse.set(d.label, [])
      const arr = reverse.get(d.label)
      if (!arr.includes(p.id)) arr.push(p.id)
    }
  }
  return reverse
}

/**
 * Entry nodes for an edit: pairs whose statement source range intersects the
 * edited range, in the given file. Statement, not proof, because the statement
 * is what others depend on. Changing a node's proof invalidates only its own
 * vetting, not its dependents.
 *
 * `file` is the project-relative path the edit touched, or null for the main
 * file — matching `statementAnchor.file`, which is null for the main file and
 * "body.tex" for an \input'd one. A pair with no anchor is skipped rather than
 * matched against the wrong file: this parser cannot place it, and a wrong
 * answer here is worse than a missing one.
 */
export function entryLabelsForEdit(pairs, fromLine, toLine, file = null) {
  const lo = Math.min(fromLine, toLine)
  const hi = Math.max(fromLine, toLine)
  const out = []
  for (const p of pairs) {
    const anchor = p.statementAnchor
    if (!anchor) continue
    if ((anchor.file || null) !== (file || null)) continue
    const r = normRange([anchor.startLine, anchor.endLine])
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
  const invalidated = new Map()
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
    statementAnchor: pair.statementAnchor || null,
    proofLines: pair.proofLines,
  }
}

/**
 * Dry-run the structural invalidation of a proposed edit.
 * @param {object} proofInfo  parsed proof-info.json ({ pairs, ... })
 * @param {number} fromLine   1-indexed start of the edited range, in `file`
 * @param {number} toLine     1-indexed end of the edited range, in `file`
 * @param {string|null} file  project-relative path edited; null = main file
 * @returns {{ directlyStale: object[], cascadeStale: object[] }}
 *   directlyStale: nodes whose own statement the edit touched
 *   cascadeStale:  transitively dependent nodes (with depth + via), sorted by depth
 */
export function dryRunInvalidation(proofInfo, fromLine, toLine, file = null) {
  const pairs = proofInfo?.pairs || []
  const pairsById = new Map(pairs.map((p) => [p.id, p]))
  const reverse = buildReverseGraph(pairs)
  const entry = entryLabelsForEdit(pairs, fromLine, toLine, file)
  const directlyStale = entry.map((id) => summarize(pairsById.get(id))).filter(Boolean)
  const cascadeStale = cascade(entry, reverse, pairsById)
    .sort((a, b) => a.depth - b.depth)
    .map((c) => ({ ...summarize(c.pair), depth: c.depth, via: c.via }))
  return { directlyStale, cascadeStale }
}

/** Find and parse the *-proof-info.json in a project's output dir. */
export function loadProofInfo(outputDir) {
  let entries
  try { entries = readdirSync(outputDir) } catch { return null }
  const f = entries.find((n) => n.endsWith('-proof-info.json'))
  if (!f) return null
  try { return JSON.parse(readFileSync(join(outputDir, f), 'utf8')) } catch { return null }
}
