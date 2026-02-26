import { useState, useEffect, useCallback, useMemo } from 'react'
import { useEditor } from 'tldraw'
import type { TLShape, TLShapeId, TLPageId } from 'tldraw'
import { navigateTo, getShapeText, COLOR_HEX } from './helpers'
import { getTabCount, switchTab } from '../noteThreading'

type SortMode = 'document' | 'recency'

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
  const [notes, setNotes] = useState<TLShape[]>([])
  const [sort, setSort] = useState<SortMode>('document')
  const [hideDone, setHideDone] = useState(false)

  useEffect(() => {
    function updateNotes() {
      setNotes(getAllNotes(editor))
    }

    updateNotes()
    const unsub1 = editor.store.listen(updateNotes, { scope: 'document', source: 'user' })
    const unsub2 = editor.store.listen(updateNotes, { scope: 'document', source: 'remote' })
    return () => { unsub1(); unsub2() }
  }, [editor])

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

  if (notes.length === 0) {
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
    return (
      <div key={shape.id} className="note-item" onClick={() => handleClick(shape)}
        style={shapeDone ? { opacity: 0.55 } : undefined}
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

        {pendingItems.length === 0 && restItems.length === 0 && (
          <div className="panel-empty">No annotations yet</div>
        )}
      </div>
    </div>
  )
}
