import { useState, useEffect, useCallback, useContext } from 'react'
import { useEditor } from 'tldraw'
import { DocContext, PanelContext } from '../PanelContext'
import { pdfToCanvas } from '../synctexAnchor'
import { getYRecords, readSignal, writeSignal } from '../useYjsSync'
import { formatRelativeTime, navigateToPage, type ReviewMap, type SummaryMap, STATUS_LABELS, STATUS_FILLED } from './helpers'
import { ChangesTab } from './ChangesTab'

function readReviewState(): ReviewMap {
  return readSignal<{ reviews: ReviewMap }>('signal:diff-review')?.reviews || {}
}

function readSummaries(): SummaryMap {
  return readSignal<{ summaries: SummaryMap }>('signal:diff-summaries')?.summaries || {}
}

function writeReviewState(reviews: ReviewMap) {
  writeSignal('signal:diff-review', { reviews })
}

export function HistoryTab() {
  const ctx = useContext(PanelContext)
  const hasDiff = !!(ctx?.diffChanges && ctx.diffChanges.length > 0)

  const entries = ctx?.historyEntries || []
  const isAtEnd = !ctx?.activeHistoryIdx || ctx.activeHistoryIdx < 0 || ctx.activeHistoryIdx >= entries.length - 1
  const showCompare = !isAtEnd

  return (
    <div className="doc-panel-content">
      {entries.length >= 2 && (
        <div className="snapshot-slider">
          {(() => {
            const idx = ctx?.activeHistoryIdx !== undefined && ctx.activeHistoryIdx >= 0
              ? ctx.activeHistoryIdx
              : entries.length - 1
            const entry = entries[idx]
            const atStart = idx <= 0
            const atEnd = idx >= entries.length - 1
            const step = (dir: number) => {
              const next = Math.max(0, Math.min(entries.length - 1, idx + dir))
              ctx?.onHistoryChange?.(next)
            }
            const label = !entry ? ''
              : atEnd ? 'current'
              : (() => {
                  const time = formatRelativeTime(entry.timestamp)
                  return entry.type === 'git'
                    ? `${entry.commitMessage?.slice(0, 30) || entry.id} (${time})`
                    : time
                })()
            return <>
              <div className="snapshot-nav-row">
                <button
                  className="snapshot-step"
                  disabled={atStart}
                  onClick={() => step(-1)}
                  title="Older"
                >&lsaquo;</button>
                <input
                  type="range"
                  className="snapshot-range"
                  min={0}
                  max={entries.length - 1}
                  value={idx}
                  onChange={(e) => ctx?.onHistoryChange?.(parseInt(e.target.value))}
                />
                <button
                  className="snapshot-step"
                  disabled={atEnd}
                  onClick={() => step(1)}
                  title="Newer"
                >&rsaquo;</button>
                {showCompare && (
                  <button
                    className={`history-compare-btn${ctx?.showHistoryPanel ? ' active' : ''}`}
                    onClick={() => ctx?.onToggleHistoryPanel?.()}
                    title="Show side-by-side comparison"
                  >
                    &#9703;
                  </button>
                )}
              </div>
              <span className="snapshot-label">
                <span className="snapshot-position">{idx + 1}/{entries.length}</span>
                {' '}
                {ctx?.historyLoading ? `${label} \u2026` : label}
              </span>
            </>
          })()}
        </div>
      )}
      {ctx?.diffAvailable && (
        <div
          className="toc-diff-hint"
          onClick={() => ctx.onToggleDiff?.()}
        >
          {ctx.diffLoading ? 'Loading diff\u2026' : ctx.diffMode ? 'Hide diff' : 'Show diff'}
        </div>
      )}
      {hasDiff && <ChangesTab />}
      {!hasDiff && <HistoryChanges />}
    </div>
  )
}

export function HistoryChanges() {
  const editor = useEditor()
  const doc = useContext(DocContext)
  const ctx = useContext(PanelContext)
  const changes = ctx?.historyChanges
  const [reviews, setReviews] = useState<ReviewMap>({})
  const [summaries, setSummaries] = useState<SummaryMap>({})

  // Load review state + summaries from Yjs and observe changes
  useEffect(() => {
    setReviews(readReviewState())
    setSummaries(readSummaries())
    const yRecords = getYRecords()
    if (!yRecords) return
    const handler = () => {
      setReviews(readReviewState())
      setSummaries(readSummaries())
    }
    yRecords.observe(handler)
    return () => yRecords.unobserve(handler)
  }, [])

  const handleNav = useCallback((c: { page: number; y?: number }) => {
    if (!doc) return
    if (c.y != null) {
      // Convert viewBox y (origin -72) to synctex y (origin 0)
      const pos = pdfToCanvas(c.page, 0, c.y + 72, doc.pages)
      if (pos) {
        // Only scroll vertically — keep current camera x
        const cam = editor.getCamera()
        const vp = editor.getViewportScreenBounds()
        const targetY = -(pos.y - vp.h / (2 * cam.z))
        editor.setCamera({ x: cam.x, y: targetY, z: cam.z }, { animation: { duration: 300 } })
        return
      }
    }
    navigateToPage(editor, doc, c.page)
  }, [editor, doc])

  if (!changes || changes.length === 0) return null

  const reviewed = changes.filter(c => reviews[c.id]).length

  return (
    <>
      <div className="changes-header">
        {reviewed}/{changes.length} reviewed
      </div>
      {changes.map((c) => {
        const status = reviews[c.id] || null
        const snippet = c.newText
          ? (c.newText.length > 50 ? c.newText.slice(0, 47) + '\u2026' : c.newText)
          : c.oldText
            ? '\u2212 ' + (c.oldText.length > 47 ? c.oldText.slice(0, 44) + '\u2026' : c.oldText)
            : null
        const isSelected = ctx?.selectedChangeId === c.id
        return (
          <div
            key={c.id}
            className={`change-item ${status ? 'reviewed' : ''} ${isSelected ? 'selected' : ''}`}
            onClick={() => {
              ctx?.onSelectChange?.(isSelected ? null : c.id)
              handleNav(c)
            }}
          >
            <span className="change-page">
              p.{c.page}
            </span>
            <span className="change-status-dots">
              {STATUS_LABELS.map(s => (
                <span
                  key={s.key}
                  className={`status-dot ${status === s.key ? 'active' : ''} status-${s.key}`}
                  onClick={(e) => { e.stopPropagation(); setReviews(prev => {
                    const next = { ...prev }
                    if (next[c.id] === s.key) delete next[c.id]
                    else next[c.id] = s.key
                    writeReviewState(next)
                    return next
                  })}}
                  data-tooltip={s.label}
                >
                  {status === s.key ? STATUS_FILLED : s.symbol}
                </span>
              ))}
            </span>
            {snippet && (
              <div className="change-snippet">
                {snippet}
              </div>
            )}
            {summaries[c.id] && (
              <div className="change-summary">
                {summaries[c.id]}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
