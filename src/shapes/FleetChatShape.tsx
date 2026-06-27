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
  type Editor,
  type TLShapeId,
} from 'tldraw'
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useContext, memo, useSyncExternalStore, forwardRef } from 'react'
import { createPortal } from 'react-dom'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { probe } from '../perf-probe'

// @ts-ignore — vanilla JS module
import { renderChatLine, resolveInlineAttachments, esc } from '../fleet/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { renderActivityGroup, scheduleTimeLabel } from '../fleet/activity-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath, renderMarkdown as renderMarkdownUtil } from '../fleet/utils.mjs'
// @ts-ignore — vanilla JS module
import { initVoice, setVoiceTarget, clearVoiceTarget, resetTranscript, restartRecording, toggleRecording, sendCurrentText, isRecording } from '../voice.mjs'
// @ts-ignore — vanilla JS module
import { getHumanId, getHumanName, getDeviceId, isDeviceReady, updateEventById, sendViewingContext, setViewingEnrichFn, getFleetWsBase } from '../fleet/fleet-data.mjs'
// @ts-ignore — vanilla JS module
import { installChatImageRetry } from '../fleet/chat-image-retry.mjs'
// @ts-ignore — vanilla JS module
import {
  buildFleetAgentFilter,
  buildFleetDmFilter,
  classifyFleetComposerTrafficMode,
  filterForFleetComposerTrafficMode,
  matchesFleetFilter,
  nextFleetComposerTrafficMode,
  quietTrafficSuppressesActivity,
} from '../fleet/filter-semantics.mjs'
import { appendToken } from '../authToken'
import { labelsForAgent } from '../../shared/fleet-labels.mjs'
import { useFleetAgents, useFleetEvents, useFleetTasks, useFleetThinking, useFleetCompacting, useFleetContext, useSuggestions, clearGroup, sendMessage, loadBefore, resolveFilter, injectOptimisticEvent, updateOptimisticEvent, removeOptimisticEvent } from '../fleet-data-adapter'
import type { Suggestion } from '../fleet-data-adapter'
import { dropPillOnTarget, chatInsertBus, filterDropPreview, chipContentStore, createTemporaryMarkdownColumn } from './FleetPillShape'
import { agentDisplayName, beginNativeSnapDrag, endNativeSnapDrag } from './fleet-utils'
import { ChatComposer } from './ChatComposer'
import { decideFollowTransition } from './chatScrollIntent.mjs'
import { AgentName, PhaseIcon } from './PhaseIcon'
import { baseName, phaseFromName } from '../../shared/lineage-name.mjs'
import { dragCoordinator } from './dragCoordinator'
import { DocContext, PanelContext } from '../PanelContext'
import { getPageRenderHash, getBuiltPageCount } from '../stores'
import { loadLookup, type LookupData } from '../synctexLookup'
import { getSourceAnchor } from '../synctexAnchor'
import { log } from '../logger'
import { linkifyDocRefs, linkifyArrowRefs, linkifyAtRefs, linkifyLabelRefs, linkifyRefCommands, buildRefResolver, refToCanvas, type DocRef, type ResolvedRef, type LabelRegionInfo, type TheoremMapEntry } from '../docLinks'
import { fetchProofInfo, fetchTheoremMap } from '../docInfoCache'
import { PDF_HEIGHT } from '../layoutConstants'
import { TerminalCard } from './TerminalCard'
import { Terminal } from 'xterm'
import { useIsInViewport, useVisibilityViewportId } from './useIsInViewport'
import {
  createTemporaryMarkdownAnnotationViewerRequest,
  dispatchManagedAnnotationViewerHide,
  dispatchManagedAnnotationViewerRequest,
} from '../wm/annotation-viewer-surface'
import { createLightboxSurfaceRequest } from '../wm/lightbox-surface'
import { clientPointToPage, pagePointToClient } from '../wm/viewport-coordinates'
import { consumeBulletContexts, subscribeBulletContext, getBulletContexts } from '../stores/bulletContextStore'
import { getPref, subscribePref } from '../preferences'
import { DATABASE_HTTP } from '../activeConfig'
import './fleet-chat.css'

const DEFAULT_W = 400
const DEFAULT_H = 600
const FLEET_API = DATABASE_HTTP
const INITIAL_CHAT_RENDER_WINDOW = 80
const CHAT_RENDER_WINDOW_CHUNK = 80
const CHAT_RENDER_LOOKBEHIND = 20
type ChatTrafficMode = 'normal' | 'quiet'
type ComposerTrafficFilterMode = 'dm-quiet' | 'dm' | 'agent' | 'custom'

function isFleetPillRecord(record: any): boolean {
  return record?.typeName === 'shape' && record.type === 'fleet-pill'
}

function useFleetPillCount(editor: Editor): number {
  const [count, setCount] = useState(() =>
    editor.getCurrentPageShapes().reduce((total, shape) => total + ((shape.type as string) === 'fleet-pill' ? 1 : 0), 0),
  )

  useEffect(() => {
    return editor.store.listen(({ changes }) => {
      let delta = 0
      for (const record of Object.values(changes.added)) {
        if (isFleetPillRecord(record)) delta += 1
      }
      for (const record of Object.values(changes.removed)) {
        if (isFleetPillRecord(record)) delta -= 1
      }
      for (const [from, to] of Object.values(changes.updated) as any[]) {
        const wasPill = isFleetPillRecord(from)
        const isPill = isFleetPillRecord(to)
        if (!wasPill && isPill) delta += 1
        else if (wasPill && !isPill) delta -= 1
      }
      if (delta !== 0) setCount(value => Math.max(0, value + delta))
    }, { source: 'all', scope: 'document' })
  }, [editor])

  return count
}

// Bind a handler that fires on both mouse click and a touch tap. On touch a tap
// on a text element (e.g. the lightbox ✕ or a chip) never synthesizes a `click`,
// so click-only handlers are dead on iPad; add a movement-guarded pointerup so a
// genuine tap (not a drag) also fires. Handlers used here are idempotent
// (overlay.remove()), so a redundant mouse/touch double-call is harmless.
function addTap(el: Element | null | undefined, fn: (e: Event) => void) {
  if (!el) return
  let dx = 0, dy = 0
  el.addEventListener('click', fn)
  // Track both finger (touch) AND stylus (pen) — Apple Pencil taps also fire no
  // synthesized click. Guard is 16px (not 10): a thumb drifts more than 10px on
  // a genuine tap, so 10 dropped real taps.
  el.addEventListener('pointerdown', (e: any) => { if (e.pointerType === 'touch' || e.pointerType === 'pen') { dx = e.clientX; dy = e.clientY } })
  el.addEventListener('pointerup', (e: any) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
    if (Math.abs(e.clientX - dx) > 16 || Math.abs(e.clientY - dy) > 16) return
    fn(e)
  })
}

// On touch devices the chat input is voice-only: tapping it focuses the field
// for dictation, and iOS must NOT raise the on-screen keyboard (it eats half the
// screen). inputmode="none" reliably suppresses the soft keyboard on a <textarea>
// while keeping focus + programmatic/hardware-keyboard input working.
// maxTouchPoints (not pointer:coarse) — a Magic Keyboard/trackpad makes the
// iPad's primary pointer "fine", which would wrongly drop the no-keyboard rule.
const _isTouchDevice = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('forcetouch'))

// Phone (narrow screen). iOS Safari auto-zooms any focused input under 16px, so
// the composer font must be ≥16px on phone — and it's set as an INLINE style
// (below), which CSS can't override, so the value is chosen here.
const _isPhone = typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 600px)').matches

function getFleetStyleVars(): React.CSSProperties {
  return {
    '--fleet-base-font': `${getPref('fleet-font-size')}px`,
    '--fleet-chrome-alpha': String(getPref('fleet-chrome-opacity')),
    '--fleet-content-alpha': String(getPref('fleet-content-opacity')),
    '--fleet-age-fade': getPref('fleet-age-fade') ? '1' : '0',
  } as React.CSSProperties
}

function useFleetStyleVars() {
  const [vars, setVars] = useState(getFleetStyleVars)
  useEffect(() => subscribePref(() => setVars(getFleetStyleVars())), [])
  return vars
}

// Bumps on any pref change so memoized values (e.g. the render ctx, which bakes
// fold heights) rebuild when the user changes a preference.
function usePrefTick() {
  const [tick, setTick] = useState(0)
  useEffect(() => subscribePref(() => setTick(t => t + 1)), [])
  return tick
}

function isNonHumanAgentLabel(agents: any[], label: string) {
  const agent = agents.find((a: any) => labelsForAgent(a).includes(label))
  return !!agent && !agent.human
}

function activeComposerAgentLabel(filter: [string, string][][], sendTargets: string[], agents: any[]) {
  for (const clause of filter) {
    for (const [, label] of clause) {
      if (isNonHumanAgentLabel(agents, label)) return label
    }
  }
  for (const label of sendTargets) {
    if (isNonHumanAgentLabel(agents, label)) return label
  }
  return ''
}

function isManagedSurfaceProofFixtureEnabled() {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('wmManagedSurfaceProof') === '1'
}

function currentManagedSurfaceOwner() {
  if (!isDeviceReady()) return { userId: '', deviceId: '' }
  return { userId: getHumanId(), deviceId: getDeviceId() }
}

function managedViewportSize() {
  return {
    w: typeof window === 'undefined' ? 1200 : window.innerWidth,
    h: typeof window === 'undefined' ? 800 : window.innerHeight,
  }
}

const MANAGED_SURFACE_PROOF_BULLET_ID = 'wm-managed-surface-proof-bullet'

function createManagedSurfaceProofMessage(targetShapeId: string) {
  const now = Date.now()
  return {
    type: 'chat',
    _tempId: 'wm-managed-surface-proof-chip',
    timestamp: new Date(now).toISOString(),
    from: getHumanId() || 'fleet:wm-managed-surface-proof',
    to: getHumanId() || 'fleet:wm-managed-surface-proof',
    text: [
      '# WM managed surface proof',
      '',
      'This query-gated proof row uses FleetChatShape source-chip rendering and the normal source-chip click handler.',
      '',
      'Managed doc-link proof: [->thm:main].',
      '',
      `Managed annotation ref-chip proof: «annotation:Proof note#${targetShapeId}».`,
      '',
      'Managed bullet-card proof: «bullet:wm-managed-surface-proof-bullet».',
      '',
      'Managed lightbox proof:',
      '',
      '![WM managed lightbox proof](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=)',
      '',
      'Expected path: real chip click -> temporary markdown surface descriptor -> managed AnnotationViewer request -> cleanup on close.',
    ].join('\n'),
    metadata: {
      source: {
        file: 'wm-managed-surface-proof.md',
        section: 'proof-chip',
      },
    },
    _bullets: [{
      id: MANAGED_SURFACE_PROOF_BULLET_ID,
      text: '- Managed bullet-card proof target',
      noteShapeId: targetShapeId,
      tuplePath: [0],
      bulletIndex: 0,
    }],
  }
}

// ---- Terminal hover pane ----

// Terminal peek overlay — shown when hovering the terminal icon on a chat shape.
// Fixed grid for the peek. MUST match the daemon's tmux-attach PTY size in
// fleet-daemon.mjs (rpcStartTerminalWatch spawns at cols:120, rows:40). The
// agent's TUI repaints at the PTY column count with absolute cursor moves, so
// the xterm grid has to be the same width or every frame garbles.
const PEEK_COLS = 120
const PEEK_ROWS = 40
// Lightbox height. When lightboxed the pane is bottom-anchored so it grows
// UPWARD from the (fixed) input bar instead of pushing the input off-screen.
const LIGHTBOX_H = 480
// Lines of real tmux scrollback to fetch for lightbox backscroll.
const HISTORY_LINES = 500

const TERM_FONT = "'SF Mono', 'Fira Code', Menlo, monospace"
const TERM_THEME = {
  background: '#0d0d14',
  foreground: '#c8c8d8',
  cursor: '#c8c8d8',
  black: '#1e1e1e', brightBlack: '#555',
  red: '#f44747', brightRed: '#f44747',
  green: '#6a9955', brightGreen: '#6a9955',
  yellow: '#dcdcaa', brightYellow: '#dcdcaa',
  blue: '#569cd6', brightBlue: '#569cd6',
  magenta: '#c678dd', brightMagenta: '#c678dd',
  cyan: '#4ec9b0', brightCyan: '#4ec9b0',
  white: '#d4d4d4', brightWhite: '#ffffff',
}

type TerminalOutputFrame = {
  data: string
  encoding?: string
}

// Hover mode: read-only snapshot that resets on each server push.
// Pinned mode: stays open, shows input bar for sending commands, resizable.
function TerminalHoverPane({ agentId, pinned, anchorRef, onDismiss, onMouseEnter, onMouseLeave }: {
  agentId: string
  pinned: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onDismiss: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}) {
  // The pane is portaled to <body> so it's OUTSIDE the chat shape's opacity group
  // (the chat sits at a semi-transparent resting opacity; a child can't be more
  // opaque than its parent). Rendered fixed, anchored to the chat input's bottom
  // edge, re-measured each frame so it tracks the panel as the canvas pans/zooms.
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null)
  useEffect(() => {
    let raf = 0
    const measure = () => {
      const el = anchorRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        setAnchor(prev => (prev && prev.left === r.left && prev.top === r.bottom && prev.width === r.width)
          ? prev
          : { left: r.left, top: r.bottom, width: r.width })
      }
      // Track the pinned pane's bottom edge while NOT lightboxed so the lightbox
      // can anchor its bottom-left there (keeping it fixed as it grows up + right).
      if (!lightboxedRef.current && paneRef.current) {
        paneBottomRef.current = paneRef.current.getBoundingClientRect().bottom
      }
      raf = requestAnimationFrame(measure)
    }
    raf = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(raf)
  }, [anchorRef])
  const containerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pinnedRef = useRef(pinned)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [height, setHeight] = useState(210)
  const [lightboxed, setLightboxed] = useState(false)
  const [scale, setScale] = useState(1)
  // The peek renders a fixed grid sized to the agent's REAL tmux window width
  // (reported by the daemon via a 'size' message), then CSS-scales it to fit the
  // panel. PEEK_COLS/ROWS are only the fallback until the first 'size' arrives —
  // a grid narrower than the window would garble the absolute-positioned stream.
  const [gridCols, setGridCols] = useState(PEEK_COLS)
  const [gridRows, setGridRows] = useState(PEEK_ROWS)
  const gridColsRef = useRef(gridCols)
  const gridRowsRef = useRef(gridRows)
  useEffect(() => { gridColsRef.current = gridCols }, [gridCols])
  useEffect(() => { gridRowsRef.current = gridRows }, [gridRows])
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  // Viewport-y of the pinned pane's bottom edge, frozen as the lightbox anchor so
  // the bottom-left corner stays put when the lightbox grows up + right.
  const paneBottomRef = useRef(0)
  const lightboxedRef = useRef(lightboxed)
  // Real tmux scrollback shown as one continuous capture when lightboxed.
  const [historyText, setHistoryText] = useState<string | null>(null)
  // Bumped to re-pull the capture (e.g. after sending a command) since the
  // lightbox capture is a snapshot, not the live attach stream.
  const [historyTick, setHistoryTick] = useState(0)
  const historyContainerRef = useRef<HTMLDivElement>(null)
  const historyTermRef = useRef<Terminal | null>(null)
  const refreshHistory = useCallback(() => {
    if (!lightboxedRef.current) return
    setTimeout(() => setHistoryTick(t => t + 1), 400)
    setTimeout(() => setHistoryTick(t => t + 1), 1200)
  }, [])

  useEffect(() => { pinnedRef.current = pinned }, [pinned])
  useEffect(() => { lightboxedRef.current = lightboxed }, [lightboxed])

  // On lightbox open, fetch the agent's real tmux scrollback (capture-pane via
  // the daemon). The live attach stream only carries the current screen, so this
  // is what makes backscroll meaningful. Snapshot — refetched each time you open.
  useEffect(() => {
    if (!lightboxed) { setHistoryText(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`${FLEET_API}/api/capture-pane`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: agentId, lines: HISTORY_LINES }),
        })
        if (!r.ok) return
        const { pane } = await r.json()
        if (!cancelled && typeof pane === 'string') setHistoryText(pane)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [lightboxed, agentId, historyTick])

  // Render the scrollback snapshot into a static, full-height xterm stacked above
  // the live screen. The body scrolls through [history][live] natively, so the
  // wheel moves smoothly (no xterm line-stepping), and the live screen stays live.
  useEffect(() => {
    const host = historyContainerRef.current
    if (!lightboxed || !historyText || !host) {
      if (historyTermRef.current) { historyTermRef.current.dispose(); historyTermRef.current = null }
      return
    }
    const text = historyText.replace(/\r?\n/g, '\r\n')
    const rows = Math.max(1, Math.min(historyText.split('\n').length, 2000))
    const term = new Terminal({
      cols: gridCols,
      rows,
      fontSize: 11,
      fontFamily: TERM_FONT,
      theme: TERM_THEME,
      scrollback: 0,
      cursorBlink: false,
      disableStdin: true,
    })
    term.open(host)
    term.write(text)
    historyTermRef.current = term
    // After the history renders, drop the body to the bottom so the live screen
    // is what's showing; scroll up to read history.
    requestAnimationFrame(() => {
      const body = bodyRef.current
      if (body) body.scrollTop = body.scrollHeight
    })
    return () => { term.dispose(); historyTermRef.current = null }
  }, [lightboxed, historyText, gridCols])

  // Create at the PEEK_COLS×PEEK_ROWS fallback, then resize to the agent's real
  // tmux window size when the 'size' message arrives (see the WS handler below).
  // The grid MUST match the window: the agent's TUI repaints at the window's
  // column count using absolute cursor positioning, so a mismatched grid garbles
  // every frame. We never reflow the grid to fit the popup — instead we scale the
  // rendered terminal visually (see the scale effect below).
  useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      cols: PEEK_COLS,
      rows: PEEK_ROWS,
      fontSize: 11,
      fontFamily: TERM_FONT,
      theme: TERM_THEME,
      scrollback: 200,
      cursorBlink: false,
      disableStdin: true,
    })
    term.open(containerRef.current)
    termRef.current = term
    try { term.resize(gridColsRef.current, gridRowsRef.current) } catch {}
    return () => {
      term.dispose()
      termRef.current = null
    }
  }, [])

  // Scale the fixed-grid terminal to fit the pane width. Peek/pinned shrink it
  // to fit (no horizontal scroll); the lightbox renders it at natural size.
  useEffect(() => {
    let raf = 0
    const measure = () => {
      const inner = containerRef.current?.querySelector('.xterm') as HTMLElement | null
      const body = bodyRef.current
      if (!inner || !body) return
      const natW = inner.offsetWidth
      if (!natW) { raf = requestAnimationFrame(measure); return }
      setScale(lightboxed ? 1 : Math.min(1, body.clientWidth / natW))
    }
    raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(() => measure())
    if (bodyRef.current) ro.observe(bodyRef.current)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [lightboxed, height, status, gridCols])

  // Leaving pinned mode also leaves the lightbox.
  useEffect(() => { if (!pinned) setLightboxed(false) }, [pinned])

  // On lightbox, scroll the body to the bottom so the live (cursor) region of
  // the terminal is what's visible, not the top of the screen.
  useEffect(() => {
    if (!lightboxed) return
    requestAnimationFrame(() => {
      const body = bodyRef.current
      if (body) body.scrollTop = body.scrollHeight
    })
  }, [lightboxed])

  // xterm installs its own wheel handler and preventDefault()s it, and its
  // viewport is overflow:hidden — so the wheel never reaches the scroll
  // container. Intercept it in the CAPTURE phase (before either xterm sees it)
  // and scroll the container ourselves, so backscroll works over both the
  // history block and the live screen.
  useEffect(() => {
    if (!lightboxed) return
    const body = bodyRef.current
    if (!body) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      body.scrollTop += e.deltaY
    }
    body.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => body.removeEventListener('wheel', onWheel, { capture: true } as any)
  }, [lightboxed, historyText])

  useEffect(() => {
    if (!agentId) return
    wsRef.current?.close()
    setStatus('connecting')
    let sawAuthoritativeSize = false
    let fallbackFlushed = false
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    const pendingOutput: TerminalOutputFrame[] = []
    const writeOutput = (msg: TerminalOutputFrame) => {
      const term = termRef.current
      if (!term) return
      if (msg.encoding === 'base64') {
        const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0))
        term.write(bytes)
      } else {
        term.write(msg.data)
      }
    }
    const flushPendingOutput = () => {
      if (!termRef.current) return
      for (const msg of pendingOutput) writeOutput(msg)
      pendingOutput.length = 0
    }
    fallbackTimer = setTimeout(() => {
      if (sawAuthoritativeSize) return
      fallbackFlushed = true
      for (const msg of pendingOutput) writeOutput(msg)
    }, 1500)
    // /ws/terminal must hit the fleet server (where the daemon is connected),
    // NOT the page origin — on the local copy the page is served from 5176 but
    // the daemon talks to Fly, so the page-origin socket had no daemon behind it.
    const ws = new WebSocket(appendToken(`${getFleetWsBase()}/ws/terminal?agent=${encodeURIComponent(agentId)}`))
    wsRef.current = ws
    ws.onopen = () => {
      setStatus('connected')
    }
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'size' && msg.cols && msg.rows) {
          // The daemon reports the agent's real tmux window size. Resize the live
          // grid to match so the absolute-positioned stream renders cleanly; the
          // scale effect then re-fits it to the panel width.
          setGridCols(msg.cols)
          setGridRows(msg.rows)
          try {
            const term = termRef.current
            term?.resize(msg.cols, msg.rows)
            if (fallbackTimer) {
              clearTimeout(fallbackTimer)
              fallbackTimer = null
            }
            if (!sawAuthoritativeSize) {
              sawAuthoritativeSize = true
              term?.clear()
              flushPendingOutput()
            }
          } catch { void 0 }
        } else if (msg.type === 'output' && msg.data && termRef.current) {
          if (sawAuthoritativeSize) {
            writeOutput(msg)
          } else {
            pendingOutput.push(msg)
            if (fallbackFlushed) writeOutput(msg)
          }
        } else if (msg.type === 'error') {
          setStatus('error')
        }
      } catch {}
    }
    ws.onerror = () => setStatus('error')
    ws.onclose = () => {}
    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer)
      ws.close()
    }
  }, [agentId])

  const sendInput = (data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }))
    }
    // Lightbox shows a capture snapshot, not the live stream — re-pull it so the
    // command's effect shows up.
    refreshHistory()
  }

  const submitInput = (text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'submit', text }))
    }
    // Lightbox shows a capture snapshot, not the live stream — re-pull it so the
    // command's effect shows up.
    refreshHistory()
  }

  const shortId = agentId.replace('fleet:', '')

  // Make this field the active voice target — dictation flows in, and saying
  // "send" runs the command in the terminal pane (mirrors the chat textarea's
  // setVoiceTarget wiring, but with a terminal-specific send).
  const registerVoice = (el: HTMLTextAreaElement) => {
    setVoiceTarget(el, [agentId], { [agentId]: shortId }, async (_targets: string[], text: string) => {
      submitInput(text)
      el.value = ''
    })
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    stopEventPropagation(e as any)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submitInput(inputRef.current?.value ?? '')
      if (inputRef.current) inputRef.current.value = ''
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault()
      sendInput('\x03')
      if (inputRef.current) inputRef.current.value = ''
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
  }

  const handleResizePointerDown = (e: React.PointerEvent) => {
    stopEventPropagation(e)
    dragRef.current = { startY: e.clientY, startH: height }
    dragCoordinator.claim(
      (ev) => {
        if (!dragRef.current) return
        const delta = ev.clientY - dragRef.current.startY
        setHeight(Math.max(100, dragRef.current.startH + delta))
      },
      () => { dragRef.current = null },
    )
  }

  return createPortal((
    // Carrier provides the .fleet-chat-shape scoped CSS + custom properties the
    // pane styles depend on (it's portaled out of the real chat shape). display:
    // contents so it adds no box and no opacity group — the pane stays fully opaque.
    <div className="fleet-chat-shape" style={{ display: 'contents' }}>
    <div
      ref={paneRef}
      className={`fleet-terminal-hover-pane${pinned ? ' fleet-terminal-hover-pane-pinned' : ''}${lightboxed ? ' fleet-terminal-hover-pane-lightboxed' : ''}`}
      style={{
        position: 'fixed',
        left: anchor?.left ?? 0,
        visibility: anchor ? 'visible' : 'hidden',
        ...(lightboxed
          // Grow UP + RIGHT from the pinned pane's bottom-left, which stays put.
          // Width comes from the lightbox CSS (min(840px,92vw)); height is fixed.
          ? {
              top: 'auto',
              bottom: (typeof window !== 'undefined' ? window.innerHeight : 0) - paneBottomRef.current,
              height: LIGHTBOX_H,
            }
          // Peek/pinned: top-anchored to the input's bottom edge at the chat's
          // width. Height is auto, so pinning ADDS the input bar below and the
          // terminal you saw on hover stays in place (pane grows downward).
          : {
              top: anchor?.top ?? 0,
              width: anchor?.width ?? 0,
              right: 'auto',
            }),
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={pinned ? undefined : onMouseLeave}
      onPointerDown={stopEventPropagation}
      onPointerMove={stopEventPropagation}
    >
      {/* No header bar — wasted space. Pinned peeks keep a tiny floating close. */}
      {pinned && (
        <button
          className="fleet-terminal-hover-close"
          title="Close terminal"
          onPointerDown={stopEventPropagation}
          onClick={(e) => { stopEventPropagation(e as any); onDismiss() }}
          style={{ position: 'absolute', top: 2, right: 4, zIndex: 3 }}
        >
          ×
        </button>
      )}
      <div
        ref={bodyRef}
        className="fleet-terminal-hover-body"
        style={lightboxed ? undefined : { height, flex: 'none' }}
      >
        {lightboxed && historyText && (
          <div ref={historyContainerRef} className="fleet-terminal-hover-history" />
        )}
        {/* Live scaled screen for the hover/pinned peek. In the lightbox we show
            the single continuous capture instead (history + current screen as one
            block), so the live wrapper is hidden once the capture has loaded —
            but stays mounted so the live term resumes when you leave the lightbox. */}
        <div
          className="fleet-terminal-hover-scale"
          style={
            lightboxed && historyText ? { display: 'none' }
            : lightboxed ? { transform: `scale(${scale})`, transformOrigin: 'top left' }
            : { transform: `scale(${scale})`, transformOrigin: 'bottom left', position: 'absolute', left: 0, bottom: 0 }
          }
        >
          <div ref={containerRef} />
        </div>
      </div>
      {pinned && (
        // Input bar shows whenever the pane is pinned — Skip's ask is that pinning
        // ALWAYS gives a field ("when you pin it, I'm not getting a text field").
        // It used to be gated on status==='connected', so a terminal that hadn't
        // connected (goose terminals, slow connects) pinned with no field at all.
        // sendInput() already no-ops while the WS isn't open, so an un-connected
        // field degrades safely; the placeholder reflects the connection state so
        // it reads as "waiting", not a dead field. (Making typing actually reach a
        // goose shell is the separate goose-terminal-connection item.)
        <div className="fleet-terminal-hover-input-bar"
          onPointerDown={stopEventPropagation}
          onPointerMove={stopEventPropagation}
        >
          <span className="fleet-terminal-hover-prompt">$</span>
          <textarea
            ref={inputRef}
            className="fleet-terminal-hover-input"
            rows={1}
            onKeyDown={handleInputKeyDown}
            onKeyUp={(e) => stopEventPropagation(e as any)}
            // Skip's ask: clicking into the pinned-terminal field must just focus
            // it so he can type — it must NOT auto-pop the lightbox (the "blowing
            // up on my screen"). The lightbox was historically spec'd to open on
            // field-tap; he asked for that removed and made manual. Focus only
            // here; do not setLightboxed(true).
            onPointerDown={(e) => { stopEventPropagation(e); registerVoice(e.currentTarget) }}
            onFocus={(e) => { stopEventPropagation(e); registerVoice(e.currentTarget) }}
            onBlur={(e) => { clearVoiceTarget(e.currentTarget); e.currentTarget.style.boxShadow = ''; setLightboxed(false) }}
            placeholder={status === 'connected' ? 'type or speak a command…' : status === 'error' ? 'terminal unavailable — reconnecting…' : 'connecting…'}
            // Suppress the iOS soft keyboard on touch (same as the main composer
            // ChatComposer.tsx + math notes): the field is voice/dictation-first,
            // and raising the on-screen keyboard shifts visualViewport, which
            // drags this portaled hover pane out of place (Skip: "the onscreen
            // keyboard drags the terminal hover somewhere else").
            inputMode={_isTouchDevice ? 'none' : undefined}
            spellCheck={false}
            autoComplete="off"
            style={{
              width: '100%',
              background: 'transparent',
              border: '1px solid rgba(128, 128, 128, 0.15)',
              borderRadius: 4,
              padding: '3px 26px 3px 18px',
              fontSize: 11,
              color: 'inherit',
              outline: 'none',
              resize: 'none',
              lineHeight: 1.4,
              fontFamily: 'inherit',
              fieldSizing: 'content',
              maxHeight: 120,
              boxSizing: 'border-box',
            } as any}
          />
          <button
            className="fleet-terminal-hover-ctrl-c"
            title="Send Ctrl+C"
            onPointerDown={(e) => { stopEventPropagation(e as any); sendInput('\x03') }}
          >
            ^C
          </button>
        </div>
      )}
      {pinned && (
        <div
          className="fleet-terminal-hover-resize-handle"
          onPointerDown={handleResizePointerDown}
          title="Drag to resize"
        />
      )}
    </div>
    </div>
  ), document.body)
}

// ---- Skill-state hover popover ----
// Hovering an agent's name in chat shows what skills they've read / owe /
// dismissed (with the reason). Data comes from /api/education/skills/:id.
type SkillState = {
  read: string[]
  owed: { skill: string; scope: string; trigger: string | null }[]
  dismissed: { skill: string; reason: string; scope: string; trigger: string | null }[]
  cards?: { drill: string; gradient: string | null; pass: boolean | null; gradedAt?: string }[]
}

// The orientation gradient → a colored dot, matching teacher's report-card icons.
function drillGradeIcon(g: string | null): string {
  if (g === 'oriented') return '🟢'
  if (g === 'recovers') return '🟡'
  if (g == null) return '⚪️'
  return '🔴' // drifts / drifts-at-<stage> / anything else
}

function SkillHoverPane({ agentId, agentName, anchorRect, onMouseEnter, onMouseLeave }: {
  agentId: string
  agentName: string
  anchorRect: { left: number; bottom: number; top: number }
  onMouseEnter: () => void
  onMouseLeave: () => void
}) {
  const [data, setData] = useState<SkillState | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/education/skills/${encodeURIComponent(agentId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(() => { if (!cancelled) { setData(null); setLoading(false) } })
    return () => { cancelled = true }
  }, [agentId])

  // Anchor below the name, clamped into the viewport.
  const PANE_W = 240
  const left = Math.max(6, Math.min(anchorRect.left, window.innerWidth - PANE_W - 6))
  const spaceBelow = window.innerHeight - anchorRect.bottom
  const placeAbove = spaceBelow < 160
  const style: React.CSSProperties = placeAbove
    ? { left, bottom: Math.max(6, window.innerHeight - anchorRect.top + 4), width: PANE_W }
    : { left, top: anchorRect.bottom + 4, width: PANE_W }

  const read = data?.read || []
  const owed = data?.owed || []
  const dismissed = data?.dismissed || []
  const cards = data?.cards || []
  const empty = !loading && read.length === 0 && owed.length === 0 && dismissed.length === 0 && cards.length === 0

  // Portal to <body>: the pane is position:fixed, but a fixed element inside the
  // TLDraw canvas's CSS transform is positioned relative to that transform, not
  // the viewport — so it lands far from the hovered name (whose rect is in
  // viewport coords). Portaling out of the transformed tree makes fixed coords
  // viewport-relative again (same fix as TerminalHoverPane).
  return createPortal((
    <div
      className="fleet-skill-hover-pane"
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onPointerDown={stopEventPropagation}
    >
      <div className="fleet-skill-hover-head">{agentName}</div>
      {loading && <div className="fleet-skill-hover-empty">…</div>}
      {empty && <div className="fleet-skill-hover-empty">no skill activity yet</div>}
      {cards.length > 0 && (
        <div className="fleet-skill-hover-section">
          <div className="fleet-skill-hover-label read">drills ({cards.length})</div>
          <div className="fleet-skill-hover-chips">
            {cards.map(c => (
              <span key={c.drill} className="fleet-skill-chip read">{drillGradeIcon(c.gradient)} {c.drill}</span>
            ))}
          </div>
        </div>
      )}
      {owed.length > 0 && (
        <div className="fleet-skill-hover-section">
          <div className="fleet-skill-hover-label owed">skills owed ({owed.length})</div>
          <div className="fleet-skill-hover-chips">
            {owed.map(o => <span key={o.skill} className="fleet-skill-chip owed">{o.skill}</span>)}
          </div>
        </div>
      )}
      {dismissed.length > 0 && (
        <div className="fleet-skill-hover-section">
          <div className="fleet-skill-hover-label dismissed">skills dismissed ({dismissed.length})</div>
          {dismissed.map(d => (
            <div key={d.skill} className="fleet-skill-dismissed-row">
              <span className="fleet-skill-chip dismissed">{d.skill}</span>
              {d.reason && <span className="fleet-skill-reason">“{d.reason}”</span>}
            </div>
          ))}
        </div>
      )}
      {read.length > 0 && (
        <div className="fleet-skill-hover-section">
          <div className="fleet-skill-hover-label read">skills read ({read.length})</div>
          <div className="fleet-skill-hover-chips">
            {read.map(s => <span key={s} className="fleet-skill-chip read">{s}</span>)}
          </div>
        </div>
      )}
    </div>
  ), document.body)
}

// Recursively read a FileSystemDirectoryEntry, returning { file, path } pairs
// where path is relative to the dropped folder root (e.g. "figures/foo.png")
async function traverseDirectory(entry: FileSystemEntry, prefix = ''): Promise<{ file: File, path: string }[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
    return [{ file, path: prefix + entry.name }]
  }
  const dirEntry = entry as FileSystemDirectoryEntry
  const reader = dirEntry.createReader()
  const results: { file: File, path: string }[] = []
  let batch: FileSystemEntry[]
  do {
    batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
    for (const child of batch) {
      results.push(...await traverseDirectory(child, prefix + entry.name + '/'))
    }
  } while (batch.length > 0)
  return results
}

// Upload a markdown file, rewriting local image refs to stable URLs for any
// companion files present in the same drop event.
// companions: { file, path } pairs where path is relative to the drop root.
// mdRelPath: path of the md file itself relative to the drop root (for resolving relative image refs).
// warnOnUnresolved: if true and some image refs couldn't be matched, appends a hint to the returned link.
async function uploadMarkdownWithImages(
  mdFile: File,
  companions: { file: File, path: string }[],
  mdRelPath?: string,
  warnOnUnresolved?: boolean,
): Promise<string> {
  const text = await mdFile.text()
  // Find local image paths: ![alt](path) where path is not http
  const localPathRe = /!\[[^\]]*\]\(([^)]+)\)/g
  const localPaths = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = localPathRe.exec(text)) !== null) {
    if (!m[1].startsWith('http')) localPaths.add(m[1])
  }
  // Directory of the md file relative to the drop root (e.g. "report/" or "")
  const mdDir = mdRelPath ? mdRelPath.split('/').slice(0, -1).join('/') : ''
  // Upload companions that match a local path by relative path or basename fallback
  const urlMap = new Map<string, string>()
  for (const localPath of localPaths) {
    const ref = localPath.replace(/^\.\//, '')
    const resolvedPath = mdDir ? `${mdDir}/${ref}` : ref
    const base = ref.split('/').pop() || ref
    const match =
      companions.find(c => c.path === resolvedPath) ||
      companions.find(c => c.file.name === base)
    if (!match) continue
    try {
      const fd = new FormData()
      fd.append('file', match.file, match.file.name)
      const r = await fetch(`${FLEET_API}/api/upload`, { method: 'POST', body: fd })
      if (!r.ok) continue
      const { url } = await r.json()
      urlMap.set(localPath, `${FLEET_API}${url}`)
    } catch {}
  }
  // Rewrite markdown and upload
  let rewritten = text
  for (const [orig, stable] of urlMap) {
    rewritten = rewritten.split(`](${orig})`).join(`](${stable})`)
  }
  const rewrittenFile = new File([new Blob([rewritten], { type: 'text/markdown' })], mdFile.name, { type: 'text/markdown' })
  const fd = new FormData()
  fd.append('file', rewrittenFile, rewrittenFile.name)
  const r = await fetch(`${FLEET_API}/api/upload`, { method: 'POST', body: fd })
  if (!r.ok) throw new Error(`markdown upload failed: ${r.status}`)
  const { url, name } = await r.json()
  let link = `[${name}](${FLEET_API}${url})`
  if (warnOnUnresolved && localPaths.size > 0) {
    const hasUnresolved = [...localPaths].some(p => !urlMap.has(p))
    if (hasUnresolved) {
      link += '\n⚠️ Some images couldn\'t be uploaded — drag the containing folder instead of the file.'
    }
  }
  return link
}

// --- Voice + trackpad input (global, one-time init) ---
initVoice()



// --- Markdown renderer using markdown-it + KaTeX ---

// Thin wrapper: delegate to the canonical renderMarkdown in utils.mjs.
// Input may be esc()'d (from chat-render) or raw (from delegation cards).
// renderMarkdown expects esc()'d input and un-escapes internally.
function tldaRenderMarkdown(input: string, macros?: Record<string, string>): string {
  // If input looks raw (not escaped), escape it first so renderMarkdown
  // can un-escape and process normally.
  const looksEscaped = input.includes('&amp;') || input.includes('&lt;') || input.includes('&gt;')
  const escapedInput = looksEscaped ? input : esc(input)
  // Extract «...» chip tokens before KaTeX rendering — math inside tokens
  // (e.g. «highlight:text $x^2$#shape:ID») would otherwise be converted to
  // HTML spans, breaking the postProcess regex.
  const chipSlots: string[] = []
  const safeInput = escapedInput.replace(/«[^»]+»/g, (tok) => {
    chipSlots.push(tok)
    return `\x00CHIP${chipSlots.length - 1}\x00`
  })
  let rendered = renderMarkdownUtil(safeInput, macros)
  for (let i = 0; i < chipSlots.length; i++) {
    rendered = rendered.replace(`\x00CHIP${i}\x00`, chipSlots[i])
    rendered = rendered.replace(`CHIP${i}`, chipSlots[i])
  }
  return rendered
}

// --- Viewer context helper ---

function gatherViewerContext(editor: any, doc: any, chatShapeId?: string, version?: string | null) {
  if (!editor || !doc) return null
  const mainEd = (window as any).__tldraw_editor__ || editor
  const camera = mainEd.getCamera()
  const viewport = mainEd.getViewportPageBounds()
  const visiblePages: number[] = []
  const viewportEdges: { page: number; topY: number; bottomY: number }[] = []
  if (doc.pages && viewport) {
    doc.pages.forEach((page: any, i: number) => {
      const b = page.bounds
      if (!b) return
      const bw = b.w ?? b.width ?? 0
      const bh = b.h ?? b.height ?? 0
      if (b.x + bw > viewport.minX && b.x < viewport.maxX &&
          b.y + bh > viewport.minY && b.y < viewport.maxY) {
        visiblePages.push(i + 1)
        const topY = Math.max(viewport.minY - b.y, 0)
        const bottomY = Math.min(viewport.maxY - b.y, bh)
        viewportEdges.push({ page: i + 1, topY, bottomY })
      }
    })
  }
  const compareRef = (window as any).__tlda_compare_ref__ || null
  const ctx: any = {
    doc: doc.docName || null,
    version: version || null,
    compareRef,
    page: visiblePages.length === 1 ? visiblePages[0] : visiblePages.length > 1 ? visiblePages : null,
    camera: { x: Math.round(camera.x), y: Math.round(camera.y), z: Math.round(camera.z * 100) / 100 },
    chatShapeId: chatShapeId || undefined,
    browser: /Chrome/.test(navigator.userAgent) ? 'chrome' : /Safari/.test(navigator.userAgent) ? 'safari' : /Firefox/.test(navigator.userAgent) ? 'firefox' : 'unknown',
    _viewportEdges: viewportEdges,
  }
  const stale = computeStaleness(mainEd, doc, version, visiblePages, viewport)
  if (stale) ctx.stale = stale
  sendViewingContext(ctx)
  return ctx
}

/**
 * Detect whether the pages under the camera have drifted from the current build
 * (Built). The version stamp is always Built; this is the *exceptional* flag
 * that rides on the location only when Displayed != Built. Returns null in the
 * normal (caught-up) case. Skips entirely when the user has scrubbed to another
 * version (the stamp won't equal Built then) — drift-vs-Built isn't meaningful.
 */
function computeStaleness(
  editor: any, doc: any, version: string | null | undefined,
  visiblePages: number[], viewport: any,
): { kinds: string[]; pages?: number[]; builtHash: string; note: string } | null {
  const sent = editor?.store?.get?.('shape:doc-version--sentinel' as TLShapeId)
  const rawHash = (sent as any)?.props?.commitHash
  const builtHash = rawHash && rawHash !== 'unknown' ? String(rawHash).slice(0, 7) : null
  if (!builtHash) return null
  // Scrubbed to a non-Built version → drift-vs-Built doesn't apply.
  if (version && version !== builtHash) return null

  const builtCount = getBuiltPageCount()
  const laidOutCount = doc?.pages?.length ?? 0
  const kinds = new Set<string>()
  const stalePages: number[] = []

  for (const pn of visiblePages) {
    const idx0 = pn - 1
    if (builtCount != null && idx0 >= builtCount) {        // doc shrank: page past the built end
      kinds.add('phantom'); stalePages.push(pn); continue
    }
    const shapeId = doc?.pages?.[idx0]?.shapeId
    const rh = shapeId ? getPageRenderHash(shapeId) : undefined
    if (rh == null) { kinds.add('unrendered'); stalePages.push(pn) }     // never rendered in this viewer yet
    else if (rh !== builtHash) { kinds.add('stale'); stalePages.push(pn) } // showing an older render
  }

  // doc grew: more built pages than are laid out, and the camera sits past the last laid-out page.
  if (builtCount != null && builtCount > laidOutCount && viewport) {
    const lb = doc?.pages?.[laidOutCount - 1]?.bounds
    const lastBottom = lb ? lb.y + (lb.h ?? lb.height ?? 0) : 0
    if (viewport.maxY > lastBottom) kinds.add('missing')
  }

  if (kinds.size === 0) return null
  return {
    kinds: [...kinds],
    pages: stalePages.length ? stalePages : undefined,
    builtHash,
    note: 'pages under the camera have not caught up to the build; source anchor is provisional until reload',
  }
}

async function enrichContextWithSourceLines(context: any): Promise<void> {
  const edges = context?._viewportEdges
  delete context?._viewportEdges
  if (!context?.doc || !edges?.length) return
  const first = edges[0]
  const last = edges[edges.length - 1]
  try {
    const [topAnchor, bottomAnchor] = await Promise.all([
      getSourceAnchor(context.doc, first.page, 300, first.topY),
      getSourceAnchor(context.doc, last.page, 300, last.bottomY),
    ])
    if (topAnchor) {
      context.sourceLine = {
        file: topAnchor.file,
        startLine: topAnchor.line,
        endLine: bottomAnchor?.line || topAnchor.line,
        endFile: bottomAnchor?.file,
      }
    }
  } catch {}
  delete context._viewportEdges
}

setViewingEnrichFn(async (ctx: any) => {
  await enrichContextWithSourceLines(ctx)
  return ctx
})

/**
 * Resolve the document version the user is currently viewing, as a short hash
 * for chat metadata. If the user has scrubbed back (shadow slider or git-history
 * slider) the stamp reflects that historical version. Otherwise — the common
 * case, viewing the live build — it reads the version straight from the
 * doc-version sentinel, the convergent source that also drives the rendered
 * pages and corner timestamp, so the stamp can't lag behind the actual build.
 */
function currentDocVersion(panel: any, editor?: Editor | null): string | null {
  // Scrubbed back via the shadow slider → the historical version you're comparing against.
  const sav = panel?.shadowActiveVersion
  if (sav?.hash) return String(sav.hash).slice(0, 7)

  // Scrubbed back via the git-history slider → the entry you scrubbed to.
  const idx = panel?.activeHistoryIdx
  if (typeof idx === 'number' && idx >= 0) {
    const e = panel?.historyEntries?.[idx]
    return e?.commitHash ? String(e.commitHash).slice(0, 7) : null
  }

  // Not scrubbed → the current build (Built). Single canonical source: the
  // doc-version sentinel, which the build writes on every build. Never the lazy
  // historyEntries list — it only refreshes on a full reload / text-changing
  // rebuild, so it drifts out of date.
  // Read from the MAIN editor: the chat shape can render in the HUD's copy
  // store, which does not contain the doc-room sentinel shape.
  const mainEd = (typeof window !== 'undefined' && (window as any).__tldraw_editor__) || editor
  if (mainEd) {
    const s = mainEd.store.get('shape:doc-version--sentinel' as TLShapeId)
    const hash = (s as any)?.props?.commitHash
    if (hash && hash !== 'unknown') return String(hash).slice(0, 7)
  }
  return null
}

/**
 * Scan message text for «highlight:...#shape:ID» and «annotation:...#shape:ID» tokens,
 * look up each shape in the editor, and return an attachments array for sendMessage().
 * The receiving side (fleet.mjs resolveChipTokens) looks up attachments by token to
 * expand them into formatted source-line references for agents.
 */
function buildRefAttachments(text: string, _editor: any): Array<{
  token: string; type: string; label: string;
  color?: string; file?: string; sourceLines?: any[]; content?: string
}> {
  if (!text || !text.includes('«')) return []
  const chipPattern = /«(.+?)»/g
  const attachments = []
  for (const match of text.matchAll(chipPattern)) {
    const inner = match[1]
    const colonIdx = inner.indexOf(':')
    if (colonIdx < 0) continue
    const type = inner.slice(0, colonIdx)
    if (type !== 'highlight' && type !== 'annotation') continue

    const token = match[0]
    const hashIdx = inner.lastIndexOf('#')
    if (hashIdx < 0) continue
    const shapeRef = inner.slice(hashIdx + 1)  // e.g. "shape:V2nwXJKv2uYjzQia8ll1E"
    const label = inner.slice(colonIdx + 1, hashIdx)

    const mainEditor = (window as any).__tldraw_editor__
    if (!mainEditor) continue
    const shape = mainEditor.getShape(shapeRef as any)
    if (!shape) continue
    const meta = shape.meta as any

    // sourceLines: [{line, content, file, highlighted, hlStart?, hlEnd?}]
    // hlStart/hlEnd are character offsets within the line for precise column ranges.
    const sourceLines: any[] = meta?.sourceLines || []
    const highlighted = sourceLines.filter((sl: any) => sl.highlighted === true)
    const firstLine = highlighted.length > 0 ? highlighted[0] : sourceLines[0]

    const attachment: any = {
      token,
      type,
      label,
      color: meta?.glowColor,
      file: firstLine?.file,
      sourceLines,
      content: meta?.highlightText || label,
    }
    // Include screenshot for unresolved highlights
    if (meta?.unresolved && meta?.screenshotDataUrl) {
      attachment.screenshotDataUrl = meta.screenshotDataUrl
      attachment.unresolved = true
    }
    attachments.push(attachment)
  }
  return attachments
}

// --- Shape definition ---

export class FleetChatShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-chat' as const
  static override props = {
    w: T.number,
    h: T.number,
    filter: T.arrayOf(T.arrayOf(T.arrayOf(T.string))),  // DNF of [role, label] tuples
    trafficMode: T.optional(T.string),
    userId: T.optional(T.string),
    deviceId: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, filter: [], trafficMode: 'normal', userId: '', deviceId: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canSnap = () => true
  override canBind = () => false
  override hideRotateHandle = () => true
  override onTranslateStart = () => beginNativeSnapDrag(this.editor)
  override onTranslateEnd = () => endNativeSnapDrag(this.editor)
  override onTranslateCancel = () => endNativeSnapDrag(this.editor)

  component(shape: any) {
    return <FleetChatComponent shape={shape} />
  }

  getIndicatorPath() {
    return undefined
  }

  indicator() {
    return null
  }
}

// --- Elapsed time display (isolated to avoid re-rendering entire chat) ---
function ElapsedTime({ startMs }: { startMs: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const secs = Math.floor((Date.now() - startMs) / 1000)
  const str = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
  return <span className="thinking-elapsed">({str})</span>
}

function ContextBadge({ percent }: { percent?: number }) {
  if (percent == null) return null
  const color = percent <= 15 ? '#e57373' : percent <= 30 ? '#ffb74d' : '#81c784'
  return (
    <span style={{ fontSize: 10, color, opacity: 0.8, flexShrink: 0, marginLeft: 8 }}>
      {percent}%
    </span>
  )
}

/**
 * ThinkingStatus — one status line per agent (thinking / compacting / waking /
 * hibernating). The slot reserves one row of height unconditionally so the line
 * fading in/out never shifts the stack (no bounce); content shows when a status
 * is active, blank otherwise. (A reserve-then-consume variant was tried but
 * fought the virtualized chat layout — flashed on every message — and was
 * reverted; see scratch/status-line-spec.md.)
 */
function ThinkingStatus({ thinkingAgents, compactingAgents, contextPercent, hibernatingAgents, ctx, agents: _agents, itemCount: _itemCount, escalationState, suggestions }: {
  thinkingAgents: Map<string, number>
  compactingAgents: Map<string, number>
  contextPercent: Map<string, number>
  hibernatingAgents: Set<string>
  ctx: any
  agents: any[]
  itemCount: number
  escalationState?: Record<string, { level: number; confirmed: number }>
  suggestions: Suggestion[]
}) {
  // Build status display from server-authoritative agent status field.
  // thinkingAgents/compactingAgents are pre-filtered to chat targets and provide elapsed timestamps.
  // hibernatingAgents is pre-filtered to chat targets.
  // Tracks the hibernating set from the previous render + which agents are
  // currently "waking" (left hibernating, alive, not yet thinking). This closes
  // the hibernating→awake→thinking gap WITHOUT a timer: an agent wakes because
  // it has work, so it always proceeds to thinking — we just hold a 'waking'
  // status from the moment it leaves hibernating until thinking lands (or it
  // hibernates again). No arbitrary duration; the real thinking event ends it.
  const prevHibRef = useRef<Set<string>>(new Set())
  const wakingRef = useRef<Set<string>>(new Set())
  const statusAgents = useMemo(() => {
    const merged = new Map<string, { status: 'thinking' | 'compacting' | 'hibernating' | 'waking', startTs: number }>()
    for (const [id, ts] of thinkingAgents) {
      merged.set(id, { status: 'thinking', startTs: ts })
    }
    for (const [id, ts] of compactingAgents) {
      if (!merged.has(id)) merged.set(id, { status: 'compacting', startTs: ts })
    }
    for (const id of hibernatingAgents) {
      if (!merged.has(id)) merged.set(id, { status: 'hibernating', startTs: 0 })
    }
    // An agent present last render's hibernating set but gone from it now (and
    // not already thinking/compacting) just woke → mark it waking.
    for (const id of prevHibRef.current) {
      if (!hibernatingAgents.has(id) && !merged.has(id)) wakingRef.current.add(id)
    }
    // Clear waking once the agent reaches a real status (thinking/compacting) or
    // goes back to hibernating; otherwise keep showing it through the gap.
    for (const id of [...wakingRef.current]) {
      if (merged.has(id)) wakingRef.current.delete(id)
      else merged.set(id, { status: 'waking', startTs: 0 })
    }
    prevHibRef.current = new Set(hibernatingAgents)
    return merged
  }, [thinkingAgents, compactingAgents, hibernatingAgents])

  // Suggestions live in the per-agent status row, keyed by the agent that
  // posted them. An agent with no thinking/compacting status (e.g. a bot like
  // todd) still gets a row the moment it has a suggestion — the suggestion IS
  // its status. The row set is the union of agents-with-status and
  // agents-with-suggestions.
  const suggestionsByAgent = useMemo(() => {
    const m = new Map<string, Suggestion[]>()
    for (const s of suggestions) {
      const key = suggestionOwnerId(s)
      if (!key) continue
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(s)
    }
    return m
  }, [suggestions])
  const rowAgentIds = useMemo(() => {
    const ids = new Set<string>(statusAgents.keys())
    for (const k of suggestionsByAgent.keys()) ids.add(k)
    // A row with suggestions but no status and no context% is a bot (e.g. todd) —
    // float it above the working agents. Order within each group is preserved.
    const isBot = (id: string) =>
      (suggestionsByAgent.get(id)?.length ?? 0) > 0 &&
      !statusAgents.has(id) &&
      contextPercent.get(id) === undefined
    const all = [...ids]
    return [...all.filter(isBot), ...all.filter((id) => !isBot(id))]
  }, [statusAgents, suggestionsByAgent, contextPercent])

  const statusKeysStr = [...statusAgents.keys()].join(',')
  useEffect(() => {
    // Log only when the set of shown statuses changes — NOT per message. (A
    // previous version read offsetHeight on every itemCount change, forcing a
    // layout reflow on each keystroke → the screen flash.)
    log.info('thinking-line', 'render', {
      keys: statusKeysStr ? statusKeysStr.split(',') : [],
      rows: statusAgents.size,
    })
  }, [statusKeysStr])

  return (
    <div style={{
      padding: '0 8px',
      fontSize: 11,
      flexShrink: 0,
      // One row of reserved height, always — the anti-bounce floor.
      minHeight: 'calc(var(--fleet-base-font, 11px) * 1.5 + 4px)',
    }}>
      {rowAgentIds.map((agentId) => {
        const statusEntry = statusAgents.get(agentId)
        const status = statusEntry?.status
        const startTs = statusEntry?.startTs ?? 0
        const chips = suggestionsByAgent.get(agentId) || []
        const esc = escalationState?.[agentId]
        const escLevel = esc?.level || 0
        const escConfirmed = esc?.confirmed || 0
        function tierOpacity(tier: number) {
          if (escLevel < tier) return 0.15
          if (escConfirmed >= tier) return 1
          return 0.55
        }
        const statusText = status === 'hibernating' ? 'is hibernating'
          : status === 'waking' ? 'waking up…'
          : status === 'compacting' ? 'compacting…'
          : status === 'thinking' ? 'thinking…'
          : null
        return (
          <div key={agentId} className="chat-line chat-thinking" style={{ padding: '2px 0', display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'baseline', gap: 6 }}>
            {/* left: agent + status */}
            <span style={{ justifySelf: 'start', minWidth: 0 }}>
              <span className="thinking-text">
                <PhaseIcon phase={phaseFromName(ctx.agentFullName(agentId))} />{baseName(ctx.agentFullName(agentId)).replace('fleet:', '')}
              </span>
              {statusText && <>{' '}<span className="thinking-text">{statusText}</span></>}
              {status && status !== 'hibernating' && status !== 'waking' && <>{' '}<ElapsedTime startMs={startTs} /></>}
              {escLevel > 0 && (
                <span className="escalation-meter" style={{ marginLeft: 6, letterSpacing: 2, fontSize: '0.9em' }}>
                  <span style={{ opacity: tierOpacity(1), transition: 'opacity 0.15s' }}>↑</span>
                  <span style={{ opacity: tierOpacity(2), transition: 'opacity 0.15s' }}>⏸</span>
                  <span style={{ opacity: tierOpacity(3), transition: 'opacity 0.15s' }}>💀</span>
                </span>
              )}
            </span>
            {/* center: suggestion groups. The grid track (minmax(0,1fr)) is the
                bound — this span fills it and clips/wraps within, so wide
                suggestions can never crowd the agent-status / context columns. */}
            <span style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap', justifyContent: 'center', minWidth: 0, overflow: 'hidden' }}>
              {[...groupChips(chips)].map(([gkey, items]) => (
                <SuggestionGroup key={gkey} chips={items} agentName={ctx.agentLabel(suggestionOwnerId(items[0]))} />
              ))}
            </span>
            {/* right: context info */}
            <span style={{ justifySelf: 'end' }}>
              <ContextBadge percent={contextPercent.get(agentId)} />
            </span>
          </div>
        )
      })}
    </div>
  )
}

// groupKey: suggestions sharing a `group` tag are one disjunctive group; an
// untagged suggestion is its own singleton group (keyed by its id).
function groupKeyOf(s: Suggestion): string { return `${s.messageId || ''}::${s.group || String(s.id)}` }
function suggestionOwnerId(s?: Suggestion): string { return s?.from || s?.targetId || '' }
function groupChips(chips: Suggestion[]): Map<string, Suggestion[]> {
  const m = new Map<string, Suggestion[]>()
  for (const c of chips) {
    const k = groupKeyOf(c)
    if (!m.has(k)) m.set(k, [])
    m.get(k)!.push(c)
  }
  return m
}

function SuggestionRow({ chips, ctx }: { chips: Suggestion[], ctx: any }) {
  return (
    <div className="chat-line chat-suggestions-inline" style={{ padding: '2px 8px 4px', fontSize: 11 }}>
      {[...groupChips(chips)].map(([gkey, items]) => (
        <SuggestionGroup key={gkey} chips={items} agentName={ctx.agentLabel(suggestionOwnerId(items[0]))} />
      ))}
    </div>
  )
}

// One disjunctive group: ✕ on the left (dismiss the group), then the options
// `|`-separated (each clickable to pick → sends its command + clears the group).
// One shared hover on the whole group → a single tooltip listing the options.
function SuggestionGroup({ chips, agentName }: { chips: Suggestion[], agentName: string }) {
  const fromAgent = suggestionOwnerId(chips[0])
  const key = groupKeyOf(chips[0])
  const details = chips
    .map(c => c.text ? `${c.label}: ${c.text}` : c.label)
    .join('\n')
  const pick = (c: Suggestion) => (e: React.SyntheticEvent) => {
    stopEventPropagation(e as any)
    if (c.command) sendMessage(c.targetId || c.from || '', c.command)
    clearGroup(fromAgent, key)
  }
  const dismiss = (e: React.SyntheticEvent) => {
    stopEventPropagation(e as any)
    clearGroup(fromAgent, key)
  }
  const stopNotePointer = (e: React.SyntheticEvent) => {
    stopEventPropagation(e)
  }
  return (
    <span
      className="suggestion-group"
      onPointerDown={stopEventPropagation}
    >
      {/* onPointerUp not onClick: these are text <span>s, dead on touch (a tap
          synthesizes no click). pointerup fires for mouse + finger + stylus. */}
      <span className="suggestion-chip-x" title="Dismiss" onPointerUp={dismiss}>✕</span>
      {details && (
        <span
          className="suggestion-note-icon"
          title={`${details}\n→ ${agentName}`}
          aria-label={`Suggestion details for ${agentName}`}
          onPointerUp={stopNotePointer}
        >
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 2.5h6l2 2v9H4z" />
            <path d="M10 2.5v2h2" />
            <path d="M6 7h4M6 10h4" />
          </svg>
        </span>
      )}
      {chips.map((c, i) => (
        <span key={c.id}>
          {i > 0 ? <span className="suggestion-group-sep"> | </span> : ' '}
          <span className="suggestion-chip-label" onPointerUp={pick(c)}>{c.label}</span>
        </span>
      ))}
    </span>
  )
}

// --- Nick color system (matches dashboard) ---

const nickColors = ['nick-agent-0','nick-agent-1','nick-agent-2','nick-agent-3','nick-agent-4','nick-agent-5']
const nickHex = ['#7a9ec8','#9370db','#c8956a','#6aafb0','#b87a95','#c8b060']
const nickMap = new Map<string, string>()
const nickHexMap = new Map<string, string>()
let nickIdx = 0

function makeCtx(agents: any[], tasks: any[], preambleMacros: Record<string, string>) {
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
    if (id === 'keepalive') return 'nick-keepalive'
    if (!nickMap.has(id)) {
      const idx = nickIdx % nickColors.length
      nickMap.set(id, nickColors[idx])
      nickHexMap.set(id, nickHex[idx])
      nickIdx++
    }
    return nickMap.get(id)!
  }
  const getAgentColor = (id: string) => nickHexMap.get(id) || '#9370db'
  // Full friendly name (e.g. "conc5:day") — keeps the phase suffix so AgentName
  // can render the dawn/day/dusk glyph. agentLabel strips it; use this where the
  // lineage lift should show.
  const agentFullName = (id: string) => {
    if (!id) return ''
    const a = agents.find((a: any) => a.id === id)
    return a?.friendly_name || (typeof id === 'string' ? id : String(id))
  }
  return {
    agentLabel,
    agentFullName,
    getNickClass,
    getAgentColor,
    isHumanId: (id: string) => {
      const a = agents.find((a: any) => a.id === id)
      return !!(a?.human)
    },
    getAgents: () => agents,
    getTasks: () => tasks,
    tldaToken: null as string | null,
    renderMarkdown: (input: string) => tldaRenderMarkdown(input, preambleMacros),
    highlightSyntax,
    langFromFilePath,
    preambleMacros,
    // Per-tool fold heights (lines; 0 = never fold). Monitoring/tool content only.
    foldHeights: {
      bash: getPref('fold-bash-lines'),
      write: getPref('fold-write-lines'),
      md: getPref('fold-md-lines'),
      diff: getPref('fold-diff-lines'),
    },
  }
}


// Apply a text transform only to non-code regions of HTML.
// Iterates alternating tag and text segments; tracks <code>/<pre> nesting depth
// so that transforms are never applied to content inside code spans or blocks.
function transformNonCode(html: string, transform: (text: string) => string): string {
  let inCode = 0
  return html.replace(/((?:<[^>]*>)|(?:[^<]+))/g, (segment) => {
    if (segment.startsWith('<')) {
      if (/^<(code|pre)\b/i.test(segment)) inCode++
      else if (/^<\/(code|pre)>/i.test(segment)) inCode = Math.max(0, inCode - 1)
      return segment
    }
    return inCode > 0 ? segment : transform(segment)
  })
}

// --- Virtual chat message row ---
// Defined outside FleetChatInner so React.memo comparisons are stable.
// Receives raw rendered HTML from renderChatLine/renderActivityGroup and a
// postProcess function (useCallback-stable) for chip/link resolution.
const ChatMessageRow = memo(function ChatMessageRow({
  html,
  postProcess,
  itemKey,
  expandedRowsRef,
}: {
  html: string
  postProcess: (html: string) => string
  itemKey: string
  expandedRowsRef: React.RefObject<Set<string>>
}) {
  const processed = useMemo(() => probe.time('chat', 'chat-row-postprocess', () => postProcess(html), {
    itemKey,
    htmlLength: html.length,
  }), [html, postProcess, itemKey])
  const divRef = useRef<HTMLDivElement>(null)

  // Restore expand state after dangerouslySetInnerHTML replaces the DOM.
  useLayoutEffect(() => {
    const t0 = probe.isEnabled('chat') ? performance.now() : 0
    const el = divRef.current
    if (!el) return
    const expanded = expandedRowsRef.current
    if (expanded.has(itemKey)) {
      const moreRows = el.querySelector('.pretty-more-rows') as HTMLElement | null
      if (moreRows) {
        moreRows.style.display = ''
        const btn = el.querySelector('.pretty-expand-btn') as HTMLElement | null
        if (btn) btn.textContent = 'collapse'
      }
    }
    // Restore code-block expand state (each block keyed by index within the row)
    el.querySelectorAll('.code-block-wrap').forEach((wrap, i) => {
      if (expanded.has(`${itemKey}:code:${i}`)) {
        const body = wrap.querySelector('.fold-body, pre') as HTMLElement | null
        if (body) { body.classList.remove('code-collapsed'); body.style.maxHeight = '' }
        const toggle = wrap.querySelector('.code-block-toggle') as HTMLElement | null
        if (toggle) toggle.textContent = 'collapse'
      }
    })
    if (probe.isEnabled('chat')) {
      const dt = performance.now() - t0
      if (dt > 1) probe.record('chat', 'chat-row-layout-restore', dt, { itemKey })
    }
  }, [processed, itemKey, expandedRowsRef])

  return <div ref={divRef} data-item-key={itemKey} dangerouslySetInnerHTML={{ __html: processed }} />
}, (prev, next) => prev.html === next.html && prev.postProcess === next.postProcess && prev.itemKey === next.itemKey)


function FleetChatInner({ shape }: { shape: any }) {
  const editor = useEditor()
  const viewportId = useVisibilityViewportId()
  const doc = useContext(DocContext)
  const panel = useContext(PanelContext)
  const fleetStyleVars = useFleetStyleVars()
  const { w, h, filter, trafficMode = 'normal' } = shape.props as { w: number; h: number; filter: [string, string][][]; trafficMode?: ChatTrafficMode }
  const quietTraffic = trafficMode === 'quiet'
  const quietDmTraffic = quietTrafficSuppressesActivity(filter, trafficMode)
  void useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterOpenByPill, setFilterOpenByPill] = useState(false)

  // Keep a ref to the current filter so the rename effect can read it without a stale closure
  const filterRef = useRef(filter)
  filterRef.current = filter

  // Track previous agent friendly names to detect renames (populated after agents is declared below)
  const prevAgentNamesRef = useRef<Record<string, string>>({})

  const activeBullets = useSyncExternalStore(subscribeBulletContext, getBulletContexts)

  // DNF filter: [[[role,label],...],...]  — OR of AND-groups of [role, label] tuples
  const dnfFilter = filter.length > 0 ? filter : null

  // Load lookup data for doc reference resolution
  const [lookup, setLookup] = useState<LookupData | null>(null)
  const [labelRegions, setLabelRegions] = useState<Record<string, LabelRegionInfo>>({})
  const [theoremMap, setTheoremMap] = useState<Record<string, TheoremMapEntry>>({})
  useEffect(() => {
    if (!doc?.docName) return
    loadLookup(doc.docName).then(setLookup)
    fetchProofInfo(doc.docName).then(data => {
      if (data?.labelRegions) setLabelRegions(data.labelRegions)
    })
    fetchTheoremMap(doc.docName).then(data => {
      if (data) setTheoremMap(data)
    })
  }, [doc?.docName])

  const refResolver = useMemo(() => lookup ? buildRefResolver(lookup, theoremMap) : null, [lookup, theoremMap])

  // Live data from fleet-data.mjs via SSE (or playback data if inside a PlaybackFrame)
  const frameId = shape.parentId as string | undefined
  const agents = useFleetAgents(frameId)
  const liveEvents = useFleetEvents(dnfFilter, frameId)
  const tasks = useFleetTasks(frameId)
  const thinkingAgents = useFleetThinking(dnfFilter, frameId)
  const compactingAgents = useFleetCompacting(dnfFilter, frameId)
  const contextPercent = useFleetContext(dnfFilter, frameId)
  const suggestionsAll = useSuggestions()

  // When an agent renames itself, auto-update any filter terms that used the old name.
  useEffect(() => {
    const prev = prevAgentNamesRef.current
    const curr: Record<string, string> = {}
    for (const a of agents) {
      if (a.id && a.friendly_name) curr[a.id] = a.friendly_name
    }
    const currentFilter = filterRef.current
    let newFilter = currentFilter
    let changed = false
    for (const [id, oldName] of Object.entries(prev)) {
      const newName = curr[id]
      if (!newName || oldName === newName) continue
      const hasOldName = newFilter.some(clause => clause.some(([, label]) => label === oldName))
      if (!hasOldName) continue
      newFilter = newFilter.map(clause =>
        clause.map(([role, label]) => [role, label === oldName ? newName : label] as [string, string])
      )
      changed = true
    }
    prevAgentNamesRef.current = curr
    if (changed) {
      editor.updateShape({ id: shape.id, type: 'fleet-chat' as any, props: { filter: newFilter } })
    }
  }, [agents])

  // Terminal card — hover to show, click to pin. Replaces the old auto-open set.
  const [termCardHoverId, setTermCardHoverId] = useState<string | null>(null)
  const [termCardPinnedId, setTermCardPinnedId] = useState<string | null>(null)
  const termCardHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Hover-intent: cursor must rest on a terminal card before the peek opens, so a
  // cursor merely passing through never triggers it.
  const termCardShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const termCardPendingIdRef = useRef<string | null>(null)

  const dismissTermCard = useCallback((agentId: string) => {
    // Mark terminal events from this agent as read when dismissed.
    const unreadEventIds = liveEvents
      .filter((e: any) =>
        (e._evType === 'terminal_card' || e._evType === 'terminal_attention') &&
        e.from === agentId &&
        e.read !== true && (e._dbId || e.id)
      )
      .map((e: any) => e._dbId || e.id)
    for (const eid of unreadEventIds) {
      fetch(`${FLEET_API}/api/mark-event-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: eid, agent: getHumanId() }),
      }).catch(e => console.warn('[fleet-chat] mark-read failed:', e.message))
    }
    setTermCardPinnedId(null)
    setTermCardHoverId(null)
  }, [liveEvents])

  // Esc interrupt: track last Esc timestamp for soft/hard distinction
  const escCountRef = useRef<number>(0)
  // Track whether the user last clicked inside this fleet chat shape.
  // Voice/touch users don't focus the textarea, so activeElement-based checks fail.
  const chatActiveRef = useRef(false)
  // Keep sendTargets accessible from native event listener without re-registering
  const sendTargetsRef = useRef<string[]>([])
  // Per-agent escalation state: tracks Esc presses for thinking indicator display.
  // { [agentId]: { level, confirmed } } — level = optimistic (on keypress), confirmed = server ack'd
  const [escalationState, setEscalationState] = useState<Record<string, { level: number; confirmed: number }>>({})

  // Clear escalation state when an agent stops thinking
  useEffect(() => {
    setEscalationState(prev => {
      let changed = false
      const next = { ...prev }
      for (const agentId of Object.keys(next)) {
        if (!thinkingAgents.has(agentId) && !compactingAgents.has(agentId)) {
          delete next[agentId]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [thinkingAgents, compactingAgents])
  const setEscLevel = (agentId: string, level: number) => {
    setEscalationState(prev => ({ ...prev, [agentId]: { level, confirmed: prev[agentId]?.confirmed || 0 } }))
  }
  const confirmEscLevel = (agentId: string, level: number) => {
    setEscalationState(prev => {
      const cur = prev[agentId]
      if (!cur) return prev
      return { ...prev, [agentId]: { ...cur, confirmed: Math.max(cur.confirmed, level) } }
    })
  }
  const clearEscState = (agentId: string) => {
    setEscalationState(prev => { const next = { ...prev }; delete next[agentId]; return next })
  }

  // Escape un-queues messages: messages sent before this timestamp are above the divider
  const [unqueuedAt, setUnqueuedAt] = useState(0)

  // One buffer: liveEvents IS the full id-keyed store view (live + backfilled
  // history, deduped by id in fleet-data). No live/older merge here — that merge
  // seam was what rendered a slipped event twice. Scrollback is folded into the
  // same store by loadBefore(), so it just appears in this list.
  const events = liveEvents

  // Reset scroll state when filter changes (history for the new filter is folded
  // into the store by the backfill effect below).
  const filterKey = JSON.stringify(filter)
  useEffect(() => {
    isAtBottomRef.current = true
    setAtBottom(true)
  }, [filterKey])

  // Resolve a friendly name/label to fleet IDs for DB queries. Uses the shared
  // labelsForAgent so send-targeting matches the live/history filters — incl.
  // pseudo-labels (awake/hibernating/human), bare lineage names, and
  // `lineage:phase` tags (all subsumed by the label set).
  const resolveToFleetIds = useCallback((label: string): string[] => {
    if (label.startsWith('fleet:')) return [label]
    const matched = agents.filter((a: any) => labelsForAgent(a).includes(label))
    return matched.length > 0 ? matched.map((a: any) => a.id) : [label]
  }, [agents])

  const resolveToFleetId = useCallback((label: string): string => {
    if (label.startsWith('fleet:')) return label
    return resolveToFleetIds(label)[0] || label
  }, [resolveToFleetIds])

  const hibernatingAgents = useMemo(() => {
    const targetIds = new Set<string>()
    if (dnfFilter && dnfFilter.length > 0) {
      for (const andGroup of dnfFilter) {
        for (const [, label] of andGroup) {
          for (const id of resolveToFleetIds(label)) targetIds.add(id)
        }
      }
    }
    const result = new Set<string>()
    for (const a of agents) {
      if (a.status === 'hibernating' && (!dnfFilter || targetIds.has(a.id))) {
        result.add(a.id)
      }
    }
    return result
  }, [agents, dnfFilter, resolveToFleetIds])

  const suggestionsPending = useMemo(() => {
    let filtered = suggestionsAll
    if (dnfFilter && dnfFilter.length > 0) {
      filtered = filtered.filter(n => {
        const ownerId = suggestionOwnerId(n)
        if (!ownerId) return false
        return matchesFleetFilter(dnfFilter, { agent: ownerId, from: ownerId, to: ownerId }, {
          agents,
          humanId: getHumanId(),
          humanName: getHumanName(),
        })
      })
    }
    const seen = new Set<string>()
    return filtered.filter(n => {
      // Key on target too: the same label (e.g. "hand off") can be pending for
      // multiple agents at once, and each must stay clickable against its own target.
      const key = `${groupKeyOf(n)}::${suggestionOwnerId(n)}::${n.label}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [suggestionsAll, dnfFilter, agents])

  // Fetch per-agent history on mount / filter change.
  // The global event buffer (MAX_EVENTS=150) is shared across all agents.
  // A quiet agent's messages may not be in the buffer at all, making the
  // chat appear empty. Fix: always fetch agent-specific history from the DB.
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)

  // Resolve the filter to its fleet-id set ONCE per (filter, agents) change, as a
  // stable sorted string. The backfill effect below depends on THIS string, not
  // the churning `agents` array — so it only re-fires when the resolved id-set
  // actually changes, not on every agent heartbeat (the 6-panels × 600-agents
  // re-fire that was pegging the browser at 112% CPU).
  const resolvedFilterIdKey = useMemo(() => {
    if (!dnfFilter || dnfFilter.length === 0) return ''
    return [...resolveFilter(dnfFilter)].sort().join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on filterKey (the stable string form of dnfFilter) not dnfFilter (new array identity each render); resolveFilter is a stable module import
  }, [filterKey, agents])

  const historyLoadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!dnfFilter || dnfFilter.length === 0) return
    if (!resolvedFilterIdKey) {
      // Filter set but resolved to nothing. Once agents are loaded this is a
      // genuine no-match; surface it (no silent fallback). Before agents load the
      // memo re-runs and this effect re-fires when the id-set appears.
      if (agents.length > 0) {
        log.warn('chat', 'filter resolved to no fleet ids; no history will load', { filter: dnfFilter })
      }
      return
    }
    const ids = resolvedFilterIdKey.split(',')
    const loadKey = `${filterKey}:${resolvedFilterIdKey}`
    if (historyLoadedRef.current === loadKey) return
    historyLoadedRef.current = loadKey
    // loadBefore folds the scrollback into the single store (deduping by id) and
    // returns the count of genuinely-new rows. No local olderEvents list — the
    // history just appears in `events` via the store view.
    loadBefore(ids, new Date().toISOString(), 200).then((added: number) => {
      if (added <= 0) return
      isAtBottomRef.current = true
      setAtBottom(true)
      // The history lands as an async PREPEND into the store; Virtuoso's
      // followOutput only follows bottom appends, and initialTopMostItemIndex
      // applied at first mount (while data was empty). So without this the list
      // stays parked at the top and a freshly-filtered view renders blank until a
      // live event arrives. Scroll to the end once the prepend has committed.
      requestAnimationFrame(() => {
        try { virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' }) }
        catch (e) { log.debug('chat', 'post-backfill scrollToIndex skipped (virtuoso not mounted)', { e: String(e) }) }
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedFilterIdKey, filterKey])


  const chatLogRef = useRef<HTMLDivElement>(null)
  // chatLogEl tracks the scroller element in state so effects can attach
  // listeners as soon as Virtuoso mounts its scroll container.
  const [chatLogEl, setChatLogEl] = useState<HTMLDivElement | null>(null)

  // Stable Scroller component for Virtuoso. Owns the .fleet-chat-log class
  // (so CanvasClipPanel's wheel reroute keeps targeting it) and captures the
  // element into chatLogRef / chatLogEl. Event listeners are attached in
  // separate effects keyed off chatLogEl — keeps this component free of
  // changing callback closures.
  const ChatLogScroller = useMemo(
    () => forwardRef<HTMLDivElement, any>(function ChatLogScroller(props, ref) {
      return (
        <div
          {...props}
          ref={(el: HTMLDivElement | null) => {
            if (typeof ref === 'function') ref(el)
            else if (ref) (ref as any).current = el
            chatLogRef.current = el
            setChatLogEl(el)
          }}
          className="fleet-chat-log"
          style={{ ...props.style, padding: '4px 0' }}
        />
      )
    }),
    [],
  )
  const inputRef = useRef<HTMLInputElement>(null)

  // Reactive map of image asset ID → src URL (populated from tldraw store).
  // Image chips use tldraw asset IDs for persistence — assets survive page reload.
  const [imageSrcs, setImageSrcs] = useState<Map<string, string>>(() => {
    const map = new Map<string, string>()
    for (const record of editor.store.allRecords()) {
      const r = record as any
      if (r.typeName === 'asset' && r.type === 'image' && r.props?.src) {
        map.set(r.id, r.props.src)
      }
    }
    return map
  })
  useEffect(() => {
    return editor.store.listen(({ changes }) => {
      const added = Object.values(changes.added).filter((r: any) => r.typeName === 'asset' && r.type === 'image')
      if (!added.length) return
      setImageSrcs(prev => {
        const next = new Map(prev)
        for (const r of added) {
          const a = r as any
          if (a.props?.src) next.set(a.id, a.props.src)
        }
        return next
      })
    }, { source: 'all', scope: 'document' })
  }, [editor])

  // Preamble macros — fetched once per doc from /api/projects/:name/macros
  const [preambleMacros, setPreambleMacros] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!doc?.docName) return
    fetch(`/api/projects/${doc.docName}/macros`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.macros) setPreambleMacros(data.macros) })
      .catch(e => console.warn('[fleet-chat] macros fetch failed:', e.message))
  }, [doc?.docName])

  // Per-sender preamble: each message carries metadata.preambleRef.doc (the
  // sender's preamble document). We render that message's math with that doc's
  // macros so it looks the same for everyone, regardless of what the viewer has
  // loaded. Cache macros per doc; fetch any referenced doc we haven't seen yet.
  const [macrosByDoc, setMacrosByDoc] = useState<Record<string, Record<string, string>>>({})

  // Build context and render messages
  const prefTick = usePrefTick()
  const ctxRenderKey = useMemo(() => JSON.stringify({
    agents: agents.map((a: any) => [
      a.id,
      a.friendly_name,
      a.name,
      !!a.human,
      a.metadata?.inPlanMode,
      a.metadata?.permission_mode,
      a.metadata?.planModeType,
    ]),
    tasks: tasks.map((t: any) => [
      t.id,
      t.status,
      t.agent,
      t.delegated_by,
    ]),
    macros: Object.entries(preambleMacros).sort(),
    prefTick,
  }), [agents, tasks, preambleMacros, prefTick])
  const ctx = useMemo(() => makeCtx(agents, tasks, preambleMacros), [agents, tasks, preambleMacros, prefTick])
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  const docRef = useRef<typeof doc>(doc)
  useEffect(() => { docRef.current = doc }, [doc])

  const openMarkdownColumn = useCallback((title: string, markdown: string, sourceEl: HTMLElement) => {
    const sourceRect = sourceEl.getBoundingClientRect()
    const left = Math.max(12, sourceRect.left)
    const top = Math.max(12, sourceRect.bottom + 8)
    const mainEditor = (window as Window & { __tldraw_editor__?: typeof editor }).__tldraw_editor__ || editor
    const chipAnchor = clientPointToPage(mainEditor, { x: left, y: top })
    const occupiedBounds = mainEditor.getCurrentPageShapes()
      .filter((s: any) => !s.meta?.temporaryMarkdownColumn)
      .map((s: any) => mainEditor.getShapePageBounds(s.id))
      .filter(Boolean) as Array<{ x: number; y: number; w: number; h: number }>
    // Click previews should not join the normal document/compare/fleet working area.
    // Put the generated markdown page diagonally far beyond occupied canvas content,
    // then view it through AnnotationViewer.
    const anchor = occupiedBounds.length
      ? {
          x: Math.max(...occupiedBounds.map(b => b.x + b.w)) + 10000,
          y: Math.max(...occupiedBounds.map(b => b.y + b.h)) + 10000,
        }
      : chipAnchor
	    void createTemporaryMarkdownColumn(mainEditor, anchor, title, markdown || title, {
	      sourceChatShapeId: shape.id,
	      wmManagedSurfaceProofFixture: isManagedSurfaceProofFixtureEnabled(),
	    }).then((result) => {
      if (!result?.bounds) return
      const chipRect = sourceEl.getBoundingClientRect()
      const request = createTemporaryMarkdownAnnotationViewerRequest(result.surface, {
        label: title || 'Markdown chip',
        chipRect: {
          left: chipRect.left,
          top: chipRect.top,
          right: chipRect.right,
          bottom: chipRect.bottom,
          width: chipRect.width,
          height: chipRect.height,
        },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      })
      window.dispatchEvent(new CustomEvent('wm-managed-surface-request', {
        detail: { request },
      }))
    }).catch((err) => {
      console.warn('[fleet-chat] markdown annotation viewer create failed:', err?.message || err)
    })
  }, [editor, shape.id])

  // Incremental render cache: non-activity messages are independent and can be
  // cached by (msgKey, ctxVersion). When ctx changes (agent rename, task done),
  // bump ctxVersion to invalidate stale lines. This turns O(N) re-render on
  // every new message into O(1) for the common case of appending one message.
  const msgLineCache = useRef<Map<string, string>>(new Map())
  const activityGroupCache = useRef<Map<string, string>>(new Map())
  const ctxVersionRef = useRef(0)
  const prevCtxRenderKeyRef = useRef(ctxRenderKey)
  if (prevCtxRenderKeyRef.current !== ctxRenderKey) {
    prevCtxRenderKeyRef.current = ctxRenderKey
    ctxVersionRef.current++
    msgLineCache.current.clear()
    activityGroupCache.current.clear()
  }

  const chatMessages = useMemo(() => {
    const chatSortTimer = probe.start('chat', 'chat-sort')
    const sorted = events
      .filter((m: any) => {
        const t = m.type
        if (quietDmTraffic && (t === 'activity' || m._activity)) return false
        return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'activity' || t === 'kill-session' || t === 'interrupt' || t === 'terminal_attention' || t === 'terminal_card' || t === 'plan_approval' || t === 'timer'
      })
      .filter((m: any) => !m._timer) // skip legacy timer-expired messages (fired→_timerFired and cancelled→_timerCancelled still render)
      // Order by arrival (DB insert id), NOT wall-clock timestamp. The daemon
      // delivers activity/terminal events carrying their original JSONL ts, but
      // it delivers them late (buffer flush + poll fallback). Sorting by ts would
      // insert a late event *back in the past*, behind rows already on screen —
      // that backward jump is the "bounce". _dbId is the monotonic server insert
      // order, so a late event always appends at the bottom and nothing already
      // rendered ever moves. Un-persisted optimistic sends (no _dbId yet) sort
      // last (they're the newest), tie-broken by timestamp.
      .sort((a: any, b: any) => {
        const ida = a._dbId, idb = b._dbId
        if (ida != null && idb != null) return ida - idb
        if (ida == null && idb == null) {
          const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
          const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
          return ta - tb
        }
        return ida == null ? 1 : -1
      })

    if (isManagedSurfaceProofFixtureEnabled()) {
      sorted.push(createManagedSurfaceProofMessage(shape.id))
    }

    probe.stop(chatSortTimer, { eventCount: events.length, resultCount: sorted.length })
    return sorted
  }, [events, quietDmTraffic])

  // Standing diagnostic — does the message list momentarily empty? When
  // chatMessages hits 0 the render swaps the Virtuoso list for the "No messages"
  // div (a different DOM node), which remounts the scroller and can read as a
  // flash/blank. These two transitions are the fingerprint to look for if the
  // history ever vanishes-and-returns. warn (notable); grep `chat-scroll`.
  const _prevMsgLen = useRef(chatMessages.length)
  useEffect(() => {
    if (chatMessages.length === 0 && _prevMsgLen.current !== 0) {
      log.debug('chat-scroll', 'message list emptied → "No messages" branch (scroller will remount)', { prev: _prevMsgLen.current })
    } else if (chatMessages.length !== 0 && _prevMsgLen.current === 0) {
      log.debug('chat-scroll', 'message list refilled 0→N (Virtuoso remounts)', { now: chatMessages.length })
    }
    _prevMsgLen.current = chatMessages.length
  }, [chatMessages.length])

  // Standing diagnostic — the scroll container's DOM node identity. A change
  // here means the scroller was mounted or REPLACED (e.g. the empty-branch swap
  // above, or a Virtuoso remount). A replacement mid-session is the signature of
  // a flash; routine on first mount. debug.
  useEffect(() => {
    log.debug('chat-scroll', 'scroll node mounted/replaced', { hasEl: !!chatLogEl, msgCount: chatMessages.length })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatLogEl])

  // Fetch macros for any preamble doc referenced by a message we haven't cached.
  useEffect(() => {
    const needed = new Set<string>()
    chatMessages.forEach((m: any) => {
      const d = m?.metadata?.preambleRef?.doc
      if (d && !(d in macrosByDoc)) needed.add(d)
    })
    if (needed.size === 0) return
    for (const d of needed) {
      fetch(`/api/projects/${encodeURIComponent(d)}/macros`)
        .then(r => r.ok ? r.json() : null)
        .then(data => setMacrosByDoc(prev => (d in prev ? prev : { ...prev, [d]: data?.macros || {} })))
        .catch(() => setMacrosByDoc(prev => (d in prev ? prev : { ...prev, [d]: {} })))
    }
  }, [chatMessages, macrosByDoc])

  // Amend events (type 'amend', metadata.amends = original id) are folded into
  // their original message as version history — they never render standalone
  // (chatMessages excludes type 'amend'). Grouped here off the full events list.
  const amendsByOrig = useMemo(() => {
    const map = new Map<number, any[]>()
    for (const e of events as any[]) {
      if (e.type !== 'amend') continue
      const orig = e.metadata?.amends
      if (orig == null) continue
      if (!map.has(orig)) map.set(orig, [])
      map.get(orig)!.push(e)
    }
    for (const list of map.values()) list.sort((a, b) => (a._dbId || 0) - (b._dbId || 0))
    return map
  }, [events])
  // Which version index the user is viewing, per original message id (default:
  // latest). The ◀▶ stepper arrows step through.
  const [amendView, setAmendView] = useState<Map<number, number>>(new Map())

  const [renderedMessageLimit, setRenderedMessageLimit] = useState(INITIAL_CHAT_RENDER_WINDOW)
  const [renderWindowAnchorStart, setRenderWindowAnchorStart] = useState<number | null>(null)
  const tailRenderWindowStartIndex = Math.max(0, chatMessages.length - renderedMessageLimit)
  const renderWindowStartIndex = renderWindowAnchorStart == null
    ? tailRenderWindowStartIndex
    : Math.max(0, Math.min(renderWindowAnchorStart, chatMessages.length))
  const renderWindowLookbehindStartIndex = Math.max(0, renderWindowStartIndex - CHAT_RENDER_LOOKBEHIND)
  const hiddenLookbehindCount = renderWindowStartIndex - renderWindowLookbehindStartIndex
  const windowedChatMessages = useMemo(
    () => chatMessages.slice(renderWindowLookbehindStartIndex),
    [chatMessages, renderWindowLookbehindStartIndex],
  )
  const canExpandRenderedHistory = renderWindowStartIndex > 0
  const pendingWindowRestoreHeightRef = useRef<number | null>(null)

  useEffect(() => {
    setRenderedMessageLimit(INITIAL_CHAT_RENDER_WINDOW)
    setRenderWindowAnchorStart(null)
    pendingWindowRestoreHeightRef.current = null
  }, [filterKey])

  const resetRenderWindowToTail = useCallback(() => {
    setRenderedMessageLimit(INITIAL_CHAT_RENDER_WINDOW)
    setRenderWindowAnchorStart(null)
  }, [])

  const anchorRenderWindow = useCallback(() => {
    setRenderWindowAnchorStart(start => start ?? renderWindowStartIndex)
  }, [renderWindowStartIndex])

  const expandRenderedHistory = useCallback((el?: HTMLElement | null): boolean => {
    if (!canExpandRenderedHistory) return false
    if (el) pendingWindowRestoreHeightRef.current = el.scrollHeight
    setRenderWindowAnchorStart(start => Math.max(0, (start ?? renderWindowStartIndex) - CHAT_RENDER_WINDOW_CHUNK))
    setRenderedMessageLimit(limit => Math.min(chatMessages.length, limit + CHAT_RENDER_WINDOW_CHUNK))
    return true
  }, [canExpandRenderedHistory, chatMessages.length, renderWindowStartIndex])

  const renderedMessageIds = useMemo(() => {
    const ids = new Set<string>()
    for (let i = renderWindowStartIndex; i < chatMessages.length; i++) {
      const m = chatMessages[i] as { _dbId?: unknown }
      if (m._dbId != null) ids.add(String(m._dbId))
    }
    return ids
  }, [chatMessages, renderWindowStartIndex])

  const suggestionsByMessage = useMemo(() => {
    const byMessage = new Map<string, Suggestion[]>()
    for (const s of suggestionsPending) {
      if (s.messageId == null) continue
      const key = String(s.messageId)
      if (!renderedMessageIds.has(key)) continue
      if (!byMessage.has(key)) byMessage.set(key, [])
      byMessage.get(key)!.push(s)
    }
    return byMessage
  }, [suggestionsPending, renderedMessageIds])

  const fallbackSuggestions = useMemo(() => (
    suggestionsPending.filter(s => s.messageId == null || !renderedMessageIds.has(String(s.messageId)))
  ), [suggestionsPending, renderedMessageIds])

  // Build per-item raw HTML array — each item is an independent renderable unit.
  // This replaces the old joined renderedHtml string and enables virtualization.
  // Items tagged _queued render below the thinking indicator; _interrupt items
  // render between the indicator and the queue (they "jump the line").
  type RawItem = { key: string; html: string; _queued?: boolean; _interrupt?: boolean; _divider?: boolean; _status?: boolean; _suggestions?: Suggestion[] }
  // Short hash of the version currently shown in the viewer (accounts for
  // scrubbing to a historical version). Build cards compare against this to
  // style themselves green (you're viewing this build) vs gray (stale).
  const viewingVersion = currentDocVersion(panel, editor)
  const rawItems = useMemo(() => {
    const rawItemsT0 = probe.isEnabled('chat') ? performance.now() : 0
    // Extend ctx with thinking state so renderChatLine can apply queued styling
    const renderCtx = { ...ctx, thinkingAgents }
    const renderVersion = ctxVersionRef.current
    const thinkingKey = [...(thinkingAgents?.entries?.() ?? [])]
      .map(([id, since]: any[]) => `${id}:${since}`)
      .join('|')
    const items: RawItem[] = []
    let activityGroup: any[] = []
    let activityGroupHasVisible = false
    let activityGroupCount = 0
    let chatLineCount = 0
    let buildResultCount = 0
    let specialCount = 0
    function pushSuggestionRow(messageId: any) {
      if (messageId == null) return
      const chips = suggestionsByMessage.get(String(messageId))
      if (!chips?.length) return
      for (const [groupKey, groupChipsForMessage] of groupChips(chips)) {
        items.push({
          key: `suggest:${messageId}:${groupKey}`,
          html: '',
          _suggestions: groupChipsForMessage,
        })
      }
    }
    function flushActivity() {
      if (activityGroup.length === 0) return
      if (!activityGroupHasVisible) {
        activityGroup = []
        activityGroupHasVisible = false
        return
      }
      const t0 = probe.isEnabled('chat') ? performance.now() : 0
      const a0: any = activityGroup[0]
      const aid = a0._dbId != null ? `db${a0._dbId}` : a0._tempId ? `tmp${a0._tempId}` : `${a0.from}:${a0.timestamp}`
      const key = `activity:${aid}`
      const groupSize = activityGroup.length
      const cacheKey = [
        renderVersion,
        activityGroup.map((a: any) => a._dbId ?? a._tempId ?? `${a.from}:${a.timestamp}:${a.text || ''}`).join(','),
      ].join('::')
      let html = activityGroupCache.current.get(cacheKey)
      const cached = !!html
      if (!html) {
        html = `<div class="chat-activity-inline-wrap">${renderActivityGroup(activityGroup, renderCtx)}</div>`
        activityGroupCache.current.set(cacheKey, html)
      }
      items.push({
        key,
        html,
      })
      activityGroupCount++
      if (probe.isEnabled('chat')) {
        const dt = performance.now() - t0
        if (dt > 2) probe.record('chat', 'chat-render-activity-group', dt, { key, groupSize, cached })
      }
      activityGroup = []
      activityGroupHasVisible = false
    }

    // Helper: is this message queued behind a thinking agent?
    function isMessageQueued(m: any): boolean {
      const isFromUser = renderCtx.isHumanId?.(m.from)
      if (!isFromUser) return false
      const targetThinkingSince = thinkingAgents?.get?.(m.to)
      if (!targetThinkingSince) return false
      const msgTs = m.timestamp ? new Date(m.timestamp).getTime() : 0
      if (msgTs < targetThinkingSince) return false
      if (unqueuedAt && msgTs <= unqueuedAt) return false
      return true
    }

    for (let i = 0; i < windowedChatMessages.length; i++) {
      const m = windowedChatMessages[i]
      const shouldRender = i >= hiddenLookbehindCount
      if (m._activity) {
        if (activityGroup.length > 0 && activityGroup[0].from !== m.from) flushActivity()
        activityGroup.push(m)
        if (shouldRender) activityGroupHasVisible = true
      } else if (m.metadata?.type === 'build_result') {
        flushActivity()
        if (!shouldRender) continue
        buildResultCount++
        const { name: docName, hash, summary, lintFindings = [], mirrorFailed, buildFailed, errors = [] } = m.metadata
        const hasDetails = !!(summary || lintFindings.length > 0 || mirrorFailed || buildFailed || errors.length > 0)
        const lintCount = lintFindings.length
        const lintBadge = lintCount > 0
          ? `<span class="build-result-lint-badge">${lintCount} finding${lintCount !== 1 ? 's' : ''}</span>`
          : ''
        const summaryHtml = summary ? renderCtx.renderMarkdown(esc(summary)) : ''
        const lintHtml = lintFindings.map((f: any) => renderCtx.renderMarkdown(esc(f.text))).join('')
        const failureText = buildFailed || mirrorFailed
        const failureHtml = failureText ? `<p class="build-result-error">${esc(failureText)}</p>` : ''
        const errorHtml = errors.map((e: any) => renderCtx.renderMarkdown(esc(e.message || String(e)))).join('')
        const toggle = hasDetails ? `<span class="build-result-toggle">▾</span>` : ''
        // Status color: red = mirror/build failed; green = the version you're
        // viewing is this build; gray = a newer build you haven't loaded (or a
        // card for a doc you're not currently viewing).
        const builtHash = String(hash || '').slice(0, 7)
        let statusCls = 'build-result-neutral'
        if (mirrorFailed || buildFailed) statusCls = 'build-result-failed'
        else if (docName === doc) statusCls = (viewingVersion && viewingVersion === builtHash) ? 'build-result-current' : 'build-result-stale'
        const title = buildFailed
          ? `Build failed — <strong>${esc(docName)}</strong>`
          : `Build <code>${esc(hash)}</code> — <strong>${esc(docName)}</strong>`
        const html = `<div class="build-result-card ${statusCls}">` +
          `<div class="build-result-header">` +
          `<span class="build-result-icon">🔨</span>` +
          `<span class="build-result-title">${title}</span>` +
          lintBadge +
          toggle +
          `</div>` +
          (hasDetails
            ? `<div class="build-result-body">${failureHtml}${errorHtml}${summaryHtml}${lintHtml}</div>`
            : '') +
          `</div>`
        items.push({ key: m._dbId || m._tempId || `${m.timestamp}:${m.from}:build`, html })
      } else if (m._evType === 'plan_approval' || m.type === 'plan_approval') {
        flushActivity()
        if (!shouldRender) continue
        specialCount++
        const agentId: string = m.from || ''
        const agentObjs: any[] = renderCtx.getAgents()
        const agentObj = agentObjs.find((a: any) => a.id === agentId)
        const agentName = agentObj?.friendly_name || agentId.replace('fleet:', '')
        const planBodyHtml = renderCtx.renderMarkdown(esc(m.text || ''))
        const planResponseCls = m._planResponse === 'approved' ? ' plan-card-approved' : m._planResponse === 'supervised' ? ' plan-card-supervised' : m._planResponse === 'rejected' ? ' plan-card-rejected' : ''
        const html = `<div class="plan-card${planResponseCls}" data-agent-id="${esc(agentId)}">` +
          `<div class="plan-card-header"><span class="plan-card-icon">📋</span>` +
          `<span class="plan-card-title">Plan from <strong>${esc(agentName)}</strong></span></div>` +
          `<div class="plan-card-body">${planBodyHtml}</div>` +
          `<div class="plan-card-actions">` +
          `<button class="plan-approve-btn" data-agent-id="${esc(agentId)}">✓ Auto</button>` +
          `<button class="plan-supervised-btn" data-agent-id="${esc(agentId)}">✓ Supervised</button>` +
          `<button class="plan-reject-btn" data-agent-id="${esc(agentId)}">✗</button>` +
          `</div></div>`
        items.push({ key: m._dbId || m._tempId || `${m.timestamp}:${m.from}:plan`, html })
      } else if (m.type === 'kill-session') {
        flushActivity()
        if (!shouldRender) continue
        specialCount++
        const agentObjs: any[] = renderCtx.getAgents()
        const targetId = m.to || ''
        const targetAgent = agentObjs.find((a: any) => a.id === targetId)
        const targetName = targetAgent?.friendly_name || targetId.replace('fleet:', '')
        const html = `<div class="kill-session-card"><span class="kill-session-icon">⚡</span><span class="kill-session-text">Session killed: <strong>${esc(targetName)}</strong></span></div>`
        items.push({ key: m._dbId || m._tempId || `${m.timestamp}:${m.from}:kill`, html })
      } else if (m.type === 'interrupt') {
        flushActivity()
        if (!shouldRender) continue
        specialCount++
        const agentObjs: any[] = renderCtx.getAgents()
        const targetId = m.to || ''
        const targetAgent = agentObjs.find((a: any) => a.id === targetId)
        const targetName = targetAgent?.friendly_name || targetId.replace('fleet:', '')
        const html = `<div class="kill-session-card"><span class="kill-session-icon">⏸</span><span class="kill-session-text">Interrupted: <strong>${esc(targetName)}</strong></span></div>`
        items.push({ key: m._dbId || m._tempId || `${m.timestamp}:${m.from}:interrupt`, html })
      } else {
        flushActivity()
        if (!shouldRender) continue
        // Fold amends: if this message has amend events, show the viewed
        // version's text (+ its own source, so the chip is per-version) and a
        // V{n} ◀▶ stepper. Un-amended messages render untouched.
        let renderM = m
        const amends = (m._dbId != null) ? amendsByOrig.get(m._dbId) : undefined
        if (amends && amends.length) {
          const versions = [
            { text: m.text, source: m.metadata?.source ?? null },
            ...amends.map((a: any) => ({ text: a.text, source: a.metadata?.source ?? null })),
          ]
          const total = versions.length
          const viewIdx = Math.min(amendView.get(m._dbId) ?? (total - 1), total - 1)
          const backDis = viewIdx <= 0 ? ' disabled' : ''
          const fwdDis = viewIdx >= total - 1 ? ' disabled' : ''
          const oid = esc(String(m._dbId))
          const stepper = `<span class="amend-versions" data-orig="${oid}"><button class="amend-arrow"${backDis} data-orig="${oid}" data-total="${total}" data-dir="back" title="older version">◀</button><span class="amend-vlabel">V${viewIdx + 1}</span><button class="amend-arrow"${fwdDis} data-orig="${oid}" data-total="${total}" data-dir="fwd" title="newer version">▶</button></span>`
          const v = versions[viewIdx]
          renderM = { ...m, text: v.text, metadata: { ...(m.metadata || {}), source: v.source }, _amendStepper: stepper }
        }
        // Render this message's math with the SENDER's preamble (preambleRef.doc),
        // not the viewer's. Fall back to the viewer's preamble for messages with no
        // ref, or while the referenced doc's macros are still loading.
        const senderPreambleDoc = m?.metadata?.preambleRef?.doc
        const lineMacros = (senderPreambleDoc && senderPreambleDoc in macrosByDoc)
          ? macrosByDoc[senderPreambleDoc]
          : preambleMacros
        const lineCtx = lineMacros === preambleMacros
          ? renderCtx
          : { ...renderCtx, renderMarkdown: (input: string) => tldaRenderMarkdown(input, lineMacros) }
        const itemKey = m._dbId || m._tempId || `${m.timestamp}:${m.from}`
        const cacheKey = [
          renderVersion,
          thinkingKey,
          itemKey,
          renderM.text || '',
          renderM._amendStepper || '',
          senderPreambleDoc || '',
          lineMacros === preambleMacros ? 'viewer' : senderPreambleDoc || 'sender',
          JSON.stringify(renderM.metadata?.source || null),
        ].join('::')
        let html = msgLineCache.current.get(cacheKey)
        const t0 = probe.isEnabled('chat') ? performance.now() : 0
        const cached = !!html
        if (!html) {
          html = renderChatLine(renderM, lineCtx)
          msgLineCache.current.set(cacheKey, html)
        }
        chatLineCount++
        if (probe.isEnabled('chat')) {
          const dt = performance.now() - t0
          if (dt > 2) {
            probe.record('chat', 'chat-render-line', dt, {
              key: itemKey,
              type: m.type,
              evType: m._evType || '',
              textLength: String(renderM.text || '').length,
              cached,
            })
          }
        }
        if (html) {
          const item: RawItem = { key: itemKey, html }
          // Tag interrupt system_notices so they jump ahead of queued messages
          if (m._evType === 'system_notice' && m._isInterrupt) {
            item._interrupt = true
          }
          // Tag queued messages so they render below the thinking indicator
          if (isMessageQueued(m)) {
            item._queued = true
          }
          items.push(item)
          pushSuggestionRow(m._dbId)
        }
      }
    }
    flushActivity()
    if (probe.isEnabled('chat')) {
      const dt = performance.now() - rawItemsT0
      const detail = {
        messageCount: chatMessages.length,
        windowMessageCount: windowedChatMessages.length,
        renderedMessageCount: chatMessages.length - renderWindowStartIndex,
        hiddenLookbehindCount,
        renderWindowStartIndex,
        renderWindowAnchored: renderWindowAnchorStart != null,
        itemCount: items.length,
        chatLineCount,
        activityGroupCount,
        buildResultCount,
        specialCount,
        eventCount: events.length,
      }
      probe.record('chat', 'chat-build-raw-items', dt, detail)
      probe.record(
        'chat',
        renderedMessageLimit > INITIAL_CHAT_RENDER_WINDOW ? 'chat-older-window-build' : 'chat-tail-window-build',
        dt,
        detail,
      )
    }
    return items
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages, windowedChatMessages, hiddenLookbehindCount, renderWindowStartIndex, renderWindowAnchorStart, renderedMessageLimit, ctx, thinkingAgents, unqueuedAt, viewingVersion, doc, amendsByOrig, amendView, macrosByDoc, preambleMacros, suggestionsByMessage])

  // Per-item post-processing: applies chip replacement, URL linkification, and
  // doc-link resolution to a single item's HTML. Called by ChatMessageRow only
  // for visible items, so the cost scales with the viewport not the message count.
  const postProcess = useCallback((html: string): string => {
    // Turn «type:label» reference tokens into chips — only in non-code regions
    // and not when immediately preceded by a quote character (quoted = literal).
    html = transformNonCode(html, (text) => text.replace(/(?<!["'])«(.+?)»/g, (_match, inner) => {
      const token = `«${inner}»`
      const colonIdx = inner.indexOf(':')
      const typePrefix = colonIdx >= 0 ? inner.slice(0, colonIdx) : ''
      const display = (colonIdx >= 0 ? inner.slice(colonIdx + 1) : inner).replace(/#[^#»]+$/, '')
      if (typePrefix === 'bullet') {
        // Bullet cards are rendered server-side in chat-render.mjs using metadata.
        // If a «bullet:ID» token reaches here, the metadata was missing — show as plain text.
        return `<span class="bullet-card-fallback">[bullet ref]</span>`
      }
      const shapeIdMatch = inner.match(/#(shape:[^»]+)$/)
      const embeddedShapeId = shapeIdMatch?.[1]
      let ref: any = undefined
      if (embeddedShapeId) {
        const mainEditor = (window as any).__tldraw_editor__
        const srcShape = (editor.getShape(embeddedShapeId as any) || mainEditor?.getShape(embeddedShapeId as any)) as any
        if (srcShape) {
          const highlightId = srcShape.props?.highlightId
          const highlight = highlightId ? (editor.getShape(highlightId as any) || mainEditor?.getShape(highlightId as any)) as any : null
          const refShape = highlight || srcShape
          const shapeEditor = mainEditor?.getShape(refShape.id) ? mainEditor : editor
          const refBounds = shapeEditor.getShapePageBounds(refShape.id)
          const meta = (highlight?.meta || srcShape.meta) as any
          const srcLineArr: any[] = meta?.sourceLines || []
          const hlSrcLines = srcLineArr.filter((sl: any) => sl.highlighted)
          const firstSrcLine = hlSrcLines.length > 0 ? hlSrcLines[0] : srcLineArr[0]
          const anchor = meta?.sourceAnchor  // fallback for old shapes
          ref = {
            type: typePrefix || 'annotation',
            label: display,
            content: srcShape.props?.text || meta?.highlightText || '',
            color: srcShape.props?.color || meta?.glowColor,
            canvasBounds: refBounds ? { x: refBounds.x, y: refBounds.y, w: refBounds.w, h: refBounds.h } : undefined,
            shapeId: embeddedShapeId,
            highlightShapeId: highlight?.id,
            screenshotRef: refBounds ? `tlda-screenshot:page:page:${refBounds.x.toFixed(0)},${refBounds.y.toFixed(0)},${refBounds.w.toFixed(0)},${refBounds.h.toFixed(0)}` : undefined,
            file: firstSrcLine?.file || anchor?.file,
            lineno: firstSrcLine?.line || anchor?.line,
          }
        }
      }
      const displayEsc = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const content = ref?.content || chipContentStore.get(token) || ''
      const contentEsc = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const isAnnotation = ref?.type === 'annotation' || ref?.type === 'highlight'
      const isImage = typePrefix === 'img'
      if (isImage) {
        const uid = inner.split('#')[1] || ''
        const src = imageSrcs.get('asset:' + uid) || content
        if (src) {
          const nameEsc = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          return `<img src="${src}" alt="${nameEsc}" style="display:block;width:75%;max-width:100%;border-radius:4px;margin:4px 0;" />`
        }
        return `<span class="ref-chip ref-chip-image">${displayEsc}</span>`
      }
      const preview = !isAnnotation && content ? `<span class="ref-chip-preview">${contentEsc}</span>` : ''
      const colorDot = isAnnotation && ref?.color ? `<span class="ref-chip-dot" style="background:${ref.color}"></span>` : ''
      const locBadge = isAnnotation && ref?.file
        ? `<span class="ref-chip-loc">${ref.file.split('/').pop()}${ref.lineno ? ':' + ref.lineno : ''}</span>` : ''
      const boundsAttr = ref?.canvasBounds
        ? ` data-bounds="${ref.canvasBounds.x},${ref.canvasBounds.y},${ref.canvasBounds.w},${ref.canvasBounds.h}"` : ''
      const shapeAttr = ref?.shapeId ? ` data-shape-ref="${ref.shapeId}"` : ''
      const highlightAttr = isAnnotation && ref?.highlightShapeId ? ` data-highlight-ref="${ref.highlightShapeId}"` : ''
      const screenshotAttr = ref?.screenshotRef ? ` data-screenshot-ref="${ref.screenshotRef}"` : ''
      const cls = isAnnotation ? 'ref-chip ref-chip-annotation' : 'ref-chip'
      const tokenAttr = ` data-token="${token.replace(/"/g, '&quot;')}"`
      return `<span class="${cls}"${tokenAttr}${boundsAttr}${shapeAttr}${highlightAttr}${screenshotAttr}>${colorDot}${displayEsc}${locBadge}${preview}</span>`
    }))
    // Process [->ref] arrow links BEFORE auto-detection (linkifyDocRefs)
    // so that [->Theorem 3.2] is consumed before "Theorem 3.2" gets auto-linked
    if (doc && Object.keys(labelRegions).length > 0) {
      // Raw \ref/\eqref/\cref commands first — convert to their compiled form
      // so the inner label isn't double-processed by the passes below.
      html = linkifyRefCommands(html, labelRegions, theoremMap)
      html = linkifyAtRefs(html, labelRegions)
      html = linkifyArrowRefs(html, labelRegions)
      html = linkifyLabelRefs(html, labelRegions)
    }
    if (doc) html = linkifyDocRefs(html)
    return html
  }, [doc, labelRegions, theoremMap, imageSrcs, editor])

  // Mark the queue divider position inline — the last non-queued item before
  // the first queued item gets _divider: true. All items stay in one list.
  const allItems = useMemo(() => {
    const items = [...rawItems]
    let firstQueuedIdx = -1
    for (let i = 0; i < items.length; i++) {
      if (items[i]._queued) { firstQueuedIdx = i; break }
    }
    if (firstQueuedIdx > 0) {
      items[firstQueuedIdx - 1] = { ...items[firstQueuedIdx - 1], _divider: true }
    }
    // Status row is a real trailing item (not a Virtuoso Footer) so its height
    // enters totalListHeight — a Footer's height leaks into scrollHeight without
    // Virtuoso knowing, which makes the pin loop re-solve the sizer paddingBottom
    // and flicker whenever the status height changes.
    items.push({ key: '__status__', html: '', _status: true })
    return items
  }, [rawItems])

  useLayoutEffect(() => {
    const prevHeight = pendingWindowRestoreHeightRef.current
    if (prevHeight == null) return
    pendingWindowRestoreHeightRef.current = null
    const el = chatLogEl
    if (!el) return
    el.scrollTop += el.scrollHeight - prevHeight
  }, [allItems.length, renderedMessageLimit, chatLogEl])

  // Virtual scroll — only mount DOM nodes for visible messages.
  // Handle clicks on ref-chip annotations → navigate to canvas bounds
  const handleRefChipClick = useCallback((e: React.MouseEvent) => {
    const chip = (e.target as HTMLElement).closest('.ref-chip-annotation') as HTMLElement | null
    if (!chip) return
    const boundsStr = chip.dataset.bounds
    if (boundsStr) {
      const [x, y, w, h] = boundsStr.split(',').map(Number)
      if ([x, y, w, h].every(n => isFinite(n))) {
        e.stopPropagation()
        editor.zoomToBounds({ x: x - 20, y: y - 20, w: w + 40, h: h + 40 }, { animation: { duration: 300 } })
        const shapeRef = chip.dataset.shapeRef
        if (shapeRef) {
          try { editor.select(shapeRef as any) } catch {}
        }
      }
    }
  }, [editor])

  // Handle clicks on doc-link spans
  const handleDocLinkClick = useCallback((e: React.MouseEvent) => {
    // Plain URL links — open in new tab (TLDraw intercepts native <a> navigation)
    const chatLink = (e.target as HTMLElement).closest('.chat-link') as HTMLAnchorElement | null
    if (chatLink?.href) { e.preventDefault(); window.open(chatLink.href, '_blank'); return }

    // Also check for annotation chip clicks
    const chipTarget = (e.target as HTMLElement).closest('.ref-chip-annotation')
    if (chipTarget) { handleRefChipClick(e); return }

    // Markdown chip → temporary page-like html column.
    // (ref-chip-doc chips AND md-file-card chips in activity cards).
    const mdChip = (e.target as HTMLElement).closest('.ref-chip-doc, .md-file-card') as HTMLElement | null
    if (mdChip) {
      if (mdChip.classList.contains('src-chip')) {
        e.stopPropagation()
        const line = mdChip.closest('.chat-line')
        const body = line?.querySelector('.message-body') as HTMLElement | null
        const title = mdChip.getAttribute('title') || mdChip.textContent || 'source'
        openMarkdownColumn(title, body?.innerText || body?.textContent || title, mdChip)
        return
      }
      const chipUrl = mdChip.dataset.url || ''
      const chipPath = mdChip.dataset.path || ''
      const isMd = /\.md$/i.test(chipUrl || chipPath)
      const fetchUrl = chipUrl || (chipPath ? `/api/read-file?path=${encodeURIComponent(chipPath)}` : '')
      if (isMd && fetchUrl) {
        e.stopPropagation()
        const title = mdChip.querySelector('.md-file-chip')?.textContent || mdChip.textContent || chipPath.split('/').pop() || 'file'
        fetch(fetchUrl)
          .then(r => r.ok ? r.text() : Promise.reject(r.status))
          .then(text => {
            const baseUrl = chipUrl ? chipUrl.substring(0, chipUrl.lastIndexOf('/') + 1) : ''
            const resolved = baseUrl ? text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
              if (src.startsWith('http') || src.startsWith('/')) return match
              return `![${alt}](${baseUrl}${src})`
            }) : text
            openMarkdownColumn(title, resolved, mdChip)
          })
          .catch(() => {
            openMarkdownColumn(title, '# Failed to load', mdChip)
          })
        return
      }
    }

    // Copy button on code blocks
    const copyBtn = (e.target as HTMLElement).closest('.code-block-copy') as HTMLElement | null
    if (copyBtn) {
      const wrap = copyBtn.closest('.code-block-wrap')
      const source = wrap?.querySelector('template.code-block-copy-source') as HTMLTemplateElement | null
      const fallback = wrap?.querySelector('pre, .fold-body, .diff-tex') as HTMLElement | null
      const text = source?.content.textContent ?? fallback?.innerText ?? fallback?.textContent
      if (text != null) {
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.textContent = '✓'
          copyBtn.classList.add('code-block-copy-success')
          setTimeout(() => { copyBtn.textContent = '⎘'; copyBtn.classList.remove('code-block-copy-success') }, 1500)
        })
      }
      return
    }

    const target = (e.target as HTMLElement).closest('.doc-link') as HTMLElement | null
    if (!target || !doc) return

    const refType = target.dataset.refType

    let resolved: ResolvedRef | null = null

    if (refType === 'label') {
      // Label-based ref — page/y are in data attributes
      const page = parseInt(target.dataset.refPage || '')
      const yTop = parseFloat(target.dataset.refYTop || '')
      if (!isNaN(page)) {
        resolved = { page, pdfY: !isNaN(yTop) ? yTop : undefined }
      }
    } else if (refResolver) {
      const refValue = target.dataset.refValue || ''
      const envType = target.dataset.envType
      const ref: DocRef = { type: refType as DocRef['type'], value: refValue, text: target.textContent || '', envType }
      resolved = refResolver(ref)
    }

    if (!resolved) return

    const canvasPos = refToCanvas(resolved, doc.pages, PDF_HEIGHT)
    if (!canvasPos) return

    e.stopPropagation()
    // Update docview shape directly if one exists
    const mainEd = (window as any).__tldraw_editor__
    if (mainEd) {
      const dvShape = mainEd.getCurrentPageShapes().find((s: any) => s.type === 'fleet-docview')
      if (dvShape) {
        const lbl = target.dataset.refLabel || ''
        const dvTitle = lbl || `p.${resolved.page}`
        if ((dvShape as any).isLocked) mainEd.updateShape({ id: dvShape.id, type: dvShape.type, isLocked: false })
        mainEd.updateShape({
          id: dvShape.id, type: dvShape.type,
          props: { ...(dvShape as any).props, mode: 'manual', label: lbl, page: resolved.page, yTop: resolved.pdfY || 0, yBottom: (resolved.pdfY || 0) + 200, title: dvTitle },
        })
      }
    }
    editor.centerOnPoint(canvasPos, { animation: { duration: 300 } })
  }, [doc, refResolver, editor, handleRefChipClick, openMarkdownColumn])

  const shapeContainerRef = useRef<HTMLDivElement>(null)
  const inputAreaRef = useRef<HTMLDivElement>(null)
  const dragClearTimerRef = useRef<number | null>(null)
  const [dragLozenges, setDragLozenges] = useState<Array<'image' | 'file'> | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return

    function onMouseOver(e: MouseEvent) {
      const target = (e.target as HTMLElement).closest('.doc-link') as HTMLElement | null
      if (!target || !doc) return
      if (target.classList.contains('doc-link-unresolved')) return

      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = setTimeout(() => {
        const refType = target.dataset.refType

        let resolved: ResolvedRef | null = null

        if (refType === 'label') {
          const page = parseInt(target.dataset.refPage || '')
          const yTop = parseFloat(target.dataset.refYTop || '')
          if (!isNaN(page)) {
            resolved = { page, pdfY: !isNaN(yTop) ? yTop : undefined }
          }
        } else if (refResolver) {
          const refValue = target.dataset.refValue || ''
          const envType = target.dataset.envType
          const ref: DocRef = { type: refType as DocRef['type'], value: refValue, text: target.textContent || '', envType }
          resolved = refResolver(ref)
        }
        if (!resolved) return

        // Convert resolved ref to canvas bounds for AnnotationViewer
        const pageIdx = resolved.page - 1
        if (pageIdx < 0 || pageIdx >= doc.pages.length) return
        const pageBounds = doc.pages[pageIdx].bounds
        const REGION_H = pageBounds.height * 0.3  // show ~30% of the page around the reference
        let cy: number
        if (resolved.pdfY != null) {
          const scale = pageBounds.height / PDF_HEIGHT
          cy = pageBounds.y + resolved.pdfY * scale
        } else {
          cy = pageBounds.y + pageBounds.height / 2
        }
        const bounds = {
          x: pageBounds.x,
          y: cy - REGION_H / 2,
          w: pageBounds.width,
          h: REGION_H,
        }
	        const chipRect = target.getBoundingClientRect()
	        const label = target.textContent?.trim() || `p.${resolved.page}`
	        dispatchManagedAnnotationViewerRequest({
	          surfaceKey: `${shape.id}:doc-link:${label}:${resolved.page}:${resolved.pdfY ?? 'page'}`,
	          bounds,
	          shapeIds: [],
	          label,
	          chipRect: { left: chipRect.left, top: chipRect.top, right: chipRect.right, bottom: chipRect.bottom, width: chipRect.width, height: chipRect.height },
	          owner: currentManagedSurfaceOwner(),
	          source: `${shape.id}:doc-link:${target.dataset.refValue || label}`,
	          viewport: managedViewportSize(),
	        })
	      }, 800)
    }

    function onMouseOut(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('.doc-link') && !target.closest('.screenshot-inline')) return
	      const related = e.relatedTarget as HTMLElement | null
	      if (related?.closest('.annotation-viewer')) return
	      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
	      dispatchManagedAnnotationViewerHide()
	    }

    // Chip hover — show popover for msg/activity/tool reference chips. The
    // apply-line's proposal ref (.apply-ref) opts into this same machinery via a
    // data-token, so we don't maintain a second hover handler.
    async function onChipOver(e: MouseEvent) {
      const chip = (e.target as HTMLElement).closest('.ref-chip[data-token], .apply-ref[data-token]') as HTMLElement | null
      if (!chip) return
      // Don't handle annotation chips here (they use AnnotationViewer)
      if (chip.classList.contains('ref-chip-annotation')) return
      // Delay to avoid accidental triggers
      await new Promise(r => setTimeout(r, 500))
      if (!chip.matches(':hover')) return
      const token = chip.getAttribute('data-token') || ''
      const refId = token.replace(/^«/, '').replace(/»$/, '').split('#')[1]
      if (!refId) return
      // Proposal ref (apply line): the full diff is on the propose card already in
      // the chat DOM, stamped with data-proposal-id. Clone it into the standard
      // chip-hover popover — the proposal store itself is in-process in the MCP
      // server, not reachable from the browser, so there's nothing to fetch.
      if (refId.startsWith('proposal:')) {
        const pid = refId.slice('proposal:'.length)
        if (!logEl) return
        const card = logEl.querySelector(`.edit-diff-wrap[data-proposal-id="${pid}"]`) as HTMLElement | null
        if (!card) return
        document.querySelector('.chip-hover-popover')?.remove()
        const popover = document.createElement('div')
        popover.className = 'chip-hover-popover fleet-chat-shape'
        popover.innerHTML = `<div class="chat-activity-inline-wrap">${card.outerHTML}</div>`
        const chipRect = chip.getBoundingClientRect()
        popover.style.position = 'fixed'
        popover.style.left = `${chipRect.left}px`
        popover.style.bottom = `${window.innerHeight - chipRect.top + 4}px`
        popover.style.zIndex = '10000'
        popover.style.maxWidth = `${w}px`
        document.body.appendChild(popover)
        return
      }
      // Find matching event by timestamp embedded in the refId
      // New format: msg:<dbId> or activity:<dbId> or activity:<dbId>:line<N>
      // Legacy format: msg:fleet:skip:2026-04-18T... or activity:fleet:xxx:ISO
      const chipType = refId.match(/^(msg|activity|tool)/)?.[1] || ''
      const lineMatch = refId.match(/:line(\d+)$/)
      const highlightLine = lineMatch ? lineMatch[1] : null
      const refBody = refId.replace(/^(msg|activity|tool):/, '').replace(/:line\d+$/, '')
      // Try local events first, then fetch from server
      let matchEvent = liveEvents.find((ev: any) => {
        const isActivity = !!ev._activity
        if (chipType === 'activity' && !isActivity) return false
        if (chipType === 'msg' && isActivity) return false
        if (ev._dbId?.toString() === refBody) return true
        const tsPart = refBody.replace(/^fleet:[^:]+:/, '')
        if (ev.timestamp === tsPart) return true
        return false
      })
      // If not found locally, fetch from server by DB ID and expand outward for activity grouping
      let fetchedGroup: any[] | null = null
      if (!matchEvent && /^\d+$/.test(refBody)) {
        try {
          const id = parseInt(refBody)
          const { convertChatEvent } = await import('../fleet/fleet-data.mjs')

          // Fetch the target event first
          const res0 = await fetch(`/api/store/events?after=${id - 1}&limit=1`)
          if (!res0.ok) throw new Error()
          const d0 = await res0.json()
          const targetRaw = (d0.events || [])[0]
          if (!targetRaw) throw new Error()
          const target = convertChatEvent(targetRaw) as any
          matchEvent = target

          // For activity events, expand outward to find the group boundaries
          if (target._activity) {
            const agentId = target.from
            const group = [target]

            // Expand backwards
            let backId = id
            let backDone = false
            while (!backDone) {
              const res = await fetch(`/api/store/events?before=${backId}&limit=10`)
              if (!res.ok) break
              const d = await res.json()
              const evts = (d.events || []).map(convertChatEvent)
              if (evts.length === 0) break
              for (let i = evts.length - 1; i >= 0; i--) {
                if (evts[i]._activity && evts[i].from === agentId) {
                  group.unshift(evts[i])
                  backId = evts[i]._dbId
                } else {
                  backDone = true
                  break
                }
              }
              if (evts.length < 10) break
            }

            // Expand forwards
            let fwdId = id
            let fwdDone = false
            while (!fwdDone) {
              const res = await fetch(`/api/store/events?after=${fwdId}&limit=10`)
              if (!res.ok) break
              const d = await res.json()
              const evts = (d.events || []).map(convertChatEvent)
              if (evts.length === 0) break
              for (const ev of evts) {
                if (ev._activity && ev.from === agentId) {
                  group.push(ev)
                  fwdId = ev._dbId
                } else {
                  fwdDone = true
                  break
                }
              }
              if (evts.length < 10) break
            }

            fetchedGroup = group
          }
        } catch {}
      }
      if (!matchEvent) return

      // Remove any existing popover
      document.querySelector('.chip-hover-popover')?.remove()

      // Render the event as chat HTML
      const popover = document.createElement('div')
      popover.className = 'chip-hover-popover fleet-chat-shape'
      let rendered: string
      if (matchEvent._activity && ctxRef.current) {
        // Use pre-fetched group or find from local events
        let group: any[]
        if (fetchedGroup && fetchedGroup.length > 0) {
          group = fetchedGroup
        } else {
          const matchIdx = liveEvents.indexOf(matchEvent)
          const agentId = matchEvent.from
          let start = matchIdx
          while (start > 0 && liveEvents[start - 1]._activity && liveEvents[start - 1].from === agentId) start--
          let end = matchIdx
          while (end < liveEvents.length - 1 && liveEvents[end + 1]._activity && liveEvents[end + 1].from === agentId) end++
          group = liveEvents.slice(start, end + 1)
        }
        const { renderActivityGroup } = await import('../fleet/activity-render.mjs')
        rendered = `<div class="chat-activity-inline-wrap">${renderActivityGroup(group.length > 0 ? group : [matchEvent], ctxRef.current)}</div>`
      } else {
        rendered = ctxRef.current ? renderChatLine(matchEvent, ctxRef.current) : `<div class="chat-line">${matchEvent.text || '(no content)'}</div>`
      }
      popover.innerHTML = rendered

      const chipRect = chip.getBoundingClientRect()
      popover.style.position = 'fixed'
      popover.style.left = `${chipRect.left}px`
      popover.style.bottom = `${window.innerHeight - chipRect.top + 4}px`
      popover.style.zIndex = '10000'
      popover.style.maxWidth = `${w}px`
      document.body.appendChild(popover)

      // Scroll to and highlight the specific tool line
      if (highlightLine) {
        const targetLine = popover.querySelector(`.tool-line[data-line="${highlightLine}"]`) as HTMLElement
        if (targetLine) {
          targetLine.style.background = 'rgba(147, 112, 219, 0.2)'
          targetLine.style.borderRadius = '3px'
          targetLine.scrollIntoView({ block: 'center' })
        }
      }
    }

    function onChipOut(e: MouseEvent) {
      const chip = (e.target as HTMLElement).closest('.ref-chip[data-token], .apply-ref[data-token]')
      if (!chip) return
      const related = e.relatedTarget as HTMLElement | null
      if (related?.closest('.chip-hover-popover')) return
      setTimeout(() => {
        if (!document.querySelector('.chip-hover-popover:hover')) {
          document.querySelector('.chip-hover-popover')?.remove()
        }
      }, 200)
    }

    logEl.addEventListener('mouseover', onMouseOver)
    logEl.addEventListener('mouseover', onChipOver)
    logEl.addEventListener('mouseout', onMouseOut)
    logEl.addEventListener('mouseout', onChipOut)
    return () => {
      logEl.removeEventListener('mouseover', onMouseOver)
      logEl.removeEventListener('mouseover', onChipOver)
      logEl.removeEventListener('mouseout', onMouseOut)
      logEl.removeEventListener('mouseout', onChipOut)
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      document.querySelector('.chip-hover-popover')?.remove()
    }
  }, [chatLogEl, doc, refResolver, w, liveEvents, shape.id])

  // Native capture-phase drop handler — intercepts OS file drops (from Finder etc.)
  // on the chat shape before tldraw can create a canvas image shape. A file only
  // ATTACHES when dropped over the input field; over the rest of the shape it's
  // swallowed (does nothing). While dragging over the field, ghost lozenges
  // preview the incoming attachment(s). Files upload to the fleet server and are
  // referenced by stable URL.
  useEffect(() => {
    const el = shapeContainerRef.current
    if (!el) return

    // True when the pointer is over the input field's drop zone.
    function overInput(e: DragEvent) {
      const r = inputAreaRef.current?.getBoundingClientRect()
      if (!r) return false
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    }

    function clearDrag() {
      if (dragClearTimerRef.current) { clearTimeout(dragClearTimerRef.current); dragClearTimerRef.current = null }
      setDragLozenges(null)
    }

    function onDragOver(e: DragEvent) {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      if (overInput(e)) {
        e.dataTransfer.dropEffect = 'copy'
        // dataTransfer.items is only readable inside the event — snapshot the
        // per-file kind (image vs other) now so we can render ghost lozenges.
        const kinds = [...(e.dataTransfer.items || [])]
          .filter(it => it.kind === 'file')
          .map(it => (it.type.startsWith('image/') ? 'image' : 'file') as 'image' | 'file')
        setDragLozenges(kinds.length ? kinds : ['file'])
        if (dragClearTimerRef.current) clearTimeout(dragClearTimerRef.current)
        dragClearTimerRef.current = window.setTimeout(clearDrag, 250)
      } else {
        e.dataTransfer.dropEffect = 'none'
        clearDrag()
      }
    }

    async function onDrop(e: DragEvent) {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      const wasOverInput = overInput(e)
      clearDrag()
      // Only the input field accepts the drop; elsewhere on the shape, swallow it.
      if (!wasOverInput) return

      // Use items API to support folder drops
      const items = e.dataTransfer.items ? [...e.dataTransfer.items] : []
      let entries: { file: File, path: string }[] = []
      let isFlat = true

      if (items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
        for (const item of items) {
          const entry = item.webkitGetAsEntry()
          if (entry) {
            if (entry.isDirectory) isFlat = false
            entries.push(...await traverseDirectory(entry))
          }
        }
      } else {
        for (const f of [...(e.dataTransfer.files || [])]) {
          entries.push({ file: f, path: f.name })
        }
      }

      if (!entries.length) return

      const mdEntries = entries.filter(({ file: f }) => f.name.endsWith('.md') || f.type === 'text/markdown')
      const otherEntries = entries.filter(({ file: f }) => !f.name.endsWith('.md') && f.type !== 'text/markdown')

      for (const { file, path } of mdEntries) {
        try {
          const companions = entries.filter(e => e.path !== path)
          const link = await uploadMarkdownWithImages(file, companions, path, isFlat)
          chatInsertBus.dispatchEvent(new CustomEvent('insert', { detail: { chatId: shape.id, text: link } }))
        } catch (err) {
          console.error('[fleet-chat] folder-drag md upload error', err)
          chatInsertBus.dispatchEvent(new CustomEvent('insert', { detail: { chatId: shape.id, text: `[${file.name}]` } }))
        }
      }
      for (const { file } of otherEntries) {
        if (mdEntries.length > 0 && /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(file.name)) continue
        try {
          const formData = new FormData()
          formData.append('file', file, file.name)
          const resp = await fetch(`${FLEET_API}/api/upload`, { method: 'POST', body: formData })
          if (!resp.ok) throw new Error(`upload failed: ${resp.status}`)
          const { url, name } = await resp.json()
          const link = file.type.startsWith('image/')
            ? `![${name}](${FLEET_API}${url})`
            : `[${name}](${FLEET_API}${url})`
          chatInsertBus.dispatchEvent(new CustomEvent('insert', { detail: { chatId: shape.id, text: link } }))
        } catch (err) {
          console.error('[fleet-chat] folder-drag file upload error', err)
          chatInsertBus.dispatchEvent(new CustomEvent('insert', { detail: { chatId: shape.id, text: `[${file.name}]` } }))
        }
      }
    }

    el.addEventListener('dragover', onDragOver, true)
    el.addEventListener('drop', onDrop, true)
    el.addEventListener('dragleave', clearDrag, true)
    return () => {
      el.removeEventListener('dragover', onDragOver, true)
      el.removeEventListener('drop', onDrop, true)
      el.removeEventListener('dragleave', clearDrag, true)
      if (dragClearTimerRef.current) clearTimeout(dragClearTimerRef.current)
    }
  }, [shape.id, editor])

  // Hover events on annotation ref-chips → dispatch to AnnotationViewer
  const annotationHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return

    function onAnnotationOver(e: MouseEvent) {
      // Match annotation chips AND any ref-chip with bounds data (doc region refs)
      const chip = (e.target as HTMLElement).closest('.ref-chip[data-bounds]') as HTMLElement | null
      if (!chip) return
      if (annotationHoverTimerRef.current) clearTimeout(annotationHoverTimerRef.current)
      annotationHoverTimerRef.current = setTimeout(() => {
        const boundsStr = chip.dataset.bounds
        if (!boundsStr) return
        const [x, y, w, h] = boundsStr.split(',').map(Number)
        if (![x, y, w, h].every(n => isFinite(n))) return
        // Extract label and color from the chip
        const label = chip.textContent?.trim() || 'Annotation'
        const dotEl = chip.querySelector('.ref-chip-dot') as HTMLElement | null
        const color = dotEl?.style.background || undefined
        const shapeIds: string[] = []
        if (chip.dataset.shapeRef) shapeIds.push(chip.dataset.shapeRef)
	        if (chip.dataset.highlightRef) shapeIds.push(chip.dataset.highlightRef)
	        // Anchor viewer to the chip element, not the cursor
	        const chipRect = chip.getBoundingClientRect()
	        dispatchManagedAnnotationViewerRequest({
	          surfaceKey: `${shape.id}:annotation:${chip.dataset.shapeRef || chip.dataset.highlightRef || boundsStr}`,
	          bounds: { x, y, w, h },
	          shapeIds,
	          label,
	          color,
	          chipRect: { left: chipRect.left, top: chipRect.top, right: chipRect.right, bottom: chipRect.bottom, width: chipRect.width, height: chipRect.height },
	          owner: currentManagedSurfaceOwner(),
	          source: `${shape.id}:annotation-chip`,
	          viewport: managedViewportSize(),
	        })
	      }, 500)
    }

    function onAnnotationOut(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('.ref-chip[data-bounds]')) return
      // Check if moving into the viewer itself
	      const related = e.relatedTarget as HTMLElement | null
	      if (related?.closest('.annotation-viewer')) return
	      if (annotationHoverTimerRef.current) clearTimeout(annotationHoverTimerRef.current)
	      dispatchManagedAnnotationViewerHide()
	    }

    logEl.addEventListener('mouseover', onAnnotationOver)
    logEl.addEventListener('mouseout', onAnnotationOut)
    return () => {
      logEl.removeEventListener('mouseover', onAnnotationOver)
      logEl.removeEventListener('mouseout', onAnnotationOut)
      if (annotationHoverTimerRef.current) clearTimeout(annotationHoverTimerRef.current)
    }
  }, [chatLogEl, shape.id])

  // Hover an agent's name in chat → show their skill state (read / owed / dismissed).
  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return
    let showTimer: ReturnType<typeof setTimeout> | null = null
    function onNickOver(e: MouseEvent) {
      const nick = (e.target as HTMLElement).closest('.agent-nick[data-agent-id]') as HTMLElement | null
      if (!nick) return
      const agentId = nick.dataset.agentId
      if (!agentId) return
      if (skillHideTimerRef.current) { clearTimeout(skillHideTimerRef.current); skillHideTimerRef.current = null }
      if (showTimer) clearTimeout(showTimer)
      showTimer = setTimeout(() => {
        if (!nick.matches(':hover')) return
        const r = nick.getBoundingClientRect()
        setSkillHover({ agentId: agentId!, agentName: nick.textContent?.trim() || agentId!, rect: { left: r.left, bottom: r.bottom, top: r.top } })
      }, 450)
    }
    function onNickOut(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest?.('.agent-nick[data-agent-id]')) return
      if (showTimer) { clearTimeout(showTimer); showTimer = null }
      skillHideTimerRef.current = setTimeout(() => setSkillHover(null), 220)
    }
    logEl.addEventListener('mouseover', onNickOver)
    logEl.addEventListener('mouseout', onNickOut)
    return () => {
      if (showTimer) clearTimeout(showTimer)
      logEl.removeEventListener('mouseover', onNickOver)
      logEl.removeEventListener('mouseout', onNickOut)
    }
  }, [chatLogEl])

  // Live countdown ticker: timer-countdown lines render a frozen number, so each
  // second we recompute remaining from data-timer-until and update the text in
  // place. Pure DOM — doesn't fight the dangerouslySetInnerHTML items. Terminal
  // states (cancelled/fired) arrive via event-update and re-render the item.
  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return
    const tick = () => {
      const nodes = logEl.querySelectorAll<HTMLElement>('.chat-timer-countdown[data-timer-until]')
      for (const node of nodes) {
        const until = node.getAttribute('data-timer-until')
        const span = node.querySelector<HTMLElement>('.timer-msg')
        if (!until || !span) continue
        const r = Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 1000))
        const mins = Math.floor(r / 60)
        const secs = r % 60
        const timeStr = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}s`
        const txt = span.textContent || ''
        const arrowIdx = txt.indexOf('→')
        const tail = arrowIdx >= 0 ? txt.slice(arrowIdx) : ''
        span.textContent = `⏱ ${timeStr} ${tail}`.trimEnd()
      }
      // ScheduleWakeup cards: same idea — recompute the "in Xm Ys" countdown each
      // second from the absolute fire epoch baked into data-fire-at.
      const schedNodes = logEl.querySelectorAll<HTMLElement>('.tool-pretty-schedule[data-fire-at]')
      for (const node of schedNodes) {
        const fireAt = parseInt(node.getAttribute('data-fire-at') || '0', 10)
        const span = node.querySelector<HTMLElement>('.schedule-time')
        if (!fireAt || !span) continue
        span.textContent = scheduleTimeLabel(fireAt)
      }
    }
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [chatLogEl])

  // Hover events on bullet cards → dispatch to AnnotationViewer
  const bulletHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return

    function onBulletOver(e: MouseEvent) {
      const card = (e.target as HTMLElement).closest('.bullet-card') as HTMLElement | null
      if (!card) return
      if (bulletHoverTimerRef.current) clearTimeout(bulletHoverTimerRef.current)
      bulletHoverTimerRef.current = setTimeout(() => {
        const shapeId = card.dataset.shapeId
        if (!shapeId) return
        const mainEd = (window as any).__tldraw_editor__ || editor
        const noteShape = mainEd.getShape(shapeId as any)
        if (!noteShape) return
        const bounds = mainEd.getShapePageBounds(noteShape.id)
        if (!bounds) return
	        const chipRect = card.getBoundingClientRect()
	        const label = card.querySelector('.bullet-card-source')?.textContent?.trim() || 'Note'
	        const bulletIdx = parseInt(card.dataset.bulletIdx || '', 10)
	        dispatchManagedAnnotationViewerRequest({
	          surfaceKey: `${shape.id}:bullet:${shapeId}:${isNaN(bulletIdx) ? 'all' : bulletIdx}`,
	          bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
	          shapeIds: [shapeId],
	          label,
	          chipRect: { left: chipRect.left, top: chipRect.top, right: chipRect.right, bottom: chipRect.bottom, width: chipRect.width, height: chipRect.height },
	          useFullBounds: true,
	          bulletIdx: isNaN(bulletIdx) ? undefined : bulletIdx,
	          owner: currentManagedSurfaceOwner(),
	          source: `${shape.id}:bullet-card`,
	          viewport: managedViewportSize(),
	        })
	      }, 500)
    }

    function onBulletOut(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('.bullet-card')) return
	      const related = e.relatedTarget as HTMLElement | null
	      if (related?.closest('.annotation-viewer')) return
	      if (bulletHoverTimerRef.current) clearTimeout(bulletHoverTimerRef.current)
	      dispatchManagedAnnotationViewerHide()
	    }

    logEl.addEventListener('mouseover', onBulletOver)
    logEl.addEventListener('mouseout', onBulletOut)
    return () => {
      logEl.removeEventListener('mouseover', onBulletOver)
      logEl.removeEventListener('mouseout', onBulletOut)
      if (bulletHoverTimerRef.current) clearTimeout(bulletHoverTimerRef.current)
    }
  }, [chatLogEl, editor, shape.id])

  // Auto-scroll to bottom — event-driven, not every frame.
  // CanvasClipPanel already routes wheel events to .fleet-chat-log via
  // scrollable.scrollTop += e.deltaY, so we must NOT fight it with a
  // continuous rAF loop. Instead: scroll to bottom when new content arrives
  // or the container resizes, but only if the user hasn't scrolled up.
  const isAtBottomRef = useRef(true)
  // Pin decisions gate on "did the user deliberately scroll up" (userScrolledUpRef),
  // NOT Virtuoso's raw at-bottom bool. A transient sub-threshold reflow gap (late
  // markdown/KaTeX/image growth) must not latch auto-follow off — only a deliberate
  // scroll-up past 200px counts as intent.
  const userScrolledUpRef = useRef(false)
  // TRACE: timestamp until which scroll events are attributable to our own
  // programmatic pinning (pinHard). Lets the scroll-trace tell "my pin" apart
  // from "user wheel" and "Virtuoso/virtualization". Temporary diagnostic.
  const programmaticUntilRef = useRef(0)
  // Reactive bottom-position state. Drives the unified follow/jump button:
  // at bottom → follow-mode toggle (horseshoe); off bottom → ⇣ jump-to-bottom.
  // Position (not scroll-intent) is the right signal here — matches the spec
  // "at the bottom it toggles the mode; off the bottom it's click-to-go-down."
  const [atBottom, setAtBottom] = useState(true)
  const [termHoverVisible, setTermHoverVisible] = useState(false)
  const [termHoverPinned, setTermHoverPinned] = useState(false)
  const termHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const termAutoPinnedRef = useRef(false)
  // Skill-state hover popover (hovering an agent name in chat)
  const [skillHover, setSkillHover] = useState<{ agentId: string; agentName: string; rect: { left: number; bottom: number; top: number } } | null>(null)
  const skillHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAttentionTsRef = useRef<string | null>(null)
  // Tracks which chat rows have been expanded (by item key) so the state
  // survives dangerouslySetInnerHTML re-renders.
  const expandedRowsRef = useRef<Set<string>>(new Set())
  // Hard-lock toggle: when on, every pin path fires unconditionally
  // (ignores isAtBottomRef), and atBottomStateChange can't un-pin us.
  // Persisted per browser in localStorage.
  const HARD_LOCKED_KEY = 'fleet-chat-hard-locked'
  const [hardLocked, setHardLocked] = useState(() => localStorage.getItem(HARD_LOCKED_KEY) === 'true')
  const hardLockedRef = useRef(hardLocked)
  useEffect(() => {
    hardLockedRef.current = hardLocked
    localStorage.setItem(HARD_LOCKED_KEY, String(hardLocked))
  }, [hardLocked])

  // pin-to-bottom: Virtuoso's own scrollToIndex(LAST, 'end') is the single
  // source of truth. It is virtualization-aware — it renders + measures the
  // last items and lands the true last item flush against the viewport bottom.
  //
  // We deliberately do NOT also slam `el.scrollTop = el.scrollHeight`. That used
  // to exist to "reach past the thinking/suggestion FOOTER" — but the status row
  // is now a measured list item, not a footer, so there is nothing below the last
  // item to clear. With the footer gone, the raw slam became actively harmful:
  // when the status item's height shrinks (an agent stops thinking), Virtuoso's
  // totalListHeight lags one frame, so scrollHeight is transiently TALLER than the
  // real content. `scrollTop = scrollHeight` then locks the view into that stale
  // tail — the last message strands at the TOP of the viewport with ~a screenful
  // of blank below it, and it persists because no later event re-pins. scrollToIndex
  // doesn't have this failure mode: it targets the last ITEM, re-measuring it, so
  // it can never scroll into space that isn't really there.
  //
  // The bounded loop re-runs as height settles; the standing watchdog below
  // guarantees convergence after this loop's frame budget.
  const pinHard = useCallback(() => {
    programmaticUntilRef.current = performance.now() + 400
    let frames = 0
    const step = () => {
      // Stop if the user has taken over since we started (unless hard-locked).
      if (userScrolledUpRef.current && !hardLockedRef.current) return
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
      const el = chatLogEl
      programmaticUntilRef.current = performance.now() + 120
      const gap = el ? (el.scrollHeight - (el.scrollTop + el.clientHeight)) : 0
      if (gap > 8 && ++frames < 12) requestAnimationFrame(step)
    }
    step()
  }, [chatLogEl])

  // Imperative scroll-to-bottom for the floating ⇣ button.
  const scrollToBottom = useCallback(() => {
    log.debug('chat-scroll', 'scrollToBottom (user click ⇣)')
    // Clear the scroll-up flag BEFORE pinHard: pinHard's step() bails
    // immediately when userScrolledUp is set (and we're not hard-locked), so
    // calling it first made the click a no-op — that was the "click twice to
    // reach the bottom" bug. Reset intent + position first, then pin.
    userScrolledUpRef.current = false
    isAtBottomRef.current = true
    setAtBottom(true)
    resetRenderWindowToTail()
    pinHard()
  }, [pinHard, resetRenderWindowToTail])

  // When the scroll container resizes — textarea growing as you type
  // (shrinks chat-log) OR shrinking back after send (grows chat-log) — pin
  // to bottom if we were at bottom. Virtuoso's followOutput only fires on
  // *content* change, not container resize, so without this you drift off
  // the bottom whenever the input area changes height.
  useEffect(() => {
    const el = chatLogEl
    if (!el) return
    let prevH = el.clientHeight
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight
      if (h !== prevH) {
        const pin = !userScrolledUpRef.current || hardLockedRef.current
        log.debug('chat-scroll', 'container resize', { prevH, h, atBottom: isAtBottomRef.current, scrolledUp: userScrolledUpRef.current, hardLocked: hardLockedRef.current, action: pin ? 'pin' : 'skip' })
        if (pin) pinHard()
      }
      prevH = h
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [chatLogEl, pinHard])

  // Force-pin when new items arrive AND we were at bottom. Virtuoso's
  // followOutput="auto" sometimes scrolls against a stale measurement of
  // the new item's height, ending up ~20px short — enough to trip
  // atBottomThreshold and surface the ⇣ arrow even though the user didn't
  // scroll. This redundant scroll catches that.
  const prevItemCountRef = useRef(allItems.length)
  // Tracks Virtuoso's total list height for totalListHeightChanged — catches
  // in-place item growth that doesn't tick items.length.
  const prevTotalHeightRef = useRef(0)
  useEffect(() => {
    const prev = prevItemCountRef.current
    prevItemCountRef.current = allItems.length
    if (allItems.length > prev && (!userScrolledUpRef.current || hardLockedRef.current)) {
      log.debug('chat-scroll', 'force-pin on item grow', { prev, now: allItems.length, scrolledUp: userScrolledUpRef.current, hardLocked: hardLockedRef.current })
      requestAnimationFrame(pinHard)
    }
  }, [allItems.length, pinHard])

  // ── Single source of follow-intent: scrollTop-DELTA on the real container ──
  // Every path that scrolls the chat log fires a native 'scroll' event on
  // .fleet-chat-log: CanvasClipPanel's wheel handler (scrollable.scrollTop +=
  // deltaY), native touch drag, AND our own programmatic pins. So we derive
  // intent here from the DELTA, not a gap threshold:
  //   • follow OFF  when the user moves UP (scrollTop decreases past a jitter
  //     epsilon) — ANY deliberate scroll-up disengages, even a small one. The
  //     old gap>120 heuristic ignored sub-120 scroll-ups, so a small read +
  //     a new message re-yanked you down. Delta has no dead band.
  //   • follow ON   only when the user is back at the TRUE bottom (gap ≤ 120,
  //     which absorbs the ~40px status footer below the last data item).
  // Two guards keep automatic motion from being misread as user intent:
  //   • programmatic fence (programmaticUntilRef, set by pinHard) — our own
  //     scrollToIndex must not flip intent.
  //   • shrink guard — when scrollHeight DECREASES (status row collapses) the
  //     browser clamps scrollTop down; that downward move is not a user
  //     scroll-up, so don't disengage.
  // Because intent now lives entirely here, atBottomStateChange no longer writes
  // it (it can't reset us mid-read), and there is no wheel-only/touch-momentum
  // split — one handler covers wheel, touch, and trackpad uniformly.
  useEffect(() => {
    const el = chatLogEl
    if (!el) return
    let lastTop = el.scrollTop
    let lastHeight = el.scrollHeight
    const handle = () => {
      const top = el.scrollTop
      const height = el.scrollHeight
      const gap = height - top - el.clientHeight
      const programmatic = performance.now() < programmaticUntilRef.current
      // All the intent math lives in the pure decideFollowTransition (unit
      // tested in test/chat-scroll-intent.test.mjs); the effect only feeds it
      // samples and applies the side effects of a transition.
      const { scrolledUp, action } = decideFollowTransition(
        { top, height, clientHeight: el.clientHeight, lastTop, lastHeight },
        { scrolledUp: userScrolledUpRef.current, hardLocked: hardLockedRef.current, programmatic },
      )
      lastTop = top
      lastHeight = height
      if (action === 'follow-off') {
        log.debug('chat-scroll', 'follow OFF (user scrolled up)', { top, gap })
        anchorRenderWindow()
      } else if (action === 'follow-on') {
        log.debug('chat-scroll', 'follow ON (returned to bottom)', { gap })
        resetRenderWindowToTail()
      }
      userScrolledUpRef.current = scrolledUp
    }
    el.addEventListener('scroll', handle, { passive: true })
    return () => el.removeEventListener('scroll', handle)
  }, [chatLogEl, anchorRenderWindow, resetRenderWindowToTail])

  // Refilter → bottom. Changing the filter swaps the whole rendered list out
  // from under Virtuoso; the scroll-position reset effect above (keyed on
  // filterKey) resets the atBottom *state*, but it runs before
  // userScrolledUpRef exists and never actually pins. So a refilter while at the
  // bottom could strand the user mid-list (Virtuoso keeps the old scrollTop
  // against new content) and, worse, a stale userScrolledUp=true would keep
  // every follow path disabled in the new view. Reset follow intent and pin:
  // the filtered history loads async, so the one pin here lands at the current
  // tail and the existing force-pin-on-item-grow + followOutput + watchdog ride
  // the new content down as it arrives. A refilter is a fresh view — bottom is
  // the right default, which is exactly what the user asked for.
  useEffect(() => {
    userScrolledUpRef.current = false
    isAtBottomRef.current = true
    setAtBottom(true)
    resetRenderWindowToTail()
    requestAnimationFrame(pinHard)
  }, [filterKey, pinHard, resetRenderWindowToTail])

  // Terminal card hover — mouseover on .lc-terminal-card shows the terminal overlay.
  useEffect(() => {
    const el = chatLogEl
    if (!el) return
    const onOver = (e: MouseEvent) => {
      const card = (e.target as HTMLElement).closest('.lc-terminal-card') as HTMLElement | null
      const agentId = card?.dataset.agentId || null
      if (!agentId) return
      if (termCardHideTimerRef.current) { clearTimeout(termCardHideTimerRef.current); termCardHideTimerRef.current = null }
      // Already open or already scheduled for this card — let it ride (don't reset the
      // intent timer on every mouseover bubbling up from child nodes).
      if (termCardPendingIdRef.current === agentId) return
      if (termCardShowTimerRef.current) { clearTimeout(termCardShowTimerRef.current); termCardShowTimerRef.current = null }
      termCardPendingIdRef.current = agentId
      termCardShowTimerRef.current = setTimeout(() => {
        termCardShowTimerRef.current = null
        // Only open if the cursor is still resting on this same card.
        const overId = (document.querySelector('.lc-terminal-card:hover') as HTMLElement | null)?.dataset.agentId
        if (overId === agentId) setTermCardHoverId(agentId)
      }, 600)
    }
    const onOut = (e: MouseEvent) => {
      const leaving = (e.target as HTMLElement).closest('.lc-terminal-card')
      const entering = (e.relatedTarget as HTMLElement | null)?.closest?.('.lc-terminal-card')
      if (leaving && !entering) {
        // Cancel a pending open so a passthrough never resolves into a popup.
        if (termCardShowTimerRef.current) { clearTimeout(termCardShowTimerRef.current); termCardShowTimerRef.current = null }
        termCardPendingIdRef.current = null
        termCardHideTimerRef.current = setTimeout(() => setTermCardHoverId(null), 200)
      }
    }
    el.addEventListener('mouseover', onOver)
    el.addEventListener('mouseout', onOut)
    return () => { el.removeEventListener('mouseover', onOver); el.removeEventListener('mouseout', onOut) }
  }, [chatLogEl])

  useEffect(() => {
    if (!chatLogEl) return
    return installChatImageRetry(chatLogEl)
  }, [chatLogEl])

  // Lightbox: click on chat-image opens full-size overlay
  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return
    function onClick(e: Event) {
      // Amend version stepper ◀▶ — step through a message's versions in place.
      const amendArrow = (e.target as HTMLElement).closest('.amend-arrow') as HTMLElement | null
      if (amendArrow) {
        e.stopPropagation()
        if (amendArrow.hasAttribute('disabled')) return
        const orig = Number(amendArrow.dataset.orig)
        const total = Number(amendArrow.dataset.total) || 1
        const dir = amendArrow.dataset.dir
        if (!orig) return
        setAmendView(prev => {
          const next = new Map(prev)
          const cur = next.get(orig) ?? (total - 1)
          const nv = dir === 'back' ? Math.max(0, cur - 1) : Math.min(total - 1, cur + 1)
          next.set(orig, nv)
          return next
        })
        return
      }
      // Resend a failed ("not sent") message — re-send with the same _tempId so
      // the existing optimistic-echo reconcile clears it on success; re-mark
      // failed if it fails again.
      const resendBtn = (e.target as HTMLElement).closest('.chat-resend-btn') as HTMLElement
      if (resendBtn) {
        e.stopPropagation()
        const to = resendBtn.dataset.resendTo
        const text = resendBtn.dataset.resendText
        const tempId = resendBtn.dataset.resendTempid
        if (to && text && tempId) {
          updateOptimisticEvent(tempId, { _failed: false })
          const resendOpts: any = { _tempId: tempId }
          sendMessage(to, text, resendOpts)
            .then((r: any) => { if (!r?.ok) throw new Error('resend failed') })
            .catch(() => updateOptimisticEvent(tempId, { _failed: true }))
        }
        return
      }
      const dismissFailedBtn = (e.target as HTMLElement).closest('.chat-dismiss-failed-btn') as HTMLElement
      if (dismissFailedBtn) {
        e.stopPropagation()
        const tempId = dismissFailedBtn.dataset.dismissTempid
        if (tempId) removeOptimisticEvent(tempId)
        return
      }
      // Plan approval buttons
      const approveBtn = (e.target as HTMLElement).closest('.plan-approve-btn') as HTMLElement
      if (approveBtn) {
        e.stopPropagation()
        const agentId = approveBtn.dataset.agentId
        if (agentId) {
          fetch(`${FLEET_API}/api/plan-mode-respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: agentId, response: 'approve' }),
          })
            .then(r => r.ok ? null : r.json().then(d => { throw new Error(d?.error || 'failed') }))
            .catch(err => sendMessage(getHumanId(), `⚠️ plan approve failed: ${err.message}`, {}))
        }
        return
      }
      const supervisedBtn = (e.target as HTMLElement).closest('.plan-supervised-btn') as HTMLElement
      if (supervisedBtn) {
        e.stopPropagation()
        const agentId = supervisedBtn.dataset.agentId
        if (agentId) {
          fetch(`${FLEET_API}/api/plan-mode-respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: agentId, response: 'supervised' }),
          })
            .then(r => r.ok ? null : r.json().then(d => { throw new Error(d?.error || 'failed') }))
            .catch(err => sendMessage(getHumanId(), `⚠️ plan supervised-approve failed: ${err.message}`, {}))
        }
        return
      }
      const rejectBtn = (e.target as HTMLElement).closest('.plan-reject-btn') as HTMLElement
      if (rejectBtn) {
        e.stopPropagation()
        const agentId = rejectBtn.dataset.agentId
        if (agentId) {
          fetch(`${FLEET_API}/api/plan-mode-respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: agentId, response: 'reject' }),
          })
            .then(r => r.ok ? null : r.json().then(d => { throw new Error(d?.error || 'failed') }))
            .catch(err => sendMessage(getHumanId(), `⚠️ plan reject failed: ${err.message}`, {}))
        }
        return
      }
      // Plan mode badge click — toggle plan mode off
      const planBadge = (e.target as HTMLElement).closest('.plan-badge-click') as HTMLElement
      if (planBadge) {
        e.stopPropagation()
        const agentId = planBadge.dataset.agentId
        if (agentId) {
          const agentName = agentNamesRef.current[agentId] || agentId.replace('fleet:', '')
          fetch(`${FLEET_API}/api/plan-mode-toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: agentId }),
          })
            .then(r => r.json().then(data => ({ ok: r.ok, data })))
            .then(({ ok, data }) => {
              if (!ok || data?.error) {
                sendMessage(getHumanId(), `⚠️ plan mode toggle failed for ${agentName}: ${data?.error || 'unknown error'}`, {})
              } else if (data?.mode) {
                const modeLabel = data.mode === 'plan' ? 'plan mode ✓' : data.mode === 'default' ? 'plan mode off ✓' : data.mode
                sendMessage(getHumanId(), `📋 ${agentName} → ${modeLabel}`, {})
              }
            })
            .catch(err => sendMessage(getHumanId(), `⚠️ plan mode toggle failed for ${agentName}: ${err.message}`, {}))
        }
        return
      }
      // Expand/collapse delegation message
      const lcMsg = (e.target as HTMLElement).closest('.lc-message') as HTMLElement
      if (lcMsg) {
        lcMsg.classList.toggle('lc-message-collapsed')
        return
      }
      // Approve/deny buttons on permission prompt cards
      const lcApproveBtn = (e.target as HTMLElement).closest('.lc-approve-btn') as HTMLElement | null
      if (lcApproveBtn) {
        const agentId = lcApproveBtn.dataset.agentId
        if (agentId) {
          fetch(`${FLEET_API}/api/send-text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: agentId, text: '1', enter: true }) })
          const eventId = lcApproveBtn.dataset.eventId || lcApproveBtn.closest('[data-msg-id]')?.getAttribute('data-msg-id')
          if (eventId) {
            fetch(`${FLEET_API}/api/prompt-respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId, response: 'approved' }) })
              .then(r => { if (r.ok) updateEventById(eventId, { _promptResponse: 'approved', metadata: { approvedAt: new Date().toISOString() } }) })
              .catch(e => console.warn('[fleet-chat] prompt approve failed:', e.message))
          }
          return
        }
      }
      const lcDenyBtn = (e.target as HTMLElement).closest('.lc-deny-btn') as HTMLElement | null
      if (lcDenyBtn) {
        const agentId = lcDenyBtn.dataset.agentId
        if (agentId) {
          fetch(`${FLEET_API}/api/send-text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: agentId, text: '3', enter: true }) })
          const eventId = lcDenyBtn.dataset.eventId || lcDenyBtn.closest('[data-msg-id]')?.getAttribute('data-msg-id')
          if (eventId) {
            fetch(`${FLEET_API}/api/prompt-respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId, response: 'rejected' }) })
              .then(r => { if (r.ok) updateEventById(eventId, { _promptResponse: 'rejected', metadata: { rejectedAt: new Date().toISOString() } }) })
              .catch(e => console.warn('[fleet-chat] prompt reject failed:', e.message))
          }
          return
        }
      }
      // Bullet card "go" button — navigate to note shape + highlight bullet
      const bulletGoBtn = (e.target as HTMLElement).closest('.bullet-card-go') as HTMLElement | null
      if (bulletGoBtn) {
        e.stopPropagation()
        const sid = bulletGoBtn.dataset.shapeId
        const tupleStr = bulletGoBtn.dataset.bulletTuple
        const idx = parseInt(bulletGoBtn.dataset.bulletIdx || '', 10)
        if (sid) {
          const mainEd = (window as any).__tldraw_editor__ || editor
          const noteShape = mainEd.getShape(sid as any)
          if (noteShape) {
            const bounds = mainEd.getShapePageBounds(noteShape.id)
            if (bounds) {
              mainEd.centerOnPoint({ x: bounds.midX, y: bounds.midY }, { animation: { duration: 300 } })
              mainEd.select(noteShape.id)
              setTimeout(() => {
                const el = document.querySelector(`[data-shape-id="${sid}"]`)
                if (!el) return
                let targetLi: Element | null = null
                if (tupleStr) {
                  // Follow tuple path: [i, j, k] → root list → i-th li → nested list → j-th li → ...
                  try {
                    const tuple = JSON.parse(tupleStr) as number[]
                    let scope: Element = el.querySelector('.math-note-prose') || el
                    for (const idx of tuple) {
                      const list = scope.tagName === 'LI' ? scope.querySelector('ul, ol') : scope.querySelector('ul, ol')
                      if (!list) break
                      const lis = Array.from(list.children).filter(c => c.tagName === 'LI')
                      if (idx < lis.length) {
                        targetLi = lis[idx]
                        scope = lis[idx]
                      } else break
                    }
                  } catch {}
                } else if (!isNaN(idx) && idx >= 0) {
                  // Legacy flat index
                  const lis = el.querySelectorAll('.math-note-prose li')
                  targetLi = lis[idx] || null
                }
                if (targetLi) {
                  targetLi.classList.add('bullet-flash')
                  setTimeout(() => targetLi!.classList.remove('bullet-flash'), 1500)
                }
              }, 400)
            }
          }
        }
        return
      }
      // Terminal lifecycle card — click to pin/unpin terminal
      const termCard = (e.target as HTMLElement).closest('.lc-terminal-card') as HTMLElement | null
      if (termCard) {
        const agentId = termCard.dataset.agentId
        if (agentId) {
          setTermCardPinnedId(prev => prev === agentId ? null : agentId)
          return
        }
      }
      // Build result card — toggle expand/collapse
      const buildHeader = (e.target as HTMLElement).closest('.build-result-header') as HTMLElement
      if (buildHeader) {
        const card = buildHeader.closest('.build-result-card') as HTMLElement
        if (card) {
          card.classList.toggle('build-result-expanded')
          return
        }
      }
      // Code block fold/unfold — track in expandedRowsRef so state survives re-renders
      const codeToggle = (e.target as HTMLElement).closest('.code-block-toggle') as HTMLElement
      if (codeToggle) {
        const wrap = codeToggle.closest('.code-block-wrap') as HTMLElement
        const itemRow = codeToggle.closest('[data-item-key]') as HTMLElement
        if (wrap && itemRow) {
          const itemKey = itemRow.getAttribute('data-item-key')
          const allWraps = Array.from(itemRow.querySelectorAll('.code-block-wrap'))
          const idx = allWraps.indexOf(wrap)
          const key = `${itemKey}:code:${idx}`
          const pre = wrap.querySelector('.fold-body, pre')
          if (pre) {
            // Inline onclick already toggled the class, so check current state
            const isNowExpanded = !pre.classList.contains('code-collapsed')
            if (isNowExpanded) expandedRowsRef.current.add(key)
            else expandedRowsRef.current.delete(key)
          }
        }
      }
      // Expand tool result (show more search results / earlier thread messages)
      const expandBtn = (e.target as HTMLElement).closest('.pretty-expand-btn') as HTMLElement
      if (expandBtn) {
        const moreRows = expandBtn.parentElement?.querySelector('.pretty-more-rows') as HTMLElement
        if (moreRows) {
          const wasExpanded = moreRows.style.display !== 'none'
          moreRows.style.display = wasExpanded ? 'none' : ''
          expandBtn.textContent = wasExpanded ? expandBtn.textContent! : 'collapse'
          const itemKey = expandBtn.closest('[data-item-key]')?.getAttribute('data-item-key')
          if (itemKey) {
            if (wasExpanded) expandedRowsRef.current.delete(itemKey)
            else expandedRowsRef.current.add(itemKey)
          }
        }
        return
      }
	      const img = (e.target as HTMLElement).closest('img') as HTMLImageElement
	      if (!img) return
	      e.stopPropagation()
	      const imgRect = img.getBoundingClientRect()
	      const request = createLightboxSurfaceRequest({
	        surfaceKey: `${shape.id}:chat-image:${img.currentSrc || img.src}`,
	        owner: currentManagedSurfaceOwner(),
	        source: `${shape.id}:chat-image:${img.currentSrc || img.src}`,
	        anchor: { left: imgRect.left, top: imgRect.top, right: imgRect.right, bottom: imgRect.bottom, width: imgRect.width, height: imgRect.height },
	        viewport: managedViewportSize(),
	      })
	      const overlay = document.createElement('div')
	      overlay.className = 'chat-lightbox'
	      overlay.dataset.managedSurfaceId = request.surfaceId
	      overlay.dataset.managedLayerId = request.layerId
	      overlay.dataset.managedKind = request.kind
	      overlay.dataset.managedHitPolicy = request.hitPolicy
	      overlay.dataset.managedOwnerUserId = request.owner.userId
	      overlay.dataset.managedOwnerDeviceId = request.owner.deviceId
	      overlay.dataset.managedSource = request.source || ''
	      overlay.innerHTML = `<img src="${img.src}" alt="${img.alt || ''}">`
	      addTap(overlay, () => overlay.remove())
	      document.body.appendChild(overlay)
    }
    // Touch/stylus: the toggles handled above are text <div>/<span> elements
    // (code-block fold, build-result header, pretty-expand, lifecycle/terminal
    // cards, plan-mode badge, delegation-message collapse) — a tap synthesizes
    // no `click`, so the delegated handler is dead on iPad/pen. On a deliberate
    // tap, re-dispatch a real .click() on the nearest such element: that fires
    // the inline onclick (code-block fold) AND this delegated handler, exactly
    // like a mouse click. <button> targets (resend/approve/deny/plan-action/
    // amend) already get a native click on touch, so they are excluded — both to
    // avoid a double-fire and so a tap on a button inside an .lc-message doesn't
    // redispatch onto the message (which would collapse it).
    let tapDownX = 0, tapDownY = 0
    const onTapDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') { tapDownX = e.clientX; tapDownY = e.clientY }
    }
    const onTapUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
      if (Math.abs(e.clientX - tapDownX) > 16 || Math.abs(e.clientY - tapDownY) > 16) return
      const t = e.target as HTMLElement
      if (t.closest('button')) return
      const hit = t.closest(
        '.code-block-toggle, .build-result-header, .pretty-expand-btn, .lc-message, .lc-terminal-card, .bullet-card-go, .plan-badge-click',
      ) as HTMLElement | null
      if (hit) hit.click()
    }
    logEl.addEventListener('pointerdown', onTapDown)
    logEl.addEventListener('pointerup', onTapUp)
    logEl.addEventListener('click', onClick)
    return () => {
      logEl.removeEventListener('pointerdown', onTapDown)
      logEl.removeEventListener('pointerup', onTapUp)
      logEl.removeEventListener('click', onClick)
    }
  }, [chatLogEl])

  // Unquote: double-click on <code> spans inside chat messages.
  // TLDraw intercepts the native dblclick event in its capture-phase handler on .tl-canvas,
  // so we detect double-click via two consecutive click events on the same <code> element.
  // click events reach bubble phase normally (markEventAsHandled on pointerdown handles TLDraw).
  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return

    // Unquote = amend the message by removing the backticks around the clicked
    // span, then re-render the WHOLE message as if it had never been quoted —
    // including file attachments. ONE behavior for ANY quoted block (path, label,
    // prose, code): the full interior is sent through the amend/upload path
    // (/api/unquote-file → daemon rechat → processMessageText), which resolves and
    // uploads any file paths inside it. The server patches the stored event and
    // broadcasts event-update, which re-renders the entire message in place — that
    // broadcast is the authoritative whole-message re-render. The local span-swap
    // below is just immediate feedback (and the terminal state when the message
    // isn't persisted server-side, so no broadcast comes back).
    async function unquoteSpan(codeEl: HTMLElement, text: string, eventId: string, agentId: string) {
      const spinner = document.createElement('span')
      spinner.textContent = '⏳'
      spinner.style.opacity = '0.6'
      codeEl.replaceWith(spinner)

      try {
        const resp = await fetch('/api/unquote-file', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ eventId: parseInt(eventId, 10), quoted: text, agentId }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const { resolvedMessage, inlineAttachments } = await resp.json()
        const rendered = resolveInlineAttachments(resolvedMessage, inlineAttachments || [], renderMarkdownUtil)
        const wrapper = document.createElement('span')
        wrapper.innerHTML = rendered
        spinner.replaceWith(...Array.from(wrapper.childNodes))
      } catch {
        // No daemon / unpersisted message: still drop the quote locally by
        // re-rendering the interior as markdown (no upload possible offline).
        const wrapper = document.createElement('span')
        wrapper.innerHTML = renderMarkdownUtil(esc(text))
        spinner.replaceWith(...Array.from(wrapper.childNodes))
      }
    }

    let lastClickEl: HTMLElement | null = null
    let lastClickTime = 0
    let pendingTimer: ReturnType<typeof setTimeout> | null = null

    function clearPending() {
      if (lastClickEl) lastClickEl.classList.remove('code-unquote-pending')
      lastClickEl = null
      lastClickTime = 0
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
    }

    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      const codeEl = target.closest('code') as HTMLElement | null
      if (!codeEl) { clearPending(); return }

      const chatLine = codeEl.closest('.chat-line') as HTMLElement | null
      if (!chatLine) { clearPending(); return }

      const text = codeEl.textContent || ''
      // Any non-empty quoted block is unquotable (Skip: "any quoted block at all").
      if (!text || text.length > 2000) { clearPending(); return }

      const now = Date.now()
      if (lastClickEl === codeEl && now - lastClickTime < 1000) {
        // Second click within 500ms on the same element = double-click
        clearPending()
        e.preventDefault()
        e.stopPropagation()
        const eventId = chatLine.dataset.msgId || ''
        const agentId = chatLine.dataset.msgFrom || ''
        unquoteSpan(codeEl, text, eventId, agentId)
      } else {
        clearPending()
        lastClickEl = codeEl
        lastClickTime = now
        codeEl.classList.add('code-unquote-pending')
        pendingTimer = setTimeout(clearPending, 1000)
      }
    }

    // Touch/stylus double-TAP parity: on touch there are no clicks, so the
    // double-click-to-unquote above is dead. Route a movement-guarded touch/pen
    // pointerup through the SAME handler — two taps on the same <code> within the
    // window trigger the unquote exactly like a double-click. Mouse keeps its
    // native double-click (touch/pen only here, so no double-count).
    let uqDownX = 0, uqDownY = 0
    const onUqDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') { uqDownX = e.clientX; uqDownY = e.clientY }
    }
    const onUqUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
      if (Math.abs(e.clientX - uqDownX) > 16 || Math.abs(e.clientY - uqDownY) > 16) return
      onClick(e)
    }
    logEl.addEventListener('pointerdown', onUqDown)
    logEl.addEventListener('pointerup', onUqUp)
    logEl.addEventListener('click', onClick)
    return () => {
      logEl.removeEventListener('pointerdown', onUqDown)
      logEl.removeEventListener('pointerup', onUqUp)
      logEl.removeEventListener('click', onClick)
    }
  }, [chatLogEl])

  // Track clicks to determine which fleet chat shape the user is interacting with.
  // Escape interrupt scopes to the shape the user last clicked on.
  useEffect(() => {
    function onPointerDownForEsc(e: PointerEvent) {
      const container = shapeContainerRef.current
      if (!container) return
      chatActiveRef.current = container.contains(e.target as Node)
    }
    document.addEventListener('pointerdown', onPointerDownForEsc, true)
    return () => document.removeEventListener('pointerdown', onPointerDownForEsc, true)
  }, [])

  // Esc interrupt — document-level listener, scoped to fire only when the user
  // last clicked inside this fleet chat shape (chatActiveRef).
  // Three tiers: 1×Esc = soft (promote a queued message above the spinner; the
  // daemon no-ops if nothing is queued, so a single Esc never hard-interrupts),
  // 2×Esc = hard (one Escape that stops the agent), 3×Esc = kill session.
  useEffect(() => {
    let escTempCounter = 0
    function onEscKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (!chatActiveRef.current) return
      const ta = inputRef.current as HTMLTextAreaElement | null
      if (ta && ta.value !== '') return
      const targets = sendTargetsRef.current
      if (targets.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      const now = Date.now()
      setUnqueuedAt(now)
      const agent = resolveToFleetIdRef.current(targets[0])
      // Escalation is action-based: each Esc increments; any non-Esc action
      // (keydown, pointer, message send) resets. No timing window.
      escCountRef.current++
      const count = escCountRef.current
      const agentLabel = agentNamesRef.current[agent] || agent.replace('fleet:', '')
      log.info('esc', 'interrupt', { count, agent, agentLabel })
      const tempId = `esc-${++escTempCounter}-${now}`
      const ts = new Date().toISOString()
      setEscLevel(agent, count >= 3 ? 3 : count)
      if (count >= 3) {
        escCountRef.current = 0
        injectOptimisticEvent({ _tempId: tempId, _evType: 'system_notice', _isInterrupt: true, from: 'system', to: agent, text: `💀 Killing ${agentLabel}…`, timestamp: ts })
        fetch(`${FLEET_API}/api/kill-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent }) })
          .then(r => r.json())
          .then(d => {
            updateOptimisticEvent(tempId, { text: d.error ? `⚠ Kill failed: ${d.error}` : `💀 Killed ${agentLabel}` })
            if (!d.error) confirmEscLevel(agent, 3)
            setTimeout(() => clearEscState(agent), 2000)
          })
          .catch(() => { updateOptimisticEvent(tempId, { text: `⚠ Kill failed (server unreachable)` }) })
      } else if (count === 2) {
        fetch(`${FLEET_API}/api/interrupt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent }) })
          .then(r => r.json())
          .then(d => {
            if (d.error) injectOptimisticEvent({ _tempId: tempId, _evType: 'system_notice', _isInterrupt: true, from: 'system', to: agent, text: `⚠ Interrupt failed: ${d.error}`, timestamp: ts })
            else confirmEscLevel(agent, 2)
          })
          .catch(() => { injectOptimisticEvent({ _tempId: tempId, _evType: 'system_notice', _isInterrupt: true, from: 'system', to: agent, text: `⚠ Interrupt failed (server unreachable)`, timestamp: ts }) })
      } else {
        // Soft interrupt: promote a queued message above the spinner without
        // stopping the agent. The daemon no-ops when nothing is queued — a single
        // Esc must never hard-interrupt. Confirm the card off the real result
        // (promoted / nothing-queued), not optimistically.
        injectOptimisticEvent({ _tempId: tempId, _evType: 'system_notice', _isInterrupt: true, from: 'system', to: agent, text: `⏸ Soft interrupt → ${agentLabel}…`, timestamp: ts })
        fetch(`${FLEET_API}/api/soft-interrupt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent }) })
          .then(r => r.json())
          .then(d => {
            if (d.error) { updateOptimisticEvent(tempId, { text: `⚠ Soft interrupt failed: ${d.error}` }) }
            else if (d.promoted) { updateOptimisticEvent(tempId, { text: `⏸ Promoted queued message → ${agentLabel}` }); confirmEscLevel(agent, 1) }
            else if (d.reason === 'nothing-queued') { updateOptimisticEvent(tempId, { text: `· nothing queued for ${agentLabel} — no-op` }) }
            else { updateOptimisticEvent(tempId, { text: `⏸ Soft interrupt → ${agentLabel} (unconfirmed)` }) }
          })
          .catch(() => { updateOptimisticEvent(tempId, { text: `⚠ Soft interrupt failed (server unreachable)` }) })
      }
    }
    function resetEscState() {
      if (escCountRef.current === 0) return
      escCountRef.current = 0
      setEscalationState({})
    }
    function onNonEscKey(e: KeyboardEvent) {
      if (e.key === 'Escape') return
      resetEscState()
    }
    function onPointerDownReset() {
      if (!chatActiveRef.current) return
      resetEscState()
    }
    document.addEventListener('keydown', onEscKey, true)
    document.addEventListener('keydown', onNonEscKey, true)
    document.addEventListener('pointerdown', onPointerDownReset, true)
    return () => {
      document.removeEventListener('keydown', onEscKey, true)
      document.removeEventListener('keydown', onNonEscKey, true)
      document.removeEventListener('pointerdown', onPointerDownReset, true)
    }
  }, [])

  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      if (a.id) map[a.id] = agentDisplayName(a)
    }
    if (getHumanId()) map[getHumanId()] = getHumanName() || 'user'
    return map
  }, [agents])

  // Detect pill drag hovering over this chat — returns stable string to avoid flicker
  // Only agent/label pills trigger filter overlay, not content pills (msg, code, etc.)
  const fleetPillCount = useFleetPillCount(editor)
  const pillOverKey = useValue('pill-over', () => {
    if (fleetPillCount === 0) return ''
    const pills = editor.getCurrentPageShapes().filter(s => (s.type as string) === 'fleet-pill') as any[]
    if (pills.length === 0) return ''
    const myBounds = editor.getShapePageBounds(shape.id)
    if (!myBounds) return ''
    for (const pill of pills) {
      const props = pill.props
      if (props.pillType !== 'agent' && props.pillType !== 'label') continue
      const pb = editor.getShapePageBounds(pill.id)
      if (!pb) continue
      const cx = pb.x + pb.w / 2
      const cy = pb.y + pb.h / 2
      if (cx >= myBounds.x && cx <= myBounds.x + myBounds.w &&
          cy >= myBounds.y && cy <= myBounds.y + myBounds.h) {
        const role = cy < myBounds.y + myBounds.h / 2 ? 'to' : 'from'
        return `${role}\0${props.value}\0${props.displayName}`
      }
    }
    return ''
  }, [editor, shape.id, fleetPillCount])
  const pillOver = useMemo(() => {
    if (!pillOverKey) return null
    const [role, value, displayName] = pillOverKey.split('\0')
    return { role, value, displayName }
  }, [pillOverKey])

  // Auto-open filter overlay when pill hovers over this chat
  useEffect(() => {
    if (pillOver && !filterOpen) {
      setFilterOpenByPill(true)
      setFilterOpen(true)
    } else if (!pillOver && filterOpenByPill) {
      setFilterOpenByPill(false)
      setFilterOpen(false)
    }
  }, [!!pillOver])

  // Derive send targets: unique agents in "to" clauses only
  const sendTargets = useMemo(() => {
    const seen = new Set<string>()
    for (const clause of filter) {
      for (const [role, label] of clause) {
        if (role === 'to' || role === 'dm') seen.add(label)
      }
    }
    return [...seen]
  }, [filterKey])
  sendTargetsRef.current = sendTargets

  const humanFilterLabel = getHumanName() || getHumanId() || 'user'
  const composerAgentLabel = useMemo(
    () => activeComposerAgentLabel(filter, sendTargets, agents),
    [filterKey, sendTargets, agents],
  )
  // Records the pointerdown that started on the traffic toggle, so a cycle only
  // fires on a deliberate tap (down AND up on the toggle, little movement) — not
  // on a stray touch or a scroll-drag that merely lifts off over it. This is the
  // `93aba2cd` spurious-filter-cycling fix.
  const trafficTapRef = useRef<{ x: number; y: number; id: number } | null>(null)
  const composerTrafficMode = useMemo<ComposerTrafficFilterMode>(
    () => classifyFleetComposerTrafficMode(filter, trafficMode, humanFilterLabel, composerAgentLabel),
    [filterKey, trafficMode, humanFilterLabel, composerAgentLabel],
  )
  const cycleComposerTrafficMode = useCallback(() => {
    if (!composerAgentLabel) return
    const nextMode = nextFleetComposerTrafficMode(composerTrafficMode)
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      props: {
        filter: filterForFleetComposerTrafficMode(nextMode, humanFilterLabel, composerAgentLabel),
        trafficMode: nextMode === 'dm-quiet' ? 'quiet' : 'normal',
      },
    })
  }, [composerAgentLabel, composerTrafficMode, editor, humanFilterLabel, shape.id, shape.type])

  // --- Composer host callbacks ---------------------------------------------
  // The shared ChatComposer owns the textarea + voice registration + send-on-
  // enter; everything chat-specific (viewer context, ref attachments, plan-mode,
  // /terminal, file-drop, escalation reset) lives here and is passed back in.
  // Defined as plain closures (recreated each render, like the old inline
  // handlers) so there's no memoization-induced staleness. Keyboard and voice
  // send remain DISTINCT — the original had two genuinely-different inline paths
  // (keyboard: inject→…→plan→send; voice: context→inject→send, no plan).
  const composerKeyboardSend = (text: string, targets: string[]) => {
    const tempId = `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`
    injectOptimisticEvent({
      _tempId: tempId,
      type: 'chat',
      event_type: 'chat',
      from: getHumanId(),
      to: targets[0],
      text,
      timestamp: new Date().toISOString(),
      read: false,
    })
    void (async () => {
      const context = gatherViewerContext(editor, doc, shape.id, currentDocVersion(panel, editor))
      if (context) await enrichContextWithSourceLines(context)
      const bullets = consumeBulletContexts()
      if (bullets.length > 0 && context) {
        ;(context as any).bullets = bullets
      }
      const lc = text.toLowerCase().replace(/[.,!?]+$/, '').trim()
      const APPROVE_PHRASES = new Set([
        'go for it', 'do it', 'proceed', 'implement it', 'implement', 'approve',
        'yes', 'yes do it', "let's go", 'lets go', 'sounds good', 'looks good',
        'go ahead', 'yeah go for it', 'yep', 'yeah', 'ok', 'okay', 'ship it',
      ])
      const REJECT_PHRASES = new Set([
        'stop', 'abort', "don't do it", 'cancel', 'no', 'reject', 'hold off',
        'wait', 'hold on', 'never mind', 'nevermind', 'nope', 'nah',
      ])
      if (APPROVE_PHRASES.has(lc) || REJECT_PHRASES.has(lc)) {
        const planResponse = APPROVE_PHRASES.has(lc) ? 'approve' : 'reject'
        for (const agentId of targets) {
          const chatLog = chatLogRef.current
          const hasCard = chatLog
            ? Array.from(chatLog.querySelectorAll(`.plan-card[data-agent-id="${CSS.escape(agentId)}"]`))
                .some(el => !el.classList.contains('plan-card-approved') && !el.classList.contains('plan-card-rejected'))
            : false
          if (hasCard) {
            fetch(`${FLEET_API}/api/plan-mode-respond`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agent: agentId, response: planResponse }),
            }).catch(e => console.warn('[fleet-chat] plan-mode-respond failed:', e.message))
          }
        }
      }
      const ENTER_PLAN_RE = /^\/plan\b|\blet'?s plan\b|\bplan mode\b|\bplanning mode\b|\bchat in planning\b|\bstay in planning\b|\bplan first\b|\bthink before\b/i
      if (ENTER_PLAN_RE.test(text)) {
        for (const agentId of targets) {
          const agentName = agentNames[agentId] || agentId
          fetch(`${FLEET_API}/api/plan-mode-toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: agentId }),
          })
            .then(r => r.json().then((data: any) => ({ ok: r.ok, data })))
            .then(({ ok, data }: { ok: boolean; data: any }) => {
              if (!ok || data?.error) {
                sendMessage(getHumanId(), `⚠️ plan mode failed for ${agentName}: ${data?.error || 'unknown error'}`, {})
              } else if (data?.mode) {
                const modeLabel = data.mode === 'plan' ? 'plan mode ✓' : data.mode
                sendMessage(getHumanId(), `📋 ${agentName} → ${modeLabel}`, {})
              }
            })
            .catch((err: any) => sendMessage(getHumanId(), `⚠️ plan mode failed for ${agentName}: ${err.message}`, {}))
        }
      }
      const refAttachments = buildRefAttachments(text, editor)
      const sendOpts: any = context ? { context, _tempId: tempId } : { _tempId: tempId }
      if (refAttachments.length > 0) sendOpts.attachments = refAttachments
      if (doc?.docName) sendOpts.preambleRef = { doc: doc.docName, version: currentDocVersion(panel, editor) || null }
      const sendWithRetry = (attempt: number) => {
        Promise.all(
          targets.map(t => sendMessage(t, text, sendOpts))
        ).then((results: {ok: boolean, event_id: number}[]) => {
          if (!results.every(r => r.ok)) throw new Error('send failed')
        }).catch(() => {
          if (attempt < 3) {
            setTimeout(() => sendWithRetry(attempt + 1), 2000 * attempt)
          } else {
            updateOptimisticEvent(tempId, { _failed: true })
          }
        })
      }
      sendWithRetry(1)
    })()
  }

  const composerVoiceSend = async (targets: string[], text: string) => {
    const context = gatherViewerContext(editor, doc, shape.id, currentDocVersion(panel, editor))
    if (context) await enrichContextWithSourceLines(context)
    const bullets = consumeBulletContexts()
    if (bullets.length > 0 && context) {
      ;(context as any).bullets = bullets
    }
    const tempId = `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`
    injectOptimisticEvent({
      _tempId: tempId,
      type: 'chat',
      event_type: 'chat',
      from: getHumanId(),
      to: targets[0],
      text,
      timestamp: new Date().toISOString(),
      read: false,
    })
    const refAttachments = buildRefAttachments(text, editor)
    const sendOpts: any = context ? { context, _tempId: tempId } : { _tempId: tempId }
    if (refAttachments.length > 0) sendOpts.attachments = refAttachments
    if (doc?.docName) sendOpts.preambleRef = { doc: doc.docName, version: currentDocVersion(panel, editor) || null }
    const sendWithRetry = (attempt: number) => {
      Promise.all(
        targets.map(t => sendMessage(t, text, sendOpts))
      ).then((results: {ok: boolean, event_id: number}[]) => {
        if (!results.every(r => r.ok)) throw new Error('send failed')
      }).catch(() => {
        if (attempt < 3) {
          setTimeout(() => sendWithRetry(attempt + 1), 2000 * attempt)
        } else {
          updateOptimisticEvent(tempId, { _failed: true })
        }
      })
    }
    sendWithRetry(1)
  }

  const composerCommand = (text: string, targets: string[], ta: HTMLTextAreaElement): boolean => {
    const termMatch = text.match(/^\/terminal\s*(.*)$/i)
    if (!termMatch) return false
    const arg = termMatch[1].trim()
    let targetId = ''
    if (arg) {
      const match = agents.find((a: any) =>
        a.friendly_name === arg || a.id === arg || a.id?.endsWith(arg)
      )
      targetId = match?.id || arg
    } else if (targets.length > 0) {
      targetId = targets[0]
    }
    if (targetId) {
      setTermCardPinnedId(targetId)
      ta.value = ''
      ta.style.height = ''
    }
    return true
  }

  const composerKeyActivity = () => {
    if (escCountRef.current > 0) {
      escCountRef.current = 0
      setEscalationState({})
    }
  }

  const composerDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const composerDrop = async (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const ta = e.currentTarget

    // External file drops — upload to fleet server, insert markdown link
    const dtItems = e.dataTransfer?.items ? [...e.dataTransfer.items] : []
    let entries: { file: File, path: string }[] = []
    let isFlat = true

    if (dtItems.length > 0 && typeof dtItems[0].webkitGetAsEntry === 'function') {
      for (const item of dtItems) {
        const entry = item.webkitGetAsEntry()
        if (entry) {
          if (entry.isDirectory) isFlat = false
          entries.push(...await traverseDirectory(entry))
        }
      }
    } else {
      for (const f of [...(e.dataTransfer?.files || [])]) {
        entries.push({ file: f, path: f.name })
      }
    }

    if (entries.length > 0) {
      const mdEntries = entries.filter(({ file: f }) => f.name.endsWith('.md') || f.type === 'text/markdown')
      const otherEntries = entries.filter(({ file: f }) => !f.name.endsWith('.md') && f.type !== 'text/markdown')

      for (const { file, path } of mdEntries) {
        try {
          const companions = entries.filter(en => en.path !== path)
          const link = await uploadMarkdownWithImages(file, companions, path, isFlat)
          const pos = ta.selectionStart || ta.value.length
          ta.value = ta.value.slice(0, pos) + link + ta.value.slice(pos)
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        } catch (err) {
          console.error('[fleet-chat] file upload failed:', err)
          const pos = ta.selectionStart || ta.value.length
          ta.value = ta.value.slice(0, pos) + `[${file.name}]` + ta.value.slice(pos)
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }
      for (const { file } of otherEntries) {
        if (mdEntries.length > 0 && /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(file.name)) continue
        try {
          const formData = new FormData()
          formData.append('file', file, file.name)
          const resp = await fetch(`${FLEET_API}/api/upload`, { method: 'POST', body: formData })
          if (!resp.ok) throw new Error(`upload failed: ${resp.status}`)
          const { url, name } = await resp.json()
          const link = file.type.startsWith('image/')
            ? `![${name}](${FLEET_API}${url})`
            : `[${name}](${FLEET_API}${url})`
          const pos = ta.selectionStart || ta.value.length
          ta.value = ta.value.slice(0, pos) + link + ta.value.slice(pos)
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        } catch (err) {
          console.error('[fleet-chat] file upload failed:', err)
          const pos = ta.selectionStart || ta.value.length
          ta.value = ta.value.slice(0, pos) + `[${file.name}]` + ta.value.slice(pos)
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
  }

  // Resolve a send-target label to one agent. The friendly name is an opaque
  // atom — you address an agent by its exact full name (or id, or a label it
  // carries). No suffix games: dawn is "base", day is "base:day", etc.
  //
  // Terminal peek needs a concrete tmux owner. Broadcast/group labels such as
  // "awake" can match many agents, so only return label matches that identify a
  // single non-human agent. Group panels deliberately show no panel-level
  // terminal peek: there is no one agent associated with the whole chat.
  const resolveTargetAgent = useCallback((label: string, agentList: any[]) => {
    if (label.startsWith('fleet:')) return agentList.find((a: any) => a.id === label) || null
    // A friendly name can have a LIVE holder plus one or more DEAD former holders:
    // a dead agent keeps its friendly_name for provenance (spec G.18), so the name
    // string outlives any single holder. The live holder IS the agent (G.22), so
    // prefer a non-dead match; fall back to a dead one only when the name has no
    // live holder (which keeps resurrect-by-name working for an all-dead name).
    const byName = agentList.filter((a: any) => a.friendly_name === label || a.id === label)
    if (byName.length) return byName.find((a: any) => !a.dead) || byName[0]
    const matched = agentList.filter((a: any) => !a.human && labelsForAgent(a).includes(label))
    return matched.length === 1 ? matched[0] : null
  }, [])

  const isTerminalReadyAgent = useCallback((agent: any) => {
    return !!agent?.tmux_session && !agent?.dead && !agent?.hibernating && agent?.status !== 'hibernating'
  }, [])

  const hoverTargetAgentId = useMemo(() => {
    const diag: any[] = []
    const candidateLabels: string[] = []
    const addLabel = (label: string) => {
      if (label && !candidateLabels.includes(label)) candidateLabels.push(label)
    }
    for (const label of sendTargets) {
      addLabel(label)
    }
    for (const clause of filter) {
      for (const [, label] of clause) addLabel(label)
    }
    for (const label of candidateLabels) {
      const agent = resolveTargetAgent(label, agents)
      diag.push({ label, fleetId: agent?.id || label, found: !!agent, tmux: agent?.tmux_session || null, dead: agent?.dead ?? null })
      if (isTerminalReadyAgent(agent)) {
        log.info('terminal-icon', 'resolved target', { sendTargets, filter, source: 'label', fleetId: agent.id, diag, agentCount: agents.length })
        return agent.id
      }
    }
    log.info('terminal-icon', 'no terminal target', { sendTargets, filter, diag, agentCount: agents.length })
    return null
  }, [sendTargets, filterKey, agents, resolveTargetAgent, isTerminalReadyAgent])

  const deadTargetAgent = useMemo(() => {
    for (const label of sendTargets) {
      const agent = resolveTargetAgent(label, agents)
      if (agent?.dead) {
        // Spec G.22: a dead agent that shares its friendly name with a LIVE
        // holder is just provenance, never a resurrect target — the live holder
        // IS the agent. Only offer resurrect when the name has NO live holder
        // (the legitimate "the only holder is dead" case). This is what stops
        // dead namesakes nagging "resurrect?" in a chat with the live holder.
        const name = agent.friendly_name
        const hasLiveHolder = !!name && agents.some((a: any) => !a.dead && a.friendly_name === name)
        if (hasLiveHolder) continue
        return { id: agent.id, name: name || agent.id.replace('fleet:', '') }
      }
    }
    return null
  }, [sendTargets, agents, resolveTargetAgent])

  // Reset auto-pin tracking when the target agent changes
  useEffect(() => {
    termAutoPinnedRef.current = false
    lastAttentionTsRef.current = null
  }, [hoverTargetAgentId])

  // (Terminal auto-pin on permission prompts removed — chat cards handle this now)

  // Detect impossible filter: filter is set but no AND group can match any known agent
  const isImpossibleFilter = useMemo(() => {
    if (filter.length === 0) return false
    const allIds = agents.map((a: any) => {
      const labels = [...(a.labels || []), a.friendly_name, a.id].filter(Boolean)
      return { id: a.id, labels }
    })
    // Also include human
    if (getHumanId()) allIds.push({ id: getHumanId(), labels: [getHumanName() || 'user', getHumanId()] })
    // For each OR clause, check if there's any agent that matches ALL terms
    return !filter.some(clause =>
      allIds.some(agent =>
        clause.every(([_role, label]) => agent.labels.includes(label))
      )
    )
  }, [filterKey, agents])

  // Resolve the filter to the fleet-id set for history paging — same resolver
  // as the initial load and the live display. null = no filter (unfiltered
  // view loads global history); [] = filtered but nothing resolved yet (don't
  // fall back to global history inside a filtered view).
  const loadBeforeAgents = useMemo<string[] | null>(
    () => (dnfFilter ? [...resolveFilter(dnfFilter)] : null),
    // filterKey is the stable string encoding of dnfFilter (avoids re-running on
    // a fresh array identity each render); resolveFilter is a stable module import.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey, agents]
  )

  // Infinite scroll — load older messages
  const loadingMore = useRef(false)
  const handleScroll = useCallback(async (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop > 50 || loadingMore.current || chatMessages.length === 0) return
    if (!userScrolledUpRef.current) return
    if (expandRenderedHistory(el)) return
    // Filtered view that hasn't resolved to any id yet — don't page in global history.
    if (loadBeforeAgents !== null && loadBeforeAgents.length === 0) return
    loadingMore.current = true
    const oldestTs = chatMessages[0]?.timestamp
    if (oldestTs) {
      const prevHeight = el.scrollHeight
      // Older rows fold into the single store (deduped by id); the view re-renders
      // off the store. Restore scroll position so the viewport doesn't jump.
      await loadBefore(loadBeforeAgents || [], oldestTs, 50)
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevHeight
      })
    }
    loadingMore.current = false
  }, [chatMessages, loadBeforeAgents, expandRenderedHistory])

  // Attach scroll + click handlers to the Virtuoso-owned scroll container.
  // Listener-based (not JSX prop) because the Scroller is memoized and
  // doesn't close over changing callbacks.
  useEffect(() => {
    const el = chatLogEl
    if (!el) return
    const onScroll = (e: Event) => handleScroll(e as any)
    // Touch: a tap on a text chip never synthesizes a `click`, so the
    // click-delegated chip/link handlers below are dead on iPad. Drive them
    // from a movement-guarded pointerup for touch instead. The movement guard
    // means a drag-to-scroll that lifts off on a chip does NOT fire an open;
    // the timestamp dedupe stops a mouse `click` from double-firing.
    let downX = 0, downY = 0, lastTouchHandled = 0
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
      downX = e.clientX; downY = e.clientY
    }
    const onPointerUp = (e: PointerEvent) => {
      // Finger AND stylus: a tap on a markdown/file chip never synthesizes a
      // `click`, so the mouse-only open handler was dead on iPad/pen. (Skip: the
      // md-chip lightbox "triggers on click with a mouse, it should work on
      // finger and stylus touch.") 16px guard so a drag-to-scroll that lifts off
      // on a chip does NOT open it (a thumb drifts >10px on a real tap).
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
      if (Math.abs(e.clientX - downX) > 16 || Math.abs(e.clientY - downY) > 16) return
      lastTouchHandled = e.timeStamp
      handleDocLinkClick(e as any)
    }
    const onClick = (e: Event) => {
      if (e.timeStamp - lastTouchHandled < 700) return
      handleDocLinkClick(e as any)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('click', onClick)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('click', onClick)
    }
  }, [chatLogEl, handleScroll, handleDocLinkClick])

  // Auto-load more history when content doesn't fill the scroll container.
  // Without this, if initial messages are too few to create a scrollbar,
  // handleScroll never fires and the user can't get more messages.
  useEffect(() => {
    const el = chatLogEl
    // Auto-load only for a resolved filtered view (a specific id set) — not for
    // the unfiltered view (null) and not while a filter is still unresolved ([]).
    if (!el || loadingMore.current || chatMessages.length === 0 || !loadBeforeAgents || loadBeforeAgents.length === 0) return
    if (el.scrollHeight > el.clientHeight) return
    const oldestTs = chatMessages[0]?.timestamp
    if (!oldestTs) return
    loadingMore.current = true
    loadBefore(loadBeforeAgents, oldestTs, 50).then(() => {
      // Older rows fold into the single store; the view re-renders off it.
      loadingMore.current = false
    })
  }, [chatLogEl, chatMessages, loadBeforeAgents])

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
    sourceAgent?: string
    filePath?: string
    fileUrl?: string
    startX: number
    startY: number
    started: boolean
    captureEl: HTMLElement | null
    pointerId: number
  } | null>(null)

  // Store agentNames in a ref so native listeners can access current value
  const agentNamesRef = useRef(agentNames)
  agentNamesRef.current = agentNames
  const resolveToFleetIdRef = useRef(resolveToFleetId)
  resolveToFleetIdRef.current = resolveToFleetId

  // Store shape.id in a ref so document-level listeners can access it
  const shapeIdRef = useRef(shape.id)
  shapeIdRef.current = shape.id

  // Track selection state via ref so native capture listeners can read it.
  // useValue makes this reactive — component re-renders when selection changes,
  // keeping isSelectedRef.current fresh. Without this, the ref is always stale
  // because tldraw doesn't re-render shapes on selection changes.
  const isSelectedRef = useRef(false)
  isSelectedRef.current = useValue('isSelected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])

  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return

    // Document-level capture listeners: fires before tldraw's tl-container
    // listener can intercept. We scope to this chat by checking if the target
    // is inside our logEl.

    // The element a drag-claim started on — so a no-move TAP on a draggable
    // chip/link can re-fire its click on touch/stylus (see onPointerUp).
    let downTargetEl: HTMLElement | null = null

    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!logEl!.contains(target)) return

      // If this shape is selected for drag/resize (fleet-drag-mode), let
      // TLDraw handle everything — don't intercept pointer events.
      if (isSelectedRef.current) return

      // Only proceed with drag logic on draggable elements.
      // Large items (activity cards, code block headers, tool lines) require
      // clicking on their .drag-handle left-edge element. Small inline items
      // (chips, timestamps) are draggable from the whole element.
      const isDraggable = target.closest(
        '.drag-handle, .chat-ts, .tool-ref, .md-file-card, .tlda-card, .build-result-card, .ref-chip-annotation, .ref-chip:not(.ref-chip-annotation), .pretty-search-ts, .agent-nick'
      )

      if (!isDraggable) {
        // Non-drag click — mark handled so tldraw skips setPointerCapture,
        // but let the event propagate to the target so the browser can start
        // text selection naturally (requires user-select:text on .chat-line).
        editor.markEventAsHandled(e)
        return
      }

      const names = agentNamesRef.current

      let drag: typeof dragRef.current = null

      // Lifecycle cards (delegate, task_done, bounced) — drag from their drag-handle
      {
        const lcCard = target.closest('.lifecycle-card') as HTMLElement
        if (lcCard && target.closest('.drag-handle')) {
          const chatLine = lcCard.closest('.chat-line') as HTMLElement
          const lcDbId = chatLine?.dataset.msgId || ''
          const lcFrom = chatLine?.dataset.msgFrom || ''
          const lcTs = chatLine?.dataset.msgTs || ''
          const lcType = lcCard.dataset.lcType || 'delegate'
          const lcNick = names[lcFrom] || lcFrom.replace('fleet:', '')
          const lcTime = lcTs ? new Date(lcTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
          const lcTitle = lcCard.querySelector('.lc-title')?.textContent || lcType
          drag = {
            pillId: null, pillType: 'msg', value: lcDbId ? `msg:${lcDbId}` : `msg:${lcFrom}:${lcTs}`,
            displayName: `${lcNick} ${lcTime} ${lcTitle}`.trim(),
            color: '#c8b060', content: lcCard.textContent?.slice(0, 300)?.trim() || '',
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Timestamp → message reference (works in main chat, search results, thread views)
      {
        const tsEl = target.closest('.chat-ts, .pretty-search-ts, .pretty-ts') as HTMLElement
        if (tsEl) {
          const line = tsEl.closest('.chat-line, .pretty-search-row, .pretty-thread-msg') as HTMLElement
          if (line) {
            const from = line.dataset.msgFrom || ''
            const ts = line.dataset.msgTs || tsEl.getAttribute('title') || tsEl.textContent || ''
            const dbId = line.dataset.msgId || ''
            const text = line.textContent?.slice(0, 200)?.trim() || ''
            const nick = from ? (names[from] || from.replace('fleet:', '')) : ''
            drag = {
              pillId: null, pillType: 'msg', value: dbId ? `msg:${dbId}` : `msg:${from}:${ts}`,
              displayName: `${nick} ${tsEl.textContent || ''} chat`.trim(),
              color: '#8888a0', content: text,
              startX: e.clientX, startY: e.clientY,
              started: false, captureEl: logEl, pointerId: e.pointerId,
            }
          }
        }
      }

      // Tool line (individual tool call row in activity card) — must check BEFORE
      // activity card since tool lines are nested inside activity cards.
      if (!drag) {
        const toolLine = target.closest('.tool-line') as HTMLElement
        if (toolLine) {
          const toolName = toolLine.dataset.toolName || toolLine.querySelector('.tool-name')?.textContent || 'tool'
          const toolArg = toolLine.dataset.toolArg || toolLine.querySelector('.tool-arg')?.textContent || ''
          // Get DB ID from the parent activity card + line number for highlighting
          const activityCard = toolLine.closest('.chat-activity-card') as HTMLElement
          const toolDbId = activityCard?.dataset.msgId || ''
          const lineNum = toolLine.dataset.line || ''
          const toolTs = activityCard?.dataset.ts || ''
          const toolNick = names[activityCard?.dataset.agent || ''] || ''
          const toolTime = toolTs ? new Date(toolTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
          drag = {
            pillId: null, pillType: 'tool', value: toolDbId ? `activity:${toolDbId}:line${lineNum}` : `tool:unknown`,
            displayName: `${toolNick} ${toolTime} ${toolName}`.trim(),
            color: '#c8b060', content: toolArg ? `${toolName}: ${toolArg}` : toolName,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Activity card (only when NOT dragging from inside a tool line or md-file chip)
      if (!drag) {
        const actCard = target.closest('.chat-activity-card') as HTMLElement
        if (actCard && !target.closest('.md-file-card')) {
          const agentId = actCard.dataset.agent || ''
          const ts = actCard.dataset.ts || ''
          const actDbId = actCard.dataset.msgId || ''
          const text = actCard.textContent?.slice(0, 300)?.trim() || ''
          const nick = names[agentId] || agentId.replace('fleet:', '')
          const actTime = ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
          drag = {
            pillId: null, pillType: 'activity', value: actDbId ? `activity:${actDbId}` : `activity:${agentId}:${ts}`,
            displayName: `${nick} ${actTime} activity`.trim(),
            color: '#c8b060', content: text,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Code block header (but not the copy button or md-file chip — let those through)
      if (!drag) {
        const codeHeader = target.closest('.code-block-header') as HTMLElement
        if (codeHeader && !target.closest('.code-block-copy') && !target.closest('.md-file-card')) {
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

      // MD file card → drag as a doc reference
      if (!drag) {
        const mdCard = target.closest('.md-file-card') as HTMLElement
        if (mdCard) {
          const filePath = mdCard.dataset.path || ''
          const name = mdCard.querySelector('.md-file-chip')?.textContent || mdCard.textContent?.trim() || filePath.split('/').pop() || 'file'
          const value = `file:${filePath}`
          drag = {
            pillId: null, pillType: 'doc' as any, value,
            displayName: name, color: '#63a0db', content: filePath,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }
      if (!drag) {
        const tldaCard = target.closest('.tlda-card') as HTMLElement
        if (tldaCard) {
          const tldaSrc = tldaCard.dataset.tldaSrc || ''
          const docName = tldaCard.querySelector('.doc-name')?.textContent || ''
          // Use 'tlda:URL' to carry the full src URL for inline-doc creation
          drag = {
            pillId: null, pillType: 'doc' as any, value: `tlda:${tldaSrc}`,
            displayName: docName, color: '#9370db', content: docName,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Annotation ref-chip → drag as note (creates collapsed math-note on canvas drop)
      if (!drag) {
        const refChip = target.closest('.ref-chip-annotation') as HTMLElement
        if (refChip) {
          // Get label text excluding location badge and dot elements
          const clone = refChip.cloneNode(true) as HTMLElement
          clone.querySelectorAll('.ref-chip-loc, .ref-chip-dot, .ref-chip-preview').forEach(el => el.remove())
          const label = clone.textContent?.trim() || 'note'
          // Use the stored token (contains embedded shapeId for new chips)
          const token = refChip.dataset.token || `«annotation:${label}»`
          const embShapeId = token.match(/#(shape:[^»]+)»/)?.[1]
          const srcShape = embShapeId ? editor.getShape(embShapeId as any) as any : null
          const dotEl = refChip.querySelector('.ref-chip-dot') as HTMLElement | null
          const chipColor = dotEl?.style.background || srcShape?.props?.color || '#3b82f6'
          drag = {
            pillId: null, pillType: 'annotation' as any, value: token,
            displayName: label, color: chipColor,
            content: srcShape?.props?.text || label,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // File ref-chip → drag as note (creates collapsed math-note on canvas drop)
      if (!drag) {
        const fileChip = target.closest('.ref-chip:not(.ref-chip-annotation)') as HTMLElement
        if (fileChip) {
          const filePath = fileChip.dataset.path || ''
          const token = filePath ? `file:${filePath}` : (fileChip.dataset.token || '')
          const fileUrl = fileChip.dataset.url || ''
          const clone = fileChip.cloneNode(true) as HTMLElement
          clone.querySelectorAll('.ref-chip-preview').forEach(el => el.remove())
          const label = clone.textContent?.trim() || 'file'
          // Fetch file content from URL for the drop (async, updates content before drop)
          // Resolve absolute image paths in the markdown; warn about relative paths
          let fileContent = label
          if (fileUrl) {
            fetch(fileUrl).then(r => r.ok ? r.text() : label).then(async (text) => {
              const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
              let resolved = text
              let hasUnresolved = false
              const uploads: Promise<void>[] = []
              let match: RegExpExecArray | null
              while ((match = imgRe.exec(text)) !== null) {
                const imgPath = match[2]
                if (imgPath.startsWith('http')) continue
                if (!imgPath.startsWith('/')) { hasUnresolved = true; continue }
                uploads.push((async () => {
                  try {
                    const readRes = await fetch(`/api/read-file?path=${encodeURIComponent(imgPath)}`)
                    if (!readRes.ok) { hasUnresolved = true; return }
                    const blob = await readRes.blob()
                    const fd = new FormData()
                    fd.append('file', blob, imgPath.split('/').pop() || 'image.png')
                    const upRes = await fetch(`${FLEET_API}/api/upload`, { method: 'POST', body: fd })
                    if (!upRes.ok) { hasUnresolved = true; return }
                    const { url } = await upRes.json()
                    resolved = resolved.split(`](${imgPath})`).join(`](${FLEET_API}${url})`)
                  } catch { hasUnresolved = true }
                })())
              }
              await Promise.all(uploads)
              if (hasUnresolved) {
                resolved += '\n\n⚠️ Some embedded images couldn\'t be resolved. Drag the containing folder instead of the file to include all images.'
              }
              if (dragRef.current) dragRef.current.content = resolved
            }).catch(e => console.warn('[fleet-chat] file content resolve failed:', e.message))
          }
          const chatLine = fileChip.closest('[data-msg-from]') as HTMLElement | null
          drag = {
            pillId: null, pillType: filePath ? 'doc' : 'file', value: token,
            displayName: label, color: '#9370db',
            content: fileContent, sourceAgent: chatLine?.dataset.msgFrom || undefined,
            filePath, fileUrl,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Agent nick → drag as agent filter pill
      if (!drag) {
        const nickEl = target.closest('.agent-nick') as HTMLElement
        if (nickEl) {
          const agentId = nickEl.dataset.agentId || ''
          const agentName = names[agentId] || agentId.replace('fleet:', '')
          drag = {
            pillId: null, pillType: 'agent' as any, value: agentName,
            displayName: agentName, color: '#7a9ec8',
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      if (!drag) return

      e.stopImmediatePropagation()
      e.preventDefault()
      dragRef.current = drag
      downTargetEl = target

      // Use shared drag coordinator instead of per-drag capture listeners
      dragCoordinator.claim(onPointerMove, onPointerUp)
    }

    function onPointerMove(e: PointerEvent) {
      const drag = dragRef.current
      if (!drag) return
      // stopImmediatePropagation/preventDefault handled by dragCoordinator
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.started) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
        drag.started = true
        const pagePos = clientPointToPage(editor, { x: e.clientX, y: e.clientY }, viewportId)
        const pillId = createShapeId()
        editor.createShape({
          id: pillId,
          type: 'fleet-pill' as any,
          x: pagePos.x - 35,
          y: pagePos.y - 9,
          props: {
            w: 70, h: 18,
            pillType: drag.pillType,
            value: drag.value,
            displayName: drag.displayName,
            color: drag.color,
          },
          meta: {
            ...(drag.sourceAgent ? { sourceAgent: drag.sourceAgent } : {}),
            ...(drag.filePath ? { filePath: drag.filePath } : {}),
            ...(drag.fileUrl ? { fileUrl: drag.fileUrl } : {}),
          },
        })
        drag.pillId = pillId as unknown as string
        // Reset tldraw's state machine via API — avoids cancelling the real pointer stream.
        editor.cancel()
      }
      if (drag.pillId) {
        const pagePos = clientPointToPage(editor, { x: e.clientX, y: e.clientY }, viewportId)
        editor.updateShape({
          id: drag.pillId as any,
          type: 'fleet-pill' as any,
          x: pagePos.x - 35,
          y: pagePos.y - 9,
        })
      }

      // Membrane handoff: when pointer leaves the chat, move the pill
      // from the panel editor to the main editor (and vice versa)
      const isMembraneType = drag.pillType === 'doc' || drag.pillType === 'annotation' || drag.pillType === 'file'
      if (drag.started && isMembraneType && drag.pillId) {
        const mainEditor = (window as any).__tldraw_editor__ as any
        const chatEl = logEl!.closest('[data-shape-id]') as HTMLElement | null
        const chatRect = chatEl?.getBoundingClientRect()
        const outside = chatRect && (
          e.clientX < chatRect.left || e.clientX > chatRect.right ||
          e.clientY < chatRect.top || e.clientY > chatRect.bottom
        )

        if (mainEditor && mainEditor !== editor) {
          const onMain = !!(drag as any)._onMain
          if (outside && !onMain) {
            // Handoff: panel → main
            try { editor.deleteShapes([drag.pillId as any]) } catch {}
            const mainPos = clientPointToPage(mainEditor, { x: e.clientX, y: e.clientY })
            mainEditor.createShape({
              id: drag.pillId as any,
              type: 'fleet-pill' as any,
              x: mainPos.x - 5,
              y: mainPos.y - 5,
              props: {
                w: 10, h: 10,
                pillType: drag.pillType,
                value: drag.value,
                displayName: drag.displayName,
                color: drag.color,
              },
              meta: {
                ...(drag.sourceAgent ? { sourceAgent: drag.sourceAgent } : {}),
                ...(drag.filePath ? { filePath: drag.filePath } : {}),
                ...(drag.fileUrl ? { fileUrl: drag.fileUrl } : {}),
              },
            })
            ;(drag as any)._onMain = true
          } else if (!outside && onMain) {
            // Handoff back: main → panel
            try { mainEditor.deleteShapes([drag.pillId as any]) } catch {}
            const panelPos = clientPointToPage(editor, { x: e.clientX, y: e.clientY }, viewportId)
            editor.createShape({
              id: drag.pillId as any,
              type: 'fleet-pill' as any,
              x: panelPos.x - 35,
              y: panelPos.y - 9,
              props: {
                w: 70, h: 18,  // chip form inside panel
                pillType: drag.pillType,
                value: drag.value,
                displayName: drag.displayName,
                color: drag.color,
              },
            })
            ;(drag as any)._onMain = false
          } else if (onMain) {
            // Move on main editor
            const mainPos = clientPointToPage(mainEditor, { x: e.clientX, y: e.clientY })
            mainEditor.updateShape({
              id: drag.pillId as any,
              type: 'fleet-pill' as any,
              x: mainPos.x - 5,
              y: mainPos.y - 5,
            })
            // Skip the panel updateShape below
            return
          }
        }
      }

      // Membrane glow: when dragging an annotation/doc pill near the fleet-chat edge
      if (drag.started && (drag.pillType === 'annotation' || drag.pillType === 'doc')) {
        const shapeEl = logEl!.closest('.fleet-shape') as HTMLElement | null
        if (shapeEl) {
          const rect = shapeEl.getBoundingClientRect()
          const edgeDist = Math.min(
            e.clientX - rect.left, rect.right - e.clientX,
            e.clientY - rect.top, rect.bottom - e.clientY,
          )
          const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                         e.clientY >= rect.top && e.clientY <= rect.bottom
          if (inside && edgeDist < 60) {
            const intensity = Math.max(0, 1 - edgeDist / 60)
            shapeEl.style.boxShadow = `0 0 ${12 + intensity * 12}px rgba(59, 130, 246, ${0.1 + intensity * 0.35})`
          } else {
            shapeEl.style.boxShadow = ''
          }
        }
      }
    }

    function onPointerUp(e: PointerEvent) {
      // Coordinator handles listener cleanup and stopImmediatePropagation
      const drag = dragRef.current
      if (!drag) return
      // Clear membrane glow
      const shapeEl = logEl!.closest('.fleet-shape') as HTMLElement | null
      if (shapeEl) shapeEl.style.boxShadow = ''
      dragRef.current = null
      if (!drag.started) {
        // No drag happened = a TAP on a draggable chip/link. This handler claimed
        // the pointer (capture-phase stopImmediatePropagation on pointerdown), so
        // the element's own click handler never ran. On mouse the browser still
        // synthesizes a `click` afterward (the chip opens); on touch/stylus it
        // does NOT, so the tap was dead. Re-fire the element's click so a tap does
        // exactly what a mouse click does — same action, just the touch pointing
        // device (Skip's pointer-device-parity rule). Touch/pen only: mouse keeps
        // its native click, so no double-open.
        if ((e.pointerType === 'touch' || e.pointerType === 'pen') && downTargetEl) {
          downTargetEl.click()
        }
        downTargetEl = null
        return
      }
      downTargetEl = null
      if (!drag.pillId) return

      const onMain = !!(drag as any)._onMain
      const mainEditor = (window as any).__tldraw_editor__ as any
      const dropEditor = (onMain && mainEditor) ? mainEditor : editor
      const pagePos = clientPointToPage(dropEditor, { x: e.clientX, y: e.clientY }, onMain ? undefined : viewportId)
      dropPillOnTarget(dropEditor, drag.pillId as any, drag.value, pagePos, drag.content)
      try { dropEditor.deleteShapes([drag.pillId as any]) } catch {}
    }

    document.addEventListener('pointerdown', onPointerDown, { capture: true })

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
      // Release coordinator if this component unmounts during a drag
      if (dragRef.current) dragCoordinator.release()
    }
  }, [chatLogEl, editor, viewportId])

  // --- chatInsertBus listener: content drops insert into textarea ---
  useEffect(() => {
    const handler = (e: Event) => {
      const { chatId, text, owner } = (e as CustomEvent).detail
      if (chatId && chatId !== shape.id) return
      if (owner && !sendTargetsRef.current.includes(owner)) return
      const ta = inputRef.current as HTMLTextAreaElement | null
      if (!ta) return
      const pos = ta.selectionStart ?? ta.value.length
      const before = ta.value.slice(0, pos)
      const after = ta.value.slice(pos)
      const insert = (before && !before.endsWith('\n') ? '\n' : '') + text + (after && !after.startsWith('\n') ? '\n' : '')
      ta.value = before + insert + after
      ta.focus()
    }
    const filterHandler = (e: Event) => {
      const { chatId } = (e as CustomEvent).detail
      if (chatId !== shape.id) return
      setFilterOpen(false)
      setFilterOpenByPill(false)
    }
    chatInsertBus.addEventListener('insert', handler)
    chatInsertBus.addEventListener('filter-applied', filterHandler)
    return () => {
      chatInsertBus.removeEventListener('insert', handler)
      chatInsertBus.removeEventListener('filter-applied', filterHandler)
    }
  }, [shape.id])

  // Auto-focus textarea + start voice when a bullet tap targets this chat
  useEffect(() => {
    if (activeBullets.length === 0) return
    const myTargets = sendTargetsRef.current
    const relevant = activeBullets.some(b => b.owner && myTargets.includes(b.owner))
    if (!relevant) return
    const ta = inputRef.current as HTMLTextAreaElement | null
    if (!ta || ta.getBoundingClientRect().width === 0) return
    ta.focus()
    if (!isRecording()) toggleRecording()
  }, [activeBullets])

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
        ref={shapeContainerRef}
        className="fleet-shape fleet-chat-shape"
        style={{
          ...fleetStyleVars,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 0,
          fontSize: 11,
          overflow: 'visible',
          fontFamily: "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
          fontWeight: 300,
          lineHeight: 1.4,
          position: 'relative',
        }}
      >
        {/* Close, filter edit, and layout buttons */}
        <div className="fleet-btn-group" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="fleet-close-btn"
            onPointerUp={(e) => {
              e.stopPropagation()
              editor.deleteShapes([shape.id])
            }}
          >
            ×
          </button>
          <button
            className="fleet-layout-btn"
            onPointerUp={(e) => {
              e.stopPropagation()
              // Must be in select tool for resize handles to appear.
              // The HUD mirrors the main editor's tool (hand/browse/etc),
              // so switch explicitly before selecting.
              editor.setCurrentTool('select')
              editor.select(shape.id)
            }}
            title="Resize / move"
          >
            ⊞
          </button>
          <button
            className="fleet-filter-btn"
            onClick={() => setFilterOpen(prev => !prev)}
            title="Edit traffic filter"
          >
            {filterOpen
              ? <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 2h12v9H6l-4 3v-3z"/></svg>
              : <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 2h14M3 7h10M6 12h4"/></svg>
            }
          </button>
          <button
            className={`fleet-traffic-mode-btn${quietTraffic ? ' fleet-traffic-mode-btn-active' : ''}`}
            onPointerDown={stopEventPropagation}
            // text-label button ('q'/'t'): onPointerUp so a touch tap fires (a
            // text label in the canvas gets no synthesized click on iPad, same
            // class as the DM/All toggle); pointerup covers mouse too.
            onPointerUp={(e) => {
              stopEventPropagation(e)
              editor.updateShape({
                id: shape.id,
                type: shape.type,
                props: { trafficMode: quietTraffic ? 'normal' : 'quiet' },
              })
            }}
            title={quietTraffic ? 'Quiet traffic: tools hidden' : 'Normal traffic: tools visible'}
          >
            {quietTraffic ? 'q' : 't'}
          </button>
        </div>

        {/* Filter editor — full overlay showing DNF expression */}
        {filterOpen && (
          <FilterOverlay
            filter={filter}
            shapeId={shape.id}
            editor={editor}
            onClose={() => setFilterOpen(false)}
            externalPillOver={pillOver}
            agents={agents}
            sendTargets={sendTargets}
          />
        )}

        {/* Messages — Virtuoso owns the scroll container via components.Scroller.
            Dropping customScrollParent: with Virtuoso-owned scroll,
            initialTopMostItemIndex is reliably honored and the previous
            "start at top" / RAF pin loop / scroll race is gone. */}
        {/* Keep Virtuoso ALWAYS mounted. A momentary chatMessages→0 (a transient
            empty, e.g. during a reconnect blip) must NOT swap the scroller out
            for a placeholder div — that unmounts Virtuoso and remounts it fresh
            when messages return, which re-runs initialTopMostItemIndex and snaps
            scroll to the bottom: the "bounce". allItems always carries the
            __status__ row, so Virtuoso is never truly empty; the empty-state hint
            is a non-interactive overlay (top-aligned + same padding as before, so
            it renders in the same place), not a replacement of the list. The
            wrapper div is the minimal means to position that overlay. */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
          <Virtuoso
            ref={virtuosoRef}
            data={allItems}
            style={{ flex: 1, minHeight: 0 }}
            initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
            // Virtuoso owns the actual scrolling (it's virtualization-aware, so it
            // reaches the TRUE list bottom); our scroll-intent just gates WHEN it
            // follows. Follow on new content unless the user deliberately scrolled up.
            followOutput={() => (!userScrolledUpRef.current || hardLockedRef.current) ? 'auto' : false}
            startReached={() => {
              if (chatLogEl && userScrolledUpRef.current) expandRenderedHistory(chatLogEl)
            }}
            // Generous enough to absorb the Virtuoso Footer (suggestion/thinking
            // status, ~40px): scrollToIndex(LAST) aligns the last DATA item, so
            // the footer sits just below the viewport and "true bottom" is ~40px
            // past the last item. With the tight 24px value, that residual read
            // as "not at bottom" and surfaced the ⇣ arrow even though the user
            // never scrolled. 120 (the long-proven value) keeps follow engaged
            // through the footer. Safe because follow-intent is owned by the
            // scrollTop-delta handler, not inferred from this gap.
            atBottomThreshold={120}
            // Fires whenever Virtuoso's computed total list height changes —
            // catches in-place item growth (markdown/font/image late-render
            // adds pixels to existing items) which doesn't tick items.length
            // and so isn't caught by force-pin-on-item-grow.
            totalListHeightChanged={(h) => {
              const diag = probe.isEnabled('chat')
              const t0 = diag ? performance.now() : 0
              const prev = prevTotalHeightRef.current
              prevTotalHeightRef.current = h
              const grew = h > prev
              const follow = !userScrolledUpRef.current || hardLockedRef.current
              const el = chatLogEl
              if (grew && follow) {
                // Following + content grew → re-pin to the true bottom with the
                // ONE pin (scrollToIndex via pinHard), which is virtualization-
                // aware and re-measures the last item. We deliberately do NOT
                // slam `el.scrollTop = el.scrollHeight`: when the status row
                // shrinks a frame later, scrollHeight is transiently taller than
                // the real content and the raw slam strands the tail in stale
                // blank space (the 224px-short / "bounce"). pinHard targets the
                // last ITEM, so it can't scroll into space that isn't there.
                if (diag) {
                  const gapBeforeGlue = el ? Math.round(el.scrollHeight - (el.scrollTop + el.clientHeight)) : null
                  log.debug('chat-scroll', 'growth → pin', { gapBeforeGlue })
                }
                pinHard()
                if (diag) {
                  requestAnimationFrame(() => {
                    const el2 = chatLogEl
                    const gapAfter = el2 ? Math.round(el2.scrollHeight - (el2.scrollTop + el2.clientHeight)) : null
                    log.debug('chat-scroll', 'TRACE after pin', { gapAfter })
                  })
                }
              }
              // Diagnostics only — gated behind the probe flag so the per-height-
              // change forced-layout reads + POSTs don't run in normal use (kept
              // for when scroll is being debugged again).
              if (diag) {
                const gapNow = el ? Math.round(el.scrollHeight - (el.scrollTop + el.clientHeight)) : null
                if (grew) {
                  log.debug('chat-scroll', 'TRACE content grew', { prev, h, gapNow, follow, scrolledUp: userScrolledUpRef.current, hardLocked: hardLockedRef.current })
                }
                const dt = performance.now() - t0
                if (dt > 1 || grew) {
                  probe.record('chat', 'chat-virtuoso-height-change', dt, {
                    prev,
                    h,
                    grew,
                    follow,
                    gapNow,
                    itemCount: allItems.length,
                  })
                }
              }
            }}
            atBottomStateChange={(atBottom) => {
              const t0 = probe.isEnabled('chat') ? performance.now() : 0
              const el = chatLogEl
              const gap = el ? (el.scrollHeight - (el.scrollTop + el.clientHeight)) : null
              if (isAtBottomRef.current !== atBottom) {
                log.debug('chat-scroll', atBottom ? 'pinned to bottom' : 'left bottom', {
                  scrollTop: el?.scrollTop,
                  scrollHeight: el?.scrollHeight,
                  clientHeight: el?.clientHeight,
                  gap,
                  items: allItems.length,
                  scrolledUp: userScrolledUpRef.current,
                  hardLocked: hardLockedRef.current,
                })
              }
              isAtBottomRef.current = atBottom
              setAtBottom(atBottom)
              // ADVISORY ONLY. Follow-intent is owned entirely by the scrollTop-
              // delta handler above; this callback must NOT write userScrolledUpRef.
              // The old code reset it to false on every atBottom=true — but with
              // atBottomThreshold=120, a reflow that momentarily brought the gap
              // under 120 while the user was reading flipped intent back ON and
              // the next message re-yanked them down (the "shot back down" bug).
              // Resume-follow now happens only when the user genuinely scrolls to
              // the bottom (handled in the delta handler). We also do NOT re-pin
              // on a spurious "left bottom": that caused an infinite bounce when
              // content barely exceeds the viewport. Hard-lock is the one
              // exception — it means "always pinned".
              if (!atBottom && hardLockedRef.current) {
                requestAnimationFrame(pinHard)
              }
              if (probe.isEnabled('chat')) {
                const dt = performance.now() - t0
                if (dt > 1) {
                  probe.record('chat', 'chat-at-bottom-change', dt, {
                    atBottom,
                    gap,
                    itemCount: allItems.length,
                  })
                }
              }
            }}
            itemContent={(_index, item) => (
              item?._status ? (
                <div>
                  <ThinkingStatus
                    thinkingAgents={thinkingAgents}
                    compactingAgents={compactingAgents}
                    contextPercent={contextPercent}
                    hibernatingAgents={hibernatingAgents}
                    ctx={ctx}
                    agents={agents}
                    itemCount={rawItems.length}
                    escalationState={escalationState}
                    suggestions={fallbackSuggestions}
                  />
                </div>
              ) : item?._suggestions ? (
                <SuggestionRow chips={item._suggestions} ctx={ctx} />
              ) : (
                <div className={'chat-row-wrap' + (item?._divider ? ' queue-divider' : '')}>
                  <ChatMessageRow html={item.html} postProcess={postProcess} itemKey={item.key} expandedRowsRef={expandedRowsRef} />
                </div>
              )
            )}
            computeItemKey={(_index, item) => item?.key ?? _index}
            components={{
              Scroller: ChatLogScroller,
            }}
          />
          {chatMessages.length === 0 && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'flex-start',
                padding: '20px 8px',
                pointerEvents: 'none',
                opacity: isImpossibleFilter ? 0.6 : 0.3,
                textAlign: 'center',
                fontSize: 10,
                color: isImpossibleFilter ? 'var(--red, #e55)' : undefined,
              }}
            >
              {isImpossibleFilter
                ? '⚠ Filter matches no known agents'
                : filter.length > 0 ? 'No messages' : 'No filter set'}
            </div>
          )}
        </div>

        {/* Terminal card overlay — shown on hover or when pinned; outside scroll container */}
        {(termCardPinnedId || termCardHoverId) && (() => {
          const activeId = termCardPinnedId ?? termCardHoverId!
          return (
            <TerminalCard
              key={`terminal-${activeId}`}
              agentId={activeId}
              agentName={agentNames[activeId] || activeId.replace('fleet:', '')}
              pinned={!!termCardPinnedId}
              onMouseEnter={() => { if (termCardHideTimerRef.current) { clearTimeout(termCardHideTimerRef.current); termCardHideTimerRef.current = null } }}
              onMouseLeave={() => { if (!termCardPinnedId) { termCardHideTimerRef.current = setTimeout(() => setTermCardHoverId(null), 200) } }}
              onDismiss={() => dismissTermCard(activeId)}
            />
          )
        })()}

        {/* Input — outside scroll container, flex sibling with flexShrink:0 */}
        <div
          ref={inputAreaRef}
          className="fleet-chat-input-area"
          style={{
            borderTop: '1px solid rgba(128, 128, 128, 0.15)',
            padding: 4,
            flexShrink: 0,
            position: 'relative',
          }}
        >
          {/* Terminal hover pane — floats below the input area when the terminal icon is hovered or pinned */}
          {(termHoverVisible || termHoverPinned) && hoverTargetAgentId && (
            <TerminalHoverPane
              agentId={hoverTargetAgentId}
              pinned={termHoverPinned}
              anchorRef={inputAreaRef}
              onDismiss={() => { setTermHoverPinned(false); setTermHoverVisible(false) }}
              onMouseEnter={() => {
                if (termHideTimerRef.current) {
                  clearTimeout(termHideTimerRef.current)
                  termHideTimerRef.current = null
                }
              }}
              onMouseLeave={() => setTermHoverVisible(false)}
            />
          )}
          {/* Skill-state hover popover — viewport-fixed, anchored to the hovered agent name */}
          {skillHover && (
            <SkillHoverPane
              agentId={skillHover.agentId}
              agentName={skillHover.agentName}
              anchorRect={skillHover.rect}
              onMouseEnter={() => { if (skillHideTimerRef.current) { clearTimeout(skillHideTimerRef.current); skillHideTimerRef.current = null } }}
              onMouseLeave={() => setSkillHover(null)}
            />
          )}
          <SendHint
            filter={filter}
            sendTargets={sendTargets}
            inputRef={inputRef}
          />
          {deadTargetAgent && (
            <div
              className="fleet-dead-agent-notice"
              onPointerDown={stopEventPropagation}
            >
              <span>{deadTargetAgent.name} is dead</span>
              <span
                className="fleet-dead-resurrect"
                // text <span>: onPointerUp so a finger/stylus tap fires (no
                // synthesized click on touch); pointerup covers mouse too.
                onPointerUp={(e) => {
                  stopEventPropagation(e as any)
                  fetch(`/api/agents/${encodeURIComponent(deadTargetAgent.id)}/resurrect`, { method: 'POST' })
                }}
              >resurrect?</span>
            </div>
          )}
          <div style={{ position: 'relative' }}>
            {/* Ghost drop preview — purple lozenges per dragged file (picture
                glyph for images, document glyph otherwise) shown while a file is
                dragged over the field. */}
            {dragLozenges && (
              <div className="fleet-drop-ghost">
                {dragLozenges.map((kind, i) => (
                  <span key={i} className="fleet-drop-lozenge">
                    {kind === 'image' ? (
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                        <circle cx="5.5" cy="6" r="1.3" fill="currentColor" stroke="none" />
                        <path d="M2 12 L6 8 L9 11 L11 9 L14 12" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                        <path d="M4 1.5 H9.5 L13 5 V14 a0.5 0.5 0 0 1 -0.5 0.5 H4 a0.5 0.5 0 0 1 -0.5 -0.5 V2 a0.5 0.5 0 0 1 0.5 -0.5 Z" strokeLinejoin="round" />
                        <path d="M9.5 1.5 V5 H13" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                ))}
              </div>
            )}
            {/* Highlight underlay — mirrors textarea text, highlights <<ref>> tokens */}
            <InputHighlightUnderlay inputRef={inputRef} />
            {/* Left gutter control cluster — terminal peek, traffic toggle, and
                follow/hard-lock ("magnet") button laid out as a tight flex row
                so they sit adjacent regardless of the traffic label's width
                (no dead gap). Order is set via CSS `order`, not DOM order. */}
            <div className="fleet-composer-gutter">
            {/* Unified follow / jump-to-bottom control. One button, fixed here:
                  - off bottom → ⇣ arrow; click jumps to bottom (does NOT change
                    follow mode — you return to the bottom first, then it's a
                    toggle again),
                  - at bottom → follow-mode toggle (horseshoe); open = smart-follow,
                    engaged (field lines) = hard-lock (always pinned).
                This replaces the separate floating ⇣ arrow. */}
            <button
              className={`fleet-hardlock-toggle${!atBottom ? ' jump-mode' : ''}`}
              onPointerDown={stopEventPropagation}
              onClick={(e) => {
                stopEventPropagation(e as any)
                if (!atBottom) {
                  // Off bottom: this click only returns to the bottom.
                  scrollToBottom()
                  return
                }
                // At bottom: toggle follow mode.
                setHardLocked(prev => {
                  const next = !prev
                  if (next) requestAnimationFrame(pinHard)
                  return next
                })
              }}
              title={!atBottom
                ? 'Scroll to bottom'
                : hardLocked
                  ? 'Hard-locked — always pinned to bottom (click to release)'
                  : 'Smart scroll — click to hard-lock to bottom'}
            >
              {!atBottom ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 1 L6 10 M2.5 6.5 L6 10 L9.5 6.5"/>
                </svg>
              ) : (
                <svg width="10" height="14" viewBox="0 0 10 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 9 L2 4 Q2 1 5 1 Q8 1 8 4 L8 9"/>
                  {hardLocked && <>
                    <path d="M1 11 Q2.5 10 5 11 Q7.5 12 9 11" strokeWidth="1"/>
                    <path d="M2 13 Q3.5 12 5 13 Q6.5 14 8 13" strokeWidth="0.8"/>
                  </>}
                </svg>
              )}
            </button>
            {/* Terminal peek icon — hover to show agent's tmux output. Hidden when no targeted agent has a tmux session. */}
            {hoverTargetAgentId && (
              <button
                className={`fleet-terminal-icon${termHoverPinned ? ' active' : ''}`}
                onPointerDown={stopEventPropagation}
                onClick={(e) => {
                  stopEventPropagation(e as any)
                  setTermHoverPinned(p => !p)
                  setTermHoverVisible(true)
                }}
                onMouseEnter={() => {
                  if (termHideTimerRef.current) {
                    clearTimeout(termHideTimerRef.current)
                    termHideTimerRef.current = null
                  }
                  setTermHoverVisible(true)
                }}
                onMouseLeave={() => {
                  if (!termHoverPinned) {
                    termHideTimerRef.current = setTimeout(() => setTermHoverVisible(false), 80)
                  }
                }}
                title={termHoverPinned ? 'Click to unpin terminal' : 'Hover to peek · click to pin'}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="1" width="8" height="8" rx="1.5"/>
                  <polyline points="2.5,4 4.5,6 2.5,8"/>
                  <line x1="5.5" y1="8" x2="7.5" y2="8"/>
                </svg>
              </button>
            )}
            <button
              className={`fleet-composer-traffic-toggle fleet-composer-traffic-toggle-${composerTrafficMode}`}
              onPointerDown={(e) => {
                stopEventPropagation(e)
                trafficTapRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
              }}
              onPointerUp={(e) => {
                // Drive the cycle from pointerup, not click: on touch a tap on
                // this text label never synthesizes a `click` (pointerdown +
                // pointerup fire, click does not), so an onClick handler is dead
                // on iPad. pointerup fires for both mouse and touch — one cycle
                // per interaction, no double-fire.
                stopEventPropagation(e)
                // Only a deliberate tap on THIS button cycles: the pointerdown
                // must have started here (same pointerId) and barely moved. A
                // stray touch or a scroll-drag that lifts off over the button has
                // no matching down (or drifted) → it must NOT change the filter.
                const down = trafficTapRef.current
                trafficTapRef.current = null
                if (!down || down.id !== e.pointerId) return
                if (Math.abs(e.clientX - down.x) > 16 || Math.abs(e.clientY - down.y) > 16) return
                if (!composerAgentLabel) return
                cycleComposerTrafficMode()
              }}
              disabled={!composerAgentLabel}
              title={!composerAgentLabel
                ? 'Choose an agent filter first'
                : composerTrafficMode === 'dm-quiet'
                  ? 'DM, tools hidden'
                  : composerTrafficMode === 'dm'
                    ? 'DM, tools visible'
                    : composerTrafficMode === 'agent'
                      ? 'All traffic for this agent'
                      : 'Custom filter; tap to switch to DM without tools'}
              aria-label="Cycle chat traffic filter"
            >
              {composerTrafficMode === 'dm-quiet'
                ? 'DM'
                : composerTrafficMode === 'dm'
                  ? 'DM ⚒'
                  : composerTrafficMode === 'agent'
                    ? 'All'
                    : 'Filter'}
            </button>
            </div>
            <ChatComposer
              sendTargets={sendTargets}
              agentNames={agentNames}
              onKeyboardSend={composerKeyboardSend}
              onVoiceSend={composerVoiceSend}
              onCommand={composerCommand}
              onKeyActivity={composerKeyActivity}
              onDrop={composerDrop}
              onDragOver={composerDragOver}
              inputRef={inputRef as any}
              isTouchDevice={_isTouchDevice}
              placeholder=""
              style={{
                width: '100%',
                background: 'transparent',
                border: '1px solid rgba(128, 128, 128, 0.15)',
                borderRadius: 4,
                padding: '4px 58px 4px 8px',
                fontSize: _isPhone ? 16 : 11,
                color: 'inherit',
                outline: 'none',
                resize: 'none',
                lineHeight: 1.4,
                fontFamily: 'inherit',
                position: 'relative',
                zIndex: 1,
                fieldSizing: 'content',
                minHeight: 'calc(1.4em + 10px)',
                maxHeight: 200,
              } as any}
            />
          </div>
        </div>

      </div>
    </HTMLContainer>
  )
}

/**
 * Viewport-culling shell for FleetChatInner.
 *
 * All the expensive hooks (useFleetEvents, useFleetAgents, etc.) live inside
 * FleetChatInner. When the shape is off-screen we render a cheap transparent
 * placeholder instead, which unmounts FleetChatInner and tears down every
 * subscription. Shapes scrolled back into view remount and resubscribe — a
 * one-time cost that is far cheaper than re-rendering on every fleet event
 * while off-screen.
 */
const FleetChatComponent = memo(function FleetChatComponent({ shape }: { shape: any }) {
  const { w, h } = shape.props as { w: number; h: number }
  const isInViewport = useIsInViewport(shape.id)
  if (!isInViewport) {
    return <HTMLContainer id={shape.id}><div style={{ width: w, height: h }} /></HTMLContainer>
  }
  return <FleetChatInner shape={shape} />
}, (prev, next) => prev.shape.props === next.shape.props)


function SendHint({
  filter: _filter,
  sendTargets,
  inputRef,
}: {
  filter: [string, string][][]
  sendTargets: string[]
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  // kind: '' (hidden) | 'empty' (no text, show target) | 'newline' | 'enter'
  const [kind, setKind] = useState<'' | 'empty' | 'newline' | 'enter'>('')

  const hasTargets = sendTargets.length > 0

  const update = useCallback(() => {
    const el = inputRef.current as HTMLTextAreaElement | null
    const val = el?.value ?? ''
    if (!val) {
      setKind(hasTargets ? 'empty' : '')
      return
    }
    const pos = el!.selectionStart ?? val.length
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1
    const currentLine = val.slice(lineStart, pos)
    setKind(currentLine.endsWith(' ') ? 'newline' : 'enter')
  }, [hasTargets, inputRef])

  useEffect(() => {
    update()
  }, [hasTargets, update])

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

  if (kind === '') return null
  if (kind === 'newline') return <span className="fleet-chat-send-hint">↵ newline</span>

  // 'empty' and 'enter' both show the target list (with phase icons, mirroring the
  // agents panel). 'enter' prefixes the ↵ glyph; with no targets it's just ↵.
  const enterPrefix = kind === 'enter' ? '↵ ' : ''
  if (!hasTargets) return <span className="fleet-chat-send-hint">↵</span>

  const targets = sendTargets.map((t, i) => (
    <span key={t} className="send-hint-target" style={{ display: 'inline-flex', alignItems: 'center' }}>
      {i > 0 ? ' + ' : null}
      <AgentName name={t} />
    </span>
  ))

  return (
    <span className="fleet-chat-send-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
      {enterPrefix}→&nbsp;{targets}
    </span>
  )
}

/** Filter overlay — uses native click listeners to bypass tldraw event interception */
/** Simplify a DNF expression: dedup within groups, dedup identical groups, absorption */
function simplifyDnf(dnf: [string, string][][]): [string, string][][] {
  // Dedup within each AND group
  let groups = dnf.map(g => {
    const seen = new Set<string>()
    return g.filter(([r, l]) => {
      const key = `${r}\0${l}`
      if (seen.has(key)) return false
      seen.add(key); return true
    })
  })
  // Dedup identical OR groups
  const seenGroups = new Set<string>()
  groups = groups.filter(g => {
    const key = g.map(([r, l]) => `${r}\0${l}`).sort().join('\n')
    if (seenGroups.has(key)) return false
    seenGroups.add(key); return true
  })
  // Absorption: if group A ⊆ group B, drop B (A is less restrictive)
  return groups.filter((g, i) =>
    !groups.some((other, j) => i !== j && other.length < g.length &&
      other.every(([r, l]) => g.some(([gr, gl]) => gr === r && gl === l)))
  )
}

/** Build preview DNF: add a new term at andGroupIdx (AND) or as new OR clause (andGroupIdx < 0) */
function buildFilterPreview(
  filter: [string, string][][],
  role: string,
  value: string,
  andGroupIdx: number,
): [string, string][][] {
  const newTerm: [string, string] = [role, value]
  if (filter.length === 0) return [[newTerm]]
  // Already exists in the target group?
  if (andGroupIdx >= 0 && filter[andGroupIdx]) {
    if (filter[andGroupIdx].some(([r, l]) => r === role && l === value)) return filter
    const result = filter.map((cl, i) => i === andGroupIdx ? [...cl, newTerm] : cl)
    return simplifyDnf(result)
  }
  // New OR clause
  return simplifyDnf([...filter, [newTerm]])
}

export function FilterOverlay({
  filter,
  shapeId,
  editor,
  onClose,
  externalPillOver,
  agents,
  sendTargets,
}: {
  filter: [string, string][][]
  shapeId: any
  editor: any
  onClose: () => void
  externalPillOver?: { role: string; value: string; displayName: string } | null
  agents: any[]
  sendTargets: string[]
}) {
  // Native click delegation on document capture — bypasses tldraw completely
  const overlayRef = useRef<HTMLDivElement>(null)
  const viewportId = useVisibilityViewportId()
  const filterRef = useRef(filter)
  filterRef.current = filter
  const humanLabel = getHumanName() || getHumanId() || 'user'
  const activeAgentLabel = useMemo(() => {
    for (const clause of filter) {
      for (const [, label] of clause) {
        if (isNonHumanAgentLabel(agents, label)) return label
      }
    }
    for (const label of sendTargets) {
      if (isNonHumanAgentLabel(agents, label)) return label
    }
    return ''
  }, [agents, filter, sendTargets])
  const applyPreset = useCallback((preset: 'all' | 'dm' | 'agent') => {
    let nextFilter: [string, string][][] = []
    if (preset === 'dm' && activeAgentLabel) {
      nextFilter = buildFleetDmFilter(humanLabel, activeAgentLabel) as [string, string][][]
    } else if (preset === 'agent' && activeAgentLabel) {
      nextFilter = buildFleetAgentFilter(activeAgentLabel) as [string, string][][]
    }
    editor.updateShape({
      id: shapeId,
      type: 'fleet-chat',
      props: { filter: nextFilter, trafficMode: 'normal' },
    })
  }, [activeAgentLabel, editor, humanLabel, shapeId])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      const overlay = overlayRef.current
      if (!overlay || !overlay.contains(target)) return

      const preset = target.closest('.fleet-filter-preset') as HTMLElement | null
      if (preset) {
        const mode = preset.dataset.preset as 'all' | 'dm' | 'agent' | undefined
        if (mode) applyPreset(mode)
        return
      }

      // Remove term ×
      const termX = target.closest('.fleet-filter-term-x') as HTMLElement
      if (termX) {
        const ci = parseInt(termX.dataset.clause || '0', 10)
        const ti = parseInt(termX.dataset.term || '0', 10)
        const f = filterRef.current
        const newFilter = f.map((cl, i) => {
          if (i !== ci) return cl
          return cl.filter((_, j) => j !== ti)
        }).filter(cl => cl.length > 0)
        editor.updateShape({
          id: shapeId,
          type: 'fleet-chat',
          props: { filter: newFilter },
        })
        return
      }

      // Clear all
      if (target.closest('.fleet-filter-clear')) {
        editor.updateShape({
          id: shapeId,
          type: 'fleet-chat',
          props: { filter: [] },
        })
        return
      }
    }
    document.addEventListener('click', handleClick, { capture: true })
    return () => document.removeEventListener('click', handleClick, { capture: true })
  }, [shapeId, editor, onClose, applyPreset])

  // Detect pill hovering over the shape — show two-pane drop preview
  const fleetPillCount = useFleetPillCount(editor)
  const pillOverKey = useValue('filter-pill-over', () => {
    if (fleetPillCount === 0) return ''
    const pills = editor.getCurrentPageShapes().filter((s: any) => s.type === 'fleet-pill')
    if (pills.length === 0) return ''
    const pill = pills[0] as any
    const pb = editor.getShapePageBounds(pill.id)
    if (!pb) return ''
    const cx = pb.x + pb.w / 2
    const cy = pb.y + pb.h / 2
    const shapeBounds = editor.getShapePageBounds(shapeId)
    if (!shapeBounds || cx < shapeBounds.x || cx > shapeBounds.x + shapeBounds.w ||
        cy < shapeBounds.y || cy > shapeBounds.y + shapeBounds.h) return ''
    return `${pill.props.value}\0${pill.props.displayName}`
  }, [editor, shapeId, fleetPillCount])

  const internalPillOver = useMemo(() => {
    if (!pillOverKey) return null
    const [value, displayName] = pillOverKey.split('\0')
    return { value, displayName }
  }, [pillOverKey])
  const pillOver = externalPillOver ?? internalPillOver

  // AND-group hover detection via pill shape position vs DOM bounding rects.
  // Pointer events don't work during drag because FleetAgentsShape holds pointer capture.
  // Instead, poll the pill's screen position each frame and check against clause box rects.
  const toPaneRef = useRef<HTMLDivElement>(null)
  const fromPaneRef = useRef<HTMLDivElement>(null)
  const replaceZoneRef = useRef<HTMLDivElement>(null)

  // AND-group hover detection with hysteresis to prevent oscillation.
  // Once hovering a group, stick to it until the pill clearly leaves (EXIT_PAD away).
  // Enter a group with ENTER_PAD tolerance.
  const lastGroupRef = useRef<{ pane: string; idx: number; rect: DOMRect } | null>(null)

  const hoveredGroup = useValue('filter-hovered-group', () => {
    if (!pillOver) { lastGroupRef.current = null; return null }
    if (fleetPillCount === 0) { lastGroupRef.current = null; return null }
    const pills = editor.getCurrentPageShapes().filter((s: any) => s.type === 'fleet-pill')
    if (pills.length === 0) { lastGroupRef.current = null; return null }
    const pill = pills[0]
    const pb = editor.getShapePageBounds(pill.id)
    if (!pb) return null
    const screenPt = pagePointToClient(editor, { x: pb.x + pb.w / 2, y: pb.y + pb.h / 2 }, viewportId)

    const ENTER_PAD = 8
    const EXIT_PAD = 30

    // If we have a sticky group, check if pill is still near it
    const last = lastGroupRef.current
    if (last) {
      const r = last.rect
      if (screenPt.x >= r.x - EXIT_PAD && screenPt.x <= r.x + r.width + EXIT_PAD &&
          screenPt.y >= r.y - EXIT_PAD && screenPt.y <= r.y + r.height + EXIT_PAD) {
        return { pane: last.pane as 'to' | 'from', idx: last.idx }
      }
      lastGroupRef.current = null
    }

    // Check replace zone first (left third)
    const replaceEl = replaceZoneRef.current
    if (replaceEl) {
      const r = replaceEl.getBoundingClientRect()
      if (screenPt.x >= r.x - ENTER_PAD && screenPt.x <= r.x + r.width + ENTER_PAD &&
          screenPt.y >= r.y - ENTER_PAD && screenPt.y <= r.y + r.height + ENTER_PAD) {
        lastGroupRef.current = { pane: 'replace', idx: -1, rect: DOMRect.fromRect(r) }
        return { pane: 'replace' as any, idx: -1 }
      }
    }

    // Check each pane
    for (const [pane, ref] of [['to', toPaneRef], ['from', fromPaneRef]] as const) {
      const paneEl = ref.current
      if (!paneEl) continue
      const paneRect = paneEl.getBoundingClientRect()
      if (screenPt.x < paneRect.x || screenPt.x > paneRect.x + paneRect.width ||
          screenPt.y < paneRect.y || screenPt.y > paneRect.y + paneRect.height) continue
      // Inside this pane — check clause boxes
      const clauseEls = paneEl.querySelectorAll('.fleet-filter-and-group')
      let foundIdx = -1
      for (let i = 0; i < clauseEls.length; i++) {
        const r = clauseEls[i].getBoundingClientRect()
        if (screenPt.x >= r.x - ENTER_PAD && screenPt.x <= r.x + r.width + ENTER_PAD &&
            screenPt.y >= r.y - ENTER_PAD && screenPt.y <= r.y + r.height + ENTER_PAD) {
          foundIdx = i
          lastGroupRef.current = { pane, idx: i, rect: DOMRect.fromRect(r) }
          break
        }
      }
      return { pane, idx: foundIdx }
    }
    return null
  }, [editor, pillOver, fleetPillCount])

  // Compute preview DNF for each pane based on hovered AND group
  const toGroupIdx = hoveredGroup?.pane === 'to' ? hoveredGroup.idx : -1
  const fromGroupIdx = hoveredGroup?.pane === 'from' ? hoveredGroup.idx : -1

  const toPreview = useMemo(() => {
    if (!pillOver) return null
    return buildFilterPreview(filter, 'to', pillOver.value, toGroupIdx)
  }, [pillOver, filter, toGroupIdx])

  const fromPreview = useMemo(() => {
    if (!pillOver) return null
    return buildFilterPreview(filter, 'from', pillOver.value, fromGroupIdx)
  }, [pillOver, filter, fromGroupIdx])

  // Highlight index: if hovering a group, that group; if new OR clause, the last group
  const toHighlightIdx = toGroupIdx >= 0 ? toGroupIdx : (toPreview && toPreview.length > filter.length ? toPreview.length - 1 : -1)
  const fromHighlightIdx = fromGroupIdx >= 0 ? fromGroupIdx : (fromPreview && fromPreview.length > filter.length ? fromPreview.length - 1 : -1)

  // Publish preview state so dropPillOnTarget can apply the right filter on release.
  // useLayoutEffect (not useEffect) — runs before the browser paint so filterDropPreview
  // is always current when pointerup fires. useEffect runs after paint, creating a window
  // where the preview is visible but activePaneRole is still null/stale.
  useLayoutEffect(() => {
    if (pillOver) {
      const replacePreview: [string, string][][] = [[['to', pillOver.value]], [['from', pillOver.value]]]
      filterDropPreview.shapeId = shapeId
      filterDropPreview.toPreview = toPreview
      filterDropPreview.fromPreview = fromPreview
      filterDropPreview.replacePreview = replacePreview
      filterDropPreview.activePaneRole = (hoveredGroup?.pane as any) ?? null
    } else if (filterDropPreview.shapeId === shapeId) {
      // Only clear if WE are the current owner. If another chat has taken
      // ownership in the interim (multiple FilterOverlays mounted), leave its
      // state alone — otherwise this effect re-running on Chat A would wipe
      // the preview Chat B just published, and the next pointerup on B would
      // see a null shapeId and silently fall through to the position-based
      // fallback (the longstanding "this chat won't filter anymore" bug).
      filterDropPreview.shapeId = null
      filterDropPreview.toPreview = null
      filterDropPreview.fromPreview = null
      filterDropPreview.replacePreview = null
      filterDropPreview.activePaneRole = null
    }
    return () => {
      // Same ownership guard for unmount/re-run cleanup. The cleanup function
      // fires on every dep change, not just unmount, so an unconditional clear
      // would race with another chat's effect body publishing fresh state.
      if (filterDropPreview.shapeId === shapeId) {
        filterDropPreview.shapeId = null
        filterDropPreview.toPreview = null
        filterDropPreview.fromPreview = null
        filterDropPreview.replacePreview = null
        filterDropPreview.activePaneRole = null
      }
    }
  }, [pillOver, toPreview, fromPreview, hoveredGroup, shapeId])

  // Render a single chip (role:label) — matches dashboard's chipHtml
  function renderChip(role: string, label: string, opts?: { ghost?: boolean; x?: { ci: number; ti: number } }) {
    // The value is always the full name (an opaque atom); AgentName is the one
    // display split — full name → base text + glyph. A plain (non-agent) label
    // has no suffix, so it renders verbatim with no glyph.
    return (
      <span className={`fleet-filter-chip fleet-filter-chip-${role}${opts?.ghost ? ' fleet-filter-chip-ghost' : ''}`}>
        <span className="fleet-filter-chip-role">{role}:</span>
        <span className="fleet-filter-chip-label">
          <AgentName name={label} />
        </span>
        {opts?.x && (
          <span className="fleet-filter-term-x" data-clause={opts.x.ci} data-term={opts.x.ti}>×</span>
        )}
      </span>
    )
  }

  // Render AND group box — vertical stack of chips, matching dashboard's .filter-and-group
  function renderAndGroup(
    clause: [string, string][],
    ci: number,
    opts?: { highlight?: boolean; ghostRole?: string; ghostValue?: string; showX?: boolean },
  ) {
    const cls = opts?.highlight
      ? 'fleet-filter-and-group fleet-filter-and-group-highlight'
      : 'fleet-filter-and-group fleet-filter-and-group-normal'
    return (
      <div className={cls} data-group-idx={ci}>
        {clause.map(([role, label], ti) => (
          <div key={ti}>
            {renderChip(role, label, opts?.showX ? { x: { ci, ti } } : undefined)}
          </div>
        ))}
        {opts?.ghostRole && opts?.ghostValue && (
          <div>{renderChip(opts.ghostRole, opts.ghostValue, { ghost: true })}</div>
        )}
      </div>
    )
  }

  // Render full DNF as AND group boxes separated by "or"
  function renderDnfExpression(
    dnf: [string, string][][],
    opts?: {
      showX?: boolean
      highlightIdx?: number
      ghostRole?: string
      ghostValue?: string
    },
  ) {
    const groups = dnf.map((clause, ci) => {
      const isHighlighted = opts?.highlightIdx === ci
      return (
        <div key={ci} className="fleet-filter-group-row">
          {ci > 0 && <span className="fleet-filter-or-sep">or</span>}
          {renderAndGroup(clause, ci, {
            highlight: isHighlighted,
            ghostRole: isHighlighted ? opts?.ghostRole : undefined,
            ghostValue: isHighlighted ? opts?.ghostValue : undefined,
            showX: opts?.showX,
          })}
        </div>
      )
    })

    // Show new OR group when ghosting and not highlighting any existing group
    const showNewGroup = opts?.ghostRole && opts?.ghostValue &&
      (opts?.highlightIdx === undefined || opts?.highlightIdx < 0) && dnf.length > 0

    return (
      <div className="fleet-filter-group-container">
        {groups}
        {showNewGroup && (
          <div className="fleet-filter-group-row">
            <span className="fleet-filter-or-sep">or</span>
            <div className="fleet-filter-and-group fleet-filter-and-group-highlight">
              {renderChip(opts!.ghostRole!, opts!.ghostValue!, { ghost: true })}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={overlayRef} className="fleet-filter-overlay" onPointerDown={stopEventPropagation}>
      {pillOver ? (
        /* Drop preview: left third = only/to+from, right side stacks to/from */
        <div className="fleet-filter-drop-panes">
          <div
            ref={replaceZoneRef}
            className={`fleet-filter-replace-zone${hoveredGroup?.pane === 'replace' ? ' fleet-filter-replace-zone-active' : ''}`}
          >
            <span className="fleet-filter-replace-label">only</span>
            {renderChip('to', pillOver.value)}
            <span className="fleet-filter-replace-sep">+</span>
            {renderChip('from', pillOver.value)}
          </div>
          <div
            ref={toPaneRef}
            className={`fleet-filter-drop-pane fleet-filter-pane-to${hoveredGroup?.pane === 'to' ? ' fleet-filter-pane-active' : ''}`}
          >
            <span className="fleet-filter-pane-label">to</span>
            {toPreview ? renderDnfExpression(toPreview, {
              highlightIdx: toHighlightIdx,
            }) : (
              <div className="fleet-filter-and-group fleet-filter-and-group-highlight">
                {renderChip('to', pillOver.value, { ghost: true })}
              </div>
            )}
          </div>
          <div
            ref={fromPaneRef}
            className={`fleet-filter-drop-pane fleet-filter-pane-from${hoveredGroup?.pane === 'from' ? ' fleet-filter-pane-active' : ''}`}
          >
            <span className="fleet-filter-pane-label">from</span>
            {fromPreview ? renderDnfExpression(fromPreview, {
              highlightIdx: fromHighlightIdx,
            }) : (
              <div className="fleet-filter-and-group fleet-filter-and-group-highlight">
                {renderChip('from', pillOver.value, { ghost: true })}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Normal edit mode */
        <>
          <div className="fleet-filter-overlay-header">
            <span style={{ fontSize: 9, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Filter</span>
            <span className="fleet-filter-presets">
              <button className="fleet-filter-preset" data-preset="all" title="Show all chat traffic">All</button>
              <button className="fleet-filter-preset" data-preset="dm" disabled={!activeAgentLabel} title={activeAgentLabel ? 'Show only human-agent direct messages' : 'Choose an agent first'}>DM</button>
              <button className="fleet-filter-preset" data-preset="agent" disabled={!activeAgentLabel} title={activeAgentLabel ? 'Show all traffic involving this agent' : 'Choose an agent first'}>Agent</button>
            </span>
          </div>
          {filter.length === 0 ? (
            <div className="fleet-filter-empty">
              No filter — drag agent pills here
            </div>
          ) : (
            <>
              {renderDnfExpression(filter, { showX: true })}
              <div className="fleet-filter-footer">
                <span className="fleet-filter-clear">Clear all</span>
              </div>
            </>
          )}
        </>
      )}
    </div>
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
