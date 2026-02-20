import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
  stopEventPropagation,
  DefaultColorStyle,
} from 'tldraw'
import type { TLShapeId } from 'tldraw'
// Type imports not needed with 'any' approach
import { useCallback, useRef, useEffect, useState, useMemo } from 'react'
import {
  getThreadMeta,
  getThreadMembers,
  getActiveShape,
  findRoot,
  switchTab,
  createReply,
  detachFromThread,
} from './noteThreading'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { getActiveMacros } from './katexMacros'

// CodeMirror imports
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { vim, getCM, Vim, CodeMirror as CM5 } from '@replit/codemirror-vim'
import { latex } from 'codemirror-lang-latex'

// Render LaTeX - always returns something, errors shown inline
function renderMath(text: string, showErrors = false): string {
  const katexOptions = { macros: getActiveMacros(), throwOnError: true }

  // Display math ($$...$$)
  let result = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { ...katexOptions, displayMode: true })
    } catch (e: any) {
      if (!showErrors) return ''
      const msg = String(e.message || e || 'parse error').replace(/</g, '&lt;')
      return `<div style="color:#b91c1c;font-size:11px;margin:4px 0">${msg}</div>`
    }
  })

  // Inline math ($...$)
  result = result.replace(/\$([^$]+)\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { ...katexOptions, displayMode: false })
    } catch (e: any) {
      if (!showErrors) return ''
      const msg = String(e.message || e || 'parse error').replace(/</g, '&lt;')
      return `<span style="color:#b91c1c;font-size:11px">${msg}</span>`
    }
  })

  return result.replace(/\n/g, '<br>')
}

function hasMath(text: string): boolean {
  return /\$[^$]+\$/.test(text)
}

export const NOTE_COLORS: Record<string, string> = {
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

// Entry mode: set before entering edit mode to dispatch vim command on mount
// 'i' = insert mode, ':' = ex command, null = normal mode (default)
let pendingEntryMode: 'i' | ':' | null = null
export function setMathNoteEntryMode(mode: 'i' | ':' | null) { pendingEntryMode = mode }

// CodeMirror theme: minimal, transparent, monospace
const cmTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
    fontSize: '13px',
    padding: '8px',
    color: '#1a1a1a',
    caretColor: '#1a1a1a',
  },
  '.cm-gutters': { display: 'none' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.04)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(0,0,0,0.15) !important' },
  '.cm-panels': { fontSize: '12px' },
  '.cm-panels input': { fontFamily: 'monospace', fontSize: '12px' },
  '.cm-tooltip-autocomplete': {
    opacity: '0.5',
    fontSize: '11px',
    border: '1px solid rgba(0,0,0,0.1)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
})

/**
 * In pen mode, finger touches should pass through to TLDraw (for palm rejection).
 * Only stop propagation for pen/mouse events or when not in pen mode.
 */
function stopIfNotPenTouch(editor: any) {
  return (e: React.PointerEvent) => {
    if (editor.getInstanceState().isPenMode && e.pointerType === 'touch') return
    stopEventPropagation(e)
  }
}

export class MathNoteShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'math-note' as const
  static override props = {
    w: T.number,
    h: T.number,
    text: T.string,
    color: DefaultColorStyle,
    autoSize: T.optional(T.boolean),
    choices: T.optional(T.arrayOf(T.string)),
    selectedChoice: T.optional(T.number),
  }

  getDefaultProps() {
    return {
      w: 200,
      h: 50,
      text: '',
      color: 'light-blue',
      autoSize: true,
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

  override onResize = (shape: any, info: any) => {
    const next = super.onResize!(shape, info) as any
    // Manual resize disables auto-size
    if (next.props) next.props.autoSize = false
    else next.props = { autoSize: false }
    return next
  }

  component(shape: any) {
    const editor = useEditor()
    const isEditing = editor.getEditingShapeId() === shape.id
    const cmContainerRef = useRef<HTMLDivElement>(null)
    const cmViewRef = useRef<EditorView | null>(null)
    const [localText, setLocalText] = useState(shape.props.text || '')
    const [previewHtml, setPreviewHtml] = useState('')
    const [isVimInsert, setIsVimInsert] = useState(false)
    const [vimMode, setVimMode] = useState('normal')
    const [splitPx, setSplitPx] = useState<number | null>(null)
    const isDraggingRef = useRef(false)
    const dragStartRef = useRef({ y: 0, splitPx: 0 })
    const previewRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const [cursorFraction, setCursorFraction] = useState(0)

    // Refs for sync coordination
    const suppressUpdateRef = useRef(false)
    const lastSentTextRef = useRef(shape.props.text || '')
    const modeJustChangedRef = useRef(false)

    const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
    const bgColor = NOTE_COLORS[shape.props.color] || NOTE_COLORS.yellow

    // Memoize KaTeX rendering — only re-parse when text actually changes
    const renderedHtml = useMemo(
      () => {
        const t = shape.props.text || ''
        return hasMath(t) ? renderMath(t) : null
      },
      [shape.props.text],
    )

    // Sync local text when shape changes from external source (undo, Yjs, etc)
    useEffect(() => {
      if (!isEditing) {
        setLocalText(shape.props.text || '')
      } else if (!isVimInsert && cmViewRef.current) {
        // In vim normal mode: accept incoming changes (e.g. Claude's reply)
        const incomingText = shape.props.text || ''
        if (incomingText !== lastSentTextRef.current) {
          suppressUpdateRef.current = true
          const view = cmViewRef.current
          const currentDoc = view.state.doc.toString()
          if (incomingText !== currentDoc) {
            view.dispatch({
              changes: { from: 0, to: currentDoc.length, insert: incomingText },
            })
            setLocalText(incomingText)
          }
          suppressUpdateRef.current = false
          lastSentTextRef.current = incomingText
        }
      }
    }, [shape.props.text, isEditing, isVimInsert])

    // Scroll preview to track cursor
    useEffect(() => {
      const el = previewRef.current
      if (!el || !isEditing) return
      const scrollRange = el.scrollHeight - el.clientHeight
      if (scrollRange > 0) {
        el.scrollTop = cursorFraction * scrollRange
      }
    }, [cursorFraction, isEditing, previewHtml])

    // Debounced KaTeX preview
    useEffect(() => {
      if (!isEditing) return
      const timer = setTimeout(() => {
        if (hasMath(localText)) {
          setPreviewHtml(renderMath(localText, true))
        } else {
          setPreviewHtml('')
        }
      }, 150)
      return () => clearTimeout(timer)
    }, [localText, isEditing])

    // Grow note height when editing starts
    useEffect(() => {
      if (isEditing && shape.props.h < 350) {
        editor.updateShape({
          id: shape.id,
          type: 'math-note' as any,
          props: { h: 350 },
        })
      }
      if (isEditing) {
        setSplitPx(null) // reset split on edit start
      }
    }, [isEditing])

    // Auto-size: measure rendered content and update shape height
    useEffect(() => {
      if (isEditing || !shape.props.autoSize) return
      if (shape.opacity === 0) return // hidden tab — skip measurement
      const el = contentRef.current
      if (!el) return
      const measured = el.scrollHeight
      const target = Math.max(40, measured)
      if (Math.abs(target - shape.props.h) > 2) {
        editor.updateShape({
          id: shape.id,
          type: 'math-note' as any,
          props: { h: target },
        })
      }
    }, [isEditing, shape.props.autoSize, shape.props.text, shape.props.w])

    // Create/destroy CodeMirror when editing state changes
    useEffect(() => {
      if (!isEditing || !cmContainerRef.current) {
        if (cmViewRef.current) {
          cmViewRef.current.destroy()
          cmViewRef.current = null
        }
        setIsVimInsert(false)
        setVimMode('normal')
        return
      }

      const exitEditing = () => {
        editor.setEditingShape(null)
      }

      const startState = EditorState.create({
        doc: shape.props.text || '',
        extensions: [
          vim(),
          latex(),
          // Auto-expand $$: typing second $ after first opens display math block
          EditorView.inputHandler.of((view, from, to, text) => {
            if (text === '$') {
              const before = view.state.doc.sliceString(from - 1, from)
              if (before === '$') {
                // Just typed the second $ — expand to $$\n|\n$$
                view.dispatch({
                  changes: { from: from - 1, to, insert: '$$\n\n$$' },
                  selection: { anchor: from + 2 },
                })
                return true
              }
            }
            return false
          }),
          EditorView.lineWrapping,
          cmTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !suppressUpdateRef.current) {
              const text = update.state.doc.toString()
              setLocalText(text)
              lastSentTextRef.current = text
              editor.updateShape({
                id: shape.id,
                type: 'math-note' as any,
                props: { text },
              })
            }
            // Track cursor position for preview scroll
            if (update.selectionSet || update.docChanged) {
              const pos = update.state.selection.main.head
              const doc = update.state.doc
              const line = doc.lineAt(pos).number
              const totalLines = doc.lines
              setCursorFraction(totalLines <= 1 ? 0 : (line - 1) / (totalLines - 1))
            }
          }),
          // Low-priority Escape: only fires if vim didn't consume it
          // (i.e. we're in normal mode with no pending command)
          Prec.low(keymap.of([{
            key: 'Escape',
            run: () => {
              exitEditing()
              return true
            },
          }])),
        ],
      })

      const view = new EditorView({
        state: startState,
        parent: cmContainerRef.current,
      })

      cmViewRef.current = view
      lastSentTextRef.current = shape.props.text || ''

      // Track vim mode changes for Yjs sync and Escape handling
      const cm = getCM(view)
      if (cm) {
        CM5.on(cm, 'vim-mode-change', (e: any) => {
          const inInsert = e.mode === 'insert'
          setIsVimInsert(inInsert)
          setVimMode(e.mode || 'normal')
          modeJustChangedRef.current = true
        })

        // :w to exit editing (save and close)
        Vim.defineEx('write', 'w', () => {
          exitEditing()
        })
      }

      // Capture Tab before TLDraw's global handler steals it
      const container = cmContainerRef.current
      const captureTab = (e: KeyboardEvent) => {
        if (e.key === 'Tab') {
          e.stopPropagation()
        }
      }
      container.addEventListener('keydown', captureTab, true)

      // Focus the editor
      view.focus()

      // Dispatch pending entry mode (from 'i' or ':' key when note was selected)
      if (pendingEntryMode && cm) {
        const mode = pendingEntryMode
        pendingEntryMode = null
        if (mode === 'i') {
          Vim.handleKey(cm, 'i', 'user')
        } else if (mode === ':') {
          Vim.handleKey(cm, ':', 'user')
        }
      }

      return () => {
        container.removeEventListener('keydown', captureTab, true)
        view.destroy()
        cmViewRef.current = null
        setIsVimInsert(false)
        setVimMode('normal')
      }
    }, [isEditing])

    // Wrapper keydown: stop TLDraw from stealing keys, handle Escape fallback
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
      stopEventPropagation(e)
      if (e.key === 'Tab') {
        e.preventDefault()
      }
      if (e.key === 'Escape') {
        if (modeJustChangedRef.current) {
          // Mode just changed (insert→normal) on this keypress — don't exit
          modeJustChangedRef.current = false
        } else {
          // Already in normal mode — exit editing
          editor.setEditingShape(null)
        }
      }
    }, [editor])

    // Divider drag handlers
    const handleDividerPointerDown = useCallback((e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      isDraggingRef.current = true
      const currentSplit = splitPx ?? Math.round(shape.props.h * 0.6)
      dragStartRef.current = { y: e.clientY, splitPx: currentSplit }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    }, [splitPx, shape.props.h])

    const handleDividerPointerMove = useCallback((e: React.PointerEvent) => {
      if (!isDraggingRef.current) return
      e.preventDefault()
      e.stopPropagation()
      const dy = e.clientY - dragStartRef.current.y
      const newSplit = Math.max(60, Math.min(shape.props.h - 40, dragStartRef.current.splitPx + dy))
      setSplitPx(newSplit)
    }, [shape.props.h])

    const handleDividerPointerUp = useCallback((e: React.PointerEvent) => {
      isDraggingRef.current = false
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    }, [])

    // Render content
    let content: React.ReactNode
    if (isEditing) {
      const showPreview = hasMath(localText) && previewHtml
      const editorHeight = showPreview
        ? (splitPx ?? Math.round(shape.props.h * 0.6))
        : shape.props.h - 20 // leave room for status bar
      const previewHeight = showPreview
        ? shape.props.h - editorHeight - 20 - 6 // 20 for status, 6 for divider
        : 0

      content = (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
          }}
          onKeyDown={handleKeyDown}
          onPointerDown={stopIfNotPenTouch(editor)}
        >
          {/* CodeMirror editor */}
          <div
            ref={cmContainerRef}
            style={{
              height: editorHeight,
              overflow: 'auto',
              flexShrink: 0,
            }}
          />
          {/* Draggable divider */}
          {showPreview && (
            <div
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              style={{
                height: '6px',
                cursor: 'row-resize',
                backgroundColor: 'rgba(0,0,0,0.06)',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div style={{
                width: '30px',
                height: '2px',
                backgroundColor: 'rgba(0,0,0,0.2)',
                borderRadius: '1px',
              }} />
            </div>
          )}
          {/* Live KaTeX preview */}
          {showPreview && (
            <div
              ref={previewRef}
              style={{
                height: previewHeight,
                overflow: 'auto',
                padding: '8px',
                fontSize: '14px',
                lineHeight: 1.4,
                opacity: 0.85,
                flexShrink: 0,
              }}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          )}
          {/* Status bar: vim mode + color dots */}
          <div
            className="math-note-statusbar"
            style={{
              height: '20px',
              lineHeight: '20px',
              fontSize: '10px',
              fontFamily: '"SF Mono", Menlo, monospace',
              padding: '0 8px',
              color: 'rgba(0,0,0,0.45)',
              backgroundColor: 'rgba(0,0,0,0.03)',
              borderTop: '1px solid rgba(0,0,0,0.06)',
              flexShrink: 0,
              userSelect: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>-- {vimMode.toUpperCase()} --</span>
            <span className="math-note-colors" style={{
              display: 'flex',
              gap: '2px',
              opacity: 0.3,
              transition: 'opacity 0.15s',
            }}>
              {['light-blue', 'light-green', 'yellow', 'violet', 'orange', 'light-red', 'grey'].map(c => (
                <span
                  key={c}
                  onPointerDown={(e) => {
                    if (editor.getInstanceState().isPenMode && e.pointerType === 'touch') return
                    e.stopPropagation()
                    editor.updateShape({
                      id: shape.id,
                      type: 'math-note' as any,
                      props: { color: c },
                    })
                  }}
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: NOTE_COLORS[c],
                    border: shape.props.color === c ? '1.5px solid rgba(0,0,0,0.5)' : '1px solid rgba(0,0,0,0.12)',
                    cursor: 'pointer',
                  }}
                />
              ))}
            </span>
            <style>{`.math-note-statusbar:hover .math-note-colors { opacity: 1 !important; }`}</style>
          </div>
        </div>
      )
    } else {
      const text = shape.props.text || ''
      const autoH = shape.props.autoSize
      const choices = shape.props.choices as string[] | undefined
      const selectedChoice = (shape.props.selectedChoice as number) ?? -1
      const hasChoices = choices && choices.length > 0

      let textContent
      if (renderedHtml) {
        textContent = (
          <div
            style={{
              padding: '12px',
              paddingBottom: hasChoices ? '4px' : '12px',
              fontSize: '14px',
              lineHeight: 1.4,
              color: '#1a1a1a',
            }}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )
      } else {
        textContent = (
          <div
            style={{
              padding: '12px',
              paddingBottom: hasChoices ? '4px' : '12px',
              fontSize: '14px',
              lineHeight: 1.4,
              whiteSpace: 'pre-wrap',
              color: '#1a1a1a',
            }}
          >
            {text || '\u00A0'}
          </div>
        )
      }

      content = (
        <div
          ref={contentRef}
          style={{
            overflow: autoH ? 'hidden' : 'auto',
            height: autoH ? 'auto' : '100%',
            boxSizing: 'border-box',
          }}
        >
          {textContent}
          {hasChoices && (
            <div style={{
              padding: '4px 10px 10px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px',
            }}>
              {choices.map((choice, i) => {
                const isSelected = selectedChoice === i
                const choiceHtml = hasMath(choice) ? renderMath(choice) : null
                return (
                  <button
                    key={i}
                    onPointerDown={(e) => {
                      if (editor.getInstanceState().isPenMode && e.pointerType === 'touch') return
                      e.stopPropagation()
                      editor.updateShape({
                        id: shape.id,
                        type: 'math-note' as any,
                        props: { selectedChoice: isSelected ? -1 : i },
                      })
                    }}
                    style={{
                      padding: '4px 12px',
                      fontSize: '12px',
                      lineHeight: 1.3,
                      border: isSelected ? '2px solid rgba(0,0,0,0.5)' : '1px solid rgba(0,0,0,0.15)',
                      borderRadius: '14px',
                      backgroundColor: isSelected ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.5)',
                      cursor: 'pointer',
                      fontWeight: isSelected ? 600 : 400,
                      transition: 'all 0.15s',
                    }}
                    {...(choiceHtml
                      ? { dangerouslySetInnerHTML: { __html: choiceHtml } }
                      : { children: choice }
                    )}
                  />
                )
              })}
            </div>
          )}
        </div>
      )
    }

    // Thread tab bar
    const meta = getThreadMeta(shape)
    const isInThread = !!meta.threadId
    const isActiveInThread = isInThread && (
      !meta.threadRootId
        ? !meta.activeReplyId  // root is active when activeReplyId is null/undefined
        : meta.activeReplyId === undefined // shouldn't happen, but safe fallback
    ) || (meta.threadRootId && (() => {
      // Reply: check if root's activeReplyId points to us
      const root = editor.getShape(meta.threadRootId as TLShapeId)
      return root && (getThreadMeta(root).activeReplyId === shape.id)
    })())

    // Context menu state for tab detach
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; shapeId: string } | null>(null)

    useEffect(() => {
      if (!contextMenu) return
      const dismiss = () => setContextMenu(null)
      document.addEventListener('pointerdown', dismiss, true)
      return () => document.removeEventListener('pointerdown', dismiss, true)
    }, [contextMenu])

    // Tab bar — only for threads with 2+ members. Only the visible tab renders it.
    let tabBar: React.ReactNode = null
    const root = isInThread ? findRoot(editor, shape) : shape
    // Skip expensive getThreadMembers for hidden tabs
    const members = isInThread && shape.opacity !== 0 ? getThreadMembers(editor, root) : isInThread ? [] : [shape]
    const showTabBar = isInThread && members.length >= 2 && shape.opacity !== 0

    if (showTabBar) {
      const inactiveBg = isDark ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.06)'
      const inactiveColor = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)'
      const activeColor = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)'
      const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
      const plusColor = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'

      tabBar = (
        <div
          style={{
            display: 'flex',
            alignItems: 'stretch',
            borderBottom: `1px solid ${borderColor}`,
            flexShrink: 0,
            pointerEvents: 'all',
          }}
          onPointerDown={stopIfNotPenTouch(editor)}
        >
          {members.map((m, i) => {
            const mActive = m.id === (getThreadMeta(root).activeReplyId || root.id)
            return (
              <div
                key={m.id}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  if (e.button === 2) return
                  switchTab(editor, root, m.id)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (getThreadMeta(m).threadRootId) {
                    setContextMenu({ x: e.clientX, y: e.clientY, shapeId: m.id })
                  }
                }}
                style={{
                  padding: '3px 8px',
                  fontSize: '9px',
                  fontFamily: '-apple-system, sans-serif',
                  cursor: 'pointer',
                  userSelect: 'none',
                  color: mActive ? activeColor : inactiveColor,
                  fontWeight: mActive ? 600 : 400,
                  backgroundColor: mActive ? 'transparent' : inactiveBg,
                  borderRight: `1px solid ${borderColor}`,
                  borderBottom: mActive ? `1px solid ${bgColor}` : 'none',
                  marginBottom: '-1px',
                }}
              >
                {i + 1}
              </div>
            )
          })}
          {/* + button */}
          <div
            onPointerDown={(e) => {
              e.stopPropagation()
              const replyId = createReply(editor, root)
              requestAnimationFrame(() => {
                editor.setEditingShape(replyId)
              })
            }}
            style={{
              padding: '3px 6px',
              fontSize: '10px',
              fontFamily: '-apple-system, sans-serif',
              cursor: 'pointer',
              userSelect: 'none',
              color: plusColor,
              backgroundColor: inactiveBg,
              marginBottom: '-1px',
            }}
          >
            +
          </div>
          {/* Spacer fills remaining width */}
          <div style={{ flex: 1 }} />
        </div>
      )
    }

    // Context menu portal for detach
    let contextMenuEl: React.ReactNode = null
    if (contextMenu) {
      contextMenuEl = (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 9999,
            background: isDark ? '#2a2a2a' : '#fff',
            border: `1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'}`,
            borderRadius: '4px',
            boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.4)' : '0 2px 8px rgba(0,0,0,0.12)',
            padding: '2px 0',
            pointerEvents: 'all',
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            style={{
              padding: '4px 12px',
              fontSize: '12px',
              cursor: 'pointer',
              fontFamily: '-apple-system, sans-serif',
              color: isDark ? '#ccc' : undefined,
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              const s = editor.getShape(contextMenu.shapeId as TLShapeId)
              if (s) detachFromThread(editor, s)
              setContextMenu(null)
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
            }}
          >
            Detach from thread
          </div>
        </div>
      )
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
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {tabBar}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
          {content}
          {/* Standalone + button for non-threaded notes */}
          {!showTabBar && !isEditing && shape.opacity !== 0 && (
            <div
              className="note-add-reply"
              onPointerDown={(e) => {
                e.stopPropagation()
                const replyId = createReply(editor, shape)
                requestAnimationFrame(() => {
                  editor.setEditingShape(replyId)
                })
              }}
            >
              +
            </div>
          )}
        </div>
        {contextMenuEl}
      </HTMLContainer>
    )
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={4} ry={4} />
  }
}
