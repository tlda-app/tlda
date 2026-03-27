/**
 * FleetChatShape — tldraw canvas shape that renders fleet chat messages.
 *
 * Uses chat-render.mjs from the fleet dashboard for consistent rendering.
 * Fetches from fleet API, renders with markdown + KaTeX, has text input.
 * Polls every 5s.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import katex from 'katex'
import MarkdownIt from 'markdown-it'
import { renderChatLine, esc, timeShort } from 'fleet-dashboard/js/chat-render.mjs'
import './fleet-chat.css'

const FLEET_API = 'http://localhost:5199'
const DEFAULT_W = 400
const DEFAULT_H = 600

// --- Markdown renderer using markdown-it + KaTeX ---

const md = new MarkdownIt({ html: false, breaks: true, linkify: true })

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

// --- Types ---

interface ChatEvent {
  id: number
  event_type?: string
  type: string | null
  timestamp: string | null
  from_id: string | null
  to_id: string | null
  text: string | null
  metadata: Record<string, unknown> | string | null
}

interface FleetAgent {
  id: string
  friendly_name: string | null
  labels: string[] | null
  last_seen: string | null
  dead: boolean
  human?: boolean
}

interface FleetTask {
  id: string
  status: string
  agent: string | null
  delegated_by: string | null
}

// --- Convert DB event to message format expected by renderChatLine ---

function eventToMessage(e: ChatEvent) {
  let metadata = e.metadata
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata) } catch { metadata = null }
  }
  const type = (e as any).event_type || e.type
  const msg: any = {
    type,
    from: e.from_id || (e as any).from,
    to: e.to_id || (e as any).to,
    text: e.text,
    timestamp: e.timestamp,
    read: true,
  }
  if (type === 'delegate') {
    msg._evType = 'delegate'
    msg._description = e.text || ''
    msg._taskId = (metadata as any)?.taskId || ''
    msg._fromLabel = (metadata as any)?.fromLabel || ''
    msg._toLabel = (metadata as any)?.toLabel || ''
    msg._criteria = (metadata as any)?.criteria || []
  } else if (type === 'task_done') {
    msg._evType = 'task_done'
    msg._description = e.text || ''
    msg._taskId = (metadata as any)?.taskId || ''
    msg._agent = (e as any).agent_id || e.from_id || ''
  } else if (type === 'terminal_user' || type === 'terminal_assistant') {
    msg._evType = type
  }
  if ((metadata as any)?.inline_attachments) {
    msg._inlineAttachments = (metadata as any).inline_attachments
  }
  if ((metadata as any)?.timer) {
    msg._timer = true
  }
  return msg
}

// --- Shape definition ---

export class FleetChatShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-chat' as const
  static override props = {
    w: T.number,
    h: T.number,
    filter: T.string,
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, filter: '' }
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

function makeCtx(agents: FleetAgent[], tasks: FleetTask[]) {
  return {
    agentLabel: (id: string) => {
      if (!id) return '[unknown]'
      const a = agents.find(a => a.id === id)
      if (a) return a.friendly_name || a.id
      return typeof id === 'string' ? id : String(id)
    },
    getNickClass: (id: string) => {
      if (!id) return 'nick-agent-0'
      const a = agents.find(a => a.id === id)
      if (a?.human) return 'nick-human'
      if (id === 'keepalive') return 'nick-keepalive'
      if (!nickMap.has(id)) {
        nickMap.set(id, nickColors[nickIdx % nickColors.length])
        nickIdx++
      }
      return nickMap.get(id)!
    },
    isHumanId: (id: string) => {
      const a = agents.find(a => a.id === id)
      return !!(a?.human)
    },
    getAgents: () => agents,
    getTasks: () => tasks,
    tldaToken: null as string | null,
    renderMarkdown: tldaRenderMarkdown,
  }
}

function FleetChatComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h, filter } = shape.props

  const [events, setEvents] = useState<ChatEvent[]>([])
  const [agents, setAgents] = useState<FleetAgent[]>([])
  const [tasks, setTasks] = useState<FleetTask[]>([])
  const [inputText, setInputText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const chatLogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const fetchData = useCallback(async () => {
    try {
      const eventsUrl = filter
        ? `${FLEET_API}/api/store/events?agent=${encodeURIComponent(filter)}&limit=50&before=999999999`
        : `${FLEET_API}/api/store/events?limit=50&before=999999999`
      const [eventsResp, stateResp] = await Promise.all([
        fetch(eventsUrl),
        fetch(`${FLEET_API}/api/state`),
      ])
      if (eventsResp.ok) {
        const data = await eventsResp.json()
        setEvents(data.events || [])
      }
      if (stateResp.ok) {
        const state = await stateResp.json()
        setAgents(state.agents || [])
        setTasks(state.tasks || [])
      }
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [filter])

  useEffect(() => {
    fetchData()
    const timer = setInterval(fetchData, 5000)
    return () => clearInterval(timer)
  }, [fetchData])

  // Build context and render messages
  const ctx = useMemo(() => makeCtx(agents, tasks), [agents, tasks])

  const chatMessages = useMemo(() => {
    return events
      .filter(e => {
        const t = (e as any).event_type || e.type
        return t === 'chat' || t === 'delegate' || t === 'task_done'
      })
      .sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return ta - tb
      })
      .map(e => eventToMessage(e))
      .filter(m => !m._timer) // skip timer-fired messages
  }, [events])

  const renderedHtml = useMemo(() => {
    return chatMessages.map(m => renderChatLine(m, ctx)).filter(Boolean).join('')
  }, [chatMessages, ctx])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (chatLogRef.current) {
      chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight
    }
  }, [renderedHtml])

  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      if (a.id) map[a.id] = a.friendly_name || (a.id || '').replace('fleet:', '')
    }
    map['fleet:skip'] = 'skip'
    return map
  }, [agents])

  const sendMessage = useCallback(async () => {
    const text = inputText.trim()
    if (!text || !filter) return
    try {
      await fetch(`${FLEET_API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, from: 'fleet:skip', to: filter }),
      })
      setInputText('')
      fetchData()
    } catch (e) {
      setError(`Send failed: ${(e as Error).message}`)
    }
  }, [inputText, filter, fetchData])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage])

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: 'all',
        overflow: 'hidden',
      }}
    >
      <div
        className="fleet-shape fleet-chat-shape"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#0f0f1a',
          border: '1px solid rgba(128, 128, 128, 0.2)',
          borderRadius: 8,
          fontSize: 11,
          color: '#8888a0',
          overflow: 'hidden',
          fontFamily: "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
          fontWeight: 300,
          lineHeight: 1.4,
        }}
        onPointerDown={stopEventPropagation}
      >
        {/* Header */}
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
          {filter && <span style={{ opacity: 0.5, fontWeight: 400 }}>
            {agentNames[filter] || filter.replace('fleet:', '')}
          </span>}
          {error && <span style={{ color: '#ef4444', marginLeft: 'auto', fontWeight: 400 }}>{error}</span>}
        </div>

        {/* Messages — rendered via chat-render.mjs */}
        <div
          ref={chatLogRef}
          className="fleet-chat-log"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '4px 0',
          }}
        >
          {chatMessages.length === 0 ? (
            <div style={{
              padding: '20px 8px',
              opacity: 0.3,
              textAlign: 'center',
              fontSize: 10,
            }}>
              {filter ? 'No messages' : 'No filter set'}
            </div>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          )}
        </div>

        {/* Input */}
        {filter && (
          <div style={{
            borderTop: '1px solid rgba(128, 128, 128, 0.15)',
            padding: 4,
            flexShrink: 0,
          }}>
            <input
              ref={inputRef}
              type="text"
              placeholder={`Message ${agentNames[filter] || 'agent'}...`}
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
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
              }}
            />
          </div>
        )}
      </div>
    </HTMLContainer>
  )
}
