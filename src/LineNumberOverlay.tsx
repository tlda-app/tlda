import { useEffect, useState, type RefObject } from 'react'
import { loadLookup, type LookupData } from './synctexLookup'
import { PDF_HEIGHT } from './layoutConstants'

// Must match synctexAnchor.ts
const VIEWBOX_OFFSET = 72
const Y_GROUP_TOLERANCE = 4 // PDF points — deduplicate entries at the same visual line

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

function basename(file: string): string {
  return file.replace(/^.*[\\/]/, '')
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

function computeLabels(lookup: LookupData, pageNum: number, shapeH: number): LineLabel[] {
  const scaleY = shapeH / PDF_HEIGHT
  const entries = buildPageLookup(lookup, pageNum)
  if (entries.length === 0) return []

  // Deduplicate entries that land on the same visual line (within tolerance)
  const deduped: LookupEntry[] = [entries[0]]
  for (let i = 1; i < entries.length; i++) {
    const prev = deduped[deduped.length - 1]
    if (Math.abs(entries[i].pdfY - prev.pdfY) > Y_GROUP_TOLERANCE || entries[i].file !== prev.file) {
      deduped.push(entries[i])
    }
  }

  return deduped.map(e => ({
    lineNum: e.lineNum,
    file: e.file,
    localY: (e.pdfY + VIEWBOX_OFFSET) * scaleY,
  }))
}

type RenderItem =
  | { kind: 'label'; label: LineLabel }
  | { kind: 'seam'; y: number; fromFile: string | null; toFile: string | null }

function buildRenderItems(labels: LineLabel[], mainFile: string | null): RenderItem[] {
  // Labels from the document's main file have file=null in the lookup. Resolve
  // null to the main file's name so the seam shows the real filename on both
  // sides instead of leaving the main-file side blank.
  const items: RenderItem[] = []
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]
    const prev = labels[i - 1]
    if (prev && label.file !== prev.file) {
      items.push({
        kind: 'seam',
        y: (prev.localY + label.localY) / 2,
        fromFile: prev.file ?? mainFile,
        toFile: label.file ?? mainFile,
      })
    }
    items.push({ kind: 'label', label })
  }
  return items
}

export function LineNumberOverlay({
  projectName,
  pageNum,
  shapeH,
  containerRef: _containerRef,
  svgText,
}: {
  projectName: string
  pageNum: number
  shapeH: number
  containerRef: RefObject<HTMLDivElement | null>
  svgText: string | undefined
}) {
  const [labels, setLabels] = useState<LineLabel[]>([])
  const [mainFile, setMainFile] = useState<string | null>(null)

  useEffect(() => {
    if (!svgText) {
      setLabels([])
      return
    }
    let cancelled = false
    loadLookup(projectName).then(lookup => {
      if (cancelled || !lookup) return
      setLabels(computeLabels(lookup, pageNum, shapeH))
      setMainFile(lookup.meta.texFile || null)
    })
    return () => { cancelled = true }
  }, [projectName, pageNum, shapeH, svgText])

  if (labels.length === 0) return null

  const items = buildRenderItems(labels, mainFile)

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
      {items.map((item, i) => {
        if (item.kind === 'label') {
          const { label } = item
          return (
            <span
              key={i}
              className="line-number-label"
              title={label.file ? `${label.file}:${label.lineNum}` : `line ${label.lineNum}`}
              style={{
                position: 'absolute',
                // Shifted right ~3 chars so the labels don't overlap the
                // understanding ribbon in the margin (8px font, monospace ~5px/char).
                left: 17,
                top: label.localY - 5,
                fontSize: 8,
                fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
                lineHeight: 1,
                pointerEvents: 'auto',
              }}
            >
              {label.lineNum}
            </span>
          )
        }
        return (
          <div
            key={i}
            className="file-seam"
            style={{
              position: 'absolute',
              left: 0,
              top: item.y - 10,
              // Width grows with the longer of the two filenames (no truncation).
              width: 'max-content',
              pointerEvents: 'none',
            }}
          >
            {item.fromFile && (
              <div className="file-seam-label file-seam-from">
                {basename(item.fromFile)}
              </div>
            )}
            <div className="file-seam-rule" />
            {item.toFile && (
              <div className="file-seam-label file-seam-to">
                {basename(item.toFile)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
