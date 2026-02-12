/**
 * Snapshot store: captures page text on each watcher rebuild so the user can
 * compare current state against any previous version via a time slider.
 *
 * Stores space-joined word lists per page (~2KB/page) in localStorage.
 * Up to 20 snapshots (~2MB max for a 47-page doc).
 */

import type { PageTextData } from './TextSelectionLayer'
import type { ChangeRegion } from './SvgPageShape'
import { diffWords } from './wordDiff'

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

/** Diff old words (space-joined string) against current PageTextData. */
function diffWordStrings(
  oldWordString: string,
  newData: PageTextData,
): ChangeRegion[] {
  return diffWords(oldWordString.split(' '), newData.lines)
}
