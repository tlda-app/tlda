import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useEditor } from 'tldraw'
import type { TLShape, TLShapeId, TLPageId } from 'tldraw'
import { navigateTo, getShapeText, COLOR_HEX } from './helpers'
import { getTabCount, switchTab } from '../noteThreading'
import { useBook } from '../BookContext'

type SortMode = 'document' | 'recency'

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
  const [sort, setSort] = useState<SortMode>('document')
  const [hideDone, setHideDone] = useState(false)

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

  const { pendingItems, restItems } = useMemo(() => {
    const sortFn = (a: TLShape, b: TLShape) => {
      if (sort === 'recency') return b.y - a.y
      return a.y - b.y
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
  }, [notes, sort, hideDone])

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

  const handleDragStart = useCallback((e: React.DragEvent, data: {
    text: string
    color: string
    tabs?: string[]
    activeTab?: number
    sourceDoc?: string
    sourceShapeId?: string
  }) => {
    e.dataTransfer.setData('application/x-ctd-note', JSON.stringify(data))
    e.dataTransfer.effectAllowed = 'copy'
  }, [])

  if (notes.length === 0 && remoteNotes.length === 0) {
    return (
      <div className="doc-panel-content">
        <div className="panel-empty">No annotations yet</div>
      </div>
    )
  }

  // Build page name lookup for chapter labels
  const pageNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of editor.getPages()) {
      map.set(p.id, p.name)
    }
    return map
  }, [editor, notes]) // re-derive when notes change (pages may have been created)

  const multiPage = editor.getPages().length > 1

  function renderNote(shape: TLShape) {
    const text = getShapeText(shape)
    const color = (shape.props as Record<string, unknown>).color as string || 'yellow'
    const meta = shape.meta as Record<string, unknown>
    const anchor = meta?.sourceAnchor as { line?: number } | undefined
    const tabCount = getTabCount(shape)
    const pageName = multiPage ? pageNames.get(shape.parentId) : undefined

    // Strip math delimiters for cleaner preview
    const cleanText = text.replace(/\$\$[\s\S]*?\$\$/g, '[math]').replace(/\$[^$]*\$/g, '[math]').trim()

    const shapeDone = isDone(shape)
    const props = shape.props as Record<string, unknown>
    const tabs = props.tabs as string[] | undefined
    const activeTabIdx = props.activeTab as number | undefined

    return (
      <div key={shape.id} className="note-item" onClick={() => handleClick(shape)}
        style={shapeDone ? { opacity: 0.55 } : undefined}
        draggable
        onDragStart={(e) => handleDragStart(e, {
          text: text,
          color,
          tabs,
          activeTab: activeTabIdx,
          sourceDoc: book?.members[book.activeIndex]?.key,
          sourceShapeId: shape.id,
        })}
      >
        <div className="note-preview" style={{ display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
          <span className="note-color-dot" style={{ background: COLOR_HEX[color] || '#ccc', marginTop: '4px', flexShrink: 0 }} />
          <span style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as any,
            overflow: 'hidden',
            lineHeight: '1.3',
            textDecoration: shapeDone ? 'line-through' : undefined,
          }}>
            {cleanText || '(empty)'}
          </span>
        </div>
        <div className="note-meta" style={{ display: 'flex', gap: '6px', paddingLeft: '9px' }}>
          {pageName && <span style={{ opacity: 0.6 }}>{pageName}</span>}
          {anchor?.line && <span>L{anchor.line}</span>}
          {tabCount > 1 && <span>{tabCount} tabs</span>}
          {shapeDone && (
            <button
              className="note-undone-btn"
              title="Reopen note"
              onClick={(e) => {
                e.stopPropagation()
                editor.updateShape({ id: shape.id, type: shape.type, props: { done: false } } as any)
              }}
            >
              ↩ reopen
            </button>
          )}
        </div>
      </div>
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
        onDragStart={(e) => handleDragStart(e, {
          text,
          color,
          tabs: note.props.tabs as string[] | undefined,
          activeTab: note.props.activeTab as number | undefined,
          sourceDoc: note.docKey,
          sourceShapeId: note.id,
        })}
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

  const sortedRemoteNotes = useMemo(() => {
    return [...remoteNotes].sort((a, b) => sort === 'recency' ? b.y - a.y : a.y - b.y)
  }, [remoteNotes, sort])

  return (
    <div className="doc-panel-content" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Sort toggle */}
      <div className="notes-toolbar">
        <button
          className="notes-sort-toggle"
          onClick={() => setSort(s => s === 'document' ? 'recency' : 'document')}
          title={sort === 'document' ? 'Sorted by position' : 'Sorted by newest'}
        >
          {sort === 'document' ? '\u2193 Position' : '\u21BB Recent'}
        </button>
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
        {/* Pending MC section */}
        {pendingItems.length > 0 && (
          <>
            <div className="notes-section-label">Pending</div>
            {pendingItems.map(renderNote)}
          </>
        )}

        {/* Rest */}
        {pendingItems.length > 0 && restItems.length > 0 && (
          <div className="notes-section-divider" />
        )}
        {restItems.map(renderNote)}

        {/* Remote notes from other book members */}
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
