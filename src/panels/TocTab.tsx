import { useState, useEffect, useRef, useCallback, useMemo, useContext, useSyncExternalStore, type DragEvent as ReactDragEvent } from 'react'
import { useBook } from '../BookContext'
import { useEditor, useValue } from 'tldraw'
import type { TLShape } from 'tldraw'
import { loadLookup, clearLookupCache, loadHtmlSearch, loadHtmlToc, type LookupEntry, type HtmlTocEntry, type HtmlSearchEntry } from '../synctexLookup'
import { pdfToCanvas } from '../synctexAnchor'
import { DocContext, PanelContext } from '../PanelContext'
import { getLiveUrl, onReloadSignal } from '../useYjsSync'
import { canPresent, subscribeCanPresent } from '../authToken'
import { getVimMode, toggleVimMode, subscribeVimMode } from '../vimMode'
import { getCameraLinked, toggleCameraLinked, subscribeCameraLinked } from '../cameraLink'
import { getSemanticHighlight, toggleSemanticHighlight, subscribeSemanticHighlight } from '../semanticHighlight'
import { navigateTo, navigateToPage, navigateToAnchor, parseHeadings, renderTocTitle, stripTex, getShapeText, type TocLevel, type TocEntry } from './helpers'
import { useFleetAgents } from '../fleet-data-adapter'
import { createFleetLayout, forceDeleteShapes } from '../shapes/fleet-utils'

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

  // Re-fetch TOC when reload signal arrives (partial or full — lookup.json is always regenerated)
  useEffect(() => {
    return onReloadSignal((_signal) => {
      if (doc) {
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
        .catch(e => console.warn('[toc] slide titles fetch failed:', e.message))
      return
    }
    const targets = doc.targets
    if (targets && targets.length > 1) {
      // Multi-target: load each target's lookup, merge with dividers
      let pageOffset = 0
      Promise.all(targets.map(async (t) => {
        const resp = await fetch(`/docs/${doc.docName}/${t.name}-lookup.json`).catch(() => null)
        if (!resp?.ok) return { target: t, headings: [] as TocEntry[], pageOffset }
        const data = await resp.json()
        const h = parseHeadings(data.lines, data.meta, { skipAppendixDivider: true })
        // Offset page numbers by pages from previous targets
        for (const entry of h) {
          entry.entry = { ...entry.entry, page: entry.entry.page + pageOffset }
        }
        const result = { target: t, headings: h, pageOffset }
        pageOffset += t.pages
        return result
      })).then(results => {
        const merged: TocEntry[] = []
        for (const r of results) {
          if (r.headings.length > 0 || results.indexOf(r) > 0) {
            // Add target divider (skip for first target if it has no special label)
            const isFirst = results.indexOf(r) === 0
            if (!isFirst) {
              const firstEntry = r.headings[0]?.entry || { page: r.pageOffset + 1, x: 0, y: 0, content: '' }
              merged.push({
                level: 'divider',
                title: r.target.title || r.target.name,
                line: -1,
                entry: firstEntry,
              })
            }
          }
          merged.push(...r.headings)
        }
        setHeadings(merged)
        setCollapsed(computeDefaultFolded(merged))
      })
    } else {
      loadLookup(doc.docName).then(data => {
        if (data) {
          const h = parseHeadings(data.lines, data.meta)
          setHeadings(h)
          setCollapsed(computeDefaultFolded(h))
        } else {
          loadHtmlToc(doc!.docName).then(toc => {
            if (toc) {
              setHtmlToc(toc)
              setCollapsed(computeDefaultFolded(toc))
            }
          })
        }
      })
    }
  }, [doc?.docName, doc?.format, doc?.targets, reloadCount])

  const handleNav = useCallback((entry: LookupEntry) => {
    if (!doc) return
    const pos = pdfToCanvas(entry.page, entry.x, entry.y, doc.pages)
    if (!pos) return
    // Preserve horizontal position — only move vertically
    const vp = editor.getViewportPageBounds()
    editor.centerOnPoint({ x: vp.x + vp.w / 2, y: pos.y }, { animation: { duration: 300 } })
  }, [editor, doc])

  const handleCenterHorizontally = useCallback(() => {
    if (!doc || doc.pages.length === 0) return
    const vp = editor.getViewportPageBounds()
    const vpCenterY = vp.y + vp.h / 2
    // Find which page the viewport center is in
    let pageCenterX = doc.pages[0].bounds.x + doc.pages[0].bounds.width / 2
    for (const page of doc.pages) {
      if (vpCenterY >= page.bounds.y && vpCenterY <= page.bounds.y + page.bounds.height) {
        pageCenterX = page.bounds.x + page.bounds.width / 2
        break
      }
    }
    editor.centerOnPoint({ x: pageCenterX, y: vpCenterY }, { animation: { duration: 300 } })
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
        const shareRes = await fetch(`${window.location.origin}/api/tlda/share`, {
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
        <CameraLinkToggle />
        {/* HideDefsToggle removed */}
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
        <CameraLinkToggle />
        {/* HideDefsToggle removed */}
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
        if (h.level === 'divider') {
          return (
            <div key={i} className="toc-item toc-divider" onClick={h.nav}>
              <span className="toc-divider-label">{h.title}</span>
            </div>
          )
        }
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
      <div className="toc-diff-hint" onClick={handleCenterHorizontally}>
        <span className="toc-toggle-icon">{'\u2299'}</span> Center
      </div>
      <CameraLinkToggle />
      {/* HideDefsToggle removed */}
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

// HideDefsToggle removed — vestigial

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

type ThemeStep = {
  theme: 'warm' | 'fog-dark' | 'fog-light' | null
  scheme: 'system' | 'dark' | 'light'
  label: string
  icon: string
  bodyClass?: string
}

const THEME_STEPS: ThemeStep[] = [
  { theme: null,        scheme: 'dark',   label: 'Dark',      icon: '☾' },
  { theme: 'fog-dark',  scheme: 'dark',   label: 'Fog Dark',  icon: '\u{1F30A}', bodyClass: 'fog-dark-mode' },
  { theme: null,        scheme: 'light',  label: 'Light',     icon: '☀' },
  { theme: null,        scheme: 'system', label: 'System',    icon: '◑' },
  { theme: 'fog-light', scheme: 'light',  label: 'Fog Light', icon: '\u{1F9CA}', bodyClass: 'fog-light-mode' },
  { theme: 'warm',      scheme: 'light',  label: 'Warm',      icon: '☀︎',        bodyClass: 'warm-mode' },
]

const BODY_CLASSES = THEME_STEPS.map(s => s.bodyClass).filter(Boolean) as string[]

export function DarkModeToggle() {
  const editor = useEditor()
  const scheme = useValue('colorScheme', () => editor.user.getUserPreferences().colorScheme || 'system', [editor])
  const [theme, setTheme] = useState<'warm' | 'fog-dark' | 'fog-light' | null>(() => {
    const stored = localStorage.getItem('tlda-theme')
    if (stored === 'warm' || stored === 'fog-dark' || stored === 'fog-light') return stored
    if (localStorage.getItem('tlda-warm-mode') === 'true') return 'warm'
    return null
  })

  const cur = THEME_STEPS.findIndex(s => s.theme === theme && s.scheme === scheme)
  const step = cur >= 0 ? THEME_STEPS[cur] : THEME_STEPS[0]

  const applyStep = useCallback((s: ThemeStep) => {
    for (const cls of BODY_CLASSES) document.body.classList.remove(cls)
    if (s.bodyClass) document.body.classList.add(s.bodyClass)
    localStorage.setItem('tlda-theme', s.theme || '')
    localStorage.setItem('tlda-warm-mode', s.theme === 'warm' ? 'true' : 'false')
    setTheme(s.theme)
    editor.user.updateUserPreferences({ colorScheme: s.scheme })
  }, [editor])

  const cycle = useCallback(() => {
    applyStep(THEME_STEPS[(cur + 1) % THEME_STEPS.length])
  }, [cur, applyStep])

  return (
    <div className="toc-diff-hint" onClick={cycle}>
      <span className="toc-toggle-icon">{step.icon}</span> {step.label}
    </div>
  )
}

const ZONE_WIDTH_KEY = 'zone-width'
const ZONE_WIDTH_EVENT = 'zone-width-change'
const ZONE_WIDTH_DEFAULT = 60
const ZONE_WIDTH_MIN = 20
const ZONE_WIDTH_MAX = 250  // full panel width — at max, no expand animation

export function getZoneWidth(): number {
  const stored = parseInt(localStorage.getItem(ZONE_WIDTH_KEY) || '')
  if (isNaN(stored)) return ZONE_WIDTH_DEFAULT
  return Math.max(ZONE_WIDTH_MIN, Math.min(ZONE_WIDTH_MAX, stored))
}

export function applyZoneWidth(w: number) {
  document.documentElement.style.setProperty('--zone-width', w + 'px')
}

export function ZoneWidthSlider() {
  const [width, setWidth] = useState(getZoneWidth)

  useEffect(() => {
    applyZoneWidth(width)
  }, [])

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // Invert: slider value increases left→right, zone width decreases left→right
    const v = ZONE_WIDTH_MAX + ZONE_WIDTH_MIN - parseInt(e.target.value)
    setWidth(v)
    localStorage.setItem(ZONE_WIDTH_KEY, String(v))
    applyZoneWidth(v)
    window.dispatchEvent(new CustomEvent(ZONE_WIDTH_EVENT, { detail: v }))
  }, [])

  return (
    <div className="toc-zone-width-slider">
      <input type="range" min={ZONE_WIDTH_MIN} max={ZONE_WIDTH_MAX} step="1"
        value={ZONE_WIDTH_MAX + ZONE_WIDTH_MIN - width} onChange={onChange} />
    </div>
  )
}

const FLEET_STATES = ['off', '3col', '2col'] as const
type FleetState = typeof FLEET_STATES[number]
const FLEET_SHAPE_TYPES_TOC = ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview']

function detectFleetState(editor: any): FleetState {
  const fleet = editor.getCurrentPageShapes().filter((s: any) =>
    FLEET_SHAPE_TYPES_TOC.includes(s.type as string))
  if (fleet.length === 0) return 'off'
  return (localStorage.getItem('fleet-layout') as FleetState) || '3col'
}

export function FleetToggle() {
  const editor = useEditor()
  const allAgents = useFleetAgents()
  const [state, setState] = useState<FleetState>(() => detectFleetState(editor))

  const handleClick = useCallback(() => {
    const current = detectFleetState(editor)
    const idx = FLEET_STATES.indexOf(current)
    const next = FLEET_STATES[(idx + 1) % FLEET_STATES.length]
    setState(next)
    localStorage.setItem('fleet-layout', next)
    if (next === 'off') {
      const fleet = editor.getCurrentPageShapes().filter((s: any) =>
        FLEET_SHAPE_TYPES_TOC.includes(s.type as string))
      if (fleet.length > 0) forceDeleteShapes(editor, fleet.map((s: any) => s.id))
      localStorage.setItem('fleet-hud-expanded', '0')
      window.dispatchEvent(new CustomEvent('fleet-hud-reset'))
    } else {
      localStorage.setItem('fleet-hud-expanded', '1')
      createFleetLayout(editor, allAgents, next === '3col' ? '3col' : '2col')
    }
  }, [editor, allAgents])

  // Button shows the NEXT state
  const nextIdx = (FLEET_STATES.indexOf(state) + 1) % FLEET_STATES.length
  const nextState = FLEET_STATES[nextIdx]

  let label: React.ReactNode
  if (nextState === '3col') {
    label = <>Fleet|</>
  } else if (nextState === '2col') {
    label = <>Flee|t</>
  } else {
    // Next: off → strikethrough
    label = <span style={{ textDecoration: 'line-through' }}>Fleet</span>
  }

  return (
    <div className="toc-diff-hint" onClick={handleClick}>
      <img src="/basestar.svg" alt="" style={{ width: 10, height: 10, verticalAlign: 'middle', marginRight: 4, opacity: 0.6, position: 'relative' as const, top: 2 }} /> {label}
    </div>
  )
}
