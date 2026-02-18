import { useState, useEffect, useCallback, useContext } from 'react'
import { useEditor, useValue } from 'tldraw'
import { loadLookup, clearLookupCache, loadHtmlToc, type LookupEntry, type HtmlTocEntry } from '../synctexLookup'
import { pdfToCanvas } from '../synctexAnchor'
import { DocContext, PanelContext } from '../PanelContext'
import { getLiveUrl, onReloadSignal } from '../useYjsSync'
import { navigateTo, navigateToPage, parseHeadings, renderTocTitle, type TocLevel, type TocEntry } from './helpers'

export function TocTab() {
  const editor = useEditor()
  const doc = useContext(DocContext)
  const ctx = useContext(PanelContext)
  const [headings, setHeadings] = useState<TocEntry[]>([])
  const [htmlToc, setHtmlToc] = useState<HtmlTocEntry[] | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number> | null>(null)
  const [reloadCount, setReloadCount] = useState(0)

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
    loadLookup(doc.docName).then(data => {
      if (data) {
        const h = parseHeadings(data.lines, data.meta)
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
        loadHtmlToc(doc!.docName).then(toc => {
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
  }, [doc?.docName, reloadCount])

  const handleNav = useCallback((entry: LookupEntry) => {
    if (!doc) return
    const pos = pdfToCanvas(entry.page, entry.x, entry.y, doc.pages)
    if (!pos) return
    const pageIndex = entry.page - 1
    const page = doc.pages[pageIndex]
    const pageCenterX = page ? page.bounds.x + page.bounds.width / 2 : pos.x
    navigateTo(editor, pos.x, pos.y, pageCenterX)
  }, [editor, doc])

  const handleHtmlNav = useCallback((pageNum: number) => {
    if (!doc) return
    navigateToPage(editor, doc, pageNum)
  }, [editor, doc])

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
      <DarkModeToggle />
    </div>
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
