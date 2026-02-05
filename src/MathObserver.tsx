import { useEffect, useRef } from 'react'
import { useEditor } from 'tldraw'
import katex from 'katex'
import 'katex/dist/katex.min.css'

// Render LaTeX: $...$ for inline, $$...$$ for display
function renderMath(text: string): string | null {
  let hadError = false

  let result = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: true })
    } catch {
      hadError = true
      return `$$${tex}$$`
    }
  })

  result = result.replace(/\$([^$]+)\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: true })
    } catch {
      hadError = true
      return `$${tex}$`
    }
  })

  return hadError ? null : result
}

function hasMath(text: string): boolean {
  return /\$[^$]+\$/.test(text)
}

function extractText(richText: unknown): string {
  if (!richText || typeof richText !== 'object') return ''
  const doc = richText as { content?: Array<{ content?: Array<{ text?: string }> }> }
  if (!doc.content) return ''
  return doc.content
    .map(para => para.content?.map(node => node.text || '').join('') || '')
    .join('\n')
}

export function MathObserver() {
  const editor = useEditor()
  const lastEditingId = useRef<string | null>(null)
  const renderedContent = useRef(new Map<string, string>())

  useEffect(() => {
    const checkEditing = () => {
      const editingId = editor.getEditingShapeId()

      if (editingId !== lastEditingId.current) {
        // Stopped editing a shape - render it after delay
        if (lastEditingId.current && !editingId) {
          const shapeId = lastEditingId.current
          setTimeout(() => {
            try {
              const shape = editor.getShape(shapeId as any)
              if (!shape || shape.type !== 'note') return

              const text = extractText((shape.props as any).richText)
              if (!hasMath(text)) return

              const rendered = renderMath(text)
              if (!rendered) return

              const el = document.querySelector(`[data-shape-id="${shapeId}"]`)
              const container = el?.querySelector('.tl-text-content')
              if (container) {
                renderedContent.current.set(shapeId, text)
                container.innerHTML = `<div class="katex-container">${rendered.replace(/\n/g, '<br>')}</div>`
              }
            } catch (e) {
              console.error('[Math] render error', e)
            }
          }, 200)
        }
        lastEditingId.current = editingId
      }
    }

    // Check periodically instead of on every state change
    const interval = setInterval(checkEditing, 100)

    // Initial render
    setTimeout(() => {
      const shapes = editor.getCurrentPageShapes()
      shapes.forEach(shape => {
        if (shape.type !== 'note') return
        try {
          const text = extractText((shape.props as any).richText)
          if (!hasMath(text)) return
          const rendered = renderMath(text)
          if (!rendered) return

          const el = document.querySelector(`[data-shape-id="${shape.id}"]`)
          const container = el?.querySelector('.tl-text-content')
          if (container && !container.querySelector('.katex')) {
            renderedContent.current.set(shape.id, text)
            container.innerHTML = `<div class="katex-container">${rendered.replace(/\n/g, '<br>')}</div>`
          }
        } catch (e) {
          console.error('[Math] initial render error', e)
        }
      })
    }, 500)

    return () => clearInterval(interval)
  }, [editor])

  return null
}
