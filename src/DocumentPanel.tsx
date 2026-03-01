import { useState, useEffect, useRef, useCallback, useContext } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, stopEventPropagation } from 'tldraw'
import type { Editor } from 'tldraw'
import { DocContext, PanelContext } from './PanelContext'
import { isSignalConnected, writeSignal, onAgentHeartbeat } from './useYjsSync'
import type { AgentHeartbeatSignal } from './useYjsSync'
import { TocTab } from './panels/TocTab'
import { HistoryTab } from './panels/HistoryTab'
import { NotesTab } from './panels/NotesTab'
import './DocumentPanel.css'

// ======================
// Ping button
// ======================

export function PingButton() {
  const editor = useEditor()
  const [state, setState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle')

  const ping = useCallback(async () => {
    if (state === 'sending') return
    setState('sending')
    try {
      if (!isSignalConnected()) throw new Error('Signal not connected')
      const center = editor.getViewportScreenCenter()
      const pt = editor.screenToPage(center)
      writeSignal('signal:ping', {
        id: 'signal:ping',
        typeName: 'signal',
        type: 'ping',
        viewport: { x: pt.x, y: pt.y },
      })

      // Capture viewport screenshot and write to Yjs
      try {
        const viewportBounds = editor.getViewportPageBounds()
        const { blob } = await editor.toImage([], {
          bounds: viewportBounds,
          background: true,
          scale: 1,
          pixelRatio: 1,
        })
        const buf = await blob.arrayBuffer()
        const reader = new FileReader()
        const base64 = await new Promise<string>((resolve) => {
          reader.onload = () => {
            const result = reader.result as string
            resolve(result.split(',')[1]) // strip data:...;base64, prefix
          }
          reader.readAsDataURL(new Blob([buf], { type: 'image/png' }))
        })
        writeSignal('signal:screenshot', { data: base64, mimeType: 'image/png' })
      } catch (e) {
        console.warn('[Ping] Screenshot capture failed:', e)
      }

      setState('success')
      setTimeout(() => setState('idle'), 1500)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 2000)
    }
  }, [editor, state])

  const portalRef = useRef<HTMLDivElement | null>(null)
  if (!portalRef.current) {
    portalRef.current = document.createElement('div')
    document.body.appendChild(portalRef.current)
  }
  useEffect(() => {
    return () => { portalRef.current?.remove(); portalRef.current = null }
  }, [])

  return createPortal(
    <button
      className={`ping-button-standalone ping-button-standalone--${state}`}
      onClick={ping}
      onPointerDown={stopEventPropagation}
      onPointerUp={stopEventPropagation}
      onTouchStart={stopEventPropagation}
      onTouchEnd={stopEventPropagation}
      disabled={state === 'sending'}
      title="Ping agent"
    >
      <TldaTittle size={18} fill="currentColor"/>
    </button>,
    portalRef.current,
  )
}

// ======================
// Main panel
// ======================

type Tab = 'history' | 'toc' | 'notes'

export function DocumentPanel() {
  const ctx = useContext(PanelContext)
  const doc = useContext(DocContext)
  const isHtml = doc?.format === 'html'
  const [tab, setTab] = useState<Tab>('toc')
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on outside touch (touch devices only — desktop uses CSS :hover)
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (e.pointerType === 'mouse') return // desktop hover handles this
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  return (
    <div
      ref={panelRef}
      className={`doc-panel${open ? ' doc-panel-open' : ''}${isHtml ? ' doc-panel--html' : ''}`}
      onPointerDown={(e) => {
        stopEventPropagation(e)
        // Touch tap on collapsed strip → open
        if ((e.nativeEvent as PointerEvent).pointerType !== 'mouse' && !open) {
          setOpen(true)
        }
      }}
      onPointerUp={stopEventPropagation}
      onPointerMove={stopEventPropagation}
      onTouchStart={stopEventPropagation}
      onTouchEnd={stopEventPropagation}
    >
      <div className="doc-panel-tabs">
        <button className={`doc-panel-tab ${tab === 'toc' ? 'active' : ''}`} onClick={() => setTab('toc')}>
          TOC
        </button>
        {!isHtml && (
          <button className={`doc-panel-tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
            History
          </button>
        )}
        <button className={`doc-panel-tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
          Notes
        </button>
      </div>
      {tab === 'toc' && <TocTab />}
      {tab === 'history' && !isHtml && <HistoryTab />}
      {tab === 'notes' && <NotesTab />}
    </div>
  )
}

// ======================
// Agent indicator (logo only, bottom-right)
// ======================

const COMMA_PATH = "M13.125 18.8843C13.125 18.1109 13.3893 17.4548 13.918 16.9158C14.4696 16.3533 15.1362 16.0721 15.9176 16.0721C16.6531 16.0721 17.2967 16.3533 17.8484 16.9158C18.4 17.4548 18.7218 18.0641 18.8137 18.7437C18.9976 20.0092 18.7677 21.2629 18.1242 22.505C17.5036 23.747 16.6072 24.6961 15.435 25.3523C14.7914 25.7273 14.2627 25.7155 13.849 25.3172C13.4583 24.9422 13.5732 24.4969 14.1938 23.9814C14.5386 23.7236 14.8259 23.3955 15.0557 22.9971C15.2856 22.5987 15.435 22.1886 15.5039 21.7668C15.5269 21.5793 15.4465 21.4856 15.2626 21.4856C14.8029 21.4621 14.3317 21.2043 13.849 20.7122C13.3663 20.2201 13.125 19.6108 13.125 18.8843Z"

/** Tittle only: circle at cy=9.25 with rotated-comma tail subtracted */
function TldaTittle({ size, className, fill = 'currentColor', stroke, strokeWidth }: {
  size: number, className?: string, fill?: string, stroke?: string, strokeWidth?: number
}) {
  const id = useRef(`tittle-${Math.random().toString(36).slice(2, 8)}`).current
  return (
    <svg width={size} height={size} viewBox="12.3 5.5 7.4 7.4" className={className}>
      <defs>
        <path id={`c-${id}`} d={COMMA_PATH}/>
        <mask id={`m-${id}`}>
          <rect x="0" y="0" width="32" height="32" fill="black"/>
          <circle cx="16" cy="9.25" r="3.2" fill="white"/>
          <g transform="rotate(180, 15.97, 18.5)"><use href={`#c-${id}`} fill="black"/></g>
        </mask>
      </defs>
      {stroke ? (
        <circle cx="16" cy="9.25" r="3.2" fill="none" stroke={stroke} strokeWidth={strokeWidth}/>
      ) : (
        <rect x="12.3" y="5.5" width="7.4" height="7.4" fill={fill} mask={`url(#m-${id})`}/>
      )}
    </svg>
  )
}

type AgentState = 'offline' | 'listening' | 'thinking' | 'stale'

const STALE_MS = 30_000
const OFFLINE_MS = 60_000

export function AgentPill({ editor }: { editor: Editor }) {
  const [agentState, setAgentState] = useState<AgentState>('offline')
  const [agentName, setAgentName] = useState<string>('claude')
  const [pinging, setPinging] = useState(false)
  const lastHeartbeatRef = useRef<number>(0)
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    function resetTimers(signal: AgentHeartbeatSignal) {
      lastHeartbeatRef.current = signal.timestamp
      setAgentState(signal.state)
      if (signal.agent) setAgentName(signal.agent)

      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current)

      staleTimerRef.current = setTimeout(() => setAgentState('stale'), STALE_MS)
      offlineTimerRef.current = setTimeout(() => setAgentState('offline'), OFFLINE_MS)
    }

    const unsub = onAgentHeartbeat(resetTimers)
    return () => {
      unsub()
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current)
    }
  }, [])

  const handlePing = useCallback(async () => {
    if (pinging) return
    setPinging(true)
    try {
      if (!isSignalConnected()) throw new Error('Signal not connected')
      const center = editor.getViewportScreenCenter()
      const pt = editor.screenToPage(center)
      writeSignal('signal:ping', {
        id: 'signal:ping',
        typeName: 'signal',
        type: 'ping',
        viewport: { x: pt.x, y: pt.y },
      })

      // Capture viewport screenshot
      try {
        const viewportBounds = editor.getViewportPageBounds()
        const { blob } = await editor.toImage([], {
          bounds: viewportBounds,
          background: true,
          scale: 1,
          pixelRatio: 1,
        })
        const buf = await blob.arrayBuffer()
        const reader = new FileReader()
        const base64 = await new Promise<string>((resolve) => {
          reader.onload = () => {
            const result = reader.result as string
            resolve(result.split(',')[1])
          }
          reader.readAsDataURL(new Blob([buf], { type: 'image/png' }))
        })
        writeSignal('signal:screenshot', { data: base64, mimeType: 'image/png' })
      } catch (e) {
        console.warn('[Ping] Screenshot capture failed:', e)
      }

      setTimeout(() => setPinging(false), 1500)
    } catch {
      setTimeout(() => setPinging(false), 2000)
    }
  }, [editor, pinging])

  return (
    <span
      className={`agent-indicator agent-${agentState}`}
      data-agent={agentName}
      onClick={handlePing}
      onPointerDown={e => e.stopPropagation()}
      onPointerUp={e => e.stopPropagation()}
      onTouchStart={e => e.stopPropagation()}
      onTouchEnd={e => e.stopPropagation()}
      title={
        agentState === 'offline' ? 'No agent connected — tap to ping' :
        agentState === 'listening' ? `${agentName === 'todd' ? 'Todd' : 'Claude'} listening — tap to ping` :
        agentState === 'thinking' ? `${agentName === 'todd' ? 'Todd' : 'Claude'} thinking` :
        'Agent may be disconnected — tap to ping'
      }
    >
      {agentState !== 'offline' && (
        <TldaTittle size={20} className="agent-indicator-logo"
          fill={agentState === 'stale' ? undefined : 'currentColor'}
          stroke={agentState === 'stale' ? 'currentColor' : undefined}
          strokeWidth={agentState === 'stale' ? 0.5 : undefined}
        />
      )}
    </span>
  )
}
