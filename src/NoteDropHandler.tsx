/**
 * NoteDropHandler — handles dropping notes from the panel or cross-window onto the TLDraw canvas.
 *
 * Attaches handlers to `document` in capture phase because TLDraw's pointer
 * system intercepts native drag events on the canvas container.
 */
import { useEffect } from 'react'
import { useEditor, createShapeId } from 'tldraw'

export function NoteDropHandler() {
  const editor = useEditor()

  useEffect(() => {
    function isNoteDrag(e: DragEvent): boolean {
      const types = e.dataTransfer?.types
      if (!types) return false
      return types.includes('application/x-tlda-note') ||
             types.includes('application/x-tlda-drop') ||
             types.includes('application/x-chat-attachment') ||
             // Cross-window: only accept text/plain if it's likely our JSON payload
             // (can't read data during dragover, so accept text/plain broadly)
             types.includes('text/plain')
    }

    function isOverOpenPanel(e: DragEvent): boolean {
      const panel = document.querySelector('.doc-panel-open')
      if (!panel) return false
      const rect = panel.getBoundingClientRect()
      return e.clientX >= rect.left && e.clientX <= rect.right &&
             e.clientY >= rect.top && e.clientY <= rect.bottom
    }

    function handleDragOver(e: DragEvent) {
      if (!isNoteDrag(e)) return
      // Don't intercept dragover on the document panel or fleet HUD
      if (isOverOpenPanel(e)) return
      if (isOverHud(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }

    function parseFleetDrop(e: DragEvent): Record<string, any> | null {
      const custom = e.dataTransfer?.getData('application/x-chat-attachment')
      if (custom) try {
        const p = JSON.parse(custom)
        return p?.type === 'shared-doc' ? null : p
      } catch {}
      const plain = e.dataTransfer?.getData('text/plain')
      if (plain) try {
        const p = JSON.parse(plain)
        if (p._fleet && p.type !== 'shared-doc') return p
      } catch {}
      return null
    }

    function isOverHud(e: DragEvent): boolean {
      // With the full-viewport overlay, check if the cursor is over an actual
      // fleet shape element — not the HUD bounding rect (which is the whole screen).
      const target = document.elementFromPoint(e.clientX, e.clientY)
      if (!target) return false
      return !!target.closest('[data-shape-type="fleet-chat"], [data-shape-type="fleet-agents"], [data-shape-type="fleet-search"], [data-shape-type="fleet-inbox"], [data-shape-type="fleet-notifications"], [data-shape-type="fleet-docview"]')
    }

    function handleDrop(e: DragEvent) {
      // Don't intercept drops on the document panel (TOC drop-to-book)
      if (isOverOpenPanel(e)) return
      // Don't create math notes on the fleet HUD
      if (isOverHud(e)) return

      // Fleet scratch card drop — full content as MathNote
      const tldaDrop = e.dataTransfer?.getData('application/x-tlda-drop')
      if (tldaDrop) {
        try {
          const dropData = JSON.parse(tldaDrop)
          if (dropData.type === 'scratch-doc' && dropData.content) {
            e.preventDefault()
            const point = editor.screenToPage({ x: e.clientX, y: e.clientY })
            const shapeId = createShapeId()
            const lineCount = dropData.content.split('\n').length
            const h = Math.min(600, Math.max(200, lineCount * 16 + 40))
            editor.createShape({
              id: shapeId,
              type: 'math-note',
              x: point.x,
              y: point.y,
              opacity: 1,
              props: {
                text: dropData.content,
                color: 'violet',
                w: 300,
                h,
                collapsed: false,
              },
              meta: {
                createdAt: Date.now(),
                copiedFromDoc: 'fleet',
                copiedFromShapeId: '',
                copiedFromTimestamp: Date.now(),
                fleetSource: JSON.stringify({ type: 'scratch-doc', name: dropData.name, path: dropData.path }),
                docName: dropData.name,
                docPath: dropData.path,
              },
            } as any)
            return
          }
        } catch {}
      }

      // Accept fleet chat attachments — convert to tlda note format
      const item = parseFleetDrop(e)
      if (item && !e.dataTransfer?.getData('application/x-tlda-note')) {
        e.preventDefault()
        try {
          const point = editor.screenToPage({ x: e.clientX, y: e.clientY })
          const shapeId = createShapeId()

          const text = item.snippet || ''
          const w = 250
          const h = 150

          editor.createShape({
            id: shapeId,
            type: 'math-note',
            x: point.x,
            y: point.y,
            opacity: 1,
            props: {
              text,
              color: 'blue',
              w,
              h,
              collapsed: false,
            },
            meta: {
              createdAt: Date.now(),
              copiedFromDoc: 'fleet',
              copiedFromShapeId: item.source || item.shareId || '',
              copiedFromTimestamp: Date.now(),
              fleetSource: JSON.stringify(item),
            },
          } as any)
        } catch {}
        return
      }

      let json = e.dataTransfer?.getData('application/x-tlda-note')
      if (!json) {
        const plain = e.dataTransfer?.getData('text/plain')
        if (plain) try {
          const p = JSON.parse(plain)
          // Accept _tlda note payloads, but skip chapter-note (those are for TOC drop)
          if (p._tlda && p.type !== 'chapter-note') json = plain
        } catch {}
      }
      if (!json) return
      e.preventDefault()

      let data: Record<string, any>
      try {
        data = JSON.parse(json)
      } catch {
        return
      }

      const point = editor.screenToPage({ x: e.clientX, y: e.clientY })
      const shapeId = createShapeId()

      // Shallow copy: if the drag payload includes full props/meta from
      // the notes panel, preserve them so file-sync and other metadata survive.
      const srcProps = data.props as Record<string, unknown> | undefined
      const srcMeta = data.meta as Record<string, unknown> | undefined

      const props = srcProps
        ? { ...srcProps }
        : { text: data.text || '', color: data.color || 'orange', w: 200, h: 150, collapsed: false }

      // Flatten any nested objects in meta to pass TLDraw validation
      const flatMeta: Record<string, unknown> = { createdAt: Date.now() }
      if (srcMeta) {
        for (const [k, v] of Object.entries(srcMeta)) {
          flatMeta[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v
        }
      }
      flatMeta.copiedFromDoc = data.sourceDoc || ''
      flatMeta.copiedFromShapeId = data.sourceShapeId || ''
      flatMeta.copiedFromTimestamp = Date.now()

      editor.createShape({
        id: shapeId,
        type: data.shapeType || 'math-note',
        x: point.x,
        y: point.y,
        opacity: 1,
        props,
        meta: flatMeta,
      } as any)
    }

    // Capture phase so we get events before TLDraw's pointer system
    document.addEventListener('dragover', handleDragOver, true)
    document.addEventListener('drop', handleDrop, true)
    return () => {
      document.removeEventListener('dragover', handleDragOver, true)
      document.removeEventListener('drop', handleDrop, true)
    }
  }, [editor])

  return null
}
