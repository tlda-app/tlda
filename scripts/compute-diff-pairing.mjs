#!/usr/bin/env node
/**
 * Compute diff pairing between current and old version of a LaTeX document.
 *
 * Usage: node compute-diff-pairing.mjs <tex-dir> <tex-file> <git-ref> \
 *          <lookup.json> <old-lookup.json> <output.json> \
 *          <current-pages> <old-pages>
 *
 * Parses git diff to find changed line ranges, maps them to pages and
 * y-coordinates via synctex lookup tables, outputs diff-info.json.
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

const [texDir, texFile, gitRef, lookupPath, oldLookupPath, outputPath, currentPagesStr, oldPagesStr] = process.argv.slice(2)

if (!texDir || !texFile || !gitRef || !lookupPath || !oldLookupPath || !outputPath) {
  console.error('Usage: node compute-diff-pairing.mjs <tex-dir> <tex-file> <git-ref> <lookup.json> <old-lookup.json> <output.json> <current-pages> <old-pages>')
  process.exit(1)
}

const currentPages = parseInt(currentPagesStr) || 0
const oldPages = parseInt(oldPagesStr) || 0

// Load lookup tables
const lookup = JSON.parse(readFileSync(lookupPath, 'utf8'))
const oldLookup = JSON.parse(readFileSync(oldLookupPath, 'utf8'))

// Run git diff to get hunks
const diffOutput = execSync(
  `git diff ${gitRef} -- ${texFile}`,
  { cwd: texDir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
)

/**
 * Parse unified diff to extract hunks with old and new line ranges.
 * Returns array of { oldStart, oldCount, newStart, newCount }
 */
function parseHunks(diff) {
  const hunks = []
  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
  let match
  while ((match = hunkRegex.exec(diff)) !== null) {
    hunks.push({
      oldStart: parseInt(match[1]),
      oldCount: parseInt(match[2] ?? '1'),
      newStart: parseInt(match[3]),
      newCount: parseInt(match[4] ?? '1'),
    })
  }
  return hunks
}

/**
 * For a range of source lines, find the page(s) and y-coordinate range
 * using a lookup table.
 */
function mapLinesToPositions(lineStart, lineCount, lookupData) {
  const results = [] // { page, yTop, yBottom }
  const pageRanges = new Map() // page -> { yMin, yMax }

  for (let line = lineStart; line < lineStart + lineCount; line++) {
    const entry = lookupData.lines[line.toString()]
    if (!entry) continue

    const page = entry.page
    if (!pageRanges.has(page)) {
      pageRanges.set(page, { yMin: entry.y, yMax: entry.y })
    } else {
      const r = pageRanges.get(page)
      r.yMin = Math.min(r.yMin, entry.y)
      r.yMax = Math.max(r.yMax, entry.y)
    }
  }

  for (const [page, range] of pageRanges) {
    results.push({
      page,
      yTop: range.yMin - 10,    // small padding above
      yBottom: range.yMax + 10,  // small padding below
    })
  }

  // Sort by page
  results.sort((a, b) => a.page - b.page)
  return results
}

const hunks = parseHunks(diffOutput)
console.log(`  Found ${hunks.length} diff hunks`)

// Build per-page highlight data
// currentHighlights: Map<page, Array<{yTop, yBottom}>>
// oldHighlights: Map<page, Array<{yTop, yBottom}>>
// changedCurrentPages: Set<page>
// changedOldPages: Set<page>
const currentHighlights = new Map()
const oldHighlights = new Map()
const changedCurrentPages = new Set()
const changedOldPages = new Set()

for (const hunk of hunks) {
  // Map new (current) lines
  if (hunk.newCount > 0) {
    const positions = mapLinesToPositions(hunk.newStart, hunk.newCount, lookup)
    for (const pos of positions) {
      changedCurrentPages.add(pos.page)
      if (!currentHighlights.has(pos.page)) currentHighlights.set(pos.page, [])
      currentHighlights.get(pos.page).push({ yTop: pos.yTop, yBottom: pos.yBottom })
    }
  }

  // Map old lines
  if (hunk.oldCount > 0) {
    const positions = mapLinesToPositions(hunk.oldStart, hunk.oldCount, oldLookup)
    for (const pos of positions) {
      changedOldPages.add(pos.page)
      if (!oldHighlights.has(pos.page)) oldHighlights.set(pos.page, [])
      oldHighlights.get(pos.page).push({ yTop: pos.yTop, yBottom: pos.yBottom })
    }
  }
}

/**
 * Merge overlapping highlight regions on the same page.
 * Regions that are within `gap` units of each other get merged.
 */
function mergeHighlights(highlights, gap = 20) {
  if (highlights.length <= 1) return highlights
  highlights.sort((a, b) => a.yTop - b.yTop)
  const merged = [{ ...highlights[0] }]
  for (let i = 1; i < highlights.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = highlights[i]
    if (curr.yTop <= prev.yBottom + gap) {
      prev.yBottom = Math.max(prev.yBottom, curr.yBottom)
    } else {
      merged.push({ ...curr })
    }
  }
  return merged
}

// Merge highlights per page
for (const [page, hl] of currentHighlights) {
  currentHighlights.set(page, mergeHighlights(hl))
}
for (const [page, hl] of oldHighlights) {
  oldHighlights.set(page, mergeHighlights(hl))
}

// Build page-level pairing.
// For each current page, find which old pages have changes related to it.
// Simple heuristic: pair current page N with old page N if both have changes.
// More sophisticated: use hunk correspondence (same hunk maps to both).

// Build hunk-level page correspondence
const pagePairs = new Map() // currentPage -> Set<oldPage>
for (const hunk of hunks) {
  const newPositions = hunk.newCount > 0
    ? mapLinesToPositions(hunk.newStart, hunk.newCount, lookup)
    : []
  const oldPositions = hunk.oldCount > 0
    ? mapLinesToPositions(hunk.oldStart, hunk.oldCount, oldLookup)
    : []

  const newPages = newPositions.map(p => p.page)
  const oldPagesInHunk = oldPositions.map(p => p.page)

  // Link each new page to old pages from the same hunk
  for (const np of newPages) {
    if (!pagePairs.has(np)) pagePairs.set(np, new Set())
    for (const op of oldPagesInHunk) {
      pagePairs.get(np).add(op)
    }
  }
}

// Also: old pages with deletions but no corresponding current page
// (content was removed entirely). Attach them to the nearest current page.
for (const oldPage of changedOldPages) {
  let attached = false
  for (const [cp, ops] of pagePairs) {
    if (ops.has(oldPage)) { attached = true; break }
  }
  if (!attached) {
    // Find nearest current page
    let bestPage = oldPage
    if (bestPage > currentPages) bestPage = currentPages
    if (!pagePairs.has(bestPage)) pagePairs.set(bestPage, new Set())
    pagePairs.get(bestPage).add(oldPage)
    changedCurrentPages.add(bestPage)
  }
}

// Build output
const pairs = []
for (let page = 1; page <= currentPages; page++) {
  const hasChanges = changedCurrentPages.has(page)
  const oldPagesForThis = pagePairs.has(page) ? [...pagePairs.get(page)].sort((a, b) => a - b) : []

  const entry = {
    currentPage: page,
    oldPages: oldPagesForThis,
    hasChanges,
  }

  if (hasChanges) {
    entry.highlights = {
      current: currentHighlights.get(page) || [],
      old: [],
    }
    // Gather old highlights for paired old pages
    for (const op of oldPagesForThis) {
      const ohl = oldHighlights.get(op) || []
      for (const h of ohl) {
        entry.highlights.old.push({ page: op, ...h })
      }
    }

    // Flag new content (highlights on current but no old pages)
    if (oldPagesForThis.length === 0 && entry.highlights.current.length > 0) {
      entry.newContent = true
    }
  }

  pairs.push(entry)
}

const output = {
  meta: {
    gitRef,
    generated: new Date().toISOString(),
  },
  currentPages,
  oldPages,
  pairs,
}

writeFileSync(outputPath, JSON.stringify(output, null, 2))

// Stats
const pagesWithChanges = pairs.filter(p => p.hasChanges).length
const totalOldPagesShown = new Set(pairs.flatMap(p => p.oldPages)).size
console.log(`  ${pagesWithChanges} pages with changes`)
console.log(`  ${totalOldPagesShown} old pages referenced`)
console.log(`  Written to ${outputPath}`)
