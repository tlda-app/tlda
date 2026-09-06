import { useState, useEffect, useRef, useCallback, useMemo, useContext, useSyncExternalStore, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useBook } from '../BookContext'
import { useEditor } from 'tldraw'
import type { TLViewportId } from 'tldraw'
import { frameFromHudPresence } from '../wm/fleet-interaction-frame'
import { getHudEditor } from '../wm/editor-host-bridge'
import { FLEET_HUD_VIEWPORT_ID } from '../wm/fleet-hud-layer'
import { loadLookup, clearLookupCache, loadHtmlToc, type LookupEntry, type HtmlTocEntry } from '../synctexLookup'
import { pdfToCanvas } from '../synctexAnchor'
import { ProjectContext, PanelContext } from '../PanelContext'
import { onReloadSignal } from '../useYjsSync'
import { canPresent, subscribeCanPresent } from '../authToken'
import { getVimMode, toggleVimMode, subscribeVimMode } from '../vimMode'
import {
  type ThemeFamily, type ColorScheme,
  getStoredFamily, setStoredFamily, getStoredScheme, setStoredScheme,
  applyThemeClass,
} from '../hooks/useFleetTheme'
import { getCameraLinked, toggleCameraLinked, subscribeCameraLinked } from '../cameraLink'
import { getPlaceStackDepth, subscribePlaceStack, goBackPlace, goForwardPlace } from '../placeStack'
import {
  getLiveSession, subscribeLiveSession, toggleLiveSession, toggleMute, toggleCamera,
  probeLiveSessionConfig,
} from '../livekit/liveSession'
import { FLEET_TOOL_DIMS, placeFleetShapeAtScreenPoint } from '../shapes/fleet-utils'
import { getPref, setPref, subscribePref } from '../preferences'
import { navigateToPage, navigateToAnchor, parseHeadings, renderTocTitle, stripTex, type TocLevel, type TocEntry } from './helpers'
import { normalizeSourceManifest } from '../../shared/source-manifest.mjs'
import { viewFormat } from '../../shared/document-formats.mjs'
import { classroomApi } from '../classroom/api'
import { cacheProjectsForOffline, type OfflineProgress, type OfflineProject } from '../airplaneMode'
import type { AirplaneState } from '../BookContext'

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

/**
 * The Quarto book sidebar: every chapter listed, the chapter you are reading
 * opened, the rest closed. So the ordinary fold, with the active chapter
 * reopened — nothing else about the policy changes.
 */
function computeBookFolded(
  items: Array<{ level: string; targetFile?: string }>,
  activeKey: string | undefined,
): Set<number> {
  const folded = computeDefaultFolded(items)
  if (!activeKey) return folded
  for (let i = 0; i < items.length; i++) {
    if (items[i].level === 'chapter' && items[i].targetFile === activeKey) folded.delete(i)
  }
  return folded
}

/** The small graphical cue on a chapter row. Each comes from a fact we hold. */
type CourseItemType = 'homework' | 'deck'

const COURSE_ITEM_LABEL: Record<CourseItemType, string> = {
  homework: 'Homework',
  deck: 'Slides',
}

const COURSE_ITEM_BADGE: Record<CourseItemType, string> = {
  homework: 'HW',
  deck: 'DECK',
}

const EMPTY_KEYS: ReadonlySet<string> = new Set<string>()

export function TocTab({ query = '' }: { query?: string }) {
  const editor = useEditor()
  const doc = useContext(ProjectContext)
  const ctx = useContext(PanelContext)
  const hasPresenterPrivilege = useSyncExternalStore(subscribeCanPresent, canPresent)
  const [headings, setHeadings] = useState<TocEntry[]>([])
  const [htmlToc, setHtmlToc] = useState<HtmlTocEntry[] | null>(null)
  const [slideTitles, setSlideTitles] = useState<string[] | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number> | null>(null)
  const [reloadCount, setReloadCount] = useState(0)
  const [tocLoaded, setTocLoaded] = useState(false)
  const [localAirplaneState, setLocalAirplaneState] = useState<AirplaneState>('off')
  const [localAirplaneProgress, setLocalAirplaneProgress] = useState<OfflineProgress>({ complete: 0, total: 0 })
  const [localAirplaneError, setLocalAirplaneError] = useState('')
  const compactControls = useSyncExternalStore(subscribePref, () => getPref('toc-controls-compact'))

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
        clearLookupCache(doc.projectName)
        setReloadCount(c => c + 1)
      }
    })
  }, [doc])

  // Which member is being read. The book's table of contents does not change
  // when it changes; which chapter is open does.
  const activeMemberKey = book?.members[book.activeIndex]?.key
  const airplaneState = book?.airplaneState ?? localAirplaneState
  const airplaneProgress = book?.airplaneProgress ?? localAirplaneProgress
  const airplaneError = book?.airplaneError ?? localAirplaneError

  const offlineProjects = useMemo<OfflineProject[]>(() => {
    if (book) return book.members.map(member => ({
      projectName: member.key,
      basePath: member.basePath,
      format: member.renderedFormat || member.format,
      pages: member.pages,
    }))
    if (!doc) return []
    return [{
      projectName: doc.projectName,
      basePath: `/docs/${encodeURIComponent(doc.projectName)}/`,
      format: doc.format,
      pages: doc.pages.length,
      targets: doc.targets,
    }]
  }, [book, doc])

  const toggleAirplaneMode = useCallback(() => {
    if (book) {
      book.toggleAirplaneMode()
      return
    }
    if (airplaneState === 'loading') return
    if (airplaneState === 'ready') {
      setLocalAirplaneState('off')
      return
    }
    setLocalAirplaneState('loading')
    setLocalAirplaneError('')
    void cacheProjectsForOffline(offlineProjects, setLocalAirplaneProgress)
      .then(() => setLocalAirplaneState('ready'))
      .catch(error => {
        setLocalAirplaneError(error instanceof Error ? error.message : String(error))
        setLocalAirplaneState('error')
      })
  }, [book, airplaneState, offlineProjects])

  // Which documents of this course are homework. Asked of the classroom store,
  // which is the only thing that knows: an assignment names the documents it is
  // made of, and a member that is one of them is homework. Nothing infers it
  // from a name or a path.
  const [assignmentDocKeys, setAssignmentDocKeys] = useState<ReadonlySet<string>>(EMPTY_KEYS)
  useEffect(() => {
    if (!book) return
    const courseId = new URLSearchParams(window.location.search).get('course')
    if (!courseId) return
    let cancelled = false
    classroomApi.assignments(courseId)
      .then(({ assignments }) => {
        if (cancelled) return
        const keys = new Set<string>()
        for (const assignment of assignments) {
          for (const key of [assignment.sourceDocKey, assignment.templateDocKey, assignment.solutionsDocKey]) {
            if (key) keys.add(key)
          }
        }
        setAssignmentDocKeys(keys)
      })
      // 401 for a reader with no classroom credential, which is most readers.
      // The book stays a book; the rows simply carry no homework mark.
      .catch(() => { if (!cancelled) setAssignmentDocKeys(EMPTY_KEYS) })
    return () => { cancelled = true }
  }, [book?.bookName])

  const memberItemType = useMemo(() => {
    const types = new Map<string, CourseItemType>()
    for (const member of book?.members ?? []) {
      if (assignmentDocKeys.has(member.key)) types.set(member.key, 'homework')
      else if (viewFormat(member) === 'slides') types.set(member.key, 'deck')
    }
    return types
  }, [book?.members, assignmentDocKeys])

  useEffect(() => {
    // A book's table of contents is the BOOK's, at every chapter.
    //
    // `aggregateBookToc` already writes exactly this file and rebuilds it after
    // every member build: one chapter per member carrying its key as
    // `targetFile`, with that member's own headings demoted underneath. Nothing
    // read it. The panel loaded the TOC of `doc.projectName`, which in a book is
    // whichever chapter happens to be mounted, so a reader got one document's
    // heading list — the project/document hierarchy rather than the course — and
    // saw the other chapters only when the mounted one had no headings at all.
    //
    // Turning a page remounts this panel — `BookViewer` keys the editor on the
    // active member — so this runs again per chapter, and `loadHtmlToc` caches
    // per project, which is what keeps that from being a fetch each time.
    if (!book) return
    let cancelled = false
    setTocLoaded(false)
    setHeadings([])
    setHtmlToc(null)
    setSlideTitles(null)
    setCollapsed(null)
    void (async () => {
      try {
        const toc = await loadHtmlToc(book.bookName)
        if (cancelled || !toc) return
        setHtmlToc(toc)
      } catch (error) {
        console.warn('[toc] book load failed:', error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setTocLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [book?.bookName, reloadCount])

  // The chapter you are in is open and the rest are closed, which is what a
  // book sidebar does. Separate from the load so that recomputing the fold does
  // not go back to `loadHtmlToc`, and so it stays right if the members change
  // under a mounted panel.
  useEffect(() => {
    if (!book || !htmlToc) return
    setCollapsed(computeBookFolded(htmlToc, activeMemberKey))
  }, [book, htmlToc, activeMemberKey])

  useEffect(() => {
    if (book || !doc) return
    let cancelled = false
    setTocLoaded(false)
    setHeadings([])
    setHtmlToc(null)
    setSlideTitles(null)
    setCollapsed(null)
    void (async () => {
      try {
        // Slides format: load TOC from page-info.json
        if (doc.format === 'slides') {
          const response = await fetch(`/docs/${doc.projectName}/page-info.json`)
          const entries = response.ok ? await response.json() as Array<{ title?: string }> : null
          if (!cancelled && entries) setSlideTitles(entries.map(entry => entry.title || ''))
          return
        }

        const targets = doc.targets
        if (targets && targets.length > 1) {
          let pageOffset = 0
          const results = await Promise.all(targets.map(async (target) => {
            const resp = await fetch(`/docs/${doc.projectName}/${target.name}-lookup.json`).catch(() => null)
            if (!resp?.ok) return { target, headings: [] as TocEntry[], pageOffset }
            const data = await resp.json()
            const targetHeadings = parseHeadings(data.lines, data.meta, { skipAppendixDivider: true })
            for (const entry of targetHeadings) {
              entry.entry = { ...entry.entry, page: entry.entry.page + pageOffset }
            }
            const result = { target, headings: targetHeadings, pageOffset }
            pageOffset += target.pages
            return result
          }))
          if (cancelled) return
          const merged: TocEntry[] = []
          for (const result of results) {
            if (results.indexOf(result) > 0) {
              const firstEntry = result.headings[0]?.entry || { page: result.pageOffset + 1, x: 0, y: 0, content: '' }
              merged.push({ level: 'divider', title: result.target.title || result.target.name, line: -1, entry: firstEntry })
            }
            merged.push(...result.headings)
          }
          setHeadings(merged)
          setCollapsed(computeDefaultFolded(merged))
          return
        }

        const data = await loadLookup(doc.projectName)
        if (cancelled) return
        if (data) {
          const parsed = parseHeadings(data.lines, data.meta)
          setHeadings(parsed)
          setCollapsed(computeDefaultFolded(parsed))
          return
        }
        const toc = await loadHtmlToc(doc.projectName)
        if (!cancelled && toc) {
          setHtmlToc(toc)
          setCollapsed(computeDefaultFolded(toc))
        }
      } catch (error) {
        console.warn('[toc] load failed:', error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setTocLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [book, doc?.projectName, doc?.format, doc?.targets, reloadCount])

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

  const handleHtmlNav = useCallback((pageNum: number, anchor?: string, targetFile?: string, variant?: 'slides') => {
    if (!doc) return
    if (targetFile) {
      // Book cross-member navigation: post tlda-navigate, BookViewer handles the switch
      window.postMessage({ type: 'tlda-navigate', targetFile, anchor: anchor || null, variant, shapeId: null }, '*')
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
      // Browser edits enter through the server-owned source-room checkout.
      await fetch(`/api/projects/${slug}/source-room/files`, {
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

  // Slides format: render TOC from page-info.json titles
  if (doc?.format === 'slides' && slideTitles) {
    const normalizedQuery = query.trim().toLowerCase()
    const visibleSlides = slideTitles
      .map((title, i) => ({ title, i }))
      .filter(({ title, i }) => !normalizedQuery || (title || `Slide ${i + 1}`).toLowerCase().includes(normalizedQuery))
    return (
      <div className="doc-panel-content" {...tocDropProps}>
        {visibleSlides.map(({ title, i }) => (
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
        <CameraLinkToggle />
        <JoinVoiceVideoToggle />
        {/* HideDefsToggle removed */}
      </div>
    )
  }

  // Use HTML TOC if no TeX headings
  const tocItems = htmlToc || null
  const useHtml = headings.length === 0 && tocItems !== null

  // Unified render for both TeX and HTML TOC entries
  let items: Array<{ level: TocLevel; title: string; nav: () => void; center: () => void; targetFile?: string }> = useHtml
    ? tocItems!.map(h => ({
        level: h.level,
        // `aggregateBookToc` titles a chapter after its member's own top
        // heading, and falls back to the member's KEY when it has none — a
        // project name, which is the hierarchy this panel is not supposed to
        // show. The book already carries the member's display name, so use it
        // when that fallback fired.
        title: h.level === 'chapter' && h.targetFile && h.title === h.targetFile
          ? (book?.members.find(m => m.key === h.targetFile)?.name || h.title)
          : h.title,
        nav: () => handleHtmlNav(h.page, h.anchor, h.targetFile, h.variant),
        center: () => handleHtmlNav(h.page, h.anchor, h.targetFile, h.variant),
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

  const normalizedQuery = stripTex(query).trim().toLowerCase()
  if (normalizedQuery) {
    items = items.filter(item => stripTex(item.title).toLowerCase().includes(normalizedQuery))
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
    const isCollapsed = !normalizedQuery && (collapsed?.has(i) ?? false)
    const next = items[i + 1]
    const childLevels = Array.isArray(nextLevel) ? nextLevel : [nextLevel]
    const hasChildren = next && childLevels.includes(next.level)
    const isHot = h.level === 'chapter' && h.targetFile != null && h.targetFile === hotKey
    const isCurrent = h.level === 'chapter' && h.targetFile != null && h.targetFile === activeMemberKey
    const itemType = h.level === 'chapter' && h.targetFile ? memberItemType.get(h.targetFile) : undefined
    return (
      <div key={i} className={`toc-item ${h.level}${isCurrent ? ' toc-item-current' : ''}`}>
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
        {itemType && (
          <span
            className={`toc-item-type toc-item-type--${itemType}`}
            title={COURSE_ITEM_LABEL[itemType]}
            aria-label={COURSE_ITEM_LABEL[itemType]}
          >{COURSE_ITEM_BADGE[itemType]}</span>
        )}
        {isHot && <span className="book-tab-hot-dot" title="Active session" />}
      </div>
    )
  }

  return (
    <div className="doc-panel-content" {...tocDropProps}>
      {normalizedQuery && items.length === 0 && (
        <div className="panel-empty">No results</div>
      )}
      {tocLoaded && !normalizedQuery && items.length === 0 && (
        <div className="panel-empty">No headings found</div>
      )}
      {/* TOC */}
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
        if (!normalizedQuery && currentPartIdx >= 0 && collapsed?.has(currentPartIdx)) return null
        if (h.level === 'chapter') {
          currentChapterIdx = i
          currentSectionIdx = -1
          currentSubsectionIdx = -1
          return renderFoldableItem(i, h, ['section', 'subsection', 'subsubsection'])
        }
        if (!normalizedQuery && currentChapterIdx >= 0 && collapsed?.has(currentChapterIdx)) return null
        if (h.level === 'section') {
          currentSectionIdx = i
          currentSubsectionIdx = -1
          return renderFoldableItem(i, h, ['subsection', 'subsubsection'])
        }
        if (!normalizedQuery && currentSectionIdx >= 0 && collapsed?.has(currentSectionIdx)) return null
        if (h.level === 'subsection') {
          currentSubsectionIdx = i
          return renderFoldableItem(i, h, 'subsubsection')
        }
        if (!normalizedQuery && currentSubsectionIdx >= 0 && collapsed?.has(currentSubsectionIdx)) return null
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
        <div className={`toc-state-controls${compactControls ? ' toc-state-controls--compact' : ''}`}>
          <button
            className={`toc-diff-hint toc-state-control${airplaneState === 'ready' ? ' toc-state-control--active' : ''}${airplaneState === 'error' ? ' toc-state-control--error' : ''}`}
            type="button"
            onClick={toggleAirplaneMode}
            disabled={airplaneState === 'loading' || offlineProjects.length === 0}
            title={airplaneError || (airplaneState === 'ready' ? 'Turn Airplane mode off' : 'Cache this project for offline reading')}
            aria-pressed={airplaneState === 'ready'}
          >
            <AirplaneIcon />
            <span className="toc-state-control-label">{airplaneState === 'loading' ? `Caching ${airplaneProgress.complete}/${airplaneProgress.total}` : airplaneState === 'ready' ? 'Ready offline' : airplaneState === 'error' ? 'Offline failed' : 'Airplane mode'}</span>
          </button>
          <CameraLinkToggle />
          <JoinVoiceVideoToggle />
        </div>
        {ctx?.onToggleWholeDocumentDiff && (
          <button
            className={`toc-diff-hint history-compare-btn${ctx.wholeDocumentDiffVisible ? ' active' : ''}`}
            type="button"
            onClick={ctx.onToggleWholeDocumentDiff}
            disabled={ctx.wholeDocumentDiffLoading}
            title={ctx.wholeDocumentDiffError || 'Highlight every change between the current and historical document'}
          >
            {ctx.wholeDocumentDiffLoading ? 'Diffing…' : ctx.wholeDocumentDiffError ? 'Diff failed' : ctx.wholeDocumentDiffVisible ? 'Hide diff' : 'Show diff'}
          </button>
        )}
        <PlaceStackNav />
      </div>
      {/* HideDefsToggle removed */}
    </div>
  )
}

/**
 * Forward and back over documents, at the bottom of the table of contents.
 *
 * Skip, 2026-08-11 04:51 EDT: "I think the plan was to base have these be at
 * the bottom of the table of contents thing---like fwd/back buttons visible
 * when you hover the toc" and "like at the bottom of the toc".
 *
 * Both arrows are always rendered so the row does not change width as you
 * navigate — a control that moves out from under the pointer is worse than a
 * dim one. They disable rather than disappear, which is also what a browser
 * does with its own back and forward.
 */
export function PlaceStackNav() {
  const editor = useEditor()
  const depth = useSyncExternalStore(subscribePlaceStack, getPlaceStackDepth)
  return (
    <>
      <button
        className="toc-diff-hint toc-place-nav"
        type="button"
        disabled={depth.back === 0}
        onClick={() => goBackPlace(editor)}
        title="Back to the previous document"
        aria-label="Back to the previous document"
      >←</button>
      <button
        className="toc-diff-hint toc-place-nav"
        type="button"
        disabled={depth.forward === 0}
        onClick={() => goForwardPlace(editor)}
        title="Forward to the next document"
        aria-label="Forward to the next document"
      >→</button>
    </>
  )
}

export function CameraLinkToggle() {
  const linked = useSyncExternalStore(subscribeCameraLinked, getCameraLinked)
  return (
    <button
      className={`toc-diff-hint toc-state-control${linked ? ' toc-state-control--active' : ''}`}
      type="button"
      onClick={toggleCameraLinked}
      title={linked ? 'Stop sharing your viewport' : 'Share what you are looking at'}
      aria-label={linked ? 'Stop sharing your viewport' : 'Share what you are looking at'}
      aria-pressed={linked}
    >
      <GlassesIcon />
      <span className="toc-state-control-label">{linked ? 'Cameras linked' : 'Link cameras'}</span>
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
    }, {
      // A press on the TOC's video button. The panel is chrome, not a projected
      // canvas viewport, so the point is in the main editor's screen space.
      frame: frameFromHudPresence(editor, FLEET_HUD_VIEWPORT_ID as TLViewportId, !!getHudEditor()),
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
          className="toc-diff-hint toc-state-control"
          type="button"
          onClick={toggleLiveSession}
          title="Join the live voice room for this paper"
          aria-label="Join the live voice room for this paper"
        >
          <WhisperIcon />
          <span className="toc-state-control-label">Voice unavailable</span>
        </button>
        <button
          className="toc-diff-hint toc-state-control"
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
          <span className="toc-state-control-label">Video unavailable</span>
        </button>
      </>
    )
  }

  return (
    <>
      <button
        className={`toc-diff-hint toc-state-control${s.intent && !s.muteIntent ? ' toc-state-control--active' : ''}`}
        type="button"
        onClick={s.intent ? toggleMute : toggleLiveSession}
        title={!s.intent ? 'Join the live voice room' : s.micOn ? 'Mute your voice' : 'Unmute your voice'}
        aria-label={!s.intent ? 'Join the live voice room' : s.micOn ? 'Mute your voice' : 'Unmute your voice'}
        aria-pressed={s.intent && !s.muteIntent}
      >
        <WhisperIcon />
        <span className="toc-state-control-label">{s.intent && !s.muteIntent ? 'Voice on' : 'Voice off'}</span>
      </button>
      <button
        className={`toc-diff-hint toc-state-control${s.cameraIntent || s.cameraOn ? ' toc-state-control--active' : ''}`}
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
        aria-pressed={s.cameraIntent || s.cameraOn}
      >
        <VideoCameraIcon />
        <span className="toc-state-control-label">{s.cameraIntent || s.cameraOn ? 'Video on' : 'Video off'}</span>
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

function AirplaneIcon() {
  return (
    <span className="toc-live-glyph-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="m2 16 8-4V5.5a2 2 0 0 1 4 0V12l8 4v2l-8-2.5V20l2 1.5V23l-4-1-4 1v-1.5l2-1.5v-4.5L2 18z" />
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

const SCHEME_STEPS: { value: ColorScheme; icon: string; label: string }[] = [
  { value: 'dark',   icon: '☾', label: 'Dark' },
  { value: 'light',  icon: '☀', label: 'Light' },
  { value: 'system', icon: '◑', label: 'System' },
]

const FAMILY_STEPS: { value: ThemeFamily; icon: string; label: string }[] = [
  // "One", not "Default" — Skip, 2026-08-12 17:29:07 EDT: "can we just, like,
  // stop calling this fucking thing the default theme? Like, I have said, call
  // it fucking one, like, about a thousand times". The stored family is still
  // `null`; only the label changed.
  { value: null,   icon: '○',      label: 'One' },
  { value: 'fog',  icon: '\u{1F30A}', label: 'Fog' },
  { value: 'lilac', icon: '◌',      label: 'Lilac' },
  { value: 'warm', icon: '☀︎',     label: 'Warm' },
  { value: 'power', icon: '◆',     label: 'Power Company' },
  { value: 'mono', icon: '◐',      label: 'Mono' },
  { value: 'blue', icon: '●',      label: 'Blue' },
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

const ZONE_WIDTH_EVENT = 'zone-width-change'
export const ZONE_WIDTH_MIN = 20
export const ZONE_WIDTH_MAX = 250  // full panel width — at max, no expand animation
// Skip, 2026-08-26: "pref default should be like 50 btw", because "i'm like,
// seeing jose constantly open the thing. things are calibrated too much for
// massive monitors" -- "since that's my usual". Watching someone else use it on
// a normal screen is the evidence; a region wide enough to be unmissable on his
// display is wide enough to be opened by accident on anyone else's.
//
// This reverses his own earlier call, and that one is kept here rather than
// deleted so nobody reads the change as a lost setting: 2026-08-18, "make th
// eTOC hover region as wide as possile" / "shit as visible as possible", for a
// first-time reader on someone else's machine. The width was the whole panel
// then. Same goal, better information about whose screen it lands on.
//
// The value that actually reaches a reader is the pref default in
// preferences.ts, because getPref falls back to it rather than reporting the
// pref unset. This constant is the clamp target and the non-finite fallback;
// the two must agree. MIN and MAX are unchanged -- the slider still reaches the
// full panel for anyone who wants it.
export const ZONE_WIDTH_DEFAULT = 50

export function normalizeZoneWidth(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return ZONE_WIDTH_DEFAULT
  return Math.round(Math.max(ZONE_WIDTH_MIN, Math.min(ZONE_WIDTH_MAX, parsed)))
}

export function getZoneWidth(): number {
  // The pref is the value. This used to ask `normalizeZoneWidth(pref) !==
  // ZONE_WIDTH_DEFAULT` and fall back to a `zone-width` localStorage key, which
  // could not tell "no pref set" from "pref set to exactly the default" — getPref
  // never reports unset, it returns the default. So a reader carrying the old
  // 60 in localStorage would have kept it no matter what the default became.
  // The legacy key is gone rather than reconciled; the slider writes the pref.
  return normalizeZoneWidth(getPref('toc-hover-zone-width'))
}

export function applyZoneWidth(w: number) {
  document.documentElement.style.setProperty('--zone-width', w + 'px')
}

export function setZoneWidthPref(next: number) {
  const v = normalizeZoneWidth(next)
  setPref('toc-hover-zone-width', v)
  applyZoneWidth(v)
  window.dispatchEvent(new CustomEvent(ZONE_WIDTH_EVENT, { detail: v }))
}

export function ZoneWidthThumbControl({ className }: { className: string }) {
  const [width, setWidth] = useState(getZoneWidth)
  const [dragging, setDragging] = useState(false)
  const railRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(width)

  widthRef.current = width

  useEffect(() => {
    applyZoneWidth(width)
  }, [])

  useEffect(() => subscribePref(() => {
    const next = getZoneWidth()
    widthRef.current = next
    setWidth(next)
    applyZoneWidth(next)
  }), [])

  const setZoneWidth = useCallback((next: number) => {
    const v = Math.round(Math.max(ZONE_WIDTH_MIN, Math.min(ZONE_WIDTH_MAX, next)))
    if (v === widthRef.current) return
    widthRef.current = v
    setWidth(v)
    setZoneWidthPref(v)
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
    <div className={className} ref={railRef} aria-hidden="true">
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
