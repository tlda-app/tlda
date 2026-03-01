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
      if (e.dataTransfer?.types.includes('application/x-tlda-note')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    }

    function handleDrop(e: DragEvent) {
      const json = e.dataTransfer?.getData('application/x-tlda-note')
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
