/**
 * TerminalCard — inline terminal embed for fleet chat.
 *
 * Renders an xterm.js terminal connected to an agent's tmux session,
 * with an input bar for sending commands. Appears inside the chat message
 * stream, tied to a specific agent.
 *
 * Usage:
 *   <TerminalCard agentId="fleet:abc123" agentName="my-agent" onDismiss={() => ...} />
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { stopEventPropagation } from 'tldraw'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import 'xterm/css/xterm.css'
import './TerminalCard.css'

// WebSocket for terminal — goes through Vite proxy in dev
const FLEET_WS_HOST = typeof window !== 'undefined'
  ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
  : 'ws://localhost:5199'

interface TerminalCardProps {
  agentId: string
  agentName: string
  onDismiss?: () => void
}

export function TerminalCard({ agentId, agentName, onDismiss }: TerminalCardProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [statusMsg, setStatusMsg] = useState('')
  const [inputFocused, setInputFocused] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [frozen, setFrozen] = useState(false)
  const [frozenText, setFrozenText] = useState('')

  // Initialize xterm
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
      scrollback: 500,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,  // input goes via the input bar, not xterm directly
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)

    // Delay fit to let the container settle
    requestAnimationFrame(() => {
      try { fit.fit() } catch {}
    })

    termRef.current = term
    fitRef.current = fit

    return () => {
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // Connect WebSocket
  useEffect(() => {
    if (!agentId || frozen) return

    setStatus('connecting')
    wsRef.current?.close()

    const ws = new WebSocket(`${FLEET_WS_HOST}/ws/terminal?agent=${encodeURIComponent(agentId)}`)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connected')
      setStatusMsg('')
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
      if (!frozen) {
        setStatus('error')
        setStatusMsg(evt.reason || 'connection closed')
      }
    }

    return () => { ws.close() }
  }, [agentId, frozen])

  // Resize xterm when container resizes
  useEffect(() => {
    if (!containerRef.current || !fitRef.current) return
    const observer = new ResizeObserver(() => {
      try {
        fitRef.current?.fit()
        const term = termRef.current
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN && term) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      } catch {}
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  // Send raw data to tmux
  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }))
    }
  }, [])

  const handleInputSubmit = useCallback(() => {
    // Send even empty string (just Enter) — useful for confirming prompts
    sendInput(inputValue + '\r')
    setInputValue('')
  }, [inputValue, sendInput])

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    stopEventPropagation(e as any)

    if (e.key === 'Enter') {
      e.preventDefault()
      handleInputSubmit()
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault()
      sendInput('\x03')
      setInputValue('')
    } else if (e.key === 'd' && e.ctrlKey) {
      e.preventDefault()
      sendInput('\x04')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      sendInput('\t')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      sendInput('\x1b[A')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      sendInput('\x1b[B')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      sendInput('\x1b')
    }
  }, [handleInputSubmit, sendInput])

  // Freeze: capture terminal text, close WS, show static snapshot
  const handleFreeze = useCallback(() => {
    const term = termRef.current
    if (term) {
      const lines: string[] = []
      const buf = term.buffer.active
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)
        if (line) lines.push(line.translateToString(true))
      }
      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
      setFrozenText(lines.join('\n'))
    }
    wsRef.current?.close()
    wsRef.current = null
    setFrozen(true)
  }, [])

  const isConnected = status === 'connected'

  if (frozen) {
    return (
      <div
        className="terminal-card terminal-card-frozen"
        onPointerDown={stopEventPropagation}
        onPointerMove={stopEventPropagation}
      >
        <div className="terminal-card-header">
          <div className="terminal-card-dots">
            <div className="terminal-card-dot" />
            <div className="terminal-card-dot" />
            <div className="terminal-card-dot" />
          </div>
          <span className="terminal-card-title">{agentName}</span>
          <span className="terminal-card-frozen-label">
            {new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
        </div>
        <pre className="terminal-card-frozen-output">{frozenText}</pre>
      </div>
    )
  }

  return (
    <div
      className={`terminal-card ${inputFocused ? 'terminal-card-input-active' : ''}`}
      onPointerDown={stopEventPropagation}
      onPointerMove={stopEventPropagation}
    >
      {/* Header */}
      <div className="terminal-card-header">
        <div className="terminal-card-dots">
          <div className={`terminal-card-dot ${isConnected ? 'green' : status === 'error' ? 'red' : ''}`} />
        </div>
        <span className="terminal-card-title">
          {isConnected ? agentName : status === 'connecting' ? 'connecting…' : agentName}
        </span>
        {onDismiss && (
          <button
            className="terminal-card-dismiss"
            title="Dismiss (freeze as snapshot)"
            onPointerDown={(e) => {
              stopEventPropagation(e as any)
              handleFreeze()
              onDismiss?.()
            }}
          >
            ×
          </button>
        )}
      </div>

      {/* Terminal output */}
      <div
        className="terminal-card-body"
        ref={containerRef}
        onPointerDown={stopEventPropagation}
        onPointerMove={stopEventPropagation}
        onKeyDown={stopEventPropagation}
        onKeyUp={stopEventPropagation}
      >
        {status === 'error' && (
          <div className="terminal-card-error">
            {statusMsg || 'Connection failed'}
          </div>
        )}
      </div>

      {/* Input bar */}
      {isConnected && (
        <div className="terminal-card-input-bar"
          onPointerDown={stopEventPropagation}
          onPointerMove={stopEventPropagation}
        >
          <span className="terminal-card-input-prompt">$</span>
          <input
            ref={inputRef}
            className="terminal-card-input"
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
            className="terminal-card-ctrl-c"
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
  )
}
