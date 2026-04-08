/**
 * TerminalShape — tldraw canvas shape embedding a live xterm.js terminal.
 *
 * Connects to an agent's tmux session via the fleet server WebSocket at
 * ws://localhost:5199/ws/terminal?agent=AGENT_ID
 *
 * Features:
 *   - Live terminal output via xterm.js
 *   - Input bar at the bottom for sending commands to the tmux session
 *   - Ctrl+C support for interrupt
 *   - Visual input-active indicator (cyan border glow)
 *
 * Props:
 *   w, h     — shape dimensions
 *   agentId  — fleet agent ID to connect to (empty = disconnected)
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import 'xterm/css/xterm.css'
import './TerminalShape.css'

// Use relative URLs for API (proxied by Vite in dev, same host in prod).
// WebSocket needs an absolute URL — derive from current host.
const FLEET_WS_HOST = typeof window !== 'undefined'
  ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
  : 'ws://localhost:5199'

const DEFAULT_W = 560
const DEFAULT_H = 380

// ---- Shape definition ----

export class TerminalShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'terminal' as const
  static override props = {
    w: T.number,
    h: T.number,
    agentId: T.string,
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, agentId: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <TerminalComponent shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}

// ---- Agent picker ----

interface Agent {
  id: string
  friendly_name: string
  tmux_session?: string
  dead?: boolean
}

function useAgents(): Agent[] {
  const [agents, setAgents] = useState<Agent[]>([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/state`)
        if (!res.ok) return
        const data = await res.json()
        const list: Agent[] = data.agents || []
        if (!cancelled) {
          setAgents(list.filter(a => !a.dead && a.tmux_session))
        }
      } catch {}
    }
    load()
    const timer = setInterval(load, 10_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  return agents
}

// ---- Terminal component ----

function TerminalComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h, agentId } = shape.props

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected')
  const [statusMsg, setStatusMsg] = useState('')
  const [inputFocused, setInputFocused] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const agents = useAgents()

  // Initialize xterm once
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontSize: 11,
      fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
      theme: {
        background: '#1a1a1a',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        black: '#1e1e1e',
        brightBlack: '#666',
        red: '#f44747',
        brightRed: '#f44747',
        green: '#6a9955',
        brightGreen: '#6a9955',
        yellow: '#dcdcaa',
        brightYellow: '#dcdcaa',
        blue: '#569cd6',
        brightBlue: '#569cd6',
        magenta: '#c678dd',
        brightMagenta: '#c678dd',
        cyan: '#4ec9b0',
        brightCyan: '#4ec9b0',
        white: '#d4d4d4',
        brightWhite: '#ffffff',
      },
      scrollback: 1000,
      convertEol: true,
      cursorBlink: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    // Forward key input from xterm to WebSocket (for direct xterm focus)
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }))
      }
    })

    return () => {
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // Resize xterm when shape dimensions change
  useEffect(() => {
    const fit = fitRef.current
    const ws = wsRef.current
    if (!fit) return

    // Give the layout a tick to settle
    const timer = setTimeout(() => {
      try {
        fit.fit()
        const term = termRef.current
        if (ws?.readyState === WebSocket.OPEN && term) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      } catch {}
    }, 50)
    return () => clearTimeout(timer)
  }, [w, h])

  // Connect WebSocket when agentId changes
  useEffect(() => {
    if (!agentId) {
      setStatus('disconnected')
      setStatusMsg('')
      wsRef.current?.close()
      wsRef.current = null
      termRef.current?.clear()
      return
    }

    setStatus('connecting')
    wsRef.current?.close()

    const ws = new WebSocket(`${FLEET_WS}/ws/terminal?agent=${encodeURIComponent(agentId)}`)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connected')
      setStatusMsg('')
      // Send current dimensions
      const term = termRef.current
      const fit = fitRef.current
      if (term && fit) {
        try { fit.fit() } catch {}
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'output' && msg.data && termRef.current) {
          termRef.current.reset()
          termRef.current.write(msg.data)
        } else if (msg.type === 'error') {
          setStatus('error')
          setStatusMsg(msg.message || 'server error')
        }
      } catch {}
    }

    ws.onerror = () => {
      setStatus('error')
      setStatusMsg('WebSocket error')
    }

    ws.onclose = (evt) => {
      if (status === 'connecting' || status === 'connected') {
        setStatus('error')
        setStatusMsg(evt.reason || 'connection closed')
      }
    }

    return () => {
      ws.close()
    }
  }, [agentId])

  const handleAgentChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    stopEventPropagation(e as any)
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      props: { agentId: e.target.value },
    })
  }, [editor, shape.id, shape.type])

  // Send raw data to tmux via WebSocket
  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }))
    }
  }, [])

  // Handle input bar submit
  const handleInputSubmit = useCallback(() => {
    if (!inputValue.trim() && !inputValue) return
    // Send the text followed by Enter (\r)
    sendInput(inputValue + '\r')
    setInputValue('')
  }, [inputValue, sendInput])

  // Handle input bar key events
  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    stopEventPropagation(e as any)

    if (e.key === 'Enter') {
      e.preventDefault()
      handleInputSubmit()
    } else if (e.key === 'c' && e.ctrlKey) {
      // Ctrl+C — send interrupt
      e.preventDefault()
      sendInput('\x03')
      setInputValue('')
    } else if (e.key === 'Tab') {
      // Tab completion
      e.preventDefault()
      sendInput('\t')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      sendInput('\x1b[A')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      sendInput('\x1b[B')
    }
  }, [handleInputSubmit, sendInput])

  const agentName = agents.find(a => a.id === agentId)?.friendly_name
    ?? (agentId ? agentId.slice(0, 12) : 'none')

  const headerTitle = status === 'connected'
    ? agentName
    : status === 'connecting'
      ? 'connecting…'
      : 'terminal'

  const isConnected = status === 'connected'

  return (
    <HTMLContainer
      style={{ width: w, height: h, pointerEvents: 'all' }}
      onPointerDown={stopEventPropagation}
      onPointerMove={stopEventPropagation}
    >
      <div className={`terminal-shape ${inputFocused ? 'terminal-shape-input-active' : ''}`}>
        {/* Title bar */}
        <div className="terminal-shape-header"
          onPointerDown={stopEventPropagation}
          onPointerMove={stopEventPropagation}
        >
          <div className="terminal-shape-dots">
            <div className={`terminal-shape-dot ${isConnected ? 'red' : ''}`} />
            <div className={`terminal-shape-dot ${isConnected ? 'yellow' : ''}`} />
            <div className={`terminal-shape-dot ${isConnected ? 'green' : ''}`} />
          </div>
          <span className="terminal-shape-title">{headerTitle}</span>
          <select
            className="terminal-shape-agent-picker"
            value={agentId}
            onChange={handleAgentChange}
            onPointerDown={stopEventPropagation}
          >
            <option value="">— pick agent —</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>
                {a.friendly_name || a.id.slice(0, 12)}
              </option>
            ))}
          </select>
        </div>

        {/* Terminal body */}
        <div
          className="terminal-shape-body"
          ref={containerRef}
          onPointerDown={stopEventPropagation}
          onPointerMove={stopEventPropagation}
          onKeyDown={stopEventPropagation}
          onKeyUp={stopEventPropagation}
        >
          {!agentId && (
            <div className="terminal-shape-status">
              Pick an agent above to connect to its terminal
            </div>
          )}
          {agentId && status === 'error' && (
            <div className="terminal-shape-status error">
              {statusMsg || 'Connection failed'}
            </div>
          )}
        </div>

        {/* Input bar — only shown when connected */}
        {isConnected && (
          <div className="terminal-shape-input-bar"
            onPointerDown={stopEventPropagation}
            onPointerMove={stopEventPropagation}
          >
            <span className="terminal-shape-input-prompt">$</span>
            <input
              ref={inputRef}
              className="terminal-shape-input"
              type="text"
              value={inputValue}
              onChange={(e) => { stopEventPropagation(e as any); setInputValue(e.target.value) }}
              onKeyDown={handleInputKeyDown}
              onKeyUp={(e) => stopEventPropagation(e as any)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder="type command…"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              className="terminal-shape-ctrl-c"
              title="Send Ctrl+C (interrupt)"
              onPointerDown={(e) => {
                stopEventPropagation(e as any)
                sendInput('\x03')
              }}
            >
              ^C
            </button>
          </div>
        )}
      </div>
    </HTMLContainer>
  )
}
