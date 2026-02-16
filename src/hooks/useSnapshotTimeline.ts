import { useState, useEffect, useCallback, useRef } from 'react'
import { setChangeHighlights, dismissAllChanges } from '../SvgPageShape'
import type { ChangeRegion } from '../SvgPageShape'
import { fetchHistory, fetchDiff, triggerGitBuild, waitForGitBuild, flattenChanges } from '../historyStore'
import type { HistoryEntry, PageDiff, ChangeItem } from '../historyStore'
import type { SvgDocument } from '../svgDocumentLoader'

// Also keep the old localStorage snapshots for immediate feedback
import { getSnapshots, diffAgainstSnapshot, onSnapshotUpdate } from '../snapshotStore'

export function useSnapshotTimeline(document: SvgDocument, docName: string) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [activeIdx, setActiveIdx] = useState(-1) // -1 = current (no diff)
  const [loading, setLoading] = useState(false)
  const [changedPages, setChangedPages] = useState<PageDiff[]>([])
  const [changes, setChanges] = useState<ChangeItem[]>([])
  const entriesRef = useRef(entries)
  entriesRef.current = entries

  // Fetch history on mount and after rebuilds
  const refresh = useCallback(async () => {
    const hist = await fetchHistory(docName)
    // Server returns newest-first; reverse so slider left=oldest, right=newest
    hist.reverse()
    setEntries(hist)
  }, [docName])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Re-fetch on snapshot store updates (triggered by rebuilds)
  // If slider was at the newest position, keep it there after refresh
  useEffect(() => {
    return onSnapshotUpdate(() => {
      const wasAtEnd = activeIdx < 0 || activeIdx >= entriesRef.current.length - 1
      setTimeout(async () => {
        await refresh()
        if (wasAtEnd) {
          setActiveIdx(entriesRef.current.length - 1)
        }
      }, 500)
    })
  }, [refresh, activeIdx])

  const handleSliderChange = useCallback(async (idx: number) => {
    setActiveIdx(idx)
    dismissAllChanges()
    setChangedPages([])
    setChanges([])

    // Rightmost position = current version, no diff
    if (idx < 0 || idx >= entriesRef.current.length - 1) {
      return
    }

    const entry = entriesRef.current[idx]

    const applyAndStore = (pageDiffs: PageDiff[]) => {
      const relevant = pageDiffs.filter(p => p.status === 'changed' || p.status === 'added')
      setChangedPages(relevant)
      setChanges(flattenChanges(relevant))
      applyDiffHighlights(pageDiffs, document)
    }

    // For git entries that aren't built yet, trigger a build
    if (entry.type === 'git' && !entry.built) {
      setLoading(true)
      const status = await triggerGitBuild(docName, entry.commitHash!)
      if (status === 'building') {
        const built = await waitForGitBuild(docName, entry.commitHash!)
        if (built) {
          await refresh()
          applyAndStore(await fetchDiff(docName, entry.id))
        }
      } else if (status === 'cached') {
        applyAndStore(await fetchDiff(docName, entry.id))
      }
      setLoading(false)
      return
    }

    // For build snapshots and cached git entries, fetch diff from server
    setLoading(true)
    applyAndStore(await fetchDiff(docName, entry.id))
    setLoading(false)
  }, [docName, document, refresh])

  return {
    historyEntries: entries,
    activeHistoryIdx: activeIdx,
    historyLoading: loading,
    historyChangedPages: changedPages,
    historyChanges: changes,
    handleHistoryChange: handleSliderChange,
    refreshHistory: refresh,
  }
}

function applyDiffHighlights(
  pageDiffs: PageDiff[],
  document: SvgDocument,
) {
  dismissAllChanges()
  const NEW_TINT = '#1d4ed8'
  for (const pd of pageDiffs) {
    const pageData = document.pages[pd.page - 1]
    if (!pageData?.shapeId) continue

    // Prefer per-line change data with text tinting
    if (pd.changes && pd.changes.length > 0) {
      const regions: ChangeRegion[] = []
      for (const c of pd.changes) {
        if (c.newLines && c.newLines.length > 0) {
          for (const l of c.newLines) {
            regions.push({ y: l.y, height: l.height, x: l.x, width: l.width, tint: NEW_TINT })
          }
        } else if (c.y != null && c.height != null) {
          regions.push({ y: c.y, height: c.height, x: c.x, width: c.width, tint: NEW_TINT })
        }
      }
      if (regions.length > 0) {
        setChangeHighlights(pageData.shapeId, regions)
      }
      continue
    }

    // Fallback: untinted region highlights
    if (pd.regions && pd.regions.length > 0) {
      setChangeHighlights(pageData.shapeId, pd.regions)
    }
  }
}
