import { useState, useEffect, useRef, useCallback, useMemo, useContext, useSyncExternalStore, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useBook } from '../BookContext'
import { useEditor } from 'tldraw'
import type { TLShape } from 'tldraw'
import { loadLookup, clearLookupCache, loadHtmlSearch, loadHtmlToc, type LookupEntry, type HtmlTocEntry, type HtmlSearchEntry } from '../synctexLookup'
import { pdfToCanvas } from '../synctexAnchor'
import { DocContext, PanelContext } from '../PanelContext'
import { getLiveUrl, onReloadSignal } from '../useYjsSync'
import { canPresent, subscribeCanPresent } from '../authToken'
import { getVimMode, toggleVimMode, subscribeVimMode } from '../vimMode'
import {
  type ThemeFamily, type ColorScheme,
  getStoredFamily, setStoredFamily, getStoredScheme, setStoredScheme,
  applyThemeClass,
} from '../hooks/useFleetTheme'
import { getCameraLinked, toggleCameraLinked, subscribeCameraLinked } from '../cameraLink'
import {
  getLiveSession, subscribeLiveSession, toggleLiveSession, toggleMute, toggleCamera,
  probeLiveSessionConfig,
} from '../livekit/liveSession'
import { FLEET_TOOL_DIMS, placeFleetShapeAtScreenPoint } from '../shapes/fleet-utils'
import { getSemanticHighlight, toggleSemanticHighlight, subscribeSemanticHighlight } from '../semanticHighlight'
import { navigateTo, navigateToPage, navigateToAnchor, parseHeadings, renderTocTitle, stripTex, getShapeText, type TocLevel, type TocEntry } from './helpers'
import { normalizeSourceManifest } from '../../shared/source-manifest.mjs'

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

  const handleCenterEntry = useCallback((entry: LookupEntry) => {
    if (!doc) return
    const pos = pdfToCanvas(entry.page, entry.x, entry.y, doc.pages)
    if (!pos) return
    const page = doc.pages[entry.page - 1]
    const pageCenterX = page ? page.bounds.x + page.bounds.width / 2 : pos.x
    editor.centerOnPoint({ x: pageCenterX, y: pos.y }, { animation: { duration: 300 } })
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
      const files = [{ path: 'content.md', content: contentB64, encoding: 'base64' }]
      await fetch(`/api/projects/${slug}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files,
          sourceManifest: normalizeSourceManifest(files.map(file => file.path), { format: 'markdown', mainFile: 'content.md' }),
        }),
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
    if (!types?.includes('text/plain')) return
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

    // Parse drop payload from a canvas chapter-note.
    let item: Record<string, any> | null = null
    const plain = e.dataTransfer?.getData('text/plain')
    if (plain) try {
      const p = JSON.parse(plain)
      if (p._tlda) item = p
    } catch {}
    if (!item) return

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
    if (doc.format === 'slides') {
      setSearchLines(null)
      setHtmlSearchIndex(null)
      return
    }
    loadLookup(doc.docName).then(data => {
      if (data) {
        setSearchLines(data.lines)
      } else {
        loadHtmlSearch(doc.docName).then(index => {
          if (index) setHtmlSearchIndex(index)
        })
      }
    })
  }, [doc?.docName, doc?.format, reloadCount])

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
        <JoinVoiceVideoToggle />
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
        <JoinVoiceVideoToggle />
        {/* HideDefsToggle removed */}
      </div>
    )
  }

  const liveUrl = getLiveUrl()

  // Unified render for both TeX and HTML TOC entries
  let items: Array<{ level: TocLevel; title: string; nav: () => void; center: () => void; targetFile?: string }> = useHtml
    ? tocItems!.map(h => ({
        level: h.level,
        title: h.title,
        nav: () => handleHtmlNav(h.page, h.anchor, h.targetFile),
        center: () => handleHtmlNav(h.page, h.anchor, h.targetFile),
        targetFile: h.targetFile,
      }))
    : headings.map(h => ({
        level: h.level,
        title: renderTocTitle(h.title),
        nav: () => handleNav(h.entry),
        center: () => handleCenterEntry(h.entry),
      }))

  // Book: if no TOC from active member, show book members as chapters
  if (items.length === 0 && book) {
    items = book.members.map((m, i) => ({
      level: 'chapter' as TocLevel,
      title: m.name || m.key,
      nav: () => book.switchTo(i),
      center: () => book.switchTo(i),
      targetFile: m.key,
    }))
  }

  // Build visibility: children hidden if their parent is collapsed
  let currentPartIdx = -1
  let currentChapterIdx = -1
  let currentSectionIdx = -1
  let currentSubsectionIdx = -1

  function renderCenterButton(h: { title: string; center: () => void }) {
    return (
      <button
        className="toc-row-center"
        type="button"
        onClick={() => { h.center() }}
        title="Center this heading"
        aria-label="Center this heading"
      >
        <span aria-hidden="true">{'\u2299'}</span>
      </button>
    )
  }

  function renderFoldableItem(i: number, h: { level: TocLevel; title: string; nav: () => void; center: () => void; targetFile?: string }, nextLevel: TocLevel | TocLevel[]) {
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
        {renderCenterButton(h)}
        <span className="toc-title" onClick={h.nav} dangerouslySetInnerHTML={{ __html: h.title }} />
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
          <div key={i} className="toc-item subsubsection">
            <span className="toc-fold-spacer" />
            {renderCenterButton(h)}
            <span className="toc-title" onClick={h.nav} dangerouslySetInnerHTML={{ __html: h.title }} />
          </div>
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
      <div className="toc-bottom-controls">
        <CameraLinkToggle />
        <JoinVoiceVideoToggle />
      </div>
      {/* HideDefsToggle removed */}
    </div>
    </>
  )
}

export function CameraLinkToggle() {
  const linked = useSyncExternalStore(subscribeCameraLinked, getCameraLinked)
  return (
    <button
      className={`toc-diff-hint toc-live-glyph${linked ? ' toc-live-glyph--active' : ''}`}
      type="button"
      onClick={toggleCameraLinked}
      title={linked ? 'Stop sharing your viewport' : 'Share what you are looking at'}
      aria-label={linked ? 'Stop sharing your viewport' : 'Share what you are looking at'}
    >
      <GlassesIcon />
    </button>
  )
}

export function JoinVoiceVideoToggle() {
  const editor = useEditor()
  const s = useSyncExternalStore(subscribeLiveSession, getLiveSession)
  const dragStartRef = useRef<{ x: number; y: number; summoned: boolean } | null>(null)
  const suppressVideoClickRef = useRef(false)
  useEffect(() => { void probeLiveSessionConfig() }, [])

  const summonVideoContainer = useCallback(async (clientX: number, clientY: number) => {
    const dims = FLEET_TOOL_DIMS['fleet-video']
    await placeFleetShapeAtScreenPoint(editor, 'fleet-video', clientX, clientY, dims.w, dims.h, {
      tileKeys: '[]',
    })
  }, [editor])

  const onVideoPointerDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const start = { x: e.clientX, y: e.clientY, summoned: false }
    dragStartRef.current = start
    const pointerId = e.pointerId
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || start.summoned) return
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 10) return
      start.summoned = true
      suppressVideoClickRef.current = true
      window.setTimeout(() => { suppressVideoClickRef.current = false }, 500)
      void summonVideoContainer(event.clientX, event.clientY)
    }
    const onEnd = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onEnd, true)
      window.removeEventListener('pointercancel', onEnd, true)
      dragStartRef.current = null
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onEnd, true)
    window.addEventListener('pointercancel', onEnd, true)
  }, [summonVideoContainer])

  const onVideoPointerMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const start = dragStartRef.current
    if (!start || start.summoned) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10) return
    start.summoned = true
    suppressVideoClickRef.current = true
    window.setTimeout(() => { suppressVideoClickRef.current = false }, 500)
    void summonVideoContainer(e.clientX, e.clientY)
  }, [summonVideoContainer])

  const clearVideoDrag = useCallback((e?: ReactPointerEvent<HTMLButtonElement>) => {
    if (e?.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragStartRef.current = null
  }, [])

  // Server has no LiveKit creds: visible but inert, clearly not configured.
  if (s.configured === false) {
    return (
      <>
        <button
          className="toc-diff-hint toc-live-glyph"
          type="button"
          onClick={toggleLiveSession}
          title="Join the live voice room for this paper"
          aria-label="Join the live voice room for this paper"
        >
          <WhisperIcon />
        </button>
        <button
          className="toc-diff-hint toc-live-glyph"
          type="button"
          style={{ cursor: 'default' }}
          onPointerDown={onVideoPointerDown}
          onPointerMove={onVideoPointerMove}
          onPointerUp={clearVideoDrag}
          onPointerCancel={clearVideoDrag}
          title="Video chat is not configured on this server; drag to place video"
          aria-label="Video chat is not configured on this server; drag to place video"
        >
          <VideoCameraIcon />
        </button>
      </>
    )
  }

  return (
    <>
      <button
        className={`toc-diff-hint toc-live-glyph${s.intent && !s.muteIntent ? ' toc-live-glyph--active' : ''}`}
        type="button"
        onClick={s.intent ? toggleMute : toggleLiveSession}
        title={!s.intent ? 'Join the live voice room' : s.micOn ? 'Mute your voice' : 'Unmute your voice'}
        aria-label={!s.intent ? 'Join the live voice room' : s.micOn ? 'Mute your voice' : 'Unmute your voice'}
      >
        <WhisperIcon />
      </button>
      <button
        className={`toc-diff-hint toc-live-glyph${s.cameraIntent || s.cameraOn ? ' toc-live-glyph--active' : ''}`}
        type="button"
        onClick={() => {
          if (suppressVideoClickRef.current) {
            suppressVideoClickRef.current = false
            return
          }
          if (!s.intent) toggleLiveSession()
          toggleCamera()
        }}
        onPointerDown={onVideoPointerDown}
        onPointerMove={onVideoPointerMove}
        onPointerUp={clearVideoDrag}
        onPointerCancel={clearVideoDrag}
        title={s.cameraIntent || s.cameraOn ? 'Turn camera off; drag to place video' : 'Turn camera on; drag to place video'}
        aria-label={s.cameraIntent || s.cameraOn ? 'Turn camera off; drag to place video' : 'Turn camera on; drag to place video'}
      >
        <VideoCameraIcon />
      </button>
    </>
  )
}

function GlassesIcon() {
  return (
    <span className="toc-live-glyph-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="14" r="4" />
        <circle cx="16" cy="14" r="4" />
        <path d="M12 14h0" />
        <path d="M4.2 13.1 3 9.5" />
        <path d="m19.8 13.1 1.2-3.6" />
      </svg>
    </span>
  )
}

function WhisperIcon() {
  return (
    <span className="toc-live-glyph-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.4 15.5c1.8 0 3.1-1.4 3.1-3.2V8.8a3.1 3.1 0 0 0-6.2 0v3.5" />
        <path d="M5.3 12.3c0 3 2.1 5.2 5 5.2" />
        <path d="M10.3 17.5v2.4" />
        <path d="M7.8 20h5" />
        <path d="M15.2 8.4c1.2.8 1.9 2 1.9 3.6s-.7 2.8-1.9 3.6" />
        <path d="M18 6.2c1.8 1.4 2.8 3.4 2.8 5.8s-1 4.4-2.8 5.8" />
      </svg>
    </span>
  )
}

function VideoCameraIcon() {
  return (
    <span className="toc-live-glyph-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="7" width="11" height="10" rx="2.2" />
        <path d="m15 10 5-2.7v9.4L15 14" />
        <circle cx="9.5" cy="12" r="1.8" />
      </svg>
    </span>
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

const SCHEME_STEPS: { value: ColorScheme; icon: string; label: string }[] = [
  { value: 'dark',   icon: '☾', label: 'Dark' },
  { value: 'light',  icon: '☀', label: 'Light' },
  { value: 'system', icon: '◑', label: 'System' },
]

const FAMILY_STEPS: { value: ThemeFamily; icon: string; label: string }[] = [
  { value: null,   icon: '○',      label: 'Default' },
  { value: 'fog',  icon: '\u{1F30A}', label: 'Fog' },
  { value: 'warm', icon: '☀︎',     label: 'Warm' },
]

export function SchemeToggle() {
  const editor = useEditor()
  const [scheme, setSchemeState] = useState<ColorScheme>(getStoredScheme)

  const cur = Math.max(0, SCHEME_STEPS.findIndex(s => s.value === scheme))
  const step = SCHEME_STEPS[cur]

  const cycle = useCallback(() => {
    const next = SCHEME_STEPS[(cur + 1) % SCHEME_STEPS.length]
    setStoredScheme(next.value)
    setSchemeState(next.value)
    applyThemeClass(getStoredFamily(), next.value)
    editor.user.updateUserPreferences({ colorScheme: next.value })
  }, [cur, editor])

  return (
    <div className="toc-diff-hint" onClick={cycle}>
      <span className="toc-toggle-icon">{step.icon}</span> {step.label}
    </div>
  )
}

export function ThemeFamilyToggle() {
  const [family, setFamilyState] = useState<ThemeFamily>(getStoredFamily)

  const cur = Math.max(0, FAMILY_STEPS.findIndex(s => s.value === family))
  const step = FAMILY_STEPS[cur]

  const cycle = useCallback(() => {
    const next = FAMILY_STEPS[(cur + 1) % FAMILY_STEPS.length]
    setStoredFamily(next.value)
    setFamilyState(next.value)
    applyThemeClass(next.value, getStoredScheme())
  }, [cur])

  return (
    <div className="toc-diff-hint" onClick={cycle}>
      <span className="toc-toggle-icon">{step.icon}</span> {step.label}
    </div>
  )
}

/** @deprecated Use SchemeToggle + ThemeFamilyToggle */
export function DarkModeToggle() {
  return null
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
  const [dragging, setDragging] = useState(false)
  const railRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(width)

  widthRef.current = width

  useEffect(() => {
    applyZoneWidth(width)
  }, [])

  const setZoneWidth = useCallback((next: number) => {
    const v = Math.round(Math.max(ZONE_WIDTH_MIN, Math.min(ZONE_WIDTH_MAX, next)))
    if (v === widthRef.current) return
    widthRef.current = v
    setWidth(v)
    localStorage.setItem(ZONE_WIDTH_KEY, String(v))
    applyZoneWidth(v)
    window.dispatchEvent(new CustomEvent(ZONE_WIDTH_EVENT, { detail: v }))
  }, [])

  const updateFromClientX = useCallback((clientX: number) => {
    const rect = railRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    setZoneWidth(ZONE_WIDTH_MAX - pct * (ZONE_WIDTH_MAX - ZONE_WIDTH_MIN))
  }, [setZoneWidth])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    setDragging(true)
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    e.stopPropagation()
    e.preventDefault()
    updateFromClientX(e.clientX)
  }, [dragging, updateFromClientX])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    setDragging(false)
    ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
  }, [])

  const thumbLeft = `${((ZONE_WIDTH_MAX - width) / (ZONE_WIDTH_MAX - ZONE_WIDTH_MIN)) * 100}%`

  return (
    <div className="toc-zone-width-slider" ref={railRef} aria-hidden="true">
      <div
        className={`toc-zone-width-thumb${dragging ? ' dragging' : ''}`}
        style={{ left: thumbLeft }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  )
}
