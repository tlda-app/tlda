import { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react'
import { createPortal } from 'react-dom'
import { useEditor } from 'tldraw'
import type { Editor, TLShape } from 'tldraw'
import katex from 'katex'
import { getActiveMacros } from './katexMacros'
import { loadLookup, clearLookupCache, loadHtmlToc, loadHtmlSearch, type LookupEntry, type HtmlTocEntry, type HtmlSearchEntry } from './synctexLookup'
import { pdfToCanvas } from './synctexAnchor'
import { PanelContext, type PanelContextValue } from './PanelContext'
import { getYRecords, getLiveUrl, onReloadSignal } from './useYjsSync'
import './DocumentPanel.css'

// --- Navigation helper ---

function navigateTo(editor: Editor, canvasX: number, canvasY: number, pageCenterX?: number) {
  const x = pageCenterX ?? canvasX
  editor.centerOnPoint({ x, y: canvasY }, { animation: { duration: 300 } })
}

// --- Heading parsing ---

type TocLevel = 'section' | 'subsection' | 'subsubsection'

interface TocEntry {
  level: TocLevel
  title: string
  line: number
  entry: LookupEntry
}

const DEMOTE: Record<TocLevel, TocLevel> = {
  section: 'subsection',
  subsection: 'subsubsection',
  subsubsection: 'subsubsection',
}

function parseHeadings(lines: Record<string, LookupEntry>): TocEntry[] {
  const headings: TocEntry[] = []
  const sectionRe = /\\(sub)*section\*?\{([^}]*)\}/

  // Find \appendix line to demote subsequent headings one step
  let appendixLine = Infinity
  let appendixEntry: LookupEntry | null = null
  for (const [lineStr, entry] of Object.entries(lines)) {
    if (entry.content.trim() === '\\appendix') {
      appendixLine = parseInt(lineStr)
      appendixEntry = entry
      break
    }
  }

  for (const [lineStr, entry] of Object.entries(lines)) {
    const lineNum = parseInt(lineStr)
    const m = entry.content.match(sectionRe)
    if (!m) continue
    let level: TocLevel = m[1] ? 'subsection' : 'section'
    if (lineNum > appendixLine) level = DEMOTE[level]
    // Clean title: preserve $...$ math, strip other TeX
    let title = m[2]
      .replace(/~}/g, '}')                         // trailing ~ before }
      .replace(/\\ref\{[^}]*\}/g, '')              // drop \ref{...}
      .replace(/~\\ref\{[^}]*\}/g, '')             // drop ~\ref{...}
      .replace(/\s+/g, ' ')
      .trim()
    if (!title) title = '(untitled)'
    headings.push({ level, title, line: lineNum, entry })
  }

  headings.sort((a, b) => a.line - b.line)

  // Insert synthetic "Appendix" section heading
  if (appendixEntry) {
    const insertIdx = headings.findIndex(h => h.line > appendixLine)
    if (insertIdx >= 0) {
      headings.splice(insertIdx, 0, {
        level: 'section',
        title: 'Appendix',
        line: appendixLine,
        entry: appendixEntry,
      })
    }
  }

  return headings
}

// --- Render TOC title: inline KaTeX for $...$ ---

function renderTocTitle(title: string): string {
  const macros = getActiveMacros()
  // Split on $...$ preserving delimiters
  return title.replace(/\$([^$]+)\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { macros, throwOnError: false, displayMode: false })
    } catch {
      return tex
    }
  })
    // Strip non-math TeX commands from the text portions
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}~]/g, '')
}

// --- Strip TeX noise for display ---

function stripTex(s: string): string {
  return s
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}$~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// --- Get text from a shape ---

function getShapeText(shape: TLShape): string {
  const props = shape.props as Record<string, unknown>
  // math-note uses .text
  if (typeof props.text === 'string') return props.text
  // tldraw note uses .richText
  if (props.richText && typeof props.richText === 'object') {
    return extractRichText(props.richText as RichTextDoc)
  }
  return ''
}

interface RichTextDoc {
  content?: Array<{ content?: Array<{ text?: string }> }>
}

function extractRichText(doc: RichTextDoc): string {
  if (!doc.content) return ''
  return doc.content
    .map(block => (block.content || []).map(n => n.text || '').join(''))
    .join(' ')
}

// --- Color map ---

const COLOR_HEX: Record<string, string> = {
  yellow: '#eab308',
  red: '#ef4444',
  green: '#22c55e',
  blue: '#3b82f6',
  violet: '#8b5cf6',
  orange: '#f97316',
  grey: '#6b7280',
  'light-red': '#ef4444',
  'light-green': '#22c55e',
  'light-blue': '#3b82f6',
  'light-violet': '#8b5cf6',
  black: '#333',
  white: '#ccc',
}

// ======================
// Tab components
// ======================

function navigateToPage(editor: Editor, ctx: PanelContextValue, pageNum: number) {
  const pageIndex = pageNum - 1
  if (pageIndex < 0 || pageIndex >= ctx.pages.length) return
  const page = ctx.pages[pageIndex]
  navigateTo(editor, page.bounds.x + page.bounds.width / 2, page.bounds.y)
}

function TocTab() {
  const editor = useEditor()
  const ctx = useContext(PanelContext)
  const [headings, setHeadings] = useState<TocEntry[]>([])
  const [htmlToc, setHtmlToc] = useState<HtmlTocEntry[] | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number> | null>(null)
  const [reloadCount, setReloadCount] = useState(0)

  // Re-fetch TOC when reload signal arrives
  useEffect(() => {
    return onReloadSignal((signal) => {
      if (signal.type === 'full' && ctx) {
        clearLookupCache(ctx.docName)
        setReloadCount(c => c + 1)
      }
    })
  }, [ctx])

  useEffect(() => {
    if (!ctx) return
    loadLookup(ctx.docName).then(data => {
      if (data) {
        const h = parseHeadings(data.lines)
        setHeadings(h)
        // Fold all headings that have children by default
        const foldedSet = new Set<number>()
        for (let i = 0; i < h.length; i++) {
          const next = h[i + 1]
          if (!next) continue
          if (h[i].level === 'section' && (next.level === 'subsection' || next.level === 'subsubsection')) {
            foldedSet.add(i)
          } else if (h[i].level === 'subsection' && next.level === 'subsubsection') {
            foldedSet.add(i)
          }
        }
        setCollapsed(foldedSet)
      } else {
        // Fallback: try HTML TOC
        loadHtmlToc(ctx.docName).then(toc => {
          if (toc) {
            setHtmlToc(toc)
            const foldedSet = new Set<number>()
            for (let i = 0; i < toc.length; i++) {
              const next = toc[i + 1]
              if (!next) continue
              if (toc[i].level === 'section' && (next.level === 'subsection' || next.level === 'subsubsection')) {
                foldedSet.add(i)
              } else if (toc[i].level === 'subsection' && next.level === 'subsubsection') {
                foldedSet.add(i)
              }
            }
            setCollapsed(foldedSet)
          }
        })
      }
    })
  }, [ctx?.docName, reloadCount])

  const handleNav = useCallback((entry: LookupEntry) => {
    if (!ctx) return
    const pos = pdfToCanvas(entry.page, entry.x, entry.y, ctx.pages)
    if (!pos) return
    const pageIndex = entry.page - 1
    const page = ctx.pages[pageIndex]
    const pageCenterX = page ? page.bounds.x + page.bounds.width / 2 : pos.x
    navigateTo(editor, pos.x, pos.y, pageCenterX)
  }, [editor, ctx])

  const handleHtmlNav = useCallback((pageNum: number) => {
    if (!ctx) return
    navigateToPage(editor, ctx, pageNum)
  }, [editor, ctx])

  const toggleSection = useCallback((idx: number) => {
    setCollapsed(prev => {
      const next = new Set(prev ?? [])
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  // Use HTML TOC if no TeX headings
  const tocItems = htmlToc || null
  const useHtml = headings.length === 0 && tocItems !== null

  if (headings.length === 0 && !useHtml) {
    return <div className="panel-empty">No headings found</div>
  }

  const liveUrl = getLiveUrl()

  // Unified render for both TeX and HTML TOC entries
  const items: Array<{ level: TocLevel; title: string; nav: () => void }> = useHtml
    ? tocItems!.map(h => ({ level: h.level, title: h.title, nav: () => handleHtmlNav(h.page) }))
    : headings.map(h => ({ level: h.level, title: renderTocTitle(h.title), nav: () => handleNav(h.entry) }))

  // Build visibility: children hidden if their parent is collapsed
  let currentSectionIdx = -1
  let currentSubsectionIdx = -1
  return (
    <div className="doc-panel-content">
      {liveUrl && (
        <a
          href={liveUrl}
          className="toc-live-link"
          target="_blank"
          rel="noopener noreferrer"
        >
          Join live session
        </a>
      )}
      {items.map((h, i) => {
        if (h.level === 'section') {
          currentSectionIdx = i
          currentSubsectionIdx = -1
          const isCollapsed = collapsed?.has(i) ?? false
          const next = items[i + 1]
          const hasChildren = next && (next.level === 'subsection' || next.level === 'subsubsection')
          return (
            <div key={i} className="toc-item section">
              {hasChildren ? (
                <span
                  className={`toc-fold ${isCollapsed ? 'collapsed' : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleSection(i) }}
                />
              ) : (
                <span className="toc-fold-spacer" />
              )}
              <span onClick={h.nav} dangerouslySetInnerHTML={{ __html: useHtml ? h.title : h.title }} />
            </div>
          )
        }
        // Hidden if parent section is collapsed
        if (collapsed?.has(currentSectionIdx)) return null
        if (h.level === 'subsection') {
          currentSubsectionIdx = i
          const isCollapsed = collapsed?.has(i) ?? false
          const next = items[i + 1]
          const hasChildren = next && next.level === 'subsubsection'
          return (
            <div key={i} className="toc-item subsection">
              {hasChildren ? (
                <span
                  className={`toc-fold ${isCollapsed ? 'collapsed' : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleSection(i) }}
                />
              ) : (
                <span className="toc-fold-spacer" />
              )}
              <span onClick={h.nav} dangerouslySetInnerHTML={{ __html: useHtml ? h.title : h.title }} />
            </div>
          )
        }
        // subsubsection: hidden if parent subsection is collapsed
        if (collapsed?.has(currentSubsectionIdx)) return null
        return (
          <div key={i} className="toc-item subsubsection" onClick={h.nav}
            dangerouslySetInnerHTML={{ __html: useHtml ? h.title : h.title }} />
        )
      })}
      {ctx?.diffAvailable && (
        <div
          className="toc-diff-hint"
          onClick={() => ctx.onToggleDiff?.()}
        >
          <kbd>d</kbd> {ctx.diffLoading ? 'Loading diff\u2026' : ctx.diffMode ? 'Hide diff' : 'Show diff'}
        </div>
      )}
    </div>
  )
}

function SearchTab() {
  const editor = useEditor()
  const ctx = useContext(PanelContext)
  const [query, setQuery] = useState('')
  const [lookupLines, setLookupLines] = useState<Record<string, LookupEntry> | null>(null)
  const [htmlSearchIndex, setHtmlSearchIndex] = useState<HtmlSearchEntry[] | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    if (!ctx) return
    loadLookup(ctx.docName).then(data => {
      if (data) {
        setLookupLines(data.lines)
      } else {
        // Fallback: try HTML search index
        loadHtmlSearch(ctx.docName).then(index => {
          if (index) setHtmlSearchIndex(index)
        })
      }
    })
  }, [ctx?.docName])

  // Debounce
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setDebouncedQuery(query), 300)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [query])

  const docResults = useMemo(() => {
    if (!debouncedQuery) return []
    const q = debouncedQuery.toLowerCase()

    // TeX lookup path
    if (lookupLines) {
      const results: Array<{ line: string; entry: LookupEntry }> = []
      for (const [line, entry] of Object.entries(lookupLines)) {
        if (entry.content.toLowerCase().includes(q)) {
          results.push({ line, entry })
          if (results.length >= 50) break
        }
      }
      return results
    }

    // HTML search index path
    if (htmlSearchIndex) {
      const results: Array<{ page: number; snippet: string; label?: string }> = []
      for (const entry of htmlSearchIndex) {
        const idx = entry.text.toLowerCase().indexOf(q)
        if (idx >= 0) {
          // Extract snippet around the match
          const start = Math.max(0, idx - 30)
          const end = Math.min(entry.text.length, idx + q.length + 50)
          const snippet = (start > 0 ? '...' : '') + entry.text.slice(start, end) + (end < entry.text.length ? '...' : '')
          results.push({ page: entry.page, snippet, label: entry.label })
          if (results.length >= 50) break
        }
      }
      return results
    }

    return []
  }, [debouncedQuery, lookupLines, htmlSearchIndex])

  const noteResults = useMemo(() => {
    if (!debouncedQuery) return []
    const q = debouncedQuery.toLowerCase()
    const shapes = editor.getCurrentPageShapes()
    const results: Array<{ shape: TLShape; text: string }> = []
    for (const shape of shapes) {
      if ((shape.type as string) !== 'math-note' && shape.type !== 'note') continue
      const text = getShapeText(shape)
      if (text.toLowerCase().includes(q)) {
        results.push({ shape, text })
        if (results.length >= 50) break
      }
    }
    return results
  }, [debouncedQuery, editor])

  const handleDocClick = useCallback((entry: LookupEntry) => {
    if (!ctx) return
    const pos = pdfToCanvas(entry.page, entry.x, entry.y, ctx.pages)
    if (!pos) return
    const pageIndex = entry.page - 1
    const page = ctx.pages[pageIndex]
    const pageCenterX = page ? page.bounds.x + page.bounds.width / 2 : pos.x
    navigateTo(editor, pos.x, pos.y, pageCenterX)
  }, [editor, ctx])

  const handlePageClick = useCallback((pageNum: number) => {
    if (!ctx) return
    navigateToPage(editor, ctx, pageNum)
  }, [editor, ctx])

  const handleNoteClick = useCallback((shape: TLShape) => {
    navigateTo(editor, shape.x, shape.y)
  }, [editor])

  const isHtmlSearch = !lookupLines && !!htmlSearchIndex

  return (
    <>
      <div className="search-input-wrap">
        <input
          className="search-input"
          type="text"
          placeholder="Search document & notes..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      <div className="doc-panel-content">
        {debouncedQuery && docResults.length === 0 && noteResults.length === 0 && (
          <div className="panel-empty">No results</div>
        )}
        {docResults.length > 0 && (
          <>
            <div className="search-group-label">Document</div>
            {isHtmlSearch
              ? (docResults as Array<{ page: number; snippet: string; label?: string }>).map((r, i) => (
                  <div key={`d-${i}`} className="search-result" onClick={() => handlePageClick(r.page)}>
                    <span className="line-num">p{r.page}</span>
                    {r.snippet}
                  </div>
                ))
              : (docResults as Array<{ line: string; entry: LookupEntry }>).map((r, i) => (
                  <div key={`d-${i}`} className="search-result" onClick={() => handleDocClick(r.entry)}>
                    <span className="line-num">L{r.line}</span>
                    {stripTex(r.entry.content).slice(0, 80)}
                  </div>
                ))
            }
          </>
        )}
        {noteResults.length > 0 && (
          <>
            <div className="search-group-label">Notes</div>
            {noteResults.map((r, i) => (
              <div key={`n-${i}`} className="search-result" onClick={() => handleNoteClick(r.shape)}>
                {r.text.slice(0, 80)}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  )
}

type ReviewStatus = 'new' | 'old' | 'discuss' | null
type ReviewMap = Record<number, ReviewStatus>  // currentPage → status
type SummaryMap = Record<number, string>       // currentPage → one-line summary

function readReviewState(): ReviewMap {
  const yRecords = getYRecords()
  if (!yRecords) return {}
  const signal = yRecords.get('signal:diff-review' as any) as any
  return signal?.reviews || {}
}

function writeReviewState(reviews: ReviewMap) {
  const yRecords = getYRecords()
  if (!yRecords) return
  const doc = yRecords.doc!
  doc.transact(() => {
    yRecords.set('signal:diff-review' as any, {
      reviews,
      timestamp: Date.now(),
    } as any)
  })
}

function readSummaries(): SummaryMap {
  const yRecords = getYRecords()
  if (!yRecords) return {}
  const signal = yRecords.get('signal:diff-summaries' as any) as any
  return signal?.summaries || {}
}

const STATUS_LABELS: Array<{ key: ReviewStatus; label: string; symbol: string }> = [
  { key: 'new', label: 'keep new', symbol: '\u25CB' },    // ○
  { key: 'old', label: 'revert', symbol: '\u25CB' },      // ○
  { key: 'discuss', label: 'discuss', symbol: '\u25CB' },  // ○
]

const STATUS_FILLED = '\u25CF' // ●

function ChangesTab() {
  const editor = useEditor()
  const ctx = useContext(PanelContext)
  const changes = ctx?.diffChanges
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
    if (!ctx) return
    navigateToPage(editor, ctx, pageNum)
    ctx.onFocusChange?.(pageNum)
  }, [editor, ctx])

  // n/p keyboard shortcuts are now handled at the SvgDocumentEditor level
  // so they work regardless of which panel tab is active

  if (!changes || changes.length === 0) {
    return (
      <div className="doc-panel-content">
        <div className="panel-empty">No changes</div>
      </div>
    )
  }

  const reviewed = changes.filter(c => reviews[c.currentPage]).length

  return (
    <div className="doc-panel-content">
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
                  title={s.label}
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
    </div>
  )
}


function ProofsTab() {
  const editor = useEditor()
  const ctx = useContext(PanelContext)
  const pairs = ctx?.proofPairs

  const handleNav = useCallback((pair: { proofPageIndices: number[] }) => {
    if (!ctx || pair.proofPageIndices.length === 0) return
    const pageIdx = pair.proofPageIndices[0]
    if (pageIdx < 0 || pageIdx >= ctx.pages.length) return
    const page = ctx.pages[pageIdx]

    // Turn on proof mode if off
    if (!ctx.proofMode && ctx.onToggleProof) {
      ctx.onToggleProof()
    }

    navigateTo(editor, page.bounds.x + page.bounds.width / 2, page.bounds.y)
  }, [editor, ctx])

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
          {crossPage.map((pair, i) => (
            <div key={pair.id} className="proof-item" onClick={() => handleNav(pair)}>
              <span className="proof-type">{pair.title}</span>
              <span className="proof-pages">
                p.{pair.statementPage} {'→'} p.{pair.proofPageIndices.map(i => i + 1).join('\u2013')}
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

function NotesTab() {
  const editor = useEditor()
  const [notes, setNotes] = useState<TLShape[]>([])

  // Listen for shape changes and update note list
  useEffect(() => {
    function updateNotes() {
      const shapes = editor.getCurrentPageShapes()
      const noteShapes = shapes.filter(
        s => (s.type as string) === 'math-note' || s.type === 'note'
      )
      // Sort by y position (top to bottom in document)
      noteShapes.sort((a, b) => a.y - b.y)
      setNotes(noteShapes)
    }

    updateNotes()

    // Re-run when store changes
    const unsub = editor.store.listen(updateNotes, { scope: 'document', source: 'all' })
    return unsub
  }, [editor])

  const handleClick = useCallback((shape: TLShape) => {
    navigateTo(editor, shape.x, shape.y)
  }, [editor])

  if (notes.length === 0) {
    return (
      <div className="doc-panel-content">
        <div className="panel-empty">No annotations yet</div>
      </div>
    )
  }

  return (
    <div className="doc-panel-content">
      {notes.map(shape => {
        const text = getShapeText(shape)
        const color = (shape.props as Record<string, unknown>).color as string || 'yellow'
        const meta = shape.meta as Record<string, unknown>
        const anchor = meta?.sourceAnchor as { line?: number } | undefined
        return (
          <div key={shape.id} className="note-item" onClick={() => handleClick(shape)}>
            <div className="note-preview">
              <span className="note-color-dot" style={{ background: COLOR_HEX[color] || '#ccc' }} />
              {text.slice(0, 60) || '(empty)'}
            </div>
            {anchor?.line && (
              <div className="note-meta">Line {anchor.line}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ======================
// Ping button
// ======================

export function PingButton() {
  const editor = useEditor()
  const [state, setState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle')

  const ping = useCallback(async () => {
    if (state === 'sending') return
    setState('sending')
    try {
      const yRecords = getYRecords()
      if (!yRecords) throw new Error('Yjs not connected')
      const doc = yRecords.doc!
      doc.transact(() => {
        yRecords.set('signal:ping', {
          id: 'signal:ping',
          typeName: 'signal',
          type: 'ping',
          timestamp: Date.now(),
          viewport: (() => {
            const center = editor.getViewportScreenCenter()
            const pt = editor.screenToPage(center)
            return { x: pt.x, y: pt.y }
          })(),
        } as any)
      })

      // Capture viewport screenshot and write to Yjs
      try {
        const viewportBounds = editor.getViewportPageBounds()
        const { blob } = await editor.toImage([], {
          bounds: viewportBounds,
          background: true,
          scale: 1,
          pixelRatio: 1,
        })
        const buf = await blob.arrayBuffer()
        const reader = new FileReader()
        const base64 = await new Promise<string>((resolve) => {
          reader.onload = () => {
            const result = reader.result as string
            resolve(result.split(',')[1]) // strip data:...;base64, prefix
          }
          reader.readAsDataURL(new Blob([buf], { type: 'image/png' }))
        })
        doc.transact(() => {
          yRecords.set('signal:screenshot' as any, {
            data: base64,
            mimeType: 'image/png',
            timestamp: Date.now(),
          } as any)
        })
      } catch (e) {
        console.warn('[Ping] Screenshot capture failed:', e)
      }

      setState('success')
      setTimeout(() => setState('idle'), 1500)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 2000)
    }
  }, [editor, state])

  const portalRef = useRef<HTMLDivElement | null>(null)
  if (!portalRef.current) {
    portalRef.current = document.createElement('div')
    document.body.appendChild(portalRef.current)
  }
  useEffect(() => {
    return () => { portalRef.current?.remove(); portalRef.current = null }
  }, [])

  return createPortal(
    <button
      className={`ping-button-standalone ping-button-standalone--${state}`}
      onClick={ping}
      onPointerDown={stopTldrawEvents}
      onPointerUp={stopTldrawEvents}
      onTouchStart={stopTldrawEvents}
      onTouchEnd={stopTldrawEvents}
      disabled={state === 'sending'}
      title="Ping Claude"
    >
      {'\u2733\uFE0E'}
    </button>,
    portalRef.current,
  )
}

// ======================
// Main panel
// ======================

type Tab = 'diff' | 'toc' | 'proofs' | 'search' | 'notes'

// Stop pointer events from reaching tldraw's canvas event handlers
function stopTldrawEvents(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}

const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

export function DocumentPanel() {
  const ctx = useContext(PanelContext)
  const hasDiff = !!(ctx?.diffChanges && ctx.diffChanges.length > 0)
  const hasProofs = !!(ctx?.proofPairs && ctx.proofPairs.length > 0)
  const [tab, setTab] = useState<Tab>(hasDiff ? 'diff' : 'toc')

  // Auto-switch to diff tab when changes appear, back to toc when they disappear
  useEffect(() => {
    if (hasDiff) setTab('diff')
    else setTab(prev => prev === 'diff' ? 'toc' : prev)
  }, [hasDiff])

  // Portal outside TLDraw's DOM tree to avoid event capture interference
  const portalRef = useRef<HTMLDivElement | null>(null)
  if (!portalRef.current) {
    portalRef.current = document.createElement('div')
    document.body.appendChild(portalRef.current)
  }
  useEffect(() => {
    return () => { portalRef.current?.remove(); portalRef.current = null }
  }, [])

  return createPortal(
    <div
      className={`doc-panel ${isTouch ? 'panel-open' : ''}`}
      onPointerDown={stopTldrawEvents}
      onPointerUp={stopTldrawEvents}
      onTouchStart={stopTldrawEvents}
      onTouchEnd={stopTldrawEvents}
    >
      <div className="doc-panel-tabs">
        {hasDiff && (
          <button className={`doc-panel-tab ${tab === 'diff' ? 'active' : ''}`} onClick={() => setTab('diff')}>
            Diff
          </button>
        )}
        <button className={`doc-panel-tab ${tab === 'toc' ? 'active' : ''}`} onClick={() => setTab('toc')}>
          TOC
        </button>
        {hasProofs && (
          <button className={`doc-panel-tab ${tab === 'proofs' ? 'active' : ''}`} onClick={() => setTab('proofs')}>
            Proofs
          </button>
        )}
        <button className={`doc-panel-tab ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>
          Search
        </button>
        <button className={`doc-panel-tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
          Notes
        </button>
      </div>
      {tab === 'diff' && hasDiff && <ChangesTab />}
      {tab === 'toc' && <TocTab />}
      {tab === 'proofs' && hasProofs && <ProofsTab />}
      {tab === 'search' && <SearchTab />}
      {tab === 'notes' && <NotesTab />}
    </div>,
    portalRef.current,
  )
}
