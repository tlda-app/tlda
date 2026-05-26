import { useEffect, useState, type RefObject } from 'react'
import { loadLookup, type LookupData } from './synctexLookup'
import { PDF_HEIGHT } from './layoutConstants'

const VIEWBOX_OFFSET = 72
const Y_GROUP_TOLERANCE = 3 // PDF points — merge SVG text elements on the same rendered line

interface LineLabel {
  lineNum: number
  file: string | null
  localY: number
}

interface LookupEntry {
  lineNum: number
  file: string | null
  pdfY: number
}

function buildPageLookup(lookup: LookupData, pageNum: number): LookupEntry[] {
  const entries: LookupEntry[] = []
  for (const [key, entry] of Object.entries(lookup.lines)) {
    if (entry.page !== pageNum) continue
    const colonIdx = key.indexOf(':')
    entries.push({
      lineNum: colonIdx >= 0 ? parseInt(key.slice(colonIdx + 1)) : parseInt(key),
      file: colonIdx >= 0 ? key.slice(0, colonIdx) : null,
      pdfY: entry.y,
    })
  }
  entries.sort((a, b) => a.pdfY - b.pdfY)
  return entries
}

function findNearestSourceLine(pdfY: number, lookupEntries: LookupEntry[]): LookupEntry | null {
  if (lookupEntries.length === 0) return null
  let best = lookupEntries[0]
  let bestDist = Math.abs(pdfY - best.pdfY)
  for (let i = 1; i < lookupEntries.length; i++) {
    const dist = Math.abs(pdfY - lookupEntries[i].pdfY)
    if (dist < bestDist) {
      best = lookupEntries[i]
      bestDist = dist
    }
  }
  return best
}

function computeLabels(
  svgContainer: HTMLDivElement,
  lookup: LookupData,
  pageNum: number,
  shapeH: number,
): LineLabel[] {
  const scaleY = shapeH / PDF_HEIGHT
  const lookupEntries = buildPageLookup(lookup, pageNum)
  if (lookupEntries.length === 0) return []

  // Extract unique Y positions from SVG text elements (= rendered lines)
  const svgEl = svgContainer.querySelector('svg')
  if (!svgEl) return []
  const textEls = svgEl.querySelectorAll('text')
  const rawYs: number[] = []
  for (let i = 0; i < textEls.length; i++) {
    rawYs.push(parseFloat(textEls[i].getAttribute('y') || '0'))
  }
  if (rawYs.length === 0) return []

  // Deduplicate Y positions (group within tolerance)
  rawYs.sort((a, b) => a - b)
  const uniqueYs: number[] = [rawYs[0]]
  for (let i = 1; i < rawYs.length; i++) {
    if (Math.abs(rawYs[i] - uniqueYs[uniqueYs.length - 1]) > Y_GROUP_TOLERANCE) {
      uniqueYs.push(rawYs[i])
    }
  }

  // SVG text Y values are in viewBox coords; synctex Y = viewBox Y (same origin)
  // Map each rendered line to its nearest source line
  const labels: LineLabel[] = []
  for (const viewBoxY of uniqueYs) {
    const synctexY = viewBoxY // same coordinate system origin
    const nearest = findNearestSourceLine(synctexY, lookupEntries)
    if (!nearest) continue
    labels.push({
      lineNum: nearest.lineNum,
      file: nearest.file,
      localY: (viewBoxY + VIEWBOX_OFFSET) * scaleY,
    })
  }

  return labels
}

export function LineNumberOverlay({
  docName,
  pageNum,
  shapeH,
  containerRef,
  svgText,
}: {
  docName: string
  pageNum: number
  shapeH: number
  containerRef: RefObject<HTMLDivElement | null>
  svgText: string | undefined
}) {
  const [labels, setLabels] = useState<LineLabel[]>([])

  useEffect(() => {
    if (!svgText || !containerRef.current) {
      setLabels([])
      return
    }
    let cancelled = false
    loadLookup(docName).then(lookup => {
      if (cancelled || !lookup || !containerRef.current) return
      setLabels(computeLabels(containerRef.current, lookup, pageNum, shapeH))
    })
    return () => { cancelled = true }
  }, [docName, pageNum, shapeH, svgText])

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
