/**
 * NoteDropHandler — handles dropping notes from the panel onto the TLDraw canvas.
 *
 * Renders nothing; attaches native dragover/drop handlers to the TLDraw container.
 * Creates a math-note shape at the drop position with provenance metadata.
 */
import { useEffect } from 'react'
import { useEditor, createShapeId } from 'tldraw'

export function NoteDropHandler() {
  const editor = useEditor()

  useEffect(() => {
    const container = editor.getContainer()
    if (!container) return

    function handleDragOver(e: DragEvent) {
      if (e.dataTransfer?.types.includes('application/x-tlda-note') ||
          e.dataTransfer?.types.includes('application/x-chat-attachment') ||
          e.dataTransfer?.types.includes('text/plain')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    }

    function parseFleetDrop(e: DragEvent): Record<string, any> | null {
      // Try custom MIME first, fall back to text/plain with _fleet marker
      const custom = e.dataTransfer?.getData('application/x-chat-attachment')
      if (custom) try { return JSON.parse(custom) } catch {}
      const plain = e.dataTransfer?.getData('text/plain')
      if (plain) try { const p = JSON.parse(plain); if (p._fleet) return p; } catch {}
      return null
    }

    function handleDrop(e: DragEvent) {
      // Accept fleet chat attachments — convert to tlda note format
      const item = parseFleetDrop(e)
      if (item && !e.dataTransfer?.getData('application/x-tlda-note')) {
        e.preventDefault()
          const point = editor.screenToPage({ x: e.clientX, y: e.clientY })
          const shapeId = createShapeId()
          editor.createShape({
            id: shapeId,
            type: 'math-note',
            x: point.x,
            y: point.y,
            props: {
              text: item.snippet || '',
              color: 'blue',
              w: 250,
              h: 150,
            },
            meta: {
              createdAt: Date.now(),
              copiedFrom: {
                doc: 'fleet',
                shapeId: item.source || '',
                timestamp: Date.now(),
              },
              fleetSource: item,
            },
          })
        } catch {}
        return
      }

      let json = e.dataTransfer?.getData('application/x-tlda-note')
      if (!json) {
        // Cross-window fallback: check text/plain for _tlda marker
        const plain = e.dataTransfer?.getData('text/plain')
        if (plain) try { const p = JSON.parse(plain); if (p._tlda) json = plain } catch {}
      }
      if (!json) return
      e.preventDefault()

      let data: {
        text: string
        color: string
        tabs?: string[]
        activeTab?: number
        sourceDoc?: string
        sourceShapeId?: string
      }
      try {
        data = JSON.parse(json)
      } catch {
        return
      }

      // Convert screen coords to page coords
      const point = editor.screenToPage({ x: e.clientX, y: e.clientY })

      const shapeId = createShapeId()
      const text = data.text || ''
      const tabs = data.tabs && data.tabs.length > 0 ? data.tabs : [text]

      editor.createShape({
        id: shapeId,
        type: 'math-note',
        x: point.x,
        y: point.y,
        props: {
          text: tabs[data.activeTab ?? 0] || text,
          color: data.color || 'orange',
          w: 200,
          h: 150,
          tabs,
          activeTab: data.activeTab ?? 0,
        },
        meta: {
          createdAt: Date.now(),
          copiedFrom: {
            doc: data.sourceDoc,
            shapeId: data.sourceShapeId,
            timestamp: Date.now(),
          },
        },
      })
    }

    container.addEventListener('dragover', handleDragOver)
    container.addEventListener('drop', handleDrop)
    return () => {
      container.removeEventListener('dragover', handleDragOver)
      container.removeEventListener('drop', handleDrop)
    }
  }, [editor])

  return null
}
