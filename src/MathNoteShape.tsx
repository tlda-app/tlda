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
import { useCallback, useRef, useEffect, useState, useMemo, useSyncExternalStore } from 'react'
import {
  switchTab,
  addTab,
  detachTab,
} from './noteThreading'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { getActiveMacros } from './katexMacros'
import { subscribeSearchFilter, getSearchFilter } from './stores'

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

// Reply context: set before entering edit mode to show the tab being replied to
let pendingReplyContext: string | null = null
export function setReplyContext(text: string | null) { pendingReplyContext = text }

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
    tabs: T.optional(T.arrayOf(T.string)),
    activeTab: T.optional(T.number),
    done: T.optional(T.boolean),
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
    const [replyContext, setReplyContextState] = useState<string | null>(null)

    // Refs for sync coordination
    const suppressUpdateRef = useRef(false)
    const lastSentTextRef = useRef(shape.props.text || '')
    const modeJustChangedRef = useRef(false)

    const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
    const bgColor = NOTE_COLORS[shape.props.color] || NOTE_COLORS.yellow
    const isDone = shape.props.done === true
    const searchFilter = useSyncExternalStore(subscribeSearchFilter, getSearchFilter)
    const isFilteredOut = searchFilter !== null && !searchFilter.has(shape.id)

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
        // Pick up reply context if set
        if (pendingReplyContext) {
          setReplyContextState(pendingReplyContext)
          pendingReplyContext = null
        }
      } else {
        setReplyContextState(null)
      }
    }, [isEditing])

    // Auto-size: measure rendered content and grow shape height (never shrink)
    useEffect(() => {
      if (isEditing || !shape.props.autoSize) return
      const el = contentRef.current
      if (!el) return
      const measured = el.scrollHeight
      const target = Math.max(40, measured)
      // Only grow — never shrink unless user manually resizes
      if (target > shape.props.h + 2) {
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

        // :q to mark note as done and exit
        Vim.defineEx('quit', 'q', () => {
          editor.updateShape({
            id: shape.id,
            type: shape.type,
            props: { done: true },
          })
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
      const replyContextHtml = replyContext
        ? (hasMath(replyContext) ? renderMath(replyContext) : replyContext.replace(/\n/g, '<br>'))
        : null
      const contextHeight = replyContext ? Math.min(120, shape.props.h * 0.3) : 0
      const availH = shape.props.h - 16 - contextHeight // 16 for status bar
      const editorHeight = showPreview
        ? (splitPx ?? Math.round(availH * 0.6))
        : availH
      const previewHeight = showPreview
        ? availH - editorHeight - 6 // 6 for divider
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
          {/* Reply context — read-only view of the tab being replied to */}
          {replyContextHtml && (
            <div
              style={{
                height: contextHeight,
                overflow: 'auto',
                padding: '6px 8px',
                fontSize: '12px',
                lineHeight: 1.35,
                color: 'rgba(0,0,0,0.55)',
                backgroundColor: 'rgba(0,0,0,0.03)',
                borderBottom: '1px solid rgba(0,0,0,0.08)',
                flexShrink: 0,
              }}
              dangerouslySetInnerHTML={{ __html: replyContextHtml }}
            />
          )}
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
              height: '16px',
              lineHeight: '16px',
              fontSize: '9px',
              fontFamily: '"SF Mono", Menlo, monospace',
              padding: '0 8px',
              color: 'rgba(0,0,0,0.25)',
              backgroundColor: 'rgba(0,0,0,0.02)',
              borderTop: '1px solid rgba(0,0,0,0.04)',
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
      const shapeTabs = shape.props.tabs as string[] | undefined
      const hasChoices = choices && choices.length > 0 && (!shapeTabs || shapeTabs.length <= 1 || ((shape.props.activeTab as number) || 0) === 0)

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
          onPointerUp={(e) => {
            // Trackpad click in pen mode: enter editing if shape is already selected
            if (!editor.getInstanceState().isPenMode) return
            if (e.pointerType !== 'mouse') return
            if (!editor.getSelectedShapeIds().includes(shape.id)) return
            editor.setEditingShape(shape.id)
          }}
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

    // Tab bar — single-shape model: tabs stored in props.tabs
    const tabs = shape.props.tabs as string[] | undefined
    const activeTabIdx = (shape.props.activeTab as number) || 0
    const showTabBar = tabs && tabs.length > 1 && !isEditing

    // Auto-widen shape when tabs overflow (up to 400px)
    const tabCount = tabs?.length ?? 0
    useEffect(() => {
      if (tabCount < 2) return
      const TAB_WIDTH = 70 // ~padding + preview text
      const PADDING = 40 // + button + margin
      const needed = tabCount * TAB_WIDTH + PADDING
      const currentW = shape.props.w as number
      if (needed > currentW && currentW < 400) {
        const newW = Math.min(400, needed)
        editor.updateShape({ id: shape.id, type: shape.type, props: { w: newW } })
      }
    }, [tabCount]) // eslint-disable-line react-hooks/exhaustive-deps

    // Context menu state for tab detach
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabIndex: number } | null>(null)

    useEffect(() => {
      if (!contextMenu) return
      const dismiss = () => setContextMenu(null)
      document.addEventListener('pointerdown', dismiss, true)
      return () => document.removeEventListener('pointerdown', dismiss, true)
    }, [contextMenu])

    let tabBar: React.ReactNode = null
    if (showTabBar) {
      const inactiveColor = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)'
      const activeColor = isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)'
      const activeBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'
      const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'

      tabBar = (
        <div
          className="math-note-tabbar"
          style={{
            display: 'flex',
            alignItems: 'stretch',
            borderBottom: `1px solid ${borderColor}`,
            flexShrink: 0,
            overflowX: 'auto',
            scrollbarWidth: 'none',
          }}
        >
          {tabs.map((tabText, i) => {
            // Show content preview: first few words, stripped of $ delimiters
            const preview = (tabText || '').replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$[^$]*\$/g, '').trim()
            const label = preview ? preview.slice(0, 12).trim() + (preview.length > 12 ? '..' : '') : `${i + 1}`
            return (
              <div
                key={i}
                onPointerDown={(e) => {
                  stopEventPropagation(e)
                  if (e.button === 2) return
                  switchTab(editor, shape.id, i)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  stopEventPropagation(e)
                  if (tabs.length > 1) {
                    setContextMenu({ x: e.clientX, y: e.clientY, tabIndex: i })
                  }
                }}
                style={{
                  padding: '3px 8px',
                  fontSize: '10px',
                  fontFamily: '-apple-system, sans-serif',
                  cursor: 'pointer',
                  userSelect: 'none',
                  pointerEvents: 'all',
                  flexShrink: 0,
                  color: i === activeTabIdx ? activeColor : inactiveColor,
                  fontWeight: i === activeTabIdx ? 600 : 400,
                  borderBottom: i === activeTabIdx ? `2px solid ${activeColor}` : '2px solid transparent',
                  backgroundColor: i === activeTabIdx ? activeBg : 'transparent',
                  marginBottom: '-1px',
                  maxWidth: '80px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </div>
            )
          })}
          {/* Spacer — no pointerEvents, so drags pass through to TLDraw */}
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
          onPointerDown={(e) => stopEventPropagation(e)}
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
              stopEventPropagation(e)
              detachTab(editor, shape.id, contextMenu.tabIndex)
              setContextMenu(null)
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
            }}
          >
            Detach tab
          </div>
        </div>
      )
    }

    return (
      <HTMLContainer
        id={shape.id}
        style={{
          backgroundColor: bgColor,
          borderRadius: '4px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24)',
          pointerEvents: 'all',
          display: 'flex',
          flexDirection: 'column',
          opacity: isFilteredOut ? 0.15 : undefined,
          transition: 'opacity 0.2s',
        }}
      >
          {tabBar}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative',
            ...(isDone && !isEditing ? { maxHeight: '28px', opacity: 0.35 } : {}),
          }}>
            {content}
            {/* + button — always top-right, browser-style */}
            {!isEditing && (
              <div
                className="note-add-reply"
                onPointerDown={(e) => {
                  stopEventPropagation(e)
                  addTab(editor, shape.id, '')
                  requestAnimationFrame(() => {
                    editor.setEditingShape(shape.id)
                  })
                }}
              >
                +
              </div>
            )}
            {/* Done toggle — top-left, visible on hover */}
            {!isEditing && (
              <div
                className="note-done-toggle"
                onPointerDown={(e) => {
                  stopEventPropagation(e)
                  const newDone = !isDone
                  editor.updateShape({
                    id: shape.id,
                    type: shape.type,
                    props: { done: newDone },
                  })
                  // Teleport to right margin gutter when marking done
                  if (newDone) {
                    const pages = editor.getCurrentPageShapes()
                      .filter(s => s.type === 'svg-page')
                    let bestPage: typeof pages[0] | null = null
                    let bestDist = Infinity
                    for (const p of pages) {
                      const pb = editor.getShapePageBounds(p.id)
                      if (!pb) continue
                      const cy = shape.y + (shape.props as any).h / 2
                      const dist = cy < pb.minY ? pb.minY - cy : cy > pb.maxY ? cy - pb.maxY : 0
                      if (dist < bestDist) { bestDist = dist; bestPage = p }
                    }
                    if (bestPage) {
                      const pb = editor.getShapePageBounds(bestPage.id)
                      if (pb) {
                        editor.updateShape({
                          id: shape.id,
                          type: shape.type,
                          x: pb.maxX + 20,
                        } as any)
                      }
                    }
                  }
                }}
              >
                {isDone ? '\u2713' : '\u25CB'}
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
