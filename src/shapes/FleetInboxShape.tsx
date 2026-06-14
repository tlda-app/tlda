/**
 * FleetInboxShape — a threaded, intentional message inbox for the fleet dashboard.
 *
 * Unlike the all-agent chat firehose, this panel is scoped to messages to/from
 * the logged-in human (getHumanId), grouped into per-correspondent threads. You
 * open a thread on purpose (master/detail drill-in), read it, and its unread
 * clears. Read-only in v1; the conversation view reserves a composer slot so a
 * reply box drops in cleanly later.
 *
 * Reuses renderChatLine (identical chip/math/link rendering to FleetChatShape)
 * and the fleet-data event store via useFleetEvents.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import { agentDisplayName } from './fleet-utils'
import { usePillDrag } from './FleetAgentsShape'
import { useState, useCallback, useRef, useMemo, useEffect, memo } from 'react'
import { useFleetAgents, useFleetTasks, useFleetEvents, useFleetUnreadCounts, useFleetIdentity } from '../fleet-data-adapter'
import katex from 'katex'
import { getActiveMacros } from '../katexMacros'
import MarkdownIt from 'markdown-it'
// @ts-ignore — vanilla JS module
import { renderChatLine, esc, timeShort } from '../fleet/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath } from '../fleet/utils.mjs'
// @ts-ignore — vanilla JS module
import { getHumanId } from '../fleet/fleet-data.mjs'
import { useIsInViewport } from './useIsInViewport'
import './fleet-chat.css'
import './fleet-inbox.css'

const DEFAULT_W = 360
const DEFAULT_H = 560
const FLEET_API = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5176'

// --- Markdown renderer (same shape as FleetSearchShape's) ---
const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
md.renderer.rules.fence = (tokens: any[], idx: number) => {
  const token = tokens[idx]
  const lang = token.info.trim()
  const code = token.content
  const langLabel = lang ? `<span class="code-block-lang">${lang}</span>` : ''
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<div class="code-block-wrap"><div class="code-block-header">${langLabel}<span class="code-block-copy" title="Copy">⎘</span></div><pre><code>${escaped}</code></pre></div>`
}

function inboxRenderMarkdown(escapedHtml: string): string {
  let text = escapedHtml
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  text = text.replace(/<(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)[^>]*>[\s\S]*?<\/(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>/g, '')
  const macros = getActiveMacros()
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex: string) => {
    try { return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: true, strict: false, macros }) }
    catch { return `<div class="math-display">$$${esc(tex)}$$</div>` }
  })
  text = text.replace(/(?<![\\$\w])\$([^$\n]+?)\$(?![\\$\w\d])/g, (_, tex: string) => {
    try { return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: true, strict: false, macros }) }
    catch { return `<span class="math-inline">$${esc(tex)}$</span>` }
  })
  let result = md.render(text)
  const trimmed = result.trim()
  if (trimmed.startsWith('<p>') && trimmed.endsWith('</p>') && trimmed.indexOf('<p>', 1) === -1) {
    result = trimmed.slice(3, -4)
  }
  result = result.replace(/<a(?![^>]*target=)([^>]*href=")/g, '<a target="_blank"$1')
  return result
}

// Nick color system (mirrors FleetSearchShape's embedded chat)
const nickColors = ['nick-agent-0','nick-agent-1','nick-agent-2','nick-agent-3','nick-agent-4','nick-agent-5']
const nickHex = ['#7a9ec8','#9370db','#c8956a','#6aafb0','#b87a95','#c8b060']
const nickMap = new Map<string, string>()
const nickHexMap = new Map<string, string>()
let nickIdx = 0

function makeChatCtx(agents: any[], tasks: any[]) {
  const agentLabel = (id: string) => {
    if (!id) return '[unknown]'
    const a = agents.find((a: any) => a.id === id)
    if (a) return agentDisplayName(a)
    return typeof id === 'string' ? id : String(id)
  }
  const getNickClass = (id: string) => {
    if (!id) return 'nick-agent-0'
    const a = agents.find((a: any) => a.id === id)
    if (a?.human) return 'nick-human'
    if (!nickMap.has(id)) {
      const idx = nickIdx % nickColors.length
      nickMap.set(id, nickColors[idx])
      nickHexMap.set(id, nickHex[idx])
      nickIdx++
    }
    return nickMap.get(id)!
  }
  return {
    agentLabel, getNickClass,
    getAgentColor: (id: string) => nickHexMap.get(id) || '#9370db',
    isHumanId: (id: string) => !!(agents.find((a: any) => a.id === id)?.human),
    getAgents: () => agents,
    getTasks: () => tasks,
    tldaToken: null as string | null,
    renderMarkdown: inboxRenderMarkdown,
    highlightSyntax,
    langFromFilePath,
    preambleMacros: {},
  }
}

interface Thread {
  partnerId: string
  partnerName: string
  friendly: string      // stable filter value for drag-to-chat (friendly name)
  color: string         // nick hex for the drag pill
  nickClass: string
  messages: any[]       // chat events in this thread, oldest → newest
  last: any             // newest message
  lastTs: string
  unread: number
  preview: string
}

// Strip markdown / math / chips down to a one-line preview for the thread list.
function previewText(text: string): string {
  if (!text) return ''
  return text
    .replace(/```[\s\S]*?```/g, '⟨code⟩')
    .replace(/\$\$[\s\S]*?\$\$/g, '⟨math⟩')
    .replace(/\$[^$\n]+\$/g, '⟨math⟩')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export class FleetInboxShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-inbox' as const
  static override props = {
    w: T.number,
    h: T.number,
    userId: T.optional(T.string),
    deviceId: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, userId: '', deviceId: '' }
  }

  override canEdit = () => true
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <FleetInboxComponent shape={shape} />
  }

  indicator() {
    return null
  }
}

function FleetInboxInner({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h } = shape.props
  void useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const containerRef = useRef<HTMLDivElement>(null)
  const isSelectedRef = useRef(false)
  isSelectedRef.current = useValue('isSelected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])

  // Capture-phase pointerdown so clicks inside the panel don't get hijacked by
  // tldraw's setPointerCapture (mirrors FleetSearchShape).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!el!.contains(target)) return
      if (isSelectedRef.current) return
      // Let draggable names handle their own pointerdown (they start a pill drag).
      if (target.closest('.fleet-inbox-pill')) return
      editor.markEventAsHandled(e)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [editor])

  const identity = useFleetIdentity()
  const myId = identity.id || getHumanId()
  const myName = identity.name || ''

  const agents = useFleetAgents()
  const tasks = useFleetTasks()
  const ctx = useMemo(() => makeChatCtx(agents, tasks), [agents, tasks])
  // Drag a partner name → spawn a filtered chat (same pill drag as the agents panel).
  const { startDrag } = usePillDrag()

  // Scope to messages to/from me. The DNF filter resolves my labels (name + id).
  const filter = useMemo<[string, string][][] | null>(
    () => (myName ? [[['to', myName]], [['from', myName]]] : null),
    [myName],
  )
  const events = useFleetEvents(filter)
  const unreadCounts = useFleetUnreadCounts()

  // Which thread is open (partnerId), or null = thread list.
  const [openPartner, setOpenPartner] = useState<string | null>(null)

  // Group chat messages into per-correspondent threads.
  const threads = useMemo<Thread[]>(() => {
    if (!myId) return []
    const byPartner = new Map<string, any[]>()
    for (const ev of events) {
      if (ev.type !== 'chat') continue
      const from = ev.from
      const to = ev.to
      // Determine the non-me party.
      let partner: string | null = null
      if (to === myId) partner = from
      else if (from === myId) partner = to
      else continue // neither side is me (shouldn't happen given the filter)
      if (!partner || partner === myId) continue
      if (!byPartner.has(partner)) byPartner.set(partner, [])
      byPartner.get(partner)!.push(ev)
    }
    const out: Thread[] = []
    for (const [partnerId, msgs] of byPartner) {
      msgs.sort((a, b) => ((a.timestamp || '') < (b.timestamp || '') ? -1 : 1))
      const last = msgs[msgs.length - 1]
      const a = agents.find((x: any) => x.id === partnerId)
      const partnerName = a ? agentDisplayName(a) : partnerId.replace('fleet:', '')
      out.push({
        partnerId,
        partnerName,
        // Filters resolve friendly names, never IDs (see app-development), so the
        // drag value is the friendly name, falling back to the display name.
        friendly: (a?.friendly_name as string) || partnerName,
        nickClass: ctx.getNickClass(partnerId),
        color: ctx.getAgentColor(partnerId),
        messages: msgs,
        last,
        lastTs: last?.timestamp || '',
        unread: unreadCounts[partnerId] || 0,
        preview: previewText(last?.text || ''),
      })
    }
    // Newest thread on top (inbox order).
    out.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1))
    return out
  }, [events, myId, agents, ctx, unreadCounts])

  const totalUnread = useMemo(() => threads.reduce((n, t) => n + t.unread, 0), [threads])

  const openThread = useCallback((t: Thread) => {
    setOpenPartner(t.partnerId)
    // Mark-as-read: clear unread for incoming messages in this thread.
    const unread = t.messages.filter(
      (e: any) => e.to === myId && e.read !== true && (e._dbId || e.id),
    )
    for (const e of unread) {
      fetch(`${FLEET_API}/api/mark-event-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: e._dbId || e.id, agent: myId }),
      }).catch(() => {})
    }
  }, [myId])

  const activeThread = useMemo(
    () => (openPartner ? threads.find(t => t.partnerId === openPartner) || null : null),
    [openPartner, threads],
  )

  return (
    <HTMLContainer style={{ width: w, height: h, pointerEvents: 'all', overflow: 'visible' }}>
      <div
        ref={containerRef}
        className="fleet-shape fleet-inbox-shape"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 0,
          fontSize: 11,
          overflow: 'hidden',
          fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
          fontWeight: 300,
          lineHeight: 1.4,
          position: 'relative',
          color: 'var(--text, #8888a0)',
        }}
      >
        {/* Close + layout buttons */}
        <div className="fleet-btn-group" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="fleet-close-btn"
            onPointerUp={(e) => { e.stopPropagation(); editor.deleteShapes([shape.id]) }}
          >×</button>
          <button
            className="fleet-layout-btn"
            onPointerUp={(e) => { e.stopPropagation(); editor.setCurrentTool('select'); editor.select(shape.id) }}
            title="Resize / move"
          >⊞</button>
        </div>

        {/* Header */}
        <div className="fleet-inbox-header" onPointerDown={(e) => stopEventPropagation(e)}>
          {activeThread ? (
            <button className="fleet-inbox-back" onPointerUp={(e) => { stopEventPropagation(e); setOpenPartner(null) }}>
              ← inbox
            </button>
          ) : (
            <span className="fleet-inbox-title">Inbox</span>
          )}
          {activeThread ? (
            <span
              className={`fleet-inbox-thread-name fleet-inbox-pill ${activeThread.nickClass}`}
              style={{ cursor: 'grab', touchAction: 'none' }}
              onPointerDown={(e) => { e.stopPropagation(); startDrag(e, 'agent', activeThread.friendly, activeThread.partnerName, activeThread.color) }}
            >{activeThread.partnerName}</span>
          ) : (
            totalUnread > 0 && <span className="fleet-inbox-unread-total">{totalUnread}</span>
          )}
        </div>

        {/* Body */}
        {activeThread ? (
          <ConversationView thread={activeThread} ctx={ctx} myId={myId} onStartDrag={startDrag} />
        ) : (
          <ThreadList threads={threads} onOpen={openThread} onStartDrag={startDrag} />
        )}
      </div>
    </HTMLContainer>
  )
}

// Scroll like a chat: TLDraw grabs the wheel in the capture phase for canvas
// pan/zoom, so a panel's overflow div never scrolls on its own. Intercept the
// wheel on the container in the capture phase and scroll it ourselves — same
// pattern FleetChatShape uses for its backscroll.
function useWheelScroll(ref: { current: HTMLDivElement | null }) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      el.scrollTop += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', onWheel, { capture: true } as any)
  }, [ref])
}

type StartDrag = (e: React.PointerEvent, pillType: 'agent' | 'label', value: string, displayName: string, color: string) => void

function ThreadList({ threads, onOpen, onStartDrag }: { threads: Thread[]; onOpen: (t: Thread) => void; onStartDrag: StartDrag }) {
  const listRef = useRef<HTMLDivElement>(null)
  useWheelScroll(listRef)
  return (
    <div ref={listRef} className="fleet-inbox-list">
      {threads.length === 0 && (
        <div className="fleet-inbox-empty">no messages yet</div>
      )}
      {threads.map((t) => (
        <div
          key={t.partnerId}
          className={`fleet-inbox-thread${t.unread > 0 ? ' unread' : ''}`}
          onPointerUp={(e) => { stopEventPropagation(e); onOpen(t) }}
        >
          <div className="fleet-inbox-thread-row">
            <span
              className={`fleet-inbox-thread-partner fleet-inbox-pill ${t.nickClass}`}
              style={{ cursor: 'grab', touchAction: 'none' }}
              onPointerDown={(e) => { e.stopPropagation(); onStartDrag(e, 'agent', t.friendly, t.partnerName, t.color) }}
            >{t.partnerName}</span>
            <span className="fleet-inbox-thread-time">{timeShort(t.lastTs)}</span>
            {t.unread > 0 && <span className="fleet-inbox-thread-badge">{t.unread}</span>}
          </div>
          <div className="fleet-inbox-thread-preview">{t.preview || '…'}</div>
        </div>
      ))}
    </div>
  )
}

function ConversationView({ thread, ctx, myId, onStartDrag }: { thread: Thread; ctx: any; myId: string | null; onStartDrag: StartDrag }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)
  // Which message has its inline message-shaped chat open (one at a time).
  const [inlineOpenId, setInlineOpenId] = useState<string | null>(null)
  // Pin to bottom when the thread opens (newest message visible, like a chat).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread.partnerId, thread.messages.length])
  // Close the inline chat when switching threads.
  useEffect(() => { setInlineOpenId(null) }, [thread.partnerId])

  return (
    <>
      <div ref={scrollRef} className="fleet-inbox-conv fleet-chat-shape">
        {thread.messages.map((m, i) => {
          const lineHtml = renderChatLine(m, ctx)
          if (!lineHtml) return null
          const mine = m.from === myId
          const key = m._dbId || m.id || String(i)
          const open = inlineOpenId === key
          return (
            <div key={key} className={`fleet-inbox-msg${mine ? ' mine' : ''}`}>
              <div dangerouslySetInnerHTML={{ __html: lineHtml }} />
              {/* ↗ → open a message-shaped chat inline, in place (Piece 3).
                  Reuses the search arrow's exact look (hidden until hover). */}
              <span
                className="search-result-open"
                title={open ? 'Close chat' : 'Open chat here'}
                onPointerUp={(e) => { stopEventPropagation(e); setInlineOpenId(open ? null : key) }}
              >↗</span>
              {open && (
                <InlineConvoChat
                  thread={thread}
                  ctx={ctx}
                  myId={myId}
                  onStartDrag={onStartDrag}
                  onClose={() => setInlineOpenId(null)}
                />
              )}
            </div>
          )
        })}
      </div>
      {/* Composer slot — read-only in v1; a reply box drops in here. */}
      <div className="fleet-inbox-composer-slot" />
    </>
  )
}

// A chat for this conversation, rendered inline in the flow as a message-shaped
// block (Piece 3, model A). The drag handle detaches it onto the canvas as a
// real, persistent fleet-chat — reusing the same pill-drag → fleet-chat path the
// partner names use, so the dropped chat is owned + filtered to this convo.
// NOTE: the inner content (live composer vs read-only) is pending Skip's call;
// this renders the read-only conversation base both forms share.
function InlineConvoChat({ thread, ctx, myId, onStartDrag, onClose }: {
  thread: Thread
  ctx: any
  myId: string | null
  onStartDrag: StartDrag
  onClose: () => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  useWheelScroll(bodyRef)
  return (
    <div className="fleet-inbox-inline-chat fleet-chat-shape" onPointerDown={(e) => stopEventPropagation(e)}>
      <div className="fleet-inbox-inline-head">
        {/* Drag handle — pull the chat out onto the canvas to keep it. */}
        <span
          className="fleet-inbox-inline-grip fleet-inbox-pill"
          style={{ cursor: 'grab', touchAction: 'none' }}
          title="Drag onto the canvas to keep"
          onPointerDown={(e) => { e.stopPropagation(); onStartDrag(e, 'agent', thread.friendly, thread.partnerName, thread.color) }}
        >⠿</span>
        <span className={`fleet-inbox-inline-name ${thread.nickClass}`}>{thread.partnerName}</span>
        <span className="fleet-inbox-inline-close" onPointerUp={(e) => { stopEventPropagation(e); onClose() }}>×</span>
      </div>
      <div ref={bodyRef} className="fleet-inbox-inline-body">
        {thread.messages.map((m, i) => {
          const lineHtml = renderChatLine(m, ctx)
          if (!lineHtml) return null
          const mine = m.from === myId
          return (
            <div key={m._dbId || m.id || i} className={`fleet-inbox-msg${mine ? ' mine' : ''}`}>
              <div dangerouslySetInnerHTML={{ __html: lineHtml }} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

const FleetInboxComponent = memo(function FleetInboxComponent({ shape }: { shape: any }) {
  const { w, h } = shape.props as { w: number; h: number }
  const isInViewport = useIsInViewport(shape.id)
  if (!isInViewport) {
    return <HTMLContainer id={shape.id}><div style={{ width: w, height: h }} /></HTMLContainer>
  }
  return <FleetInboxInner shape={shape} />
}, (prev, next) => prev.shape.props === next.shape.props)
