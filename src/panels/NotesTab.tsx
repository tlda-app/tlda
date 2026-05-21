import { useState, useEffect, useCallback, useMemo } from 'react'
import { useEditor } from 'tldraw'
import type { TLShape, TLPageId } from 'tldraw'
import { navigateTo, getShapeText, COLOR_HEX } from './helpers'
// noteThreading removed — no tabs
import { useBook } from '../BookContext'

type SortField = 'position' | 'recency'
type SortDir = 'asc' | 'desc'

/** Shape-like data from REST API for remote notes */
interface RemoteNote {
  id: string
  type: string
  x: number
  y: number
  props: Record<string, unknown>
  meta: Record<string, unknown>
  parentId?: string
  docKey: string   // which member doc this came from
  docName: string  // display name
}

function isDone(shape: TLShape): boolean {
  return (shape.props as Record<string, unknown>).done === true
}

function isPendingMC(shape: TLShape): boolean {
  const props = shape.props as Record<string, unknown>
  const choices = props.choices as string[] | undefined
  if (!choices || choices.length === 0) return false
  const sel = props.selectedChoice as number | undefined
  return sel == null || sel < 0
}

/** Get all note shapes across all TLDraw pages */
function getAllNotes(editor: ReturnType<typeof useEditor>): TLShape[] {
  const allRecords = Object.values(editor.store.allRecords())
  return allRecords.filter(
    (r: any) => r.typeName === 'shape' && ((r.type as string) === 'math-note' || r.type === 'note')
  ) as TLShape[]
}

export function NotesTab() {
  const editor = useEditor()
  const book = useBook()
  const [notes, setNotes] = useState<TLShape[]>([])
  const [remoteNotes, setRemoteNotes] = useState<RemoteNote[]>([])
  const [sortField, setSortField] = useState<SortField>('position')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [hideDone, setHideDone] = useState(false)

  const toggleSort = useCallback((field: SortField) => {
    setSortField(prev => {
      if (prev === field) {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc')
        return prev
      }
      setSortDir(field === 'recency' ? 'desc' : 'asc')
      return field
    })
  }, [])

  // Local notes from current editor
  useEffect(() => {
    function updateNotes() {
      setNotes(getAllNotes(editor))
    }

    updateNotes()
    const unsub1 = editor.store.listen(updateNotes, { scope: 'document', source: 'user' })
    const unsub2 = editor.store.listen(updateNotes, { scope: 'document', source: 'remote' })
    return () => { unsub1(); unsub2() }
  }, [editor])

  // Remote notes from other book members
  useEffect(() => {
    if (!book) return

    const activeKey = book.members[book.activeIndex]?.key
    const otherMembers = book.members.filter(m => m.key !== activeKey)
    if (otherMembers.length === 0) return

    let cancelled = false

    async function fetchRemoteNotes() {
      const allRemote: RemoteNote[] = []
      await Promise.all(otherMembers.map(async (member) => {
        try {
          const resp = await fetch(`/api/projects/${member.key}/shapes?type=math-note`)
          if (!resp.ok) return
          const shapes = await resp.json()
          for (const s of shapes) {
            allRemote.push({ ...s, docKey: member.key, docName: member.name })
          }
        } catch { /* ignore fetch errors */ }
      }))
      if (!cancelled) setRemoteNotes(allRemote)
    }

    fetchRemoteNotes()
    // Poll every 15s
    const timer = setInterval(fetchRemoteNotes, 15000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [book?.activeIndex, book?.members])

  const pageOrder = useMemo(() => {
    const map = new Map<string, number>()
    editor.getPages().forEach((p, i) => map.set(p.id, i))
    return map
  }, [editor, notes])

  const pageHeights = useMemo(() => {
    const map = new Map<string, { minY: number; maxY: number }>()
    const allShapes = editor.store.allRecords().filter((r: any) => r.typeName === 'shape') as TLShape[]
    for (const s of allShapes) {
      const pageId = s.parentId
      const h = (s.props as any)?.h || 100
      const bottom = s.y + h
      const existing = map.get(pageId)
      if (!existing) {
        map.set(pageId, { minY: s.y, maxY: bottom })
      } else {
        if (s.y < existing.minY) existing.minY = s.y
        if (bottom > existing.maxY) existing.maxY = bottom
      }
    }
    return map
  }, [editor, notes])

  const getPagePosition = useCallback((shape: TLShape): string => {
    const pageIdx = (pageOrder.get(shape.parentId) ?? 0) + 1
    const bounds = pageHeights.get(shape.parentId)
    if (!bounds || bounds.maxY === bounds.minY) return `${pageIdx}`
    const frac = Math.max(0, Math.min(1, (shape.y - bounds.minY) / (bounds.maxY - bounds.minY)))
    const decimal = Math.round(frac * 10)
    return `${pageIdx}.${decimal}`
  }, [pageOrder, pageHeights])

  const { pendingItems, restItems } = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const sortFn = (a: TLShape, b: TLShape) => {
      if (sortField === 'recency') {
        const aTime = (a.meta as Record<string, unknown>)?.createdAt as number || 0
        const bTime = (b.meta as Record<string, unknown>)?.createdAt as number || 0
        return (aTime - bTime) * dir
      }
      const aPage = pageOrder.get(a.parentId) ?? 0
      const bPage = pageOrder.get(b.parentId) ?? 0
      if (aPage !== bPage) return (aPage - bPage) * dir
      return (a.y - b.y) * dir
    }

    const pending: TLShape[] = []
    const rest: TLShape[] = []

    for (const shape of notes) {
      if (hideDone && isDone(shape)) continue
      if (isPendingMC(shape)) {
        pending.push(shape)
      } else {
        rest.push(shape)
      }
    }

    pending.sort(sortFn)
    rest.sort(sortFn)

    return { pendingItems: pending, restItems: rest }
  }, [notes, sortField, sortDir, hideDone, pageOrder])

  const handleClick = useCallback((shape: TLShape) => {
    // Switch to the note's TLDraw page if it's on a different one
    const shapePageId = shape.parentId as TLPageId
    if (shapePageId && shapePageId !== editor.getCurrentPageId()) {
      const pages = editor.getPages()
      if (pages.some(p => p.id === shapePageId)) {
        editor.setCurrentPage(shapePageId)
      }
    }
    navigateTo(editor, shape.x, shape.y)
  }, [editor])

  const handleRemoteClick = useCallback((note: RemoteNote) => {
    if (!book) return
    const idx = book.members.findIndex(m => m.key === note.docKey)
    if (idx >= 0) book.switchTo(idx)
  }, [book])

  const handleDragStart = useCallback((e: React.DragEvent, shapeOrRemote: TLShape | RemoteNote) => {
    const isLocal = 'typeName' in shapeOrRemote
    const props = (isLocal ? shapeOrRemote.props : shapeOrRemote.props) as Record<string, unknown>
    const meta = (isLocal ? shapeOrRemote.meta : shapeOrRemote.meta) as Record<string, unknown>
    const sourceDoc = isLocal
      ? book?.members[book.activeIndex]?.key
      : (shapeOrRemote as RemoteNote).docKey
    const data = {
      _tlda: true,
      text: props.text || '',
      color: props.color || 'yellow',
      sourceDoc,
      sourceShapeId: shapeOrRemote.id,
      shapeType: isLocal ? shapeOrRemote.type : (shapeOrRemote as RemoteNote).type,
      props: { ...props },
      meta: { ...meta },
    }
    e.dataTransfer.setData('application/x-tlda-note', JSON.stringify(data))
    e.dataTransfer.setData('text/plain', JSON.stringify(data))
    e.dataTransfer.effectAllowed = 'copy'
  }, [book])

  // Build page name lookup for chapter labels (must be before any early returns — hooks ordering)
  const pageNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of editor.getPages()) {
      map.set(p.id, p.name)
    }
    return map
  }, [editor, notes])

  const multiPage = editor.getPages().length > 1

  const sortedRemoteNotes = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...remoteNotes].sort((a, b) => {
      if (sortField === 'recency') {
        const aTime = (a.meta?.createdAt as number) || 0
        const bTime = (b.meta?.createdAt as number) || 0
        return (aTime - bTime) * dir
      }
      return (a.y - b.y) * dir
    })
  }, [remoteNotes, sortField, sortDir])

  if (notes.length === 0 && remoteNotes.length === 0) {
    return (
      <div className="doc-panel-content">
        <div className="panel-empty">No annotations yet</div>
      </div>
    )
  }

  function formatAge(timestamp: number): string {
    if (!timestamp) return '—'
    const diff = Date.now() - timestamp
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'now'
    if (mins < 60) return `${mins}m`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h`
    const days = Math.floor(hrs / 24)
    return `${days}d`
  }

  function renderNote(shape: TLShape) {
    const text = getShapeText(shape)
    const color = (shape.props as Record<string, unknown>).color as string || 'yellow'
    const meta = shape.meta as Record<string, unknown>
    const createdAt = meta?.createdAt as number || 0

    const cleanText = text.replace(/\$\$[\s\S]*?\$\$/g, '[math]').replace(/\$[^$]*\$/g, '[math]').trim()

    const shapeDone = isDone(shape)
    return (
      <tr key={shape.id} className={`notes-table-row${shapeDone ? ' notes-table-row--done' : ''}`}
        onClick={() => handleClick(shape)}
        draggable
        onDragStart={(e) => handleDragStart(e, shape)}
      >
        <td className="notes-table-cell notes-table-cell--note">
          <div className="notes-table-note-inner">
            <span className="note-color-dot" style={{ background: COLOR_HEX[color] || '#ccc' }} />
            <span className="notes-table-text">
              {cleanText || '(empty)'}
            </span>
            {shapeDone && (
              <button
                className="note-undone-btn"
                title="Reopen note"
                onClick={(e) => {
                  e.stopPropagation()
                  editor.updateShape({ id: shape.id, type: shape.type, props: { done: false } } as any)
                }}
              >
                ↩
              </button>
            )}
          </div>
        </td>
        <td className="notes-table-cell notes-table-cell--pos">{getPagePosition(shape)}</td>
        <td className="notes-table-cell notes-table-cell--age">{formatAge(createdAt)}</td>
      </tr>
    )
  }

  function renderRemoteNote(note: RemoteNote) {
    const text = (note.props.text as string) || ''
    const color = (note.props.color as string) || 'yellow'
    const anchor = note.meta?.sourceAnchor as { line?: number } | undefined
    const noteDone = note.props.done === true
    const cleanText = text.replace(/\$\$[\s\S]*?\$\$/g, '[math]').replace(/\$[^$]*\$/g, '[math]').trim()

    return (
      <div key={`${note.docKey}:${note.id}`} className="note-item note-item--remote"
        onClick={() => handleRemoteClick(note)}
        style={noteDone ? { opacity: 0.4 } : { opacity: 0.7 }}
        draggable
        onDragStart={(e) => handleDragStart(e, note)}
      >
        <div className="note-preview" style={{ display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
          <span className="note-color-dot" style={{ background: COLOR_HEX[color] || '#ccc', marginTop: '4px', flexShrink: 0 }} />
          <span style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as any,
            overflow: 'hidden',
            lineHeight: '1.3',
          }}>
            {cleanText || '(empty)'}
          </span>
        </div>
        <div className="note-meta" style={{ display: 'flex', gap: '6px', paddingLeft: '9px' }}>
          <span className="note-doc-badge">{note.docName}</span>
          {anchor?.line && <span>L{anchor.line}</span>}
        </div>
      </div>
    )
  }

  const arrow = sortDir === 'asc' ? '\u25B4' : '\u25BE'

  return (
    <div className="doc-panel-content" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="notes-toolbar">
        <button
          className="notes-sort-toggle"
          onClick={() => setHideDone(h => !h)}
          title={hideDone ? 'Showing active only' : 'Showing all'}
          style={{ opacity: hideDone ? 1 : 0.5 }}
        >
          {hideDone ? '\u2713 Hide done' : '\u2713 All'}
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <table className="notes-table">
          <thead>
            <tr>
              <th className="notes-table-header notes-table-header--note">Note</th>
              <th className="notes-table-header notes-table-header--pos notes-table-header--sortable"
                onClick={() => toggleSort('position')}>
                Pos {sortField === 'position' ? arrow : ''}
              </th>
              <th className="notes-table-header notes-table-header--age notes-table-header--sortable"
                onClick={() => toggleSort('recency')}>
                Age {sortField === 'recency' ? arrow : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {pendingItems.length > 0 && (
              <tr className="notes-table-section"><td colSpan={3}>Pending</td></tr>
            )}
            {pendingItems.map(renderNote)}
            {pendingItems.length > 0 && restItems.length > 0 && (
              <tr className="notes-table-section"><td colSpan={3}></td></tr>
            )}
            {restItems.map(renderNote)}
          </tbody>
        </table>

        {sortedRemoteNotes.length > 0 && (
          <>
            <div className="notes-section-divider" />
            <div className="notes-section-label">Other documents</div>
            {sortedRemoteNotes.map(renderRemoteNote)}
          </>
        )}

        {pendingItems.length === 0 && restItems.length === 0 && sortedRemoteNotes.length === 0 && (
          <div className="panel-empty">No annotations yet</div>
        )}
      </div>
    </div>
  )
}
