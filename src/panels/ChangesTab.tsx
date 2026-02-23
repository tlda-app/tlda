import { useState, useEffect, useCallback, useContext } from 'react'
import { useEditor } from 'tldraw'
import { DocContext, PanelContext } from '../PanelContext'
import { onReloadSignal, onDiffReview, onDiffSummaries, writeSignal, readSignal } from '../useYjsSync'
import { navigateToPage, type ReviewStatus, type ReviewMap, type SummaryMap, STATUS_LABELS, STATUS_FILLED } from './helpers'

function readReviewState(): ReviewMap {
  return readSignal<{ reviews: ReviewMap }>('signal:diff-review')?.reviews || {}
}

function writeReviewState(reviews: ReviewMap) {
  writeSignal('signal:diff-review', { reviews })
}

function readSummaries(): SummaryMap {
  return readSignal<{ summaries: SummaryMap }>('signal:diff-summaries')?.summaries || {}
}

export function ChangesTab() {
  const editor = useEditor()
  const doc = useContext(DocContext)
  const ctx = useContext(PanelContext)
  const changes = ctx?.diffChanges
  const [reviews, setReviews] = useState<ReviewMap>({})
  const [summaries, setSummaries] = useState<SummaryMap>({})

  // Load review state + summaries from cache and subscribe to signal bus for changes
  useEffect(() => {
    setReviews(readReviewState())
    setSummaries(readSummaries())
    const unsub1 = onDiffReview((signal) => {
      setReviews(signal.reviews || {})
    })
    const unsub2 = onDiffSummaries((signal) => {
      setSummaries(signal.summaries || {})
    })
    return () => { unsub1(); unsub2() }
  }, [])

  // Clear reviews + summaries on reload (diff changed, need fresh triage)
  useEffect(() => {
    return onReloadSignal(() => {
      writeReviewState({})
      setReviews({})
      setSummaries({})
    })
  }, [])

  const setStatus = useCallback((page: number, status: ReviewStatus) => {
    setReviews(prev => {
      const next = { ...prev }
      if (next[page] === status) {
        delete next[page] // toggle off
      } else {
        next[page] = status
      }
      writeReviewState(next)
      return next
    })
  }, [])

  const handleNav = useCallback((pageNum: number) => {
    if (!doc) return
    navigateToPage(editor, doc, pageNum)
    ctx?.onFocusChange?.(pageNum)
  }, [editor, doc, ctx])

  if (!changes || changes.length === 0) return null

  const reviewed = changes.filter(c => reviews[c.currentPage]).length

  return (
    <>
      <div className="changes-header">
        {reviewed}/{changes.length} reviewed
      </div>
      {changes.map((c) => {
        const status = reviews[c.currentPage] || null
        return (
          <div key={c.currentPage} className={`change-item ${status ? 'reviewed' : ''}`}>
            <span className="change-page" onClick={() => handleNav(c.currentPage)}>
              p.{c.currentPage}
            </span>
            {c.oldPages.length > 0 && (
              <span className="change-old" onClick={() => handleNav(c.currentPage)}>
                {'\u2190 '}
                {c.oldPages.length === 1
                  ? `p.${c.oldPages[0]}`
                  : `p.${c.oldPages[0]}\u2013${c.oldPages[c.oldPages.length - 1]}`
                }
              </span>
            )}
            {c.oldPages.length === 0 && (
              <span className="change-new" onClick={() => handleNav(c.currentPage)}>new</span>
            )}
            <span className="change-status-dots">
              {STATUS_LABELS.map(s => (
                <span
                  key={s.key}
                  className={`status-dot ${status === s.key ? 'active' : ''} status-${s.key}`}
                  onClick={(e) => { e.stopPropagation(); setStatus(c.currentPage, s.key) }}
                  data-tooltip={s.label}
                >
                  {status === s.key ? STATUS_FILLED : s.symbol}
                </span>
              ))}
            </span>
            {summaries[c.currentPage] && (
              <div className="change-summary" onClick={() => handleNav(c.currentPage)}>
                {summaries[c.currentPage]}
              </div>
            )}
          </div>
        )
      })}
      <div className="changes-hint">
        n / p to jump &middot; {STATUS_FILLED} new &middot; {STATUS_FILLED} old &middot; {STATUS_FILLED} discuss
      </div>
    </>
  )
}
