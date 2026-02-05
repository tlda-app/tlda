import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  stopEventPropagation,
  DefaultColorStyle,
} from 'tldraw'
// Type imports not needed with 'any' approach
import { useCallback, useRef, useEffect, useState } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { getActiveMacros } from './katexMacros'


// Render LaTeX - always returns something, errors shown inline
function renderMath(text: string): string {
  const katexOptions = { macros: getActiveMacros(), throwOnError: true }

  // Display math ($$...$$)
  let result = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { ...katexOptions, displayMode: true })
    } catch (e: any) {
      const msg = String(e.message || e || 'parse error').replace(/</g, '&lt;')
      const escaped = tex.replace(/</g, '&lt;')
      return `<div style="color:#b91c1c;font-size:11px;background:#fef2f2;padding:6px;border-radius:3px;margin:4px 0"><div>⚠️ ${msg}</div><code style="font-size:10px;color:#666;display:block;margin-top:4px">${escaped}</code></div>`
    }
  })

  // Inline math ($...$)
  result = result.replace(/\$([^$]+)\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { ...katexOptions, displayMode: false })
    } catch {
      const escaped = tex.replace(/</g, '&lt;')
      return `<span style="color:#b91c1c;background:#fef2f2;padding:1px 4px;border-radius:2px;font-size:11px">⚠️ ${escaped}</span>`
    }
  })

  return result.replace(/\n/g, '<br>')
}

function hasMath(text: string): boolean {
  return /\$[^$]+\$/.test(text)
}

const NOTE_COLORS: Record<string, string> = {
  'yellow': '#fef9c3',
  'red': '#fecaca',
  'green': '#bbf7d0',
  'blue': '#bfdbfe',
  'violet': '#ddd6fe',
  'orange': '#fed7aa',
  'grey': '#e5e5e5',
  'light-red': '#fecaca',
  'light-green': '#bbf7d0',
  'light-blue': '#bfdbfe',
  'light-violet': '#ddd6fe',
  'black': '#e5e5e5',
  'white': '#ffffff',
}

export class MathNoteShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'math-note' as const
  static override props = {
    w: T.number,
    h: T.number,
    text: T.string,
    color: DefaultColorStyle,
  }

  getDefaultProps() {
    return {
      w: 200,
      h: 200,
      text: '',
      color: 'yellow',
    }
  }

  override canEdit = () => true
  override canResize = () => true
  override canBind = () => false
  override isAspectRatioLocked = () => false
  override hideResizeHandles = () => false
  override hideRotateHandle = () => true
  override hideSelectionBoundsBg = () => false
  override hideSelectionBoundsFg = () => false

  component(shape: any) {
    const editor = useEditor()
    const isEditing = editor.getEditingShapeId() === shape.id
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const [localText, setLocalText] = useState(shape.props.text || '')

    const bgColor = NOTE_COLORS[shape.props.color] || NOTE_COLORS.yellow

    // Sync local text when shape changes (from undo, etc)
    useEffect(() => {
      if (!isEditing) {
        setLocalText(shape.props.text || '')
      }
    }, [shape.props.text, isEditing])

    // Focus textarea when editing starts
    useEffect(() => {
      if (isEditing && textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.select()
      }
    }, [isEditing])

    const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value
      setLocalText(newText)
      editor.updateShape({
        id: shape.id,
        type: 'math-note' as any,
        props: { text: newText },
      })
    }, [editor, shape.id])

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        editor.setEditingShape(null)
      }
      stopEventPropagation(e)
    }, [editor])

    // Render content
    let content: React.ReactNode
    if (isEditing) {
      content = (
        <textarea
          ref={textareaRef}
          value={localText}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPointerDown={stopEventPropagation}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            outline: 'none',
            resize: 'none',
            background: 'transparent',
            fontFamily: 'monospace',
            fontSize: '14px',
            padding: '12px',
            boxSizing: 'border-box',
          }}
        />
      )
    } else {
      const text = shape.props.text || ''
      if (hasMath(text)) {
        const rendered = renderMath(text)
        content = (
          <div
            style={{
              padding: '12px',
              fontSize: '14px',
              lineHeight: 1.4,
              overflow: 'auto',
              height: '100%',
              boxSizing: 'border-box',
            }}
            dangerouslySetInnerHTML={{ __html: rendered }}
          />
        )
      } else {
        content = (
          <div style={{
            padding: '12px',
            fontSize: '14px',
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            height: '100%',
            boxSizing: 'border-box',
          }}>
            {text}
          </div>
        )
      }
    }

    return (
      <HTMLContainer
        id={shape.id}
        style={{
          width: shape.props.w,
          height: shape.props.h,
          backgroundColor: bgColor,
          borderRadius: '4px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24)',
          pointerEvents: 'all',
        }}
      >
        {content}
      </HTMLContainer>
    )
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={4} ry={4} />
  }
}
