import { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react'
import { createPortal } from 'react-dom'
import { useEditor } from 'tldraw'
import type { Editor, TLShape } from 'tldraw'
import katex from 'katex'
import { getActiveMacros } from './katexMacros'
import { loadLookup, clearLookupCache, loadHtmlToc, loadHtmlSearch, type LookupEntry, type HtmlTocEntry, type HtmlSearchEntry } from './synctexLookup'
import { pdfToCanvas } from './synctexAnchor'
import { PanelContext, type PanelContextValue } from './PanelContext'
import { getYRecords, getLiveUrl, onReloadSignal, writeSignal, readSignal } from './useYjsSync'
import { changedPages, onChangeStoreUpdate, dismissAllChanges } from './SvgPageShape'
import './DocumentPanel.css'

// --- Helpers ---

function formatRelativeTime(ts: number | undefined): string {
  if (!ts) return ''
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  return `${Math.floor(delta / 86400_000)}d ago`
}

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
  // Matches both \appendix and \begin{appendix}
  let appendixEntry: LookupEntry | null = null
  for (const [lineStr, entry] of Object.entries(lines)) {
    const trimmed = entry.content.trim()
    if (trimmed === '\\appendix' || trimmed === '\\begin{appendix}') {
      if (!isNaN(parseInt(lineStr))) {
        appendixEntry = entry
        break
      }
    }
  }

  for (const [lineStr, entry] of Object.entries(lines)) {
    // Handle both plain line numbers and multi-file keys ("file.tex:N")
    let lineNum: number
    const colonIdx = lineStr.lastIndexOf(':')
    if (colonIdx > 0 && lineStr.slice(0, colonIdx).includes('.')) {
      // Multi-file key — use page position for sorting
      lineNum = entry.page * 10000 + Math.round(entry.y)
    } else {
      lineNum = parseInt(lineStr)
      if (isNaN(lineNum)) continue
    }

    const m = entry.content.match(sectionRe)
    if (!m) continue
    let level: TocLevel = m[1] ? 'subsection' : 'section'
    if (entry.page >= (appendixEntry?.page ?? Infinity)) level = DEMOTE[level]
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
    const insertIdx = headings.findIndex(h => h.entry.page >= appendixEntry!.page)
    if (insertIdx >= 0) {
      headings.splice(insertIdx, 0, {
        level: 'section',
        title: 'Appendix',
        line: headings[insertIdx].line - 1,
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

  // Track recent changes (page-level "unread" indicators)
  const [changedPageSet, setChangedPageSet] = useState<Set<string>>(() => new Set(changedPages))
  useEffect(() => {
    return onChangeStoreUpdate(() => {
      setChangedPageSet(new Set(changedPages))
    })
  }, [])

  // Map shapeIds to 1-indexed page numbers for display
  const changedPageNumbers = useMemo(() => {
    if (!ctx || changedPageSet.size === 0) return []
    const nums: number[] = []
    for (let i = 0; i < ctx.pages.length; i++) {
      if (changedPageSet.has(ctx.pages[i].shapeId as string)) {
        nums.push(i + 1)
      }
    }
    return nums.sort((a, b) => a - b)
  }, [ctx, changedPageSet])

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
      {(changedPageNumbers.length > 0 || (ctx && (ctx.snapshotCount ?? 0) >= 2)) && (
        <div className="recent-changes">
          {changedPageNumbers.length > 0 && (
            <>
              <div className="recent-changes-header">
                <span className="recent-changes-label">Recent changes</span>
                <span className="recent-changes-dismiss" onClick={() => {
                  dismissAllChanges()
                  if (ctx?.onSliderChange) ctx.onSliderChange(-1)
                }}>
                  mark read
                </span>
              </div>
              <div className="recent-changes-pages">
                {changedPageNumbers.map(n => (
                  <span
                    key={n}
                    className="recent-changes-page"
                    onClick={() => { if (ctx) navigateToPage(editor, ctx, n) }}
                  >
                    p.{n}
                  </span>
                ))}
              </div>
            </>
          )}
          {ctx && (ctx.snapshotCount ?? 0) >= 2 && ctx.snapshotTimestamps && (
            <div className="snapshot-slider">
              {changedPageNumbers.length === 0 && (
                <span className="recent-changes-label" style={{ marginRight: 4 }}>history</span>
              )}
              <input
                type="range"
                className="snapshot-range"
                min={0}
                max={(ctx.snapshotCount ?? 1) - 1}
                value={ctx.activeSnapshotIdx !== undefined && ctx.activeSnapshotIdx >= 0
                  ? ctx.activeSnapshotIdx
                  : (ctx.snapshotCount ?? 1) - 1}
                onChange={(e) => ctx.onSliderChange?.(parseInt(e.target.value))}
              />
              <span className="snapshot-label">
                {formatRelativeTime(ctx.snapshotTimestamps[
                  ctx.activeSnapshotIdx !== undefined && ctx.activeSnapshotIdx >= 0
                    ? ctx.activeSnapshotIdx
                    : (ctx.snapshotCount ?? 1) - 1
                ])}
              </span>
            </div>
          )}
        </div>
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
      {ctx?.onToggleCameraLink && (
        <div
          className="toc-diff-hint"
          onClick={() => ctx.onToggleCameraLink?.()}
        >
          <kbd>l</kbd> {ctx.cameraLinked ? 'Unlink cameras' : 'Link cameras'}
        </div>
      )}
      {ctx?.cameraLinked && ctx?.onTogglePanelsLocal && (
        <div
          className="toc-diff-hint"
          onClick={() => ctx.onTogglePanelsLocal?.()}
        >
          {ctx.panelsLocal ? 'Hide panels here' : 'Show panels here'}
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
  return readSignal<{ reviews: ReviewMap }>('signal:diff-review')?.reviews || {}
}

function writeReviewState(reviews: ReviewMap) {
  writeSignal('signal:diff-review', { reviews })
}

function readSummaries(): SummaryMap {
  return readSignal<{ summaries: SummaryMap }>('signal:diff-summaries')?.summaries || {}
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
          {crossPage.map((pair) => (
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
      if (!getYRecords()) throw new Error('Yjs not connected')
      const center = editor.getViewportScreenCenter()
      const pt = editor.screenToPage(center)
      writeSignal('signal:ping', {
        id: 'signal:ping',
        typeName: 'signal',
        type: 'ping',
        viewport: { x: pt.x, y: pt.y },
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
        writeSignal('signal:screenshot', { data: base64, mimeType: 'image/png' })
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
      <svg width="18" height="18" viewBox="0 0 248 248" fill="currentColor">
        <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z"/>
      </svg>
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


// Tool toggle regions — fixed squares at bottom-right (touch devices only)
const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

function ToolToggleZones() {
  const editor = useEditor()
  const lastTapRef = useRef<{ tool: string; time: number }>({ tool: '', time: 0 })

  // Pen-only double-tap detection via document-level listener.
  // No DOM elements needed — zones are defined by screen coordinates.
  // This avoids capturing finger/touch events entirely.
  useEffect(() => {
    if (!isTouch) return

    const ZONE_SIZE = 250
    function handlePointerDown(e: PointerEvent) {
      if (e.pointerType !== 'pen') return

      const x = e.clientX
      const y = e.clientY
      const w = window.innerWidth
      const h = window.innerHeight

      // Bottom-right corner: two stacked zones
      if (x < w - ZONE_SIZE) return

      let targetTool: string | null = null
      if (y >= h - ZONE_SIZE) {
        targetTool = 'eraser' // bottom zone
      } else if (y >= h - ZONE_SIZE * 2) {
        targetTool = 'highlight' // zone above
      }
      if (!targetTool) return

      const now = Date.now()
      const last = lastTapRef.current
      if (last.tool === targetTool && now - last.time < 400) {
        // Double-tap: toggle
        const cur = editor.getCurrentToolId()
        editor.setCurrentTool(cur === targetTool ? 'draw' : targetTool)
        lastTapRef.current = { tool: '', time: 0 }
      } else {
        lastTapRef.current = { tool: targetTool, time: now }
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [editor])

  // No DOM elements — fully transparent to touch
  return null
}

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
    <>
      <div
        className="doc-panel"
      >
        <div
          className="doc-panel-tabs"
          onPointerDown={stopTldrawEvents}
          onPointerUp={stopTldrawEvents}
          onTouchStart={stopTldrawEvents}
          onTouchEnd={stopTldrawEvents}
        >
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
      </div>
      <ToolToggleZones />
    </>,
    portalRef.current,
  )
}
