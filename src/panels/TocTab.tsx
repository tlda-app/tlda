import { useState, useEffect, useRef, useCallback, useMemo, useContext, useSyncExternalStore, type DragEvent as ReactDragEvent } from 'react'
import { useBook } from '../BookContext'
import { useEditor, useValue, createShapeId } from 'tldraw'
import type { TLShape } from 'tldraw'
import { loadLookup, clearLookupCache, loadHtmlSearch, loadHtmlToc, type LookupEntry, type HtmlTocEntry, type HtmlSearchEntry } from '../synctexLookup'
import { pdfToCanvas } from '../synctexAnchor'
import { DocContext, PanelContext, type PanelContextValue } from '../PanelContext'
import { getLiveUrl, onReloadSignal } from '../useYjsSync'
import { canPresent, subscribeCanPresent } from '../authToken'
import { getVimMode, toggleVimMode, subscribeVimMode } from '../vimMode'
import { getCameraLinked, toggleCameraLinked, subscribeCameraLinked } from '../cameraLink'
import { getSemanticHighlight, toggleSemanticHighlight, subscribeSemanticHighlight } from '../semanticHighlight'
import { navigateTo, navigateToPage, navigateToAnchor, parseHeadings, renderTocTitle, stripTex, getShapeText, type TocLevel, type TocEntry } from './helpers'
import { useFleetAgents } from '../fleet-data-adapter'

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

  // --- Drop-to-book state (must be before any early returns) ---
  const [tocDragOver, setTocDragOver] = useState(false)
  const [tocAdding, setTocAdding] = useState<string | null>(null)

  // TLDraw-native drop target: listen for custom events from TocDropTargetShape
  useEffect(() => {
    if (!book) return
    function onHover(e: Event) {
      const active = (e as CustomEvent).detail?.active
      setTocDragOver(!!active)
    }
    function onChapter(e: Event) {
      const { text, title } = (e as CustomEvent).detail || {}
      if (text && title) addChapterFromContent(title, text)
    }
    window.addEventListener('toc-drop-hover', onHover)
    window.addEventListener('toc-drop-chapter', onChapter)
    return () => {
      window.removeEventListener('toc-drop-hover', onHover)
      window.removeEventListener('toc-drop-chapter', onChapter)
    }
  }, [book]) // eslint-disable-line react-hooks/exhaustive-deps

  // Shared chapter-add logic: create markdown project from content, add to book
  async function addChapterFromContent(title: string, text: string) {
    if (!book) return
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chapter'
    setTocAdding(title)
    try {
      const createRes = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: slug, title, format: 'markdown', mainFile: 'content.md' }),
      })
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}))
        if (!err.error?.includes('exists')) throw new Error('Failed to create project')
      }
      const contentB64 = btoa(unescape(encodeURIComponent(text)))
      await fetch(`/api/projects/${slug}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [{ path: 'content.md', content: contentB64, encoding: 'base64' }] }),
      })
      const patchRes = await fetch(`/api/projects/${book.bookName}/members`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ add: slug }),
      })
      if (!patchRes.ok) throw new Error('Failed to add to book')
      window.location.reload()
    } catch (err) {
      console.error('Drop-to-book failed:', err)
      setTocAdding(null)
    }
  }

  function handleTocDragOver(e: ReactDragEvent) {
    if (!book) return
    const types = e.dataTransfer?.types
    if (!types?.includes('text/plain') && !types?.includes('application/x-chat-attachment')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setTocDragOver(true)
  }

  function handleTocDragLeave(e: ReactDragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setTocDragOver(false)
  }

  async function handleTocDrop(e: ReactDragEvent) {
    setTocDragOver(false)
    if (!book) return

    // Parse drop payload: fleet shared-doc OR canvas chapter-note
    let item: Record<string, any> | null = null
    const custom = e.dataTransfer?.getData('application/x-chat-attachment')
    if (custom) try { item = JSON.parse(custom) } catch {}
    if (!item) {
      const plain = e.dataTransfer?.getData('text/plain')
      if (plain) try {
        const p = JSON.parse(plain)
        if (p._fleet || p._tlda) item = p
      } catch {}
    }
    if (!item) return

    // Fleet shared-doc: create project via fleet share endpoint
    if (item.type === 'shared-doc' && item.path) {
      e.preventDefault()
      const fileName = item.name || item.path.split('/').pop() || 'untitled'
      setTocAdding(fileName)

      try {
        const shareRes = await fetch('http://localhost:5199/api/tlda/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: item.path }),
        })
        if (!shareRes.ok) throw new Error('Failed to create project')
        const shareData = await shareRes.json()

        const patchRes = await fetch(`/api/projects/${book.bookName}/members`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ add: shareData.project }),
        })
        if (!patchRes.ok) throw new Error('Failed to add to book')

        window.location.reload()
      } catch (err) {
        console.error('Drop-to-book failed:', err)
        setTocAdding(null)
      }
      return
    }

    // Canvas chapter-note: create markdown project from note content
    if (item.type === 'chapter-note' && item.text) {
      e.preventDefault()
      addChapterFromContent(item.title || 'Untitled', item.text)
      return
    }
  }

  const tocDropProps = book ? {
    onDragOver: handleTocDragOver,
    onDragLeave: handleTocDragLeave,
    onDrop: handleTocDrop,
  } : {}

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
      <div className="doc-panel-content" {...tocDropProps}>
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
        <SemanticHighlightToggle />
        <DarkModeToggle />
        <VimModeToggle />
        <CameraLinkToggle />
        <HideDefsToggle ctx={ctx} />
      </div>
    )
  }

  // Use HTML TOC if no TeX headings
  const tocItems = htmlToc || null
  const useHtml = headings.length === 0 && tocItems !== null

  if (headings.length === 0 && !useHtml) {
    return (
      <div className="doc-panel-content" {...tocDropProps}>
        <div className="panel-empty">No headings found</div>
        {tocDragOver && book && (
          <div className="toc-item toc-drop-hint">+ Add chapter</div>
        )}
        {tocAdding && (
          <div className="toc-item toc-adding">Adding {tocAdding}...</div>
        )}
        {ctx?.onToggleRole && hasPresenterPrivilege && doc?.format === 'slides' && (
          <div className="toc-diff-hint" onClick={() => ctx.onToggleRole?.()}>
            {ctx.role === 'presenter' ? '\uD83C\uDFA4 Presenting' : '\uD83D\uDC64 Viewing'}
          </div>
        )}
        <SemanticHighlightToggle />
        <DarkModeToggle />
        <VimModeToggle />
        <CameraLinkToggle />
        <HideDefsToggle ctx={ctx} />
      </div>
    )
  }

  const liveUrl = getLiveUrl()

  // Unified render for both TeX and HTML TOC entries
  let items: Array<{ level: TocLevel; title: string; nav: () => void; targetFile?: string }> = useHtml
    ? tocItems!.map(h => ({ level: h.level, title: h.title, nav: () => handleHtmlNav(h.page, h.anchor, h.targetFile), targetFile: h.targetFile }))
    : headings.map(h => ({ level: h.level, title: renderTocTitle(h.title), nav: () => handleNav(h.entry) }))

  // Book: if no TOC from active member, show book members as chapters
  if (items.length === 0 && book) {
    items = book.members.map((m, i) => ({
      level: 'chapter' as TocLevel,
      title: m.name || m.key,
      nav: () => book.switchTo(i),
      targetFile: m.key,
    }))
  }

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
    <div className="doc-panel-content" {...tocDropProps}>
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
      {tocDragOver && book && (
        <div className="toc-item toc-drop-hint">+ Add chapter</div>
      )}
      {tocAdding && (
        <div className="toc-item toc-adding">Adding {tocAdding}...</div>
      )}
      {ctx?.onToggleRole && hasPresenterPrivilege && doc?.format === 'slides' && (
        <div
          className="toc-diff-hint"
          onClick={() => ctx.onToggleRole?.()}
        >
          {ctx.role === 'presenter' ? '\uD83C\uDFA4 Presenting' : '\uD83D\uDC64 Viewing'}
        </div>
      )}
      <FleetToggle />
      <DarkModeToggle />
      <VimModeToggle />
      <CameraLinkToggle />
      <HideDefsToggle ctx={ctx} />
    </div>
    </>
  )
}

export function CameraLinkToggle() {
  const linked = useSyncExternalStore(subscribeCameraLinked, getCameraLinked)
  return (
    <div className="toc-diff-hint" onClick={toggleCameraLinked}>
      <span className="toc-toggle-icon">{'\u21C6'}</span> {linked ? 'Linked' : 'Link cameras'}
    </div>
  )
}

export function HideDefsToggle({ ctx }: { ctx: PanelContextValue | null }) {
  if (!ctx?.onTogglePanelsLocal) return null
  return (
    <div className="toc-diff-hint toc-toggle-indented" onClick={() => ctx.onTogglePanelsLocal?.()}>
      {ctx.panelsLocal ? 'Hide defs' : 'Show defs'}
    </div>
  )
}

export function VimModeToggle() {
  const enabled = useSyncExternalStore(subscribeVimMode, getVimMode)
  return (
    <div className="toc-diff-hint" onClick={toggleVimMode}>
      <span className="toc-toggle-icon">{'\u276F'}</span> {enabled ? 'Vim' : 'Vim off'}
    </div>
  )
}

export function SemanticHighlightToggle() {
  const enabled = useSyncExternalStore(subscribeSemanticHighlight, getSemanticHighlight)
  return (
    <div className="toc-diff-hint" onClick={toggleSemanticHighlight}>
      <span className="toc-toggle-icon">{'\u2B22'}</span> {enabled ? 'Semantic HL' : 'Semantic HL off'}
    </div>
  )
}

export function DarkModeToggle() {
  const editor = useEditor()
  const scheme = useValue('colorScheme', () => editor.user.getUserPreferences().colorScheme || 'system', [editor])
  const [warm, setWarm] = useState(() => {
    const saved = localStorage.getItem('tlda-warm-mode') === 'true'
    if (saved) document.body.classList.add('warm-mode')
    return saved || document.body.classList.contains('warm-mode')
  })

  const label = warm ? 'Warm' : scheme === 'system' ? 'System' : scheme === 'dark' ? 'Dark' : 'Light'
  const icon = warm ? '\u2600\uFE0E' : scheme === 'dark' ? '\u263E' : scheme === 'light' ? '\u2600' : '\u25D1'

  const cycle = useCallback(() => {
    if (warm) {
      // Warm → System (exit warm mode)
      document.body.classList.remove('warm-mode')
      localStorage.setItem('tlda-warm-mode', 'false')
      setWarm(false)
      editor.user.updateUserPreferences({ colorScheme: 'system' })
    } else if (scheme === 'system') {
      editor.user.updateUserPreferences({ colorScheme: 'dark' })
    } else if (scheme === 'dark') {
      editor.user.updateUserPreferences({ colorScheme: 'light' })
    } else {
      // Light → Warm
      document.body.classList.add('warm-mode')
      localStorage.setItem('tlda-warm-mode', 'true')
      setWarm(true)
    }
  }, [editor, scheme, warm])

  return (
    <div className="toc-diff-hint" onClick={cycle}>
      <span className="toc-toggle-icon">{icon}</span> {label}
    </div>
  )
}

const FLEET_SHAPE_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-pill']

export function FleetToggle() {
  const editor = useEditor()
  const allAgents = useFleetAgents()

  const handleClick = useCallback(() => {
    // Always delete existing fleet shapes and recreate fresh
    const existing = editor.getCurrentPageShapes().filter(s => FLEET_SHAPE_TYPES.includes(s.type))
    if (existing.length > 0) {
      editor.deleteShapes(existing.map(s => s.id))
    }

    // Pick 2 most recently active non-human agents for 1-on-1 chat filters
    const nonHuman = allAgents.filter((a: any) => a.id !== 'fleet:skip' && a.friendly_name !== 'skip')
    const sorted = [...nonHuman].sort((a: any, b: any) => {
      const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0
      const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0
      return tb - ta
    })
    const [agent1, agent2] = sorted.slice(0, 2)
    const name1 = (agent1?.friendly_name || agent1?.id) as string | undefined
    const name2 = (agent2?.friendly_name || agent2?.id) as string | undefined
    const filter1: [string, string][][] = name1 ? [[['from', name1]], [['to', name1]]] : []
    const filter2: [string, string][][] = name2 ? [[['from', name2]], [['to', name2]]] : []

    // Position: right edge of fleet just left of doc's left margin, ~1 page above doc top
    const pageShapes = editor.getCurrentPageShapes().filter(s =>
      (s.type as string) === 'html-page' || (s.type as string) === 'svg-page')

    const leftW = 340
    const chatW = 420
    const gap = 10
    const chatH = 510
    const totalW = leftW + gap + chatW

    let anchorX = 0, anchorY = 0
    if (pageShapes.length > 0) {
      let minLeft = Infinity, minTop = Infinity
      for (const ps of pageShapes) {
        const b = editor.getShapePageBounds(ps.id)
        if (b) {
          if (b.x < minLeft) minLeft = b.x
          if (b.y < minTop) minTop = b.y
        }
      }
      anchorX = minLeft - 40 - totalW
      anchorY = minTop - 1200
    } else {
      const vb = editor.getViewportScreenBounds()
      const cam = editor.getCamera()
      anchorX = (-cam.x + (vb.x + vb.w / 2) / cam.z) - totalW / 2
      anchorY = -cam.y + (vb.y + vb.h / 2) / cam.z
    }

    editor.createShapes([
      {
        id: createShapeId(),
        type: 'fleet-agents' as any,
        x: anchorX, y: anchorY,
        props: { w: leftW, h: chatH },
      },
      {
        id: createShapeId(),
        type: 'fleet-search' as any,
        x: anchorX, y: anchorY + chatH + gap,
        props: { w: leftW, h: chatH },
      },
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap, y: anchorY,
        props: { w: chatW, h: chatH, filter: filter1 },
      },
      {
        id: createShapeId(),
        type: 'fleet-chat' as any,
        x: anchorX + leftW + gap, y: anchorY + chatH + gap,
        props: { w: chatW, h: chatH, filter: filter2 },
      },
    ])

    editor.centerOnPoint(
      { x: anchorX + totalW / 2, y: anchorY + chatH },
      { animation: { duration: 300 } }
    )
  }, [editor, allAgents])

  return (
    <div className="toc-diff-hint" onClick={handleClick}>
      <span className="toc-toggle-icon">{'\u2693'}</span> Fleet
    </div>
  )
}
