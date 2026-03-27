/**
 * FleetChatShape — tldraw canvas shape that renders fleet chat messages.
 *
 * Fetches from fleet API, renders messages with markdown + KaTeX,
 * has a text input for sending messages. Polls every 5s.
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

const FLEET_API = 'http://localhost:5199'
const DEFAULT_W = 400
const DEFAULT_H = 600

// --- Markdown + KaTeX rendering (from FleetTab) ---

function renderMarkdown(text: string): string {
  if (!text) return ''
  let html = text.replace(/\$\$([^$]+)\$\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { throwOnError: false, displayMode: true })
    } catch { return tex }
  })
  html = html.replace(/\$([^$]+)\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { throwOnError: false, displayMode: false })
    } catch { return tex }
  })
  html = html.replace(/```([^`]*?)```/gs, '<pre><code>$1</code></pre>')
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  html = html.replace(/\n/g, '<br>')
  return html
}

function formatRelativeTime(ts: number | undefined): string {
  if (!ts) return ''
  const delta = Date.now() - ts
  if (delta < 60_000) return 'now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h`
  return `${Math.floor(delta / 86400_000)}d`
}

// --- Types ---

interface ChatEvent {
  id: number
  type: string | null
  timestamp: string | null
  from_id: string | null
  to_id: string | null
  text: string | null
  metadata: Record<string, unknown> | null
}

interface FleetAgent {
  id: string
  friendly_name: string | null
  labels: string[] | null
  last_seen: string | null
  dead: boolean
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

function FleetChatComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h, filter } = shape.props

  const [events, setEvents] = useState<ChatEvent[]>([])
  const [agents, setAgents] = useState<FleetAgent[]>([])
  const [inputText, setInputText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const fetchData = useCallback(async () => {
    try {
      const eventsUrl = filter
        ? `${FLEET_API}/api/store/events?agent=${encodeURIComponent(filter)}&limit=50`
        : `${FLEET_API}/api/store/events?limit=50`
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

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      if (a.id) map[a.id] = a.friendly_name || (a.id || '').replace('fleet:', '')
    }
    map['fleet:skip'] = 'skip'
    return map
  }, [agents])

  const chatEvents = useMemo(() => {
    return events
      .filter(e => e.type === 'chat' && e.text && !(e.metadata as any)?.timer)
      .sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return ta - tb
      })
  }, [events])

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
          backgroundColor: 'var(--color-background, #1e1e1e)',
          border: '1px solid rgba(128, 128, 128, 0.2)',
          borderRadius: 8,
          fontSize: 11,
          color: 'var(--color-text, #e0e0e0)',
          overflow: 'hidden',
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
          <span style={{ fontSize: 12 }}>💬</span>
          <span>fleet chat</span>
          {filter && <span style={{ opacity: 0.5, fontWeight: 400 }}>
            · {agentNames[filter] || filter.replace('fleet:', '')}
          </span>}
          {error && <span style={{ color: '#ef4444', marginLeft: 'auto', fontWeight: 400 }}>{error}</span>}
        </div>

        {/* Messages */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 0',
        }}>
          {chatEvents.length === 0 ? (
            <div style={{
              padding: '20px 8px',
              opacity: 0.3,
              textAlign: 'center',
              fontSize: 10,
            }}>
              {filter ? 'No messages' : 'No filter set'}
            </div>
          ) : (
            chatEvents.map(ev => {
              const fromName = agentNames[ev.from_id || ''] || (ev.from_id || '').replace('fleet:', '')
              const isSkip = ev.from_id === 'fleet:skip'
              const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : undefined
              return (
                <div key={ev.id} style={{
                  padding: '4px 8px',
                  borderBottom: '1px solid rgba(128, 128, 128, 0.06)',
                  background: isSkip ? 'rgba(100, 140, 255, 0.04)' : 'transparent',
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 6,
                    marginBottom: 2,
                  }}>
                    <span style={{ fontWeight: 600, fontSize: 10 }}>{fromName}</span>
                    <span style={{ fontSize: 9, opacity: 0.35 }}>{formatRelativeTime(ts)}</span>
                  </div>
                  <div
                    className="fleet-message-text"
                    style={{ fontSize: 11, lineHeight: 1.4, wordBreak: 'break-word' }}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(ev.text || '') }}
                  />
                </div>
              )
            })
          )}
          <div ref={chatEndRef} />
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
