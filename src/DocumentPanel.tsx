import { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react'
import { useEditor } from 'tldraw'
import type { Editor, TLShape } from 'tldraw'
import katex from 'katex'
import { getActiveMacros } from './katexMacros'
import { loadLookup, type LookupEntry } from './synctexLookup'
import { pdfToCanvas } from './synctexAnchor'
import { PanelContext } from './PanelContext'
import { getYRecords } from './useYjsSync'
import './DocumentPanel.css'

// --- Navigation helper ---

function navigateTo(editor: Editor, canvasX: number, canvasY: number) {
  editor.centerOnPoint({ x: canvasX, y: canvasY }, { animation: { duration: 300 } })
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

function TocTab() {
  const editor = useEditor()
  const ctx = useContext(PanelContext)
  const [headings, setHeadings] = useState<TocEntry[]>([])
  const [collapsed, setCollapsed] = useState<Set<number> | null>(null)

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
      }
    })
  }, [ctx?.docName])

  const handleNav = useCallback((entry: LookupEntry) => {
    if (!ctx) return
    const pos = pdfToCanvas(entry.page, entry.x, entry.y, ctx.pages)
    if (pos) navigateTo(editor, pos.x, pos.y)
  }, [editor, ctx])

  const toggleSection = useCallback((idx: number) => {
    setCollapsed(prev => {
      const next = new Set(prev ?? [])
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  if (headings.length === 0) {
    return <div className="panel-empty">No headings found</div>
  }

  // Build visibility: children hidden if their parent is collapsed
  let currentSectionIdx = -1
  let currentSubsectionIdx = -1
  return (
    <div className="doc-panel-content">
      {headings.map((h, i) => {
        if (h.level === 'section') {
          currentSectionIdx = i
          currentSubsectionIdx = -1
          const isCollapsed = collapsed?.has(i) ?? false
          const next = headings[i + 1]
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
              <span onClick={() => handleNav(h.entry)} dangerouslySetInnerHTML={{ __html: renderTocTitle(h.title) }} />
            </div>
          )
        }
        // Hidden if parent section is collapsed
        if (collapsed?.has(currentSectionIdx)) return null
        if (h.level === 'subsection') {
          currentSubsectionIdx = i
          const isCollapsed = collapsed?.has(i) ?? false
          const next = headings[i + 1]
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
              <span onClick={() => handleNav(h.entry)} dangerouslySetInnerHTML={{ __html: renderTocTitle(h.title) }} />
            </div>
          )
        }
        // subsubsection: hidden if parent subsection is collapsed
        if (collapsed?.has(currentSubsectionIdx)) return null
        return (
          <div key={i} className="toc-item subsubsection" onClick={() => handleNav(h.entry)}
            dangerouslySetInnerHTML={{ __html: renderTocTitle(h.title) }} />
        )
      })}
    </div>
  )
}

function SearchTab() {
  const editor = useEditor()
  const ctx = useContext(PanelContext)
  const [query, setQuery] = useState('')
  const [lookupLines, setLookupLines] = useState<Record<string, LookupEntry> | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    if (!ctx) return
    loadLookup(ctx.docName).then(data => {
      if (data) setLookupLines(data.lines)
    })
  }, [ctx?.docName])

  // Debounce
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setDebouncedQuery(query), 300)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [query])

  const docResults = useMemo(() => {
    if (!debouncedQuery || !lookupLines) return []
    const q = debouncedQuery.toLowerCase()
    const results: Array<{ line: string; entry: LookupEntry }> = []
    for (const [line, entry] of Object.entries(lookupLines)) {
      if (entry.content.toLowerCase().includes(q)) {
        results.push({ line, entry })
        if (results.length >= 50) break
      }
    }
    return results
  }, [debouncedQuery, lookupLines])

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
    if (pos) navigateTo(editor, pos.x, pos.y)
  }, [editor, ctx])

  const handleNoteClick = useCallback((shape: TLShape) => {
    navigateTo(editor, shape.x, shape.y)
  }, [editor])

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
            {docResults.map((r, i) => (
              <div key={`d-${i}`} className="search-result" onClick={() => handleDocClick(r.entry)}>
                <span className="line-num">L{r.line}</span>
                {stripTex(r.entry.content).slice(0, 80)}
              </div>
            ))}
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

      // Capture viewport screenshot and POST to MCP server
      try {
        const viewportBounds = editor.getViewportPageBounds()
        const { blob } = await editor.toImage([], {
          bounds: viewportBounds,
          background: true,
          scale: 1,
          pixelRatio: 1,
        })
        const mcpHost = window.location.hostname || 'localhost'
        await fetch(`http://${mcpHost}:5174/viewport-screenshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
          body: blob,
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

  return (
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
    </button>
  )
}

// ======================
// Main panel
// ======================

type Tab = 'toc' | 'search' | 'notes'

// Stop pointer events from reaching tldraw's canvas event handlers
function stopTldrawEvents(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}

const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

export function DocumentPanel() {
  const [tab, setTab] = useState<Tab>('toc')
  return (
    <>
      <div
        className={`doc-panel ${isTouch ? 'panel-open' : ''}`}
        onPointerDown={stopTldrawEvents}
        onPointerUp={stopTldrawEvents}
        onTouchStart={stopTldrawEvents}
        onTouchEnd={stopTldrawEvents}
      >
        <div className="doc-panel-tabs">
          <button className={`doc-panel-tab ${tab === 'toc' ? 'active' : ''}`} onClick={() => setTab('toc')}>
            TOC
          </button>
          <button className={`doc-panel-tab ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>
            Search
          </button>
          <button className={`doc-panel-tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
            Notes
          </button>
        </div>
        {tab === 'toc' && <TocTab />}
        {tab === 'search' && <SearchTab />}
        {tab === 'notes' && <NotesTab />}
      </div>
    </>
  )
}
