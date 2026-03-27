import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import katex from 'katex'
import { formatRelativeTime } from './helpers'

const FLEET_API = 'http://localhost:5199'

// --- Types ---

interface FleetAgent {
  id: string
  friendly_name: string
  labels: string[]
  last_seen: string
  dead: boolean
  human: boolean
  is_manager: boolean
  cwd: string | null
}

interface FleetTask {
  id: string
  title: string
  status: string
  assignee: string | null
  description?: string
}

interface ChatEvent {
  id: number
  type: string
  timestamp: string
  from_id: string
  to_id: string
  text: string
  metadata: Record<string, unknown> | null
}

// --- Markdown + KaTeX rendering ---

function renderMarkdown(text: string): string {
  if (!text) return ''
  // First pass: render KaTeX (display then inline)
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

  // Simple markdown: bold, italic, inline code, code blocks, lists
  html = html.replace(/```([^`]*?)```/gs, '<pre><code>$1</code></pre>')
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>')

  // Line breaks → <br> (but not inside pre blocks)
  html = html.replace(/\n/g, '<br>')

  return html
}

// --- Helpers ---

function isAlive(agent: FleetAgent): boolean {
  if (agent.dead) return false
  const seen = new Date(agent.last_seen).getTime()
  return Date.now() - seen < 120_000 // 2 min
}

function agentDisplayName(agent: FleetAgent): string {
  return agent.friendly_name || (agent.id || '').replace('fleet:', '')
}

function agentInitial(name: string): string {
  return name.charAt(0).toUpperCase()
}

// --- Component ---

export function FleetTab() {
  const [agents, setAgents] = useState<FleetAgent[]>([])
  const [tasks, setTasks] = useState<FleetTask[]>([])
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [inputText, setInputText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch state + events
  const fetchData = useCallback(async () => {
    try {
      const stateResp = await fetch(`${FLEET_API}/api/state`)
      if (!stateResp.ok) throw new Error(`State API ${stateResp.status}`)
      const state = await stateResp.json()
      setAgents(state.agents || [])
      setTasks(state.tasks || [])

      // Fetch events — filter by selected agent if one is selected
      const eventsUrl = selectedAgent
        ? `${FLEET_API}/api/store/events?agent=${encodeURIComponent(selectedAgent)}&limit=50`
        : `${FLEET_API}/api/store/events?limit=50`
      const eventsResp = await fetch(eventsUrl)
      if (eventsResp.ok) {
        const data = await eventsResp.json()
        setEvents(data.events || [])
      }

      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [selectedAgent])

  useEffect(() => {
    fetchData()
    const timer = setInterval(fetchData, 5000)
    return () => clearInterval(timer)
  }, [fetchData])

  // Auto-scroll chat to bottom on new events
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  // Send message
  const sendMessage = useCallback(async () => {
    const text = inputText.trim()
    if (!text || !selectedAgent) return
    try {
      await fetch(`${FLEET_API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, from: 'fleet:skip', to: selectedAgent }),
      })
      setInputText('')
      // Refresh immediately
      fetchData()
    } catch (e) {
      setError(`Send failed: ${(e as Error).message}`)
    }
  }, [inputText, selectedAgent, fetchData])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage])

  // Alive agents sorted: non-human first, then by name
  const aliveAgents = useMemo(() => {
    return agents
      .filter(a => isAlive(a) && !a.human)
      .sort((a, b) => agentDisplayName(a).localeCompare(agentDisplayName(b)))
  }, [agents])

  // Task lookup by assignee
  const taskByAgent = useMemo(() => {
    const map: Record<string, FleetTask> = {}
    for (const t of tasks) {
      if (t.assignee && (t.status === 'pending' || t.status === 'in_progress')) {
        map[t.assignee] = t
      }
    }
    return map
  }, [tasks])

  // Chat events — only chat type, sorted chronologically
  const chatEvents = useMemo(() => {
    return events
      .filter(e => e.type === 'chat' && e.text && !(e.metadata as any)?.timer)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  }, [events])

  // Agent name lookup
  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      map[a.id] = agentDisplayName(a)
    }
    map['fleet:skip'] = 'skip'
    return map
  }, [agents])

  if (error && agents.length === 0) {
    return (
      <div className="doc-panel-content">
        <div className="panel-empty">Fleet offline<br/><span style={{ fontSize: '9px', opacity: 0.5 }}>{error}</span></div>
      </div>
    )
  }

  return (
    <div className="doc-panel-content fleet-tab" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Agent list */}
      <div className="fleet-agents">
        {aliveAgents.length === 0 ? (
          <div className="fleet-no-agents">No agents online</div>
        ) : (
          aliveAgents.map(agent => {
            const name = agentDisplayName(agent)
            const task = taskByAgent[agent.id]
            const isSelected = selectedAgent === agent.id
            return (
              <div
                key={agent.id}
                className={`fleet-agent-row${isSelected ? ' selected' : ''}`}
                onClick={() => setSelectedAgent(isSelected ? null : agent.id)}
              >
                <span className="fleet-agent-avatar">{agentInitial(name)}</span>
                <div className="fleet-agent-info">
                  <span className="fleet-agent-name">{name}</span>
                  {task && (
                    <span className="fleet-agent-task">{task.title}</span>
                  )}
                </div>
                <span className="fleet-agent-seen">{agent.last_seen ? formatRelativeTime(new Date(agent.last_seen).getTime()) : ''}</span>
              </div>
            )
          })
        )}
      </div>

      {/* Chat area */}
      <div className="fleet-chat-area" style={{ flex: 1, overflow: 'auto' }}>
        {chatEvents.length === 0 ? (
          <div className="fleet-no-messages">
            {selectedAgent ? 'No messages' : 'Select an agent to chat'}
          </div>
        ) : (
          chatEvents.map(ev => {
            const fromName = agentNames[ev.from_id] || (ev.from_id || '').replace('fleet:', '')
            const isSkip = ev.from_id === 'fleet:skip'
            return (
              <div key={ev.id} className={`fleet-message${isSkip ? ' fleet-message--skip' : ''}`}>
                <div className="fleet-message-header">
                  <span className="fleet-message-sender">{fromName}</span>
                  <span className="fleet-message-time">{ev.timestamp ? formatRelativeTime(new Date(ev.timestamp).getTime()) : ''}</span>
                </div>
                <div
                  className="fleet-message-text"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(ev.text || '') }}
                />
              </div>
            )
          })
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Chat input */}
      {selectedAgent && (
        <div className="fleet-chat-input">
          <input
            ref={inputRef}
            type="text"
            placeholder={`Message ${agentNames[selectedAgent] || 'agent'}...`}
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
      )}
    </div>
  )
}
