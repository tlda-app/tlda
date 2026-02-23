import { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react'
import { useEditor } from 'tldraw'
import type { TLShape } from 'tldraw'
import { loadLookup, loadHtmlSearch, type LookupEntry, type HtmlSearchEntry } from '../synctexLookup'
import { pdfToCanvas } from '../synctexAnchor'
import { DocContext } from '../PanelContext'
import { navigateTo, navigateToPage, stripTex, getShapeText } from './helpers'
import { setSearchFilter } from '../stores'

export function SearchTab() {
  const editor = useEditor()
  const ctx = useContext(DocContext)
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

  // Push matching note IDs to canvas visibility filter
  useEffect(() => {
    if (!debouncedQuery || noteResults.length === 0) {
      setSearchFilter(null)
      return
    }
    setSearchFilter(new Set(noteResults.map(r => r.shape.id)))
    return () => setSearchFilter(null)
  }, [debouncedQuery, noteResults])

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
