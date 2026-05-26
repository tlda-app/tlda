import { useEffect, useState } from 'react'
import { loadLookup, type LookupData } from './synctexLookup'
import { PDF_HEIGHT } from './layoutConstants'

const VIEWBOX_OFFSET = 72
const Y_GROUP_TOLERANCE = 3 // PDF points — merge entries on the same rendered line

interface LineLabel {
  lineNum: number
  file: string | null // null = main file
  localY: number      // page-local pixel Y
}

function computeLabels(lookup: LookupData, pageNum: number, shapeH: number): LineLabel[] {
  const scaleY = shapeH / PDF_HEIGHT

  const entries: { lineNum: number; file: string | null; pdfX: number; pdfY: number }[] = []
  for (const [key, entry] of Object.entries(lookup.lines)) {
    if (entry.page !== pageNum) continue
    const colonIdx = key.indexOf(':')
    if (colonIdx >= 0) {
      entries.push({
        lineNum: parseInt(key.slice(colonIdx + 1)),
        file: key.slice(0, colonIdx),
        pdfX: entry.x,
        pdfY: entry.y,
      })
    } else {
      entries.push({
        lineNum: parseInt(key),
        file: null,
        pdfX: entry.x,
        pdfY: entry.y,
      })
    }
  }

  if (entries.length === 0) return []

  // Sort by Y then X — leftmost first within each rendered line
  entries.sort((a, b) => a.pdfY - b.pdfY || a.pdfX - b.pdfX)

  // Group by approximate Y, pick leftmost (first) per group
  const labels: LineLabel[] = []
  let groupY = entries[0].pdfY
  let groupBest = entries[0]

  for (let i = 1; i < entries.length; i++) {
    const e = entries[i]
    if (Math.abs(e.pdfY - groupY) <= Y_GROUP_TOLERANCE) {
      if (e.pdfX < groupBest.pdfX) groupBest = e
    } else {
      labels.push({
        lineNum: groupBest.lineNum,
        file: groupBest.file,
        localY: (groupBest.pdfY + VIEWBOX_OFFSET) * scaleY,
      })
      groupY = e.pdfY
      groupBest = e
    }
  }
  labels.push({
    lineNum: groupBest.lineNum,
    file: groupBest.file,
    localY: (groupBest.pdfY + VIEWBOX_OFFSET) * scaleY,
  })

  return labels
}

export function LineNumberOverlay({
  docName,
  pageNum,
  shapeH,
}: {
  docName: string
  pageNum: number
  shapeH: number
}) {
  const [labels, setLabels] = useState<LineLabel[]>([])

  useEffect(() => {
    let cancelled = false
    loadLookup(docName).then(lookup => {
      if (cancelled || !lookup) return
      setLabels(computeLabels(lookup, pageNum, shapeH))
    })
    return () => { cancelled = true }
  }, [docName, pageNum, shapeH])

  if (labels.length === 0) return null

  return (
    <div
      className="line-number-overlay"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    >
      {labels.map((label, i) => (
        <span
          key={i}
          className="line-number-label"
          title={label.file ? `${label.file}:${label.lineNum}` : `line ${label.lineNum}`}
          style={{
            position: 'absolute',
            left: 2,
            top: label.localY - 5,
            fontSize: 8,
            fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
            lineHeight: 1,
            pointerEvents: 'auto',
          }}
        >
          {label.lineNum}
        </span>
      ))}
    </div>
  )
}
