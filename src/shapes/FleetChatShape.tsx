/**
 * FleetChatShape — tldraw canvas shape that renders fleet chat messages.
 *
 * Uses fleet-data.mjs (via adapter) for live SSE updates — no polling.
 * Renders with chat-render.mjs from the fleet dashboard.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import { useState, useEffect, useCallback, useRef, useMemo, useContext } from 'react'
import katex from 'katex'
import MarkdownIt from 'markdown-it'
import { renderChatLine, esc, timeShort } from 'fleet-dashboard/js/chat-render.mjs'
import { renderActivityGroup } from 'fleet-dashboard/js/activity-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath } from 'fleet-dashboard/js/utils.mjs'
import { useFleetAgents, useFleetEvents, useFleetTasks, useFleetActivity, sendMessage, loadBefore } from '../fleet-data-adapter'
import { DocContext } from '../PanelContext'
import { loadLookup, type LookupData } from '../synctexLookup'
import { linkifyDocRefs, buildRefResolver, refToCanvas, type DocRef } from '../docLinks'
import { PDF_HEIGHT } from '../layoutConstants'
import './fleet-chat.css'

const DEFAULT_W = 400
const DEFAULT_H = 600

// --- Markdown renderer using markdown-it + KaTeX ---

const md = new MarkdownIt({ html: true, breaks: true, linkify: true })

function tldaRenderMarkdown(escapedHtml: string): string {
  // Input is esc()'d — unescape for markdown-it
  let text = escapedHtml
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')

  // Strip system metadata tags
  text = text.replace(/<(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)[^>]*>[\s\S]*?<\/(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>/g, '')

  // KaTeX: display math $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false, strict: false })
    } catch { return `<div class="math-display">${esc(tex)}</div>` }
  })

  // KaTeX: inline math $...$
  text = text.replace(/(?<![\\$\w])\$([^$\n]+?)\$(?![\\$\w\d])/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false, strict: false })
    } catch { return `<span class="math-inline">${esc(tex)}</span>` }
  })

  // Render markdown
  let result = md.render(text)

  // Unwrap single <p> for inline chat layout
  const trimmed = result.trim()
  if (trimmed.startsWith('<p>') && trimmed.endsWith('</p>') && trimmed.indexOf('<p>', 1) === -1) {
    result = trimmed.slice(3, -4)
  }

  // Make links open in new tab
  result = result.replace(/<a(?![^>]*target=)([^>]*href=")/g, '<a target="_blank"$1')

  return result
}

// --- Shape definition ---

export class FleetChatShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-chat' as const
  static override props = {
    w: T.number,
    h: T.number,
    filter: T.arrayOf(T.arrayOf(T.arrayOf(T.string))),  // DNF of [role, label] tuples
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, filter: [] }
  }

  override canEdit = () => true
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <FleetChatComponent shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />
  }
}

// --- Nick color system (matches dashboard) ---

const nickColors = ['nick-agent-0','nick-agent-1','nick-agent-2','nick-agent-3','nick-agent-4','nick-agent-5']
const nickMap = new Map<string, string>()
let nickIdx = 0

function makeCtx(agents: any[], tasks: any[]) {
  const agentLabel = (id: string) => {
    if (!id) return '[unknown]'
    const a = agents.find((a: any) => a.id === id)
    if (a) return a.friendly_name || a.id
    return typeof id === 'string' ? id : String(id)
  }
  const getNickClass = (id: string) => {
    if (!id) return 'nick-agent-0'
    const a = agents.find((a: any) => a.id === id)
    if (a?.human) return 'nick-human'
    if (id === 'keepalive') return 'nick-keepalive'
    if (!nickMap.has(id)) {
      nickMap.set(id, nickColors[nickIdx % nickColors.length])
      nickIdx++
    }
    return nickMap.get(id)!
  }
  return {
    agentLabel,
    getNickClass,
    isHumanId: (id: string) => {
      const a = agents.find((a: any) => a.id === id)
      return !!(a?.human)
    },
    getAgents: () => agents,
    getTasks: () => tasks,
    tldaToken: null as string | null,
    renderMarkdown: tldaRenderMarkdown,
    highlightSyntax,
    langFromFilePath,
  }
}

function FleetChatComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const doc = useContext(DocContext)
  const { w, h, filter } = shape.props as { w: number; h: number; filter: [string, string][][] }
  const isEditing = useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])

  // DNF filter: [[a,b],[c]] means (a AND b) OR c
  const dnfFilter = filter.length > 0 ? filter : null

  // Load lookup data for doc reference resolution
  const [lookup, setLookup] = useState<LookupData | null>(null)
  useEffect(() => {
    if (!doc?.docName) return
    loadLookup(doc.docName).then(setLookup)
  }, [doc?.docName])

  const refResolver = useMemo(() => lookup ? buildRefResolver(lookup) : null, [lookup])

  // Live data from fleet-data.mjs via SSE
  const agents = useFleetAgents()
  const liveEvents = useFleetEvents(dnfFilter)
  const activityEvents = useFleetActivity(dnfFilter)
  const tasks = useFleetTasks()
  const [olderEvents, setOlderEvents] = useState<any[]>([])

  // Merge older (scrollback) events with live events + activity events
  const events = useMemo(() => {
    const all = [...liveEvents, ...activityEvents]
    if (olderEvents.length === 0) return all
    // Deduplicate by _dbId or timestamp+from
    const seen = new Set(all.map((e: any) => e._dbId || `${e.timestamp}:${e.from}`))
    const unique = olderEvents.filter((e: any) => !seen.has(e._dbId || `${e.timestamp}:${e.from}`))
    return [...unique, ...all]
  }, [liveEvents, activityEvents, olderEvents])

  // Reset older events when filter changes
  const filterKey = JSON.stringify(filter)
  useEffect(() => { setOlderEvents([]) }, [filterKey])

  const [inputText, setInputText] = useState('')
  const chatLogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Build context and render messages
  const ctx = useMemo(() => makeCtx(agents, tasks), [agents, tasks])

  const chatMessages = useMemo(() => {
    return events
      .filter((m: any) => {
        const t = m.type
        return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'activity'
      })
      .filter((m: any) => !m._timer) // skip timer-fired messages
      .sort((a: any, b: any) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return ta - tb
      })
  }, [events])

  const renderedHtml = useMemo(() => {
    // Group consecutive activity events from the same agent into cards
    const parts: string[] = []
    let activityGroup: any[] = []

    function flushActivity() {
      if (activityGroup.length === 0) return
      parts.push(
        `<div class="chat-activity-inline-wrap">${renderActivityGroup(activityGroup, ctx)}</div>`
      )
      activityGroup = []
    }

    for (const m of chatMessages) {
      if (m._activity) {
        // Continue grouping if same agent, otherwise flush and start new group
        if (activityGroup.length > 0 && activityGroup[0].from !== m.from) {
          flushActivity()
        }
        activityGroup.push(m)
      } else {
        flushActivity()
        const line = renderChatLine(m, ctx)
        if (line) parts.push(line)
      }
    }
    flushActivity()

    return parts.join('')
  }, [chatMessages, ctx])

  // Post-process HTML to add clickable doc links
  const linkedHtml = useMemo(() => {
    if (!doc) return renderedHtml
    return linkifyDocRefs(renderedHtml)
  }, [renderedHtml, doc])

  // Handle clicks on doc-link spans
  const handleDocLinkClick = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('.doc-link') as HTMLElement | null
    if (!target || !doc || !refResolver) return

    const refType = target.dataset.refType as DocRef['type']
    const refValue = target.dataset.refValue || ''
    const envType = target.dataset.envType

    const ref: DocRef = { type: refType, value: refValue, text: target.textContent || '', envType }
    const resolved = refResolver(ref)
    if (!resolved) return

    const canvasPos = refToCanvas(resolved, doc.pages, PDF_HEIGHT)
    if (!canvasPos) return

    e.stopPropagation()
    editor.centerOnPoint(canvasPos, { animation: { duration: 300 } })
  }, [doc, refResolver, editor])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (chatLogRef.current) {
      chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight
    }
  }, [linkedHtml])

  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      if (a.id) map[a.id] = a.friendly_name || (a.id || '').replace('fleet:', '')
    }
    map['fleet:skip'] = 'skip'
    return map
  }, [agents])

  // Derive a single send target: only when filter is exactly [[["to", agentId]]]
  const sendTarget = useMemo(() => {
    if (filter.length === 1 && filter[0].length === 1) {
      const [role, label] = filter[0][0]
      if (role === 'to') return label
    }
    return null
  }, [filterKey])

  // Derive a loadBefore agent: use first "to" or "from" label
  const loadBeforeAgent = useMemo(() => {
    for (const clause of filter) {
      for (const [, label] of clause) return label
    }
    return undefined
  }, [filterKey])

  const handleSend = useCallback(async () => {
    const text = inputText.trim()
    if (!text || !sendTarget) return
    await sendMessage(sendTarget, text)
    setInputText('')
  }, [inputText, sendTarget])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Stop ALL propagation so tldraw doesn't intercept keys
    e.stopPropagation()
    ;(e.nativeEvent as any).stopImmediatePropagation?.()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  // Infinite scroll — load older messages
  const loadingMore = useRef(false)
  const handleScroll = useCallback(async (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop > 50 || loadingMore.current || chatMessages.length === 0) return
    loadingMore.current = true
    const oldestTs = chatMessages[0]?.timestamp
    if (oldestTs) {
      const prevHeight = el.scrollHeight
      const older = await loadBefore(loadBeforeAgent, oldestTs, 50)
      if (older.length > 0) {
        setOlderEvents(prev => [...older, ...prev])
      }
      // Maintain scroll position
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevHeight
      })
    }
    loadingMore.current = false
  }, [chatMessages, loadBeforeAgent])

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: 'all',
        overflow: 'visible',
      }}
    >
      <div
        className="fleet-shape fleet-chat-shape"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 8,
          fontSize: 11,
          overflow: 'visible',
          fontFamily: "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
          fontWeight: 300,
          lineHeight: 1.4,
          position: 'relative',
        }}
      >
        {/* Close button */}
        <button
          className="fleet-close-btn"
          onPointerDown={stopEventPropagation}
          onPointerUp={(e) => {
            stopEventPropagation(e)
            editor.deleteShapes([shape.id])
          }}
        >
          ×
        </button>

        {/* Header — no stopEventPropagation so tldraw can select/drag from here */}
        <div style={{
          padding: '6px 10px',
          borderBottom: '1px solid rgba(128, 128, 128, 0.15)',
          fontSize: 10,
          fontWeight: 600,
          opacity: 0.6,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}>
          <span>fleet chat</span>
          {sendTarget && <span style={{ opacity: 0.5, fontWeight: 400 }}>
            {agentNames[sendTarget] || sendTarget.replace('fleet:', '')}
          </span>}
        </div>

        {/* Filter chips */}
        {filter.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 3,
              padding: '3px 10px',
              borderBottom: '1px solid rgba(128, 128, 128, 0.1)',
              flexShrink: 0,
              alignItems: 'center',
            }}
          >
            {filter.map((clause, ci) => (
              <span key={ci} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                {ci > 0 && <span style={{ fontSize: 8, opacity: 0.3, margin: '0 1px' }}>or</span>}
                {clause.map(([role, label], ti) => (
                  <span key={ti} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                    {ti > 0 && <span style={{ fontSize: 8, opacity: 0.3 }}>+</span>}
                    <span
                      onPointerDown={stopEventPropagation}
                      onPointerUp={(e) => {
                        stopEventPropagation(e)
                        const newFilter = filter
                          .map((c, i) => i === ci ? c.filter((_, j) => j !== ti) : c)
                          .filter(c => c.length > 0)
                        editor.updateShape({
                          id: shape.id,
                          type: 'fleet-chat',
                          props: { filter: newFilter },
                        })
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '0 4px',
                        borderRadius: 2,
                        background: 'rgba(128, 128, 128, 0.12)',
                        fontSize: 9,
                        cursor: 'pointer',
                        lineHeight: '14px',
                      }}
                    >
                      <span style={{ opacity: 0.4, marginRight: 2 }}>{role}:</span>
                      {agentNames[label] || label.replace('fleet:', '')}
                      <span style={{ marginLeft: 3, opacity: 0.4, fontSize: 8 }}>×</span>
                    </span>
                  </span>
                ))}
              </span>
            ))}
          </div>
        )}

        {/* Messages — rendered via chat-render.mjs */}
        <div
          ref={chatLogRef}
          className="fleet-chat-log"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '4px 0',
          }}
          onScroll={handleScroll}
          onClick={handleDocLinkClick}
        >
          {chatMessages.length === 0 ? (
            <div style={{
              padding: '20px 8px',
              opacity: 0.3,
              textAlign: 'center',
              fontSize: 10,
            }}>
              {filter.length > 0 ? 'No messages' : 'No filter set'}
            </div>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: linkedHtml }} />
          )}
        </div>

        {/* Input — only when filter resolves to a single agent */}
        {sendTarget && (
          <div style={{
            borderTop: '1px solid rgba(128, 128, 128, 0.15)',
            padding: 4,
            flexShrink: 0,
            overflow: 'visible',
          }}>
            <textarea
              ref={inputRef as any}
              placeholder={`Message ${agentNames[sendTarget] || 'agent'}...`}
              rows={1}
              onKeyDown={(e) => {
                stopEventPropagation(e)
                const ta = e.currentTarget
                if (e.key === 'Enter' && !e.shiftKey) {
                  const val = ta.value
                  if (val.trim() === '') {
                    e.preventDefault() // suppress on empty
                    return
                  }
                  // Get text before cursor on current line
                  const before = val.substring(0, ta.selectionStart || val.length)
                  const lastNewline = before.lastIndexOf('\n')
                  const lineText = before.substring(lastNewline + 1)

                  if (lineText.trim() === '') {
                    // Blank line (double-enter) = send
                    e.preventDefault()
                    const text = val.trim()
                    if (text && sendTarget) {
                      sendMessage(sendTarget, text)
                      ta.value = ''
                      ta.style.height = 'auto'
                    }
                  } else if (lineText.endsWith(' ')) {
                    // Trailing space = newline (let default happen)
                    return
                  } else {
                    // Non-blank, no trailing space = send
                    e.preventDefault()
                    const text = val.trim()
                    if (text && sendTarget) {
                      sendMessage(sendTarget, text)
                      ta.value = ''
                      ta.style.height = 'auto'
                    }
                  }
                }
              }}
              onInput={(e) => {
                // Auto-resize
                const ta = e.currentTarget
                ta.style.height = 'auto'
                ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
              }}
              onPointerDown={stopEventPropagation}
              onFocus={stopEventPropagation}
              style={{
                width: '100%',
                background: 'rgba(128, 128, 128, 0.08)',
                border: '1px solid rgba(128, 128, 128, 0.15)',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 11,
                color: 'inherit',
                outline: 'none',
                resize: 'none',
                lineHeight: 1.4,
                fontFamily: 'inherit',
              }}
              onDrop={(e) => {
                // Handle tldraw drag attachments
                const types = e.dataTransfer?.types || []
                if (types.includes('application/x-chat-attachment') || types.includes('text/plain')) {
                  e.preventDefault()
                  e.stopPropagation()
                  const text = e.dataTransfer?.getData('text/plain') || ''
                  if (text) {
                    const ta = e.currentTarget
                    const pos = ta.selectionStart || ta.value.length
                    ta.value = ta.value.slice(0, pos) + text + ta.value.slice(pos)
                  }
                }
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
            />
          </div>
        )}
      </div>
    </HTMLContainer>
  )
}
