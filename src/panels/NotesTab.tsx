import { useState, useEffect, useCallback, useMemo } from 'react'
import { useEditor } from 'tldraw'
import type { TLShape, TLShapeId } from 'tldraw'
import { navigateTo, getShapeText, COLOR_HEX } from './helpers'
import {
  getThreadMeta,
  isReply,
  getThreadMembers,
  switchTab,
} from '../noteThreading'

type SortMode = 'document' | 'recency'

interface ThreadGroup {
  root: TLShape
  replies: TLShape[]
}

function isPendingMC(shape: TLShape): boolean {
  const props = shape.props as Record<string, unknown>
  const choices = props.choices as string[] | undefined
  if (!choices || choices.length === 0) return false
  const sel = props.selectedChoice as number | undefined
  return sel == null || sel < 0
}

export function NotesTab() {
  const editor = useEditor()
  const [notes, setNotes] = useState<TLShape[]>([])
  const [sort, setSort] = useState<SortMode>('document')
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set())

  useEffect(() => {
    function updateNotes() {
      const shapes = editor.getCurrentPageShapes()
      const noteShapes = shapes.filter(
        s => (s.type as string) === 'math-note' || s.type === 'note'
      )
      setNotes(noteShapes)
    }

    updateNotes()
    const unsub1 = editor.store.listen(updateNotes, { scope: 'document', source: 'user' })
    const unsub2 = editor.store.listen(updateNotes, { scope: 'document', source: 'remote' })
    return () => { unsub1(); unsub2() }
  }, [editor])

  // Build grouped + sorted display list
  const { pendingItems, restItems } = useMemo(() => {
    // Group into threads
    const threadMap = new Map<string, ThreadGroup>()
    const standalone: TLShape[] = []

    for (const shape of notes) {
      const m = getThreadMeta(shape)
      if (m.threadId) {
        if (!threadMap.has(m.threadId)) {
          threadMap.set(m.threadId, { root: shape, replies: [] })
        } else {
          const group = threadMap.get(m.threadId)!
          if (m.threadRootId) {
            group.replies.push(shape)
          } else {
            if (getThreadMeta(group.root).threadRootId) {
              group.replies.push(group.root)
              group.root = shape
            }
          }
        }
      } else {
        standalone.push(shape)
      }
    }

    for (const group of threadMap.values()) {
      group.replies.sort((a, b) =>
        (getThreadMeta(a).threadOrder || 0) - (getThreadMeta(b).threadOrder || 0)
      )
    }

    type DisplayEntry = { type: 'standalone'; shape: TLShape }
      | { type: 'thread-root'; group: ThreadGroup }
      | { type: 'reply'; shape: TLShape; rootId: TLShapeId }

    const allEntries: DisplayEntry[] = []
    for (const shape of standalone) allEntries.push({ type: 'standalone', shape })
    for (const group of threadMap.values()) allEntries.push({ type: 'thread-root', group })

    // Sort
    const sortFn = (a: DisplayEntry, b: DisplayEntry) => {
      const sa = a.type === 'thread-root' ? a.group.root : a.shape
      const sb = b.type === 'thread-root' ? b.group.root : b.shape
      if (sort === 'recency') return sb.y - sa.y
      return sa.y - sb.y
    }

    // Split into pending MC vs rest
    const pending: DisplayEntry[] = []
    const rest: DisplayEntry[] = []

    for (const entry of allEntries) {
      const shape = entry.type === 'thread-root' ? entry.group.root : entry.shape
      if (isPendingMC(shape)) {
        pending.push(entry)
      } else {
        rest.push(entry)
      }
    }

    pending.sort(sortFn)
    rest.sort(sortFn)

    // Expand threads into flat lists
    function expand(entries: DisplayEntry[]): DisplayEntry[] {
      const result: DisplayEntry[] = []
      for (const entry of entries) {
        result.push(entry)
        if (entry.type === 'thread-root' && expandedThreads.has(entry.group.root.id)) {
          for (const reply of entry.group.replies) {
            result.push({ type: 'reply', shape: reply, rootId: entry.group.root.id })
          }
        }
      }
      return result
    }

    return { pendingItems: expand(pending), restItems: expand(rest) }
  }, [notes, sort, expandedThreads])

  const handleClick = useCallback((shape: TLShape) => {
    const m = getThreadMeta(shape)
    if (m.threadId) switchTab(editor, shape, shape.id)
    navigateTo(editor, shape.x, shape.y)
  }, [editor])

  const toggleThread = useCallback((rootId: string) => {
    setExpandedThreads(prev => {
      const next = new Set(prev)
      if (next.has(rootId)) next.delete(rootId)
      else next.add(rootId)
      return next
    })
  }, [])

  if (notes.length === 0) {
    return (
      <div className="doc-panel-content">
        <div className="panel-empty">No annotations yet</div>
      </div>
    )
  }

  function renderEntry(entry: { type: string; shape?: TLShape; group?: ThreadGroup; rootId?: TLShapeId }) {
    if (entry.type === 'reply') {
      const shape = entry.shape!
      const text = getShapeText(shape)
      const color = (shape.props as Record<string, unknown>).color as string || 'yellow'
      const order = getThreadMeta(shape).threadOrder || 0
      return (
        <div
          key={shape.id}
          className="note-item note-reply"
          onClick={() => handleClick(shape)}
        >
          <div className="note-preview">
            <span className="note-thread-order">{order + 1}</span>
            <span className="note-color-dot" style={{ background: COLOR_HEX[color] || '#ccc' }} />
            {text.slice(0, 50) || '(empty)'}
          </div>
        </div>
      )
    }

    const shape = entry.type === 'thread-root' ? entry.group!.root : entry.shape!
    const text = getShapeText(shape)
    const color = (shape.props as Record<string, unknown>).color as string || 'yellow'
    const meta = shape.meta as Record<string, unknown>
    const anchor = meta?.sourceAnchor as { line?: number } | undefined
    const isThread = entry.type === 'thread-root'
    const replyCount = isThread ? entry.group!.replies.length : 0
    const isExpanded = isThread && expandedThreads.has(shape.id)

    return (
      <div key={shape.id} className="note-item" onClick={() => handleClick(shape)}>
        <div className="note-preview">
          {isThread && (
            <span
              className="note-thread-toggle"
              onClick={(e) => { e.stopPropagation(); toggleThread(shape.id) }}
            >
              {isExpanded ? '\u25BC' : '\u25B6'}
            </span>
          )}
          <span className="note-color-dot" style={{ background: COLOR_HEX[color] || '#ccc' }} />
          {text.slice(0, 60) || '(empty)'}
          {replyCount > 0 && (
            <span className="note-reply-count">+{replyCount}</span>
          )}
        </div>
        {anchor?.line && (
          <div className="note-meta">Line {anchor.line}</div>
        )}
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
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {/* Pending MC section */}
        {pendingItems.length > 0 && (
          <>
            <div className="notes-section-label">Pending</div>
            {pendingItems.map(renderEntry)}
          </>
        )}

        {/* Rest */}
        {pendingItems.length > 0 && restItems.length > 0 && (
          <div className="notes-section-divider" />
        )}
        {restItems.map(renderEntry)}

        {pendingItems.length === 0 && restItems.length === 0 && (
          <div className="panel-empty">No annotations yet</div>
        )}
      </div>
    </div>
  )
}
