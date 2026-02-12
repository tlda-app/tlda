import { useState, useEffect, useCallback } from 'react'
import { getSnapshots, diffAgainstSnapshot, onSnapshotUpdate } from '../snapshotStore'
import { setChangeHighlights, dismissAllChanges } from '../SvgPageShape'
import type { SvgDocument } from '../svgDocumentLoader'

export function useSnapshotTimeline(document: SvgDocument) {
  const [snapshotSliderIdx, setSnapshotSliderIdx] = useState(-1) // -1 = "latest rebuild"
  const [snapshotCount, setSnapshotCount] = useState(() => getSnapshots().length)

  useEffect(() => {
    return onSnapshotUpdate(() => {
      setSnapshotCount(getSnapshots().length)
      // Reset slider to rightmost on new snapshot
      setSnapshotSliderIdx(-1)
    })
  }, [])

  const handleSliderChange = useCallback((idx: number) => {
    setSnapshotSliderIdx(idx)
    const snaps = getSnapshots()
    if (idx < 0 || idx >= snaps.length) {
      // Rightmost: restore most-recent-rebuild diff (clear and let default kick in)
      dismissAllChanges()
      return
    }
    const result = diffAgainstSnapshot(idx, document.pages.map(p => ({
      shapeId: p.shapeId as string,
      textData: p.textData,
    })))
    // Clear and apply new highlights
    dismissAllChanges()
    for (const [shapeId, regions] of result) {
      setChangeHighlights(shapeId, regions)
    }
  }, [document])

  return { snapshotSliderIdx, snapshotCount, handleSliderChange }
}
