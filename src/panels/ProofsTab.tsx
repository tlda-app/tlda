import { useCallback, useContext } from 'react'
import { useEditor } from 'tldraw'
import { DocContext, PanelContext } from '../PanelContext'
import { navigateTo } from './helpers'

export function ProofsTab() {
  const editor = useEditor()
  const doc = useContext(DocContext)
  const ctx = useContext(PanelContext)
  const pairs = ctx?.proofPairs

  const handleNav = useCallback((pair: { proofPageIndices: number[] }) => {
    if (!doc || pair.proofPageIndices.length === 0) return
    const pageIdx = pair.proofPageIndices[0]
    if (pageIdx < 0 || pageIdx >= doc.pages.length) return
    const page = doc.pages[pageIdx]

    // Turn on proof mode if off
    if (!ctx.proofMode && ctx.onToggleProof) {
      ctx.onToggleProof()
    }

    navigateTo(editor, page.bounds.x + page.bounds.width / 2, page.bounds.y)
  }, [editor, doc, ctx])

  if (!pairs || pairs.length === 0) {
    return (
      <div className="doc-panel-content">
        <div className="panel-empty">No theorem/proof pairs found</div>
      </div>
    )
  }

  const crossPage = pairs.filter(p => !p.samePage)
  const samePage = pairs.filter(p => p.samePage)

  return (
    <div className="doc-panel-content">
      {ctx?.onToggleProof && (
        <div
          className="toc-diff-hint"
          onClick={() => ctx.onToggleProof?.()}
        >
          <kbd>r</kbd> {ctx.proofLoading ? 'Loading\u2026' : ctx.proofMode ? 'Hide cards' : 'Show cards'}
        </div>
      )}
      {crossPage.length > 0 && (
        <>
          <div className="search-group-label">Cross-page ({crossPage.length})</div>
          {crossPage.map((pair) => (
            <div key={pair.id} className="proof-item" onClick={() => handleNav(pair)}>
              <span className="proof-type">{pair.title}</span>
              <span className="proof-pages">
                p.{pair.statementPage} {'\u2192'} p.{pair.proofPageIndices.map(i => i + 1).join('\u2013')}
              </span>
            </div>
          ))}
        </>
      )}
      {samePage.length > 0 && (
        <>
          <div className="search-group-label">Same page ({samePage.length})</div>
          {samePage.map((pair) => (
            <div key={pair.id} className="proof-item same-page" onClick={() => handleNav(pair)}>
              <span className="proof-type">{pair.title}</span>
              <span className="proof-pages">p.{pair.statementPage}</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
