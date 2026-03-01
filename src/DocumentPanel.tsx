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
      <svg width="18" height="18" viewBox="0 0 248 248" fill="currentColor">
        <path d={TILDA_LOGO_PATH}/>
      </svg>
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

const TILDA_LOGO_PATH = "M0 211 C25 198, 37 37, 87 37 C112 37, 112 112, 124 112 C136 112, 144 149, 248 37 C223 50, 211 211, 161 211 C136 211, 136 161, 124 161 C112 161, 104 99, 0 211Z"

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
        <svg className="agent-indicator-logo" width="12" height="12" viewBox="0 0 248 248"
          fill={agentState === 'stale' ? 'none' : 'currentColor'}
          stroke={agentState === 'stale' ? 'currentColor' : 'none'}
          strokeWidth={agentState === 'stale' ? 12 : 0}
        >
          <path d={TILDA_LOGO_PATH}/>
        </svg>
      )}
    </span>
  )
}
