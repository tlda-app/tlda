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
  createShapeId,
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
import { dropPillOnTarget, chatInsertBus, refStore } from './FleetPillShape'
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
  override hideSelectionBoundsBg = () => true
  override hideSelectionBoundsFg = () => true

  component(shape: any) {
    return <FleetChatComponent shape={shape} />
  }

  indicator() {
    return null
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
    let html = doc ? linkifyDocRefs(renderedHtml) : renderedHtml
    // Turn «type:label» reference tokens into chips with hover preview
    html = html.replace(/«(.+?)»/g, (match, inner) => {
      const token = `«${inner}»`
      const ref = refStore.get(token)
      // Display: strip the "type:" prefix, show just the label
      const colonIdx = inner.indexOf(':')
      const display = colonIdx >= 0 ? inner.slice(colonIdx + 1) : inner
      const displayEsc = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const content = ref?.content || ''
      const contentEsc = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const preview = content ? `<span class="ref-chip-preview">${contentEsc}</span>` : ''
      return `<span class="ref-chip">${displayEsc}${preview}</span>`
    })
    return html
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

  // Detect pill drag hovering over this chat — returns stable string to avoid flicker
  const pillOverKey = useValue('pill-over', () => {
    const pills = editor.getCurrentPageShapes().filter(s => s.type === 'fleet-pill')
    if (pills.length === 0) return ''
    const myBounds = editor.getShapePageBounds(shape.id)
    if (!myBounds) return ''
    for (const pill of pills) {
      const pb = editor.getShapePageBounds(pill.id)
      if (!pb) continue
      const cx = pb.x + pb.w / 2
      const cy = pb.y + pb.h / 2
      if (cx >= myBounds.x && cx <= myBounds.x + myBounds.w &&
          cy >= myBounds.y && cy <= myBounds.y + myBounds.h) {
        const role = cy < myBounds.y + myBounds.h / 2 ? 'to' : 'from'
        return `${role}\0${(pill as any).props.value}\0${(pill as any).props.displayName}`
      }
    }
    return ''
  }, [editor, shape.id])
  const pillOver = useMemo(() => {
    if (!pillOverKey) return null
    const [role, value, displayName] = pillOverKey.split('\0')
    return { role, value, displayName }
  }, [pillOverKey])

  // Preview of what filter will look like after drop
  const dropPreview = useMemo(() => {
    if (!pillOver) return null
    const newTerm: [string, string] = [pillOver.role, pillOver.value]
    if (filter.length === 0) return [[newTerm]]
    const lastClause = filter[filter.length - 1]
    if (lastClause.some(([r, l]) => r === pillOver.role && l === pillOver.value)) return filter
    return [...filter.slice(0, -1), [...lastClause, newTerm]]
  }, [pillOver, filter])

  // Derive send targets: unique agents in "to" clauses only
  const sendTargets = useMemo(() => {
    const seen = new Set<string>()
    for (const clause of filter) {
      for (const [role, label] of clause) {
        if (role === 'to') seen.add(label)
      }
    }
    return [...seen]
  }, [filterKey])

  // Single target shorthand (for placeholder text etc.)
  const sendTarget = sendTargets.length === 1 ? sendTargets[0] : null

  // Derive a loadBefore agent: use first agent in filter
  const loadBeforeAgent = sendTargets[0] ?? undefined

  const handleSend = useCallback(async () => {
    const text = inputText.trim()
    if (!text || sendTargets.length === 0) return
    for (const target of sendTargets) {
      await sendMessage(target, text)
    }
    setInputText('')
  }, [inputText, sendTargets])

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

  // --- Chat log drag → ghost pill ---
  // Uses native capture-phase listeners because tldraw intercepts React events
  const DRAG_THRESHOLD = 5
  const dragRef = useRef<{
    pillId: string | null
    pillType: string
    value: string
    displayName: string
    color: string
    content?: string
    startX: number
    startY: number
    started: boolean
    captureEl: HTMLElement | null
    pointerId: number
  } | null>(null)

  // Store agentNames in a ref so native listeners can access current value
  const agentNamesRef = useRef(agentNames)
  agentNamesRef.current = agentNames

  // Store shape.id in a ref so document-level listeners can access it
  const shapeIdRef = useRef(shape.id)
  shapeIdRef.current = shape.id

  useEffect(() => {
    const logEl = chatLogRef.current
    if (!logEl) return

    // Document-level capture listeners: fires before tldraw's tl-container
    // listener can intercept. We scope to this chat by checking if the target
    // is inside our logEl.

    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!logEl.contains(target)) return

      const names = agentNamesRef.current

      // Only intercept on draggable elements
      const isDraggable = target.closest('.chat-nick span[class*="nick-"], .chat-ts, .chat-activity-card, .code-block-header, .tool-ref')
      if (!isDraggable) return

      let drag: typeof dragRef.current = null

      // Agent name
      const nickSpan = target.closest('.chat-nick span[class*="nick-"]') as HTMLElement
      if (nickSpan) {
        const line = nickSpan.closest('.chat-line') as HTMLElement
        const agentId = line?.dataset.msgFrom
        if (agentId) {
          drag = {
            pillId: null, pillType: 'agent', value: agentId,
            displayName: nickSpan.textContent?.replace(/:$/, '') || agentId,
            color: '#7a9ec8', startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Timestamp → message reference
      if (!drag) {
        const tsEl = target.closest('.chat-ts') as HTMLElement
        if (tsEl) {
          const line = tsEl.closest('.chat-line') as HTMLElement
          if (line) {
            const from = line.dataset.msgFrom || ''
            const ts = line.dataset.msgTs || ''
            const text = line.textContent?.slice(0, 200)?.trim() || ''
            const nick = names[from] || from.replace('fleet:', '')
            drag = {
              pillId: null, pillType: 'msg', value: `msg:${from}:${ts}`,
              displayName: `${nick} ${tsEl.textContent || ''}`.trim(),
              color: '#8888a0', content: text,
              startX: e.clientX, startY: e.clientY,
              started: false, captureEl: logEl, pointerId: e.pointerId,
            }
          }
        }
      }

      // Activity card
      if (!drag) {
        const actCard = target.closest('.chat-activity-card') as HTMLElement
        if (actCard) {
          const agentId = actCard.dataset.agent || ''
          const ts = actCard.dataset.ts || ''
          const text = actCard.textContent?.slice(0, 300)?.trim() || ''
          const nick = names[agentId] || agentId.replace('fleet:', '')
          drag = {
            pillId: null, pillType: 'activity', value: `activity:${agentId}:${ts}`,
            displayName: `${nick} activity`,
            color: '#c8b060', content: text,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Code block header
      if (!drag) {
        const codeHeader = target.closest('.code-block-header') as HTMLElement
        if (codeHeader) {
          const wrap = codeHeader.closest('.code-block-wrap')
          const code = wrap?.querySelector('pre code')
          if (code) {
            const langEl = codeHeader.querySelector('.code-block-lang')
            drag = {
              pillId: null, pillType: 'code', value: 'code',
              displayName: langEl?.textContent || 'code',
              color: '#6aafb0', content: code.textContent || '',
              startX: e.clientX, startY: e.clientY,
              started: false, captureEl: logEl, pointerId: e.pointerId,
            }
          }
        }
      }

      // Tool ref
      if (!drag) {
        const toolRef = target.closest('.tool-ref') as HTMLElement
        if (toolRef) {
          const preview = toolRef.querySelector('.tool-ref-preview')
          drag = {
            pillId: null, pillType: 'tool', value: 'tool',
            displayName: toolRef.querySelector('.tool-ref-type')?.textContent || 'tool',
            color: '#c8b060', content: (preview?.textContent || toolRef.textContent || '').trim(),
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      if (!drag) return

      e.stopImmediatePropagation()
      e.preventDefault()
      dragRef.current = drag
    }

    function onPointerMove(e: PointerEvent) {
      const drag = dragRef.current
      if (!drag) return
      e.stopImmediatePropagation()
      e.preventDefault()
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.started) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
        drag.started = true
        const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
        const pillId = createShapeId()
        editor.createShape({
          id: pillId,
          type: 'fleet-pill',
          x: pagePos.x - 35,
          y: pagePos.y - 9,
          props: {
            w: 70, h: 18,
            pillType: drag.pillType,
            value: drag.value,
            displayName: drag.displayName,
            color: drag.color,
          },
        })
        drag.pillId = pillId as unknown as string
      }
      if (drag.pillId) {
        const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
        editor.updateShape({
          id: drag.pillId as any,
          type: 'fleet-pill',
          x: pagePos.x - 35,
          y: pagePos.y - 9,
        })
      }
    }

    function onPointerUp(e: PointerEvent) {
      const drag = dragRef.current
      if (!drag) return
      e.stopImmediatePropagation()
      dragRef.current = null
      if (!drag.started || !drag.pillId) return
      const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
      dropPillOnTarget(editor, drag.pillId as any, drag.value, pagePos, drag.content)
      try { editor.deleteShapes([drag.pillId as any]) } catch {}
    }

    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    document.addEventListener('pointermove', onPointerMove, { capture: true })
    document.addEventListener('pointerup', onPointerUp, { capture: true })

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
      document.removeEventListener('pointermove', onPointerMove, { capture: true })
      document.removeEventListener('pointerup', onPointerUp, { capture: true })
    }
  }, [editor])

  // --- chatInsertBus listener: content drops insert into textarea ---
  useEffect(() => {
    const handler = (e: Event) => {
      const { chatId, text } = (e as CustomEvent).detail
      if (chatId !== shape.id) return
      const ta = inputRef.current as HTMLTextAreaElement | null
      if (!ta) return
      const pos = ta.selectionStart ?? ta.value.length
      const before = ta.value.slice(0, pos)
      const after = ta.value.slice(pos)
      const insert = (before && !before.endsWith('\n') ? '\n' : '') + text + (after && !after.startsWith('\n') ? '\n' : '')
      ta.value = before + insert + after
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
      ta.focus()
    }
    chatInsertBus.addEventListener('insert', handler)
    return () => chatInsertBus.removeEventListener('insert', handler)
  }, [shape.id])

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
        {/* Drop overlay — visible when pill is dragged over this chat */}
        {pillOver && (
          <div style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 8,
            overflow: 'hidden',
            pointerEvents: 'none',
          }}>
            {/* Top zone: "to" */}
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: pillOver.role === 'to'
                ? 'rgba(122, 158, 200, 0.15)'
                : 'rgba(128, 128, 128, 0.04)',
              borderBottom: '1px solid rgba(128, 128, 128, 0.15)',
              transition: 'background 0.1s',
            }}>
              <span style={{ fontSize: 9, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                to
              </span>
              {pillOver.role === 'to' && dropPreview && (
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 3, justifyContent: 'center', padding: '0 10px' }}>
                  {dropPreview.map((clause, ci) => (
                    <span key={ci} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      {ci > 0 && <span style={{ fontSize: 8, opacity: 0.3 }}>or</span>}
                      {clause.map(([role, label], ti) => (
                        <span key={ti} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          {ti > 0 && <span style={{ fontSize: 8, opacity: 0.3 }}>+</span>}
                          <span style={{
                            padding: '0 4px',
                            borderRadius: 2,
                            background: role === pillOver.role && label === pillOver.value
                              ? 'rgba(122, 158, 200, 0.3)'
                              : 'rgba(128, 128, 128, 0.12)',
                            fontSize: 9,
                            lineHeight: '14px',
                          }}>
                            <span style={{ opacity: 0.4, marginRight: 2 }}>{role}:</span>
                            {agentNames[label] || label.replace('fleet:', '')}
                          </span>
                        </span>
                      ))}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {/* Bottom zone: "from" */}
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: pillOver.role === 'from'
                ? 'rgba(122, 184, 160, 0.15)'
                : 'rgba(128, 128, 128, 0.04)',
              transition: 'background 0.1s',
            }}>
              <span style={{ fontSize: 9, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                from
              </span>
              {pillOver.role === 'from' && dropPreview && (
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 3, justifyContent: 'center', padding: '0 10px' }}>
                  {dropPreview.map((clause, ci) => (
                    <span key={ci} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      {ci > 0 && <span style={{ fontSize: 8, opacity: 0.3 }}>or</span>}
                      {clause.map(([role, label], ti) => (
                        <span key={ti} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          {ti > 0 && <span style={{ fontSize: 8, opacity: 0.3 }}>+</span>}
                          <span style={{
                            padding: '0 4px',
                            borderRadius: 2,
                            background: role === pillOver.role && label === pillOver.value
                              ? 'rgba(122, 184, 160, 0.3)'
                              : 'rgba(128, 128, 128, 0.12)',
                            fontSize: 9,
                            lineHeight: '14px',
                          }}>
                            <span style={{ opacity: 0.4, marginRight: 2 }}>{role}:</span>
                            {agentNames[label] || label.replace('fleet:', '')}
                          </span>
                        </span>
                      ))}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

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

        {/* Filter chips removed — filter is set via pill drag overlay */}

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

        {/* Input */}
        <div style={{
          borderTop: '1px solid rgba(128, 128, 128, 0.15)',
          padding: 4,
          flexShrink: 0,
          position: 'relative',
        }}>
          <SendHint
            filter={filter}
            sendTargets={sendTargets}
            agentNames={agentNames}
            inputRef={inputRef}
          />
          <div style={{ position: 'relative' }}>
            {/* Highlight underlay — mirrors textarea text, highlights <<ref>> tokens */}
            <InputHighlightUnderlay inputRef={inputRef} />
            <textarea
              ref={inputRef as any}
              placeholder={sendTargets.length > 0 ? `Message ${sendTargets.map(t => agentNames[t] || t.replace('fleet:', '')).join(', ')}...` : 'Message...'}
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
                    if (text && sendTargets.length > 0) {
                      for (const t of sendTargets) sendMessage(t, text)
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
                    if (text && sendTargets.length > 0) {
                      for (const t of sendTargets) sendMessage(t, text)
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
                background: 'transparent',
                border: '1px solid rgba(128, 128, 128, 0.15)',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 11,
                color: 'inherit',
                outline: 'none',
                resize: 'none',
                lineHeight: 1.4,
                fontFamily: 'inherit',
                position: 'relative',
                zIndex: 1,
              }}
              onDrop={async (e) => {
                e.preventDefault()
                e.stopPropagation()
                const ta = e.currentTarget

                // External file drops
                const files = [...(e.dataTransfer?.files || [])]
                if (files.length > 0) {
                  for (const file of files) {
                    if (file.type.startsWith('text/') || /\.(txt|md|tex|json|js|ts|py|r|css|html|csv|yaml|yml|toml|sh|sql|xml)$/i.test(file.name)) {
                      // Text file → read contents, insert as code block
                      const text = await file.text()
                      const ext = file.name.split('.').pop() || ''
                      const block = `\`\`\`${ext}\n${text}\n\`\`\``
                      const token = `«file:${file.name}»`
                      refStore.set(token, { type: 'file', label: file.name, content: text })
                      const pos = ta.selectionStart || ta.value.length
                      ta.value = ta.value.slice(0, pos) + token + ta.value.slice(pos)
                      ta.dispatchEvent(new Event('input', { bubbles: true }))
                    } else if (file.type.startsWith('image/')) {
                      // Image → upload to fleet dashboard, insert markdown
                      try {
                        const buf = await file.arrayBuffer()
                        const res = await fetch('/api/upload', { method: 'POST', body: buf })
                        const data = await res.json()
                        if (data.url) {
                          const pos = ta.selectionStart || ta.value.length
                          ta.value = ta.value.slice(0, pos) + `![${file.name}](${data.url})` + ta.value.slice(pos)
                          ta.dispatchEvent(new Event('input', { bubbles: true }))
                        }
                      } catch {}
                    } else {
                      // Other file → insert path reference
                      const token = `«file:${file.name}»`
                      const pos = ta.selectionStart || ta.value.length
                      ta.value = ta.value.slice(0, pos) + token + ta.value.slice(pos)
                      ta.dispatchEvent(new Event('input', { bubbles: true }))
                    }
                  }
                  return
                }

                // Text/attachment drops (from other chat elements)
                const text = e.dataTransfer?.getData('text/plain') || ''
                if (text) {
                  const pos = ta.selectionStart || ta.value.length
                  ta.value = ta.value.slice(0, pos) + text + ta.value.slice(pos)
                }
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
          />
          </div>
        </div>
      </div>
    </HTMLContainer>
  )
}

function SendHint({
  filter,
  sendTargets,
  agentNames,
  inputRef,
}: {
  filter: [string, string][][]
  sendTargets: string[]
  agentNames: Record<string, string>
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const [hint, setHint] = useState('')

  const targetLabel = useMemo(() => {
    if (sendTargets.length === 0) return ''
    return sendTargets.map(t => agentNames[t] || t.replace('fleet:', '')).join(' + ')
  }, [sendTargets, agentNames])

  const update = useCallback(() => {
    const el = inputRef.current as HTMLTextAreaElement | null
    if (!el) {
      setHint(targetLabel ? `→ ${targetLabel}` : '')
      return
    }
    const val = el.value
    if (!val) {
      setHint(targetLabel ? `→ ${targetLabel}` : '')
      return
    }
    const pos = el.selectionStart ?? val.length
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1
    const currentLine = val.slice(lineStart, pos)
    if (currentLine.endsWith(' ')) {
      setHint('↵ newline')
    } else {
      setHint(targetLabel ? `↵ → ${targetLabel}` : '↵')
    }
  }, [targetLabel, inputRef])

  useEffect(() => {
    update()
  }, [targetLabel, update])

  useEffect(() => {
    const el = inputRef.current as HTMLTextAreaElement | null
    if (!el) return
    const handler = () => update()
    el.addEventListener('input', handler)
    el.addEventListener('keyup', handler)
    el.addEventListener('focus', handler)
    el.addEventListener('blur', handler)
    return () => {
      el.removeEventListener('input', handler)
      el.removeEventListener('keyup', handler)
      el.removeEventListener('focus', handler)
      el.removeEventListener('blur', handler)
    }
  }, [inputRef, update])

  if (!hint) return null

  return (
    <span className="fleet-chat-send-hint">
      {hint}
    </span>
  )
}

/** Underlay div that mirrors textarea content, highlighting <<ref>> tokens */
function InputHighlightUnderlay({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [html, setHtml] = useState('')

  useEffect(() => {
    const el = inputRef.current as HTMLTextAreaElement | null
    if (!el) return
    const sync = () => {
      const val = el.value
      if (!val || !val.includes('«')) {
        setHtml('')
        return
      }
      // Escape HTML, then highlight «...» tokens
      const escaped = val
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      const highlighted = escaped.replace(
        /(«.+?»)/g,
        '<span class="ref-chip-underlay">$1</span>'
      )
      setHtml(highlighted)
    }
    el.addEventListener('input', sync)
    // Also sync on external value changes (chatInsertBus)
    const observer = new MutationObserver(sync)
    observer.observe(el, { attributes: true })
    sync()
    return () => {
      el.removeEventListener('input', sync)
      observer.disconnect()
    }
  }, [inputRef])

  if (!html) return null

  return (
    <div
      className="fleet-chat-input-underlay"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
