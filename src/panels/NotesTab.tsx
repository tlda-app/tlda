import { useState, useEffect, useCallback } from 'react'
import { useEditor } from 'tldraw'
import type { TLShape } from 'tldraw'
import { navigateTo, getShapeText, COLOR_HEX } from './helpers'

export function NotesTab() {
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

    // Re-run on user actions and remote sync (Yjs), but not internal TLDraw events
    // (pointer moves, selections, etc. which fire constantly)
    const unsub1 = editor.store.listen(updateNotes, { scope: 'document', source: 'user' })
    const unsub2 = editor.store.listen(updateNotes, { scope: 'document', source: 'remote' })
    return () => { unsub1(); unsub2() }
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
