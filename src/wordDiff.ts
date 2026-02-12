// Shared word-level diff algorithm — longest common prefix/suffix, O(n).
// Used by SvgDocument (live change detection) and snapshotStore (historical diffs).

import type { ChangeRegion } from './SvgPageShape'
import type { TextLine } from './TextSelectionLayer'

interface WordEntry { word: string; lineIdx: number }

function extractWordEntries(lines: TextLine[]): WordEntry[] {
  const result: WordEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const words = lines[i].text.split(/\s+/).filter(w => w.length > 0)
    for (const word of words) {
      result.push({ word, lineIdx: i })
    }
  }
  return result
}

/**
 * Diff old words against new lines, returning highlight regions.
 * oldWords: flat array of words (no line provenance needed).
 * newLines: lines with text and position info — changed words map back to these.
 */
export function diffWords(
  oldWords: string[],
  newLines: TextLine[],
): ChangeRegion[] {
  const newEntries = extractWordEntries(newLines)

  // Longest common prefix
  let prefixLen = 0
  const minLen = Math.min(oldWords.length, newEntries.length)
  while (prefixLen < minLen && oldWords[prefixLen] === newEntries[prefixLen].word) {
    prefixLen++
  }

  // Longest common suffix (non-overlapping with prefix)
  let suffixLen = 0
  const maxSuffix = minLen - prefixLen
  while (suffixLen < maxSuffix &&
    oldWords[oldWords.length - 1 - suffixLen] === newEntries[newEntries.length - 1 - suffixLen].word) {
    suffixLen++
  }

  const changeStart = prefixLen
  const changeEnd = newEntries.length - suffixLen
  if (changeStart >= changeEnd && oldWords.length - suffixLen <= prefixLen) return []

  // Collect line indices that contain changed words
  const changedLineIndices = new Set<number>()
  for (let i = changeStart; i < changeEnd; i++) {
    changedLineIndices.add(newEntries[i].lineIdx)
  }
  // Include boundary lines for partial-line changes
  if (changeStart > 0) changedLineIndices.add(newEntries[changeStart - 1].lineIdx)
  if (changeEnd < newEntries.length) changedLineIndices.add(newEntries[changeEnd].lineIdx)

  // If only deletions (changeStart >= changeEnd but old has extra words),
  // highlight the boundary line where text was removed
  if (changedLineIndices.size === 0 && oldWords.length > newEntries.length) {
    const boundaryIdx = Math.min(changeStart, newEntries.length - 1)
    if (boundaryIdx >= 0) changedLineIndices.add(newEntries[boundaryIdx].lineIdx)
  }

  // Convert to regions
  const rawRegions: ChangeRegion[] = []
  for (const idx of changedLineIndices) {
    const line = newLines[idx]
    if (!line) continue
    rawRegions.push({
      y: line.y - line.fontSize * 0.3,
      height: line.fontSize * 1.4,
    })
  }

  if (rawRegions.length === 0) return []

  // Merge overlapping/adjacent regions
  rawRegions.sort((a, b) => a.y - b.y)
  const merged: ChangeRegion[] = []
  for (const r of rawRegions) {
    const last = merged[merged.length - 1]
    if (last && r.y <= last.y + last.height + 2) {
      const bottom = Math.max(last.y + last.height, r.y + r.height)
      last.height = bottom - last.y
    } else {
      merged.push({ ...r })
    }
  }

  return merged
}

/** Extract flat word array from lines (for building old-word input). */
export function extractFlatWords(lines: TextLine[]): string[] {
  const result: string[] = []
  for (const line of lines) {
    const words = line.text.split(/\s+/).filter(w => w.length > 0)
    result.push(...words)
  }
  return result
}
