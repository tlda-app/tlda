/**
 * Snapshot store: captures page text on each watcher rebuild so the user can
 * compare current state against any previous version via a time slider.
 *
 * Stores space-joined word lists per page (~2KB/page) in localStorage.
 * Up to 20 snapshots (~2MB max for a 47-page doc).
 */

import type { PageTextData, TextLine } from './TextSelectionLayer'
import type { ChangeRegion } from './SvgPageShape'

interface TextSnapshot {
  timestamp: number
  pages: Record<number, string>  // pageIndex → space-joined words
}

const STORAGE_KEY_PREFIX = 'tldraw-snapshots:'
const MAX_SNAPSHOTS = 20

let snapshots: TextSnapshot[] = []
let currentDocName = ''

// Listener for snapshot count changes (so panel can react)
type SnapshotListener = () => void
const snapshotListeners = new Set<SnapshotListener>()

export function onSnapshotUpdate(fn: SnapshotListener): () => void {
  snapshotListeners.add(fn)
  return () => { snapshotListeners.delete(fn) }
}

function notifySnapshotListeners() {
  for (const fn of snapshotListeners) fn()
}

/** Load snapshots from localStorage for a document. */
export function initSnapshots(docName: string): void {
  currentDocName = docName
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + docName)
    if (raw) {
      const parsed = JSON.parse(raw)
      snapshots = parsed.snapshots || []
    } else {
      snapshots = []
    }
  } catch {
    snapshots = []
  }
}

/** Extract space-joined words from PageTextData. */
function extractWords(textData: PageTextData): string {
  const words: string[] = []
  for (const line of textData.lines) {
    const lineWords = line.text.split(/\s+/).filter(w => w.length > 0)
    words.push(...lineWords)
  }
  return words.join(' ')
}

/** Capture the current state of all pages into a new snapshot. */
export function captureSnapshot(
  pages: Array<{ textData?: PageTextData | null }>,
  timestamp: number,
): void {
  const pageWords: Record<number, string> = {}
  for (let i = 0; i < pages.length; i++) {
    const td = pages[i].textData
    if (td) {
      pageWords[i] = extractWords(td)
    }
  }

  // Don't store empty snapshots
  if (Object.keys(pageWords).length === 0) return

  // Dedup: skip if identical to the most recent snapshot
  const last = snapshots[snapshots.length - 1]
  if (last) {
    const lastKeys = Object.keys(last.pages)
    const newKeys = Object.keys(pageWords)
    if (lastKeys.length === newKeys.length &&
        newKeys.every(k => last.pages[Number(k)] === pageWords[Number(k)])) {
      return
    }
  }

  snapshots.push({ timestamp, pages: pageWords })

  // Evict oldest if over limit
  while (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.shift()
  }

  persist()
  notifySnapshotListeners()
}

function persist(): void {
  try {
    const data = JSON.stringify({ snapshots })
    localStorage.setItem(STORAGE_KEY_PREFIX + currentDocName, data)
  } catch {
    // Quota exceeded: drop oldest half and retry
    snapshots = snapshots.slice(Math.floor(snapshots.length / 2))
    try {
      localStorage.setItem(
        STORAGE_KEY_PREFIX + currentDocName,
        JSON.stringify({ snapshots }),
      )
    } catch {
      // Give up silently
    }
  }
}

/** Get all snapshots (oldest first). */
export function getSnapshots(): TextSnapshot[] {
  return snapshots
}

/**
 * Diff a snapshot against current page text data.
 * Returns a Map of shapeId → ChangeRegion[] for all pages with changes.
 */
export function diffAgainstSnapshot(
  snapshotIdx: number,
  pages: Array<{ shapeId: string; textData?: PageTextData | null }>,
): Map<string, ChangeRegion[]> {
  const result = new Map<string, ChangeRegion[]>()
  const snapshot = snapshots[snapshotIdx]
  if (!snapshot) return result

  for (let i = 0; i < pages.length; i++) {
    const currentTextData = pages[i].textData
    if (!currentTextData) continue

    const oldWordString = snapshot.pages[i]
    if (oldWordString === undefined) continue

    const regions = diffWordStrings(oldWordString, currentTextData)
    if (regions.length > 0) {
      result.set(pages[i].shapeId, regions)
    }
  }

  return result
}

/**
 * Diff old words (space-joined string) against current PageTextData.
 * Uses longest common prefix + suffix (O(n)) to find the changed region,
 * then maps changed words back to their line positions for highlighting.
 */
function diffWordStrings(
  oldWordString: string,
  newData: PageTextData,
): ChangeRegion[] {
  const oldWords = oldWordString.split(' ')

  // Extract new words with line provenance
  interface WordEntry { word: string; lineIdx: number }
  const newEntries: WordEntry[] = []
  for (let i = 0; i < newData.lines.length; i++) {
    const words = newData.lines[i].text.split(/\s+/).filter(w => w.length > 0)
    for (const word of words) {
      newEntries.push({ word, lineIdx: i })
    }
  }

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
  const newLines = newData.lines
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
