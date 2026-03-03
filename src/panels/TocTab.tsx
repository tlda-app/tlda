import { useState, useEffect, useRef, useCallback, useMemo, useContext, useSyncExternalStore } from 'react'
import { useBook } from '../BookContext'
import { useEditor, useValue } from 'tldraw'
import type { TLShape } from 'tldraw'
import { loadLookup, clearLookupCache, loadHtmlSearch, loadHtmlToc, type LookupEntry, type HtmlTocEntry, type HtmlSearchEntry } from '../synctexLookup'
import { pdfToCanvas } from '../synctexAnchor'
import { DocContext, PanelContext } from '../PanelContext'
import { getLiveUrl, onReloadSignal } from '../useYjsSync'
import { canPresent, subscribeCanPresent } from '../authToken'
import { navigateTo, navigateToPage, navigateToAnchor, parseHeadings, renderTocTitle, stripTex, getShapeText, type TocLevel, type TocEntry } from './helpers'

const CHILDREN: Record<string, string[]> = {
  part: ['chapter', 'section', 'subsection', 'subsubsection'],
  chapter: ['section', 'subsection', 'subsubsection'],
  section: ['subsection', 'subsubsection'],
  subsection: ['subsubsection'],
}

function computeDefaultFolded(items: Array<{ level: string }>): Set<number> {
  const set = new Set<number>()
  for (let i = 0; i < items.length; i++) {
    const next = items[i + 1]
    if (!next) continue
    const children = CHILDREN[items[i].level]
    if (children && children.includes(next.level)) {
      set.add(i)
    }
  }
  return set
}

export function TocTab() {
  const editor = useEditor()
  const doc = useContext(DocContext)
  const ctx = useContext(PanelContext)
  const hasPresenterPrivilege = useSyncExternalStore(subscribeCanPresent, canPresent)
  const [headings, setHeadings] = useState<TocEntry[]>([])
  const [htmlToc, setHtmlToc] = useState<HtmlTocEntry[] | null>(null)
  const [slideTitles, setSlideTitles] = useState<string[] | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number> | null>(null)
  const [reloadCount, setReloadCount] = useState(0)

  // Hot session: most recently pushed book member (must be before any early returns)
  const book = useBook()
  const hotKey = useMemo(() => {
    if (!book) return null
    let best: string | null = null, bestAt = 0
    for (const m of book.members) {
      if (m.sessionAt && m.sessionAt > bestAt) { bestAt = m.sessionAt; best = m.key }
    }
    return best
  }, [book])

  // Re-fetch TOC when reload signal arrives
  useEffect(() => {
    return onReloadSignal((signal) => {
      if (signal.type === 'full' && doc) {
        clearLookupCache(doc.docName)
        setReloadCount(c => c + 1)
      }
    })
  }, [doc])

  useEffect(() => {
    if (!doc) return
    // Slides format: load TOC from page-info.json
    if (doc?.format === 'slides') {
      fetch(`/docs/${doc.docName}/page-info.json`)
        .then(r => r.ok ? r.json() : null)
        .then((entries: Array<{ title?: string }> | null) => {
          if (entries) setSlideTitles(entries.map(e => e.title || ''))
        })
        .catch(() => {})
      return
    }
    loadLookup(doc.docName).then(data => {
      if (data) {
        const h = parseHeadings(data.lines, data.meta)
        setHeadings(h)
        // Fold all headings that have children by default
        setCollapsed(computeDefaultFolded(h))
      } else {
        // Fallback: try HTML TOC
        loadHtmlToc(doc!.docName).then(toc => {
          if (toc) {
            setHtmlToc(toc)
            setCollapsed(computeDefaultFolded(toc))
          }
        })
      }
    })
  }, [doc?.docName, doc?.format, reloadCount])

  const handleNav = useCallback((entry: LookupEntry) => {
    if (!doc) return
    const pos = pdfToCanvas(entry.page, entry.x, entry.y, doc.pages)
    if (!pos) return
    const pageIndex = entry.page - 1
    const page = doc.pages[pageIndex]
    const pageCenterX = page ? page.bounds.x + page.bounds.width / 2 : pos.x
    navigateTo(editor, pos.x, pos.y, pageCenterX)
  }, [editor, doc])

  const handleHtmlNav = useCallback((pageNum: number, anchor?: string, targetFile?: string) => {
    if (!doc) return
    if (targetFile) {
      // Book cross-member navigation: post tlda-navigate, BookViewer handles the switch
      window.postMessage({ type: 'tlda-navigate', targetFile, anchor: anchor || null, shapeId: null }, '*')
      return
    }
    if (anchor) {
      navigateToAnchor(editor, doc, pageNum, anchor)
    } else {
      navigateToPage(editor, doc, pageNum)
    }
  }, [editor, doc])

  const toggleSection = useCallback((idx: number) => {
    setCollapsed(prev => {
      const next = new Set(prev ?? [])
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  // --- Search state (must be before any early returns) ---
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchLines, setSearchLines] = useState<Record<string, LookupEntry> | null>(null)
  const [htmlSearchIndex, setHtmlSearchIndex] = useState<HtmlSearchEntry[] | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    if (!doc) return
    loadLookup(doc.docName).then(data => {
      if (data) {
        setSearchLines(data.lines)
      } else {
        loadHtmlSearch(doc.docName).then(index => {
          if (index) setHtmlSearchIndex(index)
        })
      }
    })
  }, [doc?.docName, reloadCount])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setDebouncedQuery(query), 300)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [query])

  const docResults = useMemo(() => {
    if (!debouncedQuery) return []
    const q = debouncedQuery.toLowerCase()
    if (searchLines) {
      const results: Array<{ line: string; entry: LookupEntry }> = []
      for (const [line, entry] of Object.entries(searchLines)) {
        if (entry.content.toLowerCase().includes(q)) {
          results.push({ line, entry })
          if (results.length >= 50) break
        }
      }
      return results
    }
    if (htmlSearchIndex) {
      const results: Array<{ page: number; snippet: string; label?: string; anchor?: string }> = []
      for (const entry of htmlSearchIndex) {
        const idx = entry.text.toLowerCase().indexOf(q)
        if (idx >= 0) {
          const start = Math.max(0, idx - 30)
          const end = Math.min(entry.text.length, idx + q.length + 50)
          const snippet = (start > 0 ? '...' : '') + entry.text.slice(start, end) + (end < entry.text.length ? '...' : '')
          results.push({ page: entry.page, snippet, label: entry.label, anchor: entry.anchor })
          if (results.length >= 50) break
        }
      }
      return results
    }
    return []
  }, [debouncedQuery, searchLines, htmlSearchIndex])

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

  const handleDocSearchClick = useCallback((entry: LookupEntry) => {
    if (!doc) return
    const pos = pdfToCanvas(entry.page, entry.x, entry.y, doc.pages)
    if (!pos) return
    const pageIndex = entry.page - 1
    const page = doc.pages[pageIndex]
    const pageCenterX = page ? page.bounds.x + page.bounds.width / 2 : pos.x
    navigateTo(editor, pos.x, pos.y, pageCenterX)
  }, [editor, doc])

  const handlePageSearchClick = useCallback((pageNum: number, anchor?: string) => {
    if (!doc) return
    if (anchor) {
      navigateToAnchor(editor, doc, pageNum, anchor)
    } else {
      navigateToPage(editor, doc, pageNum)
    }
  }, [editor, doc])

  const handleNoteSearchClick = useCallback((shape: TLShape) => {
    navigateTo(editor, shape.x, shape.y)
  }, [editor])

  const isHtmlSearch = !searchLines && !!htmlSearchIndex
  const hasSearchResults = debouncedQuery && (docResults.length > 0 || noteResults.length > 0)
  const hasNoResults = debouncedQuery && docResults.length === 0 && noteResults.length === 0

  // Slides format: render TOC from page-info.json titles
  if (doc?.format === 'slides' && slideTitles) {
    return (
      <div className="doc-panel-content">
        {slideTitles.map((title, i) => (
          <div
            key={i}
            className="toc-item section"
            onClick={() => doc && navigateToPage(editor, doc, i + 1)}
          >
            {title || `Slide ${i + 1}`}
          </div>
        ))}
        {ctx?.onToggleRole && hasPresenterPrivilege && (
          <div className="toc-diff-hint" onClick={() => ctx.onToggleRole?.()}>
            {ctx.role === 'presenter' ? '\uD83C\uDFA4 Presenting' : '\uD83D\uDC64 Viewing'}
          </div>
        )}
        <DarkModeToggle />
      </div>
    )
  }

  // Use HTML TOC if no TeX headings
  const tocItems = htmlToc || null
  const useHtml = headings.length === 0 && tocItems !== null

  if (headings.length === 0 && !useHtml) {
    return (
      <div className="doc-panel-content">
        <div className="panel-empty">No headings found</div>
        {ctx?.onToggleRole && hasPresenterPrivilege && doc?.format === 'slides' && (
          <div className="toc-diff-hint" onClick={() => ctx.onToggleRole?.()}>
            {ctx.role === 'presenter' ? '\uD83C\uDFA4 Presenting' : '\uD83D\uDC64 Viewing'}
          </div>
        )}
        <DarkModeToggle />
      </div>
    )
  }

  const liveUrl = getLiveUrl()

  // Unified render for both TeX and HTML TOC entries
  const items: Array<{ level: TocLevel; title: string; nav: () => void; targetFile?: string }> = useHtml
    ? tocItems!.map(h => ({ level: h.level, title: h.title, nav: () => handleHtmlNav(h.page, h.anchor, h.targetFile), targetFile: h.targetFile }))
    : headings.map(h => ({ level: h.level, title: renderTocTitle(h.title), nav: () => handleNav(h.entry) }))

  // Build visibility: children hidden if their parent is collapsed
  let currentPartIdx = -1
  let currentChapterIdx = -1
  let currentSectionIdx = -1
  let currentSubsectionIdx = -1

  function renderFoldableItem(i: number, h: { level: TocLevel; title: string; nav: () => void; targetFile?: string }, nextLevel: TocLevel | TocLevel[]) {
    const isCollapsed = collapsed?.has(i) ?? false
    const next = items[i + 1]
    const childLevels = Array.isArray(nextLevel) ? nextLevel : [nextLevel]
    const hasChildren = next && childLevels.includes(next.level)
    const isHot = h.level === 'chapter' && h.targetFile != null && h.targetFile === hotKey
    return (
      <div key={i} className={`toc-item ${h.level}`}>
        {hasChildren ? (
          <span
            className={`toc-fold ${isCollapsed ? 'collapsed' : ''}`}
            onClick={(e) => { e.stopPropagation(); toggleSection(i) }}
          />
        ) : (
          <span className="toc-fold-spacer" />
        )}
        <span onClick={h.nav} dangerouslySetInnerHTML={{ __html: h.title }} />
        {isHot && <span className="book-tab-hot-dot" title="Active session" />}
      </div>
    )
  }

  return (
    <>
    <div className="search-input-wrap">
      <input
        className="search-input"
        type="text"
        placeholder="Search..."
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
    </div>
    <div className="doc-panel-content">
      {/* Search results first */}
      {hasSearchResults && (
        <>
          {docResults.length > 0 && (
            <>
              <div className="search-group-label">Document</div>
              {isHtmlSearch
                ? (docResults as Array<{ page: number; snippet: string; label?: string; anchor?: string }>).map((r, i) => (
                    <div key={`d-${i}`} className="search-result" onClick={() => handlePageSearchClick(r.page, r.anchor)}>
                      <span className="line-num">{r.label || `p${r.page}`}</span>
                      {r.snippet}
                    </div>
                  ))
                : (docResults as Array<{ line: string; entry: LookupEntry }>).map((r, i) => (
                    <div key={`d-${i}`} className="search-result" onClick={() => handleDocSearchClick(r.entry)}>
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
                <div key={`n-${i}`} className="search-result" onClick={() => handleNoteSearchClick(r.shape)}>
                  {r.text.slice(0, 80)}
                </div>
              ))}
            </>
          )}
          <div className="notes-section-divider" />
        </>
      )}
      {hasNoResults && (
        <div className="panel-empty">No results</div>
      )}
      {/* TOC */}
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
        if (h.level === 'part') {
          currentPartIdx = i
          currentChapterIdx = -1
          currentSectionIdx = -1
          currentSubsectionIdx = -1
          return renderFoldableItem(i, h, ['chapter', 'section', 'subsection', 'subsubsection'])
        }
        if (currentPartIdx >= 0 && collapsed?.has(currentPartIdx)) return null
        if (h.level === 'chapter') {
          currentChapterIdx = i
          currentSectionIdx = -1
          currentSubsectionIdx = -1
          return renderFoldableItem(i, h, ['section', 'subsection', 'subsubsection'])
        }
        if (currentChapterIdx >= 0 && collapsed?.has(currentChapterIdx)) return null
        if (h.level === 'section') {
          currentSectionIdx = i
          currentSubsectionIdx = -1
          return renderFoldableItem(i, h, ['subsection', 'subsubsection'])
        }
        if (currentSectionIdx >= 0 && collapsed?.has(currentSectionIdx)) return null
        if (h.level === 'subsection') {
          currentSubsectionIdx = i
          return renderFoldableItem(i, h, 'subsubsection')
        }
        if (currentSubsectionIdx >= 0 && collapsed?.has(currentSubsectionIdx)) return null
        return (
          <div key={i} className="toc-item subsubsection" onClick={h.nav}
            dangerouslySetInnerHTML={{ __html: h.title }} />
        )
      })}
      {ctx?.onToggleRole && hasPresenterPrivilege && doc?.format === 'slides' && (
        <div
          className="toc-diff-hint"
          onClick={() => ctx.onToggleRole?.()}
        >
          {ctx.role === 'presenter' ? '\uD83C\uDFA4 Presenting' : '\uD83D\uDC64 Viewing'}
        </div>
      )}
      {ctx?.onTogglePanelsLocal && (
        <div
          className="toc-diff-hint"
          onClick={() => ctx.onTogglePanelsLocal?.()}
        >
          {ctx.panelsLocal ? 'Hide panels here' : 'Show panels here'}
        </div>
      )}
      <DarkModeToggle />
    </div>
    </>
  )
}

export function DarkModeToggle() {
  const editor = useEditor()
  const scheme = useValue('colorScheme', () => editor.user.getUserPreferences().colorScheme || 'system', [editor])
  const label = scheme === 'system' ? 'System' : scheme === 'dark' ? 'Dark' : 'Light'
  return (
    <div
      className="toc-diff-hint"
      onClick={() => {
        const next = scheme === 'system' ? 'dark' : scheme === 'dark' ? 'light' : 'system'
        editor.user.updateUserPreferences({ colorScheme: next })
      }}
    >
      {scheme === 'dark' ? '\u263E' : scheme === 'light' ? '\u2600' : '\u25D1'} {label}
    </div>
  )
}
