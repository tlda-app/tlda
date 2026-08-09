/**
 * FleetChatShape — tldraw canvas shape that renders fleet chat messages.
 *
 * Uses fleet-data.mjs (via adapter) for live SSE updates — no polling.
 * Renders with chat-render.mjs from the fleet dashboard.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  createShapeId,
  stopEventPropagation,
  useEditor,
  useToasts,
  useValue,
  type Editor,
  type TLShapeId,
} from 'tldraw'
import { fleetChatProps } from '../../shared/shapes/fleet-panel-schema.mjs'
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useContext, memo, useSyncExternalStore, forwardRef } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { probe } from '../perf-probe'
import { isPhoneViewport } from '../phoneViewport'

// @ts-ignore — vanilla JS module
import { renderChatLine, resolveInlineAttachments, esc, chatLineAttachmentRenderSignature } from '../fleet/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { compareChatMessagesChronologically } from '../fleet/chat-ordering.mjs'
// @ts-ignore — vanilla JS module
import { renderActivityGroup, renderThreadRows, scheduleTimeLabel } from '../fleet/activity-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath, renderMarkdown as renderMarkdownUtil } from '../fleet/utils.mjs'
// @ts-ignore — vanilla JS module
import { initVoice, setVoiceTarget, clearVoiceTarget, completeMessageSend, resetTranscript, restartRecording, toggleRecording, sendCurrentText, isRecording, dumpVoiceTarget } from '../voice.mjs'
// @ts-ignore — vanilla JS module
import { getHumanId, getHumanName, getDeviceId, isDeviceReady, updateEventById, sendViewingContext, setViewingEnrichFn, setFleetEventsLiveTailPinned, clearFleetEventsLiveTailPinned, recordBrowserActivityRendered, fleetDurable, fleetEphemeral, sendKey, getLastEventId, convertChatEvent } from '../fleet/fleet-data.mjs'
// Deliberately NOT calling forgetPanel() on unmount: a panel's tail state
// surviving a remount is informative — the viewport-driven unmount at the bottom
// of this file tears down every subscription, and a remount whose tail goes
// BACKWARDS is exactly what that would look like.
import { noteFollowTransition, notePanelTail } from '../fleet/chat-freeze-probe.mjs'
import { requestEarlierChatHistory, subscribeChat } from '../fleet/chat-subscription.mjs'
// @ts-ignore — vanilla JS module
import { installChatImageRetry } from '../fleet/chat-image-retry.mjs'
// @ts-ignore — vanilla JS module
import {
  FLEET_TEAM_FROM_ROLE,
  FLEET_TEAM_TO_ROLE,
  classifyFleetComposerTrafficMode,
  fleetFilterSendTargets,
  filterForFleetComposerTrafficMode,
  matchesFleetFilter,
  nextFleetComposerTrafficMode,
  quietTrafficSuppressesActivity,
} from '../../shared/filter-semantics.mjs'
import { openTerminalTransport, type TerminalTransport } from '../fleet/terminal-transport'
import { TERMINAL_GLYPH_PATHS, TERMINAL_GLYPH_UNAVAILABLE_PATH, TERMINAL_GLYPH_VIEWBOX } from '../fleet/terminal-glyph.mjs'
import { labelsForAgent } from '../../shared/fleet-labels.mjs'
import { runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'
import { ACTIVITY_DELIVERY_STAGES } from '../../shared/activity-delivery-counters.mjs'
import { useFleetAgents, useFleetChatAgents, useFleetEvents, useFleetIdentity, useFleetTasks, useFleetThinking, useFleetCompacting, useFleetContext, useFleetStatusTargets, useFleetFilterHasMatchingAgent, useSuggestions, clearGroup, sendMessage, receiveFilterEvents, resolveFleetAgentLabelIds, injectOptimisticEvent, updateOptimisticEvent, removeOptimisticEvent, searchFleet } from '../fleet-data-adapter'
import { buildFleetSearchFilters, parseSearchQuery, rankSearchResults } from '../fleet/search-query'
import { parseMessageFilter } from '../../shared/fleet-labels.mjs'
import { isTerminalAvailableForAgent } from '../fleet/fleet-chat-visibility.mjs'
import type { Suggestion } from '../fleet-data-adapter'
import { dropPillOnTarget, chatInsertBus, filterDropPreview, chipContentStore } from './FleetPillShape'
import { fleetFilterForPillDrop } from './fleet-pill-drop-filter'
import { agentDisplayLabel, agentExactName, beginFleetDragWithoutSnap, endFleetDragWithoutSnap, isFleetShapeForOwnerKey } from './fleet-utils'
import { usePillDrag } from './FleetAgentsShape'
import { FleetPanelButtonGroup } from './FleetPanelChrome'
import { ChatComposer, type VoiceTargetHandle } from './ChatComposer'
import { PersistentCornerButtonSlider } from '../CornerButtonSlider'
import { PrettyName } from './PrettyName'
import { dragCoordinator } from './dragCoordinator'
import { cancelDragBeforeRelease } from './fleet-pill-lifecycle'
import { deleteFleetPill } from './fleet-pill-forensics'
import { hasActiveFleetPill, markFleetPillActive, markFleetPillInactive, transientFleetPillProps } from './fleet-pill-transient'
import { ProjectContext, PanelContext } from '../PanelContext'
import { getPageRenderHash, getBuiltPageCount } from '../stores'
import { loadLookup, type LookupData } from '../synctexLookup'
import { getSourceAnchor } from '../synctexAnchor'
import { log } from '../logger'
import { linkifyDocRefs, linkifyArrowRefs, linkifyAtRefs, linkifyLabelRefs, linkifyRefCommands, buildRefResolver, refToCanvas, type DocRef, type ResolvedRef, type LabelRegionInfo, type TheoremMapEntry } from '../docLinks'
// @ts-ignore — vanilla JS module
import { decideFollowTransition, isTrueBottomGap } from './chatScrollIntent.mjs'
import { fetchProofInfo, fetchTheoremMap } from '../docInfoCache'
import { PDF_HEIGHT } from '../layoutConstants'
import { Terminal } from 'xterm'
import { useVisibilityViewportId } from './useIsInViewport'
import {
  dispatchManagedAnnotationViewerHide,
  dispatchManagedAnnotationViewerRequest,
} from '../wm/annotation-viewer-surface'
import { createLightboxSurfaceRequest } from '../wm/lightbox-surface'
import { clientPointToPage, pagePointToClient } from '../wm/viewport-coordinates'
import { fleetInteractionFrame, fleetPointerEventPagePoint } from '../wm/fleet-interaction-frame'
import { openChatMarkdownColumn, openMarkdownChipFromTarget as openMarkdownChipFromTargetElement } from './fleet-chat-markdown-open'
import { subscribeFleetChatInputDropPreview } from './fleet-chat-drop-target'
import { consumeBulletContexts, subscribeBulletContext, getBulletContexts } from '../stores/bulletContextStore'
import { peekClearedComposerDraft, stashClearedComposerDraft, takeClearedComposerDraft, dropClearedComposerDraft } from '../stores/composerDraftStore'
import { getPref, subscribePref } from '../preferences'
import { beginUiIntent, hashUiIntentState } from '../uiIntentTelemetry'
import { DATABASE_HTTP } from '../activeConfig'
import {
  FleetAgentDirectoryList,
  FleetAgentDirectoryNameColumn,
  getFleetAgentDirectoryRows,
  fleetAgentLabelColor,
  sortFleetAgentDirectoryRowsByRecency,
} from './FleetAgentDirectoryRow'
import { getUnreadAgentRailRows, isOnlyOwnedChat } from './fleet-unread-agent-rail'
import './fleet-chat.css'

const DEFAULT_W = 400
const DEFAULT_H = 600
const FLEET_API = DATABASE_HTTP
// Quiet period after the last scroll event before a touch-driven scroll counts
// as finished. A momentum glide emits scroll events continuously, so this only
// has to outlast the gap between two of them.
const TOUCH_SCROLL_SETTLE_MS = 150
// Finger travel that counts as a drag rather than a tap. A drag is the touch
// analogue of an upward wheel delta: enough of a gesture to ask the question.
// Neither one answers it — enterReaderMode decides from where the scroller
// ended up, so a drag or a tick that never left the bottom changes nothing.
const TOUCH_READER_INTENT_PX = 8
// Delay before the follow invariant repairs the tail. Also the re-arm interval
// while an input gesture is in flight.
const FOLLOW_INVARIANT_MS = 500
type ChatTrafficMode = 'normal' | 'quiet'
type ComposerTrafficFilterMode = 'dm-quiet' | 'dm' | 'agent' | 'custom'
type TerminalAgent = {
  id?: string
  dead?: boolean
  human?: boolean
  friendly_name?: string
  name?: string
  tmux_session?: string | null
  runtime_status?: unknown
  terminalInputAllowed?: boolean
  status_reason?: string | null
  activity?: string | null
} & Record<string, unknown>
type TerminalComposerControl = {
  id: string
  agent: TerminalAgent | null
  label: string
  unavailableReason: string | null
}
type FleetChatRenderCounter = {
  active?: boolean
  renderCount?: number
  events?: Array<{ type: 'render'; t: number; shapeId?: string }>
}
type TldrawEditorWindow = Window & { __tldraw_editor__?: Editor }

type ChatRenderProbeKind =
  | 'shape-render'
  | 'row-render'
  | 'row-mount'
  | 'row-unmount'
  | 'row-postprocess'
  | 'markdown-render'
  | 'chat-line-render'
  | 'chat-line-cache-hit'
  | 'activity-render'
  | 'activity-cache-hit'
  | 'render-cache-clear'

type ChatRenderProbe = {
  active?: boolean
  counts?: Record<string, number>
  byKey?: Record<string, Record<string, number>>
  events?: Array<{ type: ChatRenderProbeKind; key?: string; t: number; detail?: Record<string, unknown> }>
}

function recordChatRenderProbe(type: ChatRenderProbeKind, key?: string, detail?: Record<string, unknown>) {
  if (typeof window === 'undefined') return
  const probeWindow = window as Window & { __tldaChatRenderProbe?: ChatRenderProbe }
  const counter = probeWindow.__tldaChatRenderProbe
  if (!counter?.active) return
  const counts = (counter.counts ??= {})
  counts[type] = (counts[type] || 0) + 1
  if (key) {
    const byKey = (counter.byKey ??= {})
    const keyCounts = (byKey[key] ??= {})
    keyCounts[type] = (keyCounts[type] || 0) + 1
  }
  const events = (counter.events ??= [])
  events.push({
    type,
    key,
    t: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    detail,
  })
  if (events.length > 20_000) events.splice(0, events.length - 20_000)
}

function recordFleetChatRender(shape: any) {
  if (typeof window === 'undefined') return
  recordChatRenderProbe('shape-render', shape?.id)
  const testWindow = window as Window & { __tldaFleetChatRenderCounter?: FleetChatRenderCounter }
  const counter = testWindow.__tldaFleetChatRenderCounter
  if (!counter?.active) return
  counter.renderCount = (counter.renderCount || 0) + 1
  if (!counter.events) counter.events = []
  counter.events.push({
    type: 'render',
    t: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    shapeId: shape?.id,
  })
}

function terminalUnavailableReason(agent: TerminalAgent | null): string | null {
  if (!agent) return 'No terminal target selected'
  if (!agent.id) return 'Terminal unavailable: target is unresolved'
  if (agent.dead) return 'Terminal unavailable: agent is dead'
  return null
}

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

/**
 * The fleet pill currently over a given chat shape, or null.
 *
 * There can be more than one fleet-pill on the page — pills are ordinary synced
 * shapes, so another client's pill shows up here too, and one left behind by a
 * different user or device is not reclaimable by this one
 * (shouldReclaimFleetPill requires a matching userId/deviceId). Taking
 * `pills[0]` therefore tracked whichever pill happened to sort first rather than
 * the one under the pointer, and a single foreign pill was enough to aim the
 * filter overlay at the wrong shape.
 *
 * One selection, shared by every reader, so the preview and the filter that
 * gets committed cannot disagree about which pill is being dragged.
 */
function fleetPillOverShape(editor: Editor, shapeId: TLShapeId) {
  const chatBounds = editor.getShapePageBounds(shapeId)
  if (!chatBounds) return null
  for (const pill of editor.getCurrentPageShapes()) {
    if ((pill.type as string) !== 'fleet-pill') continue
    const props = pill.props as { pillType?: string; value?: string; displayName?: string }
    // Content pills (msg, code, ref, …) go to the composer, not to the filter.
    if (props.pillType !== 'agent' && props.pillType !== 'label' && props.pillType !== 'team') continue
    const pb = editor.getShapePageBounds(pill.id)
    if (!pb) continue
    const cx = pb.x + pb.w / 2
    const cy = pb.y + pb.h / 2
    if (cx >= chatBounds.x && cx <= chatBounds.x + chatBounds.w &&
        cy >= chatBounds.y && cy <= chatBounds.y + chatBounds.h) {
      return { props, centre: { x: cx, y: cy }, chatBounds }
    }
  }
  return null
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

// On touch devices, the shared ChatComposer suppresses the iOS keyboard while an
// app voice backend is selected (Browser/Deepgram/Whisper). With Voice Off, the
// keyboard stays available for ordinary typing or native dictation.
// maxTouchPoints (not pointer:coarse) — a Magic Keyboard/trackpad makes the
// iPad's primary pointer "fine", which would wrongly drop the no-keyboard rule.
const _isTouchDevice = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('forcetouch'))

// Phone (narrow screen). iOS Safari auto-zooms any focused input under 16px, so
// the composer font must be ≥16px on phone — and it's set as an INLINE style
// (below), which CSS can't override, so the value is chosen here.
const _isPhone = isPhoneViewport()

function getFleetStyleVars(): React.CSSProperties {
  return {
    '--fleet-base-font': `${getPref('fleet-font-size')}px`,
    '--fleet-chrome-alpha': String(getPref('fleet-chrome-opacity')),
    '--fleet-content-alpha': String(getPref('fleet-content-opacity')),
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
function TerminalHoverPane({ agentId, agentName, pinned, terminalInputAllowed: advertisedTerminalInputAllowed, anchorRef, onDismiss, onMouseEnter, onMouseLeave }: {
  agentId: string
  agentName: string
  pinned: boolean
  terminalInputAllowed: boolean
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
      raf = requestAnimationFrame(measure)
    }
    raf = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(raf)
  }, [anchorRef])
  const containerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const terminalTransportRef = useRef<TerminalTransport | null>(null)
  const pinnedRef = useRef(pinned)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [height, setHeight] = useState(210)
  const [terminalInputAllowed, setTerminalInputAllowed] = useState(advertisedTerminalInputAllowed === true)
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

  useEffect(() => { pinnedRef.current = pinned }, [pinned])
  useEffect(() => {
    setTerminalInputAllowed(advertisedTerminalInputAllowed === true)
  }, [advertisedTerminalInputAllowed])

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
    try {
      term.resize(gridColsRef.current, gridRowsRef.current)
    } catch (e) {
      setStatus('error')
      const message = e instanceof Error ? e.message : String(e)
      term.write(`\r\nTerminal resize failed: ${message}\r\n`)
    }
    return () => {
      term.dispose()
      termRef.current = null
    }
  }, [])

  // Scale the fixed-grid terminal to fit the pane width (no horizontal scroll).
  useEffect(() => {
    let raf = 0
    const measure = () => {
      const inner = containerRef.current?.querySelector('.xterm') as HTMLElement | null
      const body = bodyRef.current
      if (!inner || !body) return
      const natW = inner.offsetWidth
      if (!natW) { raf = requestAnimationFrame(measure); return }
      setScale(Math.min(1, body.clientWidth / natW))
    }
    raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(() => measure())
    if (bodyRef.current) ro.observe(bodyRef.current)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [height, status, gridCols])

  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let activeFallbackTimer: ReturnType<typeof setTimeout> | null = null

    const clearActiveFallbackTimer = () => {
      if (activeFallbackTimer) {
        clearTimeout(activeFallbackTimer)
        activeFallbackTimer = null
      }
    }

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

    const connect = (attempt = 0) => {
      if (cancelled) return
      clearActiveFallbackTimer()
      const previousTransport = terminalTransportRef.current
      terminalTransportRef.current = null
      previousTransport?.close()
      termRef.current?.clear()
      setStatus('connecting')
      let sawAuthoritativeSize = false
      let fallbackFlushed = false
      const pendingOutput: TerminalOutputFrame[] = []
      const flushPendingOutput = () => {
        if (!termRef.current) return
        for (const msg of pendingOutput) writeOutput(msg)
        pendingOutput.length = 0
      }
      activeFallbackTimer = setTimeout(() => {
        if (sawAuthoritativeSize || cancelled) return
        fallbackFlushed = true
        for (const msg of pendingOutput) writeOutput(msg)
      }, 1500)

      // /ws/terminal must hit the fleet server (where the daemon is connected),
      // NOT the page origin — on the local copy the page is served from 5176 but
      // the daemon talks to Fly, so the page-origin socket had no daemon behind it.
      const terminalTransport = openTerminalTransport({
        agentId,
        onOpen: () => {
          if (cancelled) { terminalTransport.close(); return }
          setStatus('connected')
        },
        onFrame: (msg) => {
          if (cancelled) return
          if (msg.type === 'size' && msg.cols && msg.rows) {
            // The daemon reports the agent's real tmux window size. Resize the live
            // grid to match so the absolute-positioned stream renders cleanly; the
            // scale effect then re-fits it to the panel width.
            setGridCols(msg.cols)
            setGridRows(msg.rows)
            try {
              const term = termRef.current
              term?.resize(msg.cols, msg.rows)
              clearActiveFallbackTimer()
              if (!sawAuthoritativeSize) {
                sawAuthoritativeSize = true
                term?.clear()
                flushPendingOutput()
              }
            } catch { void 0 }
          } else if (msg.type === 'output' && msg.data && termRef.current) {
            const output = { type: 'output', data: msg.data, encoding: msg.encoding }
            if (sawAuthoritativeSize) {
              writeOutput(output)
            } else {
              pendingOutput.push(output)
              if (fallbackFlushed) writeOutput(output)
            }
          } else if (msg.type === 'capabilities') {
            setTerminalInputAllowed(msg.terminalInputAllowed === true || msg.capabilities?.terminalInputAllowed === true)
          } else if (msg.type === 'error') {
            setStatus('error')
          }
        },
        onError: () => {
          if (!cancelled) setStatus('error')
        },
        onClose: () => {
          if (cancelled) return
          if (terminalTransportRef.current !== terminalTransport) return
          clearActiveFallbackTimer()
          const delay = Math.min(5000, 500 * Math.max(1, attempt + 1))
          setStatus('connecting')
          retryTimer = setTimeout(() => connect(attempt + 1), delay)
        },
      })
      terminalTransportRef.current = terminalTransport
    }

    connect()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      clearActiveFallbackTimer()
      terminalTransportRef.current?.close()
      terminalTransportRef.current = null
    }
  }, [agentId])

  const sendInput = (data: string) => {
    if (!terminalInputAllowed) return
    terminalTransportRef.current?.input(data)
  }

  const submitInput = (text: string) => {
    if (!terminalInputAllowed) return
    terminalTransportRef.current?.submit(text)
  }

  const interruptTerminal = () => {
    fleetEphemeral('interrupt', { agent: agentId }).catch((e: unknown) => {
      setStatus('error')
      const message = e instanceof Error ? e.message : String(e)
      termRef.current?.write(`\r\nInterrupt failed: ${message}\r\n`)
    })
  }

  // Jump the terminal to its newest output. This deliberately does NOT go
  // through sendInput(): that writes raw bytes to the attached PTY, and the
  // scrollback being jumped out of belongs to tmux, not to the program inside
  // it. Ctrl+End has to arrive as a tmux key, which is what send-key does.
  const jumpToBottom = () => {
    sendKey(agentId, 'C-End').catch((e: unknown) => {
      // A control that silently does nothing is the complaint that started
      // this, so a failed jump has to be visible in the pane.
      setStatus('error')
      const message = e instanceof Error ? e.message : String(e)
      termRef.current?.write(`\r\nJump to bottom failed: ${message}\r\n`)
    })
  }

  const shortId = agentId.replace('fleet:', '')

  const submitCurrent = (submittedText?: string) => {
    const el = inputRef.current
    if (!el) return false
    const text = el.value
    submitInput(text)
    el.value = ''
    completeMessageSend(submittedText ?? text)
    return true
  }

  // Make this field the active voice target — dictation flows in, and saying
  // "send" runs the command in the terminal pane (mirrors the chat textarea's
  // setVoiceTarget wiring, but with a terminal-specific send).
  const registerVoice = (el: HTMLTextAreaElement) => {
    setVoiceTarget(el, {
      getSendTargets: () => [agentId],
      getAgentNames: () => ({ [agentId]: agentName || shortId }),
      getTargetKind: () => 'terminal',
      submitCurrent,
    })
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    stopEventPropagation(e as any)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submitCurrent()
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
      className={`fleet-terminal-hover-pane${pinned ? ' fleet-terminal-hover-pane-pinned' : ''}`}
      style={{
        position: 'fixed',
        left: anchor?.left ?? 0,
        top: anchor?.top ?? 0,
        width: anchor?.width ?? 0,
        right: 'auto',
        visibility: anchor ? 'visible' : 'hidden',
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
        style={{ height, flex: 'none' }}
      >
        {/* Live scaled screen for the hover/pinned peek. */}
        <div
          className="fleet-terminal-hover-scale"
          style={{ transform: `scale(${scale})`, transformOrigin: 'bottom left', position: 'absolute', left: 0, bottom: 0 }}
        >
          <div ref={containerRef} />
        </div>
      </div>
      {pinned && (
        // Pinned read-only terminals keep dedicated controls but no text field.
        <div className="fleet-terminal-hover-input-bar"
          onPointerDown={stopEventPropagation}
          onPointerMove={stopEventPropagation}
        >
          {terminalInputAllowed && (
            <>
              <span className="fleet-terminal-hover-prompt">$</span>
              <textarea
                ref={inputRef}
                className="fleet-terminal-hover-input"
                rows={1}
                onKeyDown={handleInputKeyDown}
                onKeyUp={(e) => stopEventPropagation(e as any)}
                onPointerDown={(e) => { stopEventPropagation(e); registerVoice(e.currentTarget) }}
                onFocus={(e) => { stopEventPropagation(e); registerVoice(e.currentTarget) }}
                onBlur={(e) => { clearVoiceTarget(e.currentTarget); e.currentTarget.style.boxShadow = '' }}
                // The pane can now be pinned by a terminal-card notification for an
                // agent this panel is not addressing, so it has to say whose
                // terminal this is. Carried in the existing placeholder — which
                // already reported connection state — rather than a new header.
                placeholder={status === 'connected' ? `${agentName} — type or speak a command…` : status === 'error' ? `${agentName} — terminal unavailable, reconnecting…` : `${agentName} — connecting…`}
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
                  padding: '3px 50px 3px 18px',
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
            </>
          )}
          <button
            className="fleet-terminal-hover-jump-bottom"
            title="Send Ctrl+End"
            onPointerDown={(e) => { stopEventPropagation(e); jumpToBottom() }}
          >
            ^End
          </button>
          <button
            className="fleet-terminal-hover-ctrl-c"
            title="Send Ctrl+C"
            onPointerDown={(e) => { stopEventPropagation(e as any); interruptTerminal() }}
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
  partial?: { skill: string; percent: number }[]
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
  const partial = data?.partial || []
  const owed = data?.owed || []
  const dismissed = data?.dismissed || []
  const cards = data?.cards || []
  const empty = !loading && read.length === 0 && partial.length === 0 && owed.length === 0 && dismissed.length === 0 && cards.length === 0

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
      {partial.length > 0 && (
        <div className="fleet-skill-hover-section">
          <div className="fleet-skill-hover-label owed">skills partial ({partial.length})</div>
          <div className="fleet-skill-hover-chips">
            {partial.map(p => <span key={p.skill} className="fleet-skill-chip owed">{p.skill} {p.percent}%</span>)}
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
  const failedUploads = new Set<string>()
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
      if (!r.ok) { failedUploads.add(localPath); continue }
      const { url } = await r.json()
      urlMap.set(localPath, `${FLEET_API}${url}`)
    } catch {
      failedUploads.add(localPath)
    }
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
    const hasUnresolved = [...localPaths].some(p => !urlMap.has(p) || failedUploads.has(p))
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
    doc: doc.projectName || null,
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
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    context.sourceLineError = `source line lookup failed: ${message}`
  }
  delete context._viewportEdges
}

setViewingEnrichFn(async (ctx: any) => {
  await enrichContextWithSourceLines(ctx)
  return ctx
})

/**
 * Resolve the document version the user is currently viewing, as a short hash
 * for chat metadata. If the user has scrubbed back with the shadow slider, the
 * stamp reflects that historical version. Otherwise — the common
 * case, viewing the live build — it reads the version straight from the
 * doc-version sentinel, the convergent source that also drives the rendered
 * pages and corner timestamp, so the stamp can't lag behind the actual build.
 */
function currentDocVersion(panel: any, editor?: Editor | null): string | null {
  // Scrubbed back via the shadow slider → the historical version you're comparing against.
  const sav = panel?.shadowActiveVersion
  if (sav?.hash) return String(sav.hash).slice(0, 7)

  // Not scrubbed → the current build (Built). Single canonical source: the
  // doc-version sentinel, which the build writes on every build. Never the lazy
  // history list, which can drift out of date.
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
    const anchoredLines = sourceLines.filter((sl: any) => sl?.anchored !== false && Number.isFinite(Number(sl?.line)))
    const highlighted = anchoredLines.filter((sl: any) => sl.highlighted === true)
    const firstLine = highlighted.length > 0 ? highlighted[0] : anchoredLines[0]

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
  static override props = fleetChatProps

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, filter: [], trafficMode: 'normal', userId: '', deviceId: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override onTranslateStart = () => beginFleetDragWithoutSnap(this.editor)
  override onTranslateEnd = () => endFleetDragWithoutSnap(this.editor)
  override onTranslateCancel = () => endFleetDragWithoutSnap(this.editor)
  override canSnap = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

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

function formatElapsedTime(startMs: number): string {
  const secs = Math.floor((Date.now() - startMs) / 1000)
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
}

// --- Elapsed time display (memoized leaf so only the ticker re-renders) ---
const ElapsedTime = memo(function ElapsedTime({ startMs }: { startMs: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [startMs])
  return <span className="thinking-elapsed">{`(${formatElapsedTime(startMs)})`}</span>
})

function setTickerText(span: HTMLElement, text: string) {
  if (span.textContent !== text) span.textContent = text
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
 * ThinkingStatus — one status line per agent (thinking / compacting /
 * hibernating). The slot reserves one row of height unconditionally so the line
 * fading in/out never shifts the stack (no bounce); content shows when a status
 * is active, blank otherwise. (A reserve-then-consume variant was tried but
 * fought the virtualized chat layout — flashed on every message — and was
 * reverted; see scratch/status-line-spec.md.)
 */
function ThinkingStatus({ thinkingAgents, compactingAgents, contextPercent, hibernatingAgents, statusTargetIds, ctx, itemCount: _itemCount, escalationState, suggestions }: {
  thinkingAgents: Map<string, number>
  compactingAgents: Map<string, number>
  contextPercent: Map<string, number>
  hibernatingAgents: Set<string>
  statusTargetIds: Set<string> | null
  ctx: any
  itemCount: number
  escalationState?: Record<string, { level: number; confirmed: number }>
  suggestions: Suggestion[]
}) {
  // Build status display from server-authoritative agent status field.
  // thinkingAgents/compactingAgents are pre-filtered to chat targets and provide elapsed timestamps.
  // hibernatingAgents is pre-filtered to chat targets.
  const statusAgents = useMemo(() => {
    const isRelevant = (id: string) => !statusTargetIds || statusTargetIds.has(id)
    const merged = new Map<string, { status: 'thinking' | 'compacting' | 'hibernating' | 'waking', startTs: number }>()
    for (const [id, ts] of thinkingAgents) {
      if (!isRelevant(id)) continue
      merged.set(id, { status: 'thinking', startTs: ts })
    }
    for (const [id, ts] of compactingAgents) {
      if (!isRelevant(id)) continue
      if (!merged.has(id)) merged.set(id, { status: 'compacting', startTs: ts })
    }
    for (const id of hibernatingAgents) {
      if (!isRelevant(id)) continue
      if (!merged.has(id)) merged.set(id, { status: 'hibernating', startTs: 0 })
    }
    return merged
  }, [thinkingAgents, compactingAgents, hibernatingAgents, statusTargetIds])

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
        return [
          <div key={agentId} className="chat-line chat-thinking" style={{ padding: '2px 0', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', alignItems: 'baseline', gap: 6 }}>
            {/* left: agent + status */}
            <span style={{ justifySelf: 'start', minWidth: 0 }}>
              <span className="thinking-text">
                <PrettyName prettyName={ctx.agentPrettyName(agentId) ?? ctx.agentFullName(agentId)} />
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
            {/* center: kept empty to preserve the left/right grid columns. */}
            <span style={{ justifySelf: 'center', minWidth: 0 }} />
            {/* right: context info */}
            <span style={{ justifySelf: 'end' }}>
              <ContextBadge percent={contextPercent.get(agentId)} />
            </span>
          </div>,
          // suggestion groups: own line(s) below the status line, one line per group
          ...[...groupChips(chips)].map(([gkey, items]) => (
            <div key={`${agentId}::sug::${gkey}`} className="chat-line chat-thinking" style={{ padding: '2px 0', display: 'flex', alignItems: 'baseline' }}>
              <SuggestionGroup chips={items} agentName={ctx.agentLabel(suggestionOwnerId(items[0]))} />
            </div>
          )),
        ]
      })}
    </div>
  )
}

// The suggestion tooltip can't live inside the chip: the fleet-chat shape is
// dimmed (opacity < 1) and CSS opacity caps every descendant. It also must not
// be a portal (breaks TLDraw), so the HUD layer renders this shared store.
type TipOption = { label: string; text: string }
type TipData = {
  left: number; bottom: number; agentName: string
  vars: Record<string, string>
  options: TipOption[]
} | null
let _tipData: TipData = null
const _tipSubs = new Set<() => void>()
function setSuggestionTip(d: TipData) { _tipData = d; _tipSubs.forEach(f => f()) }
const TIP_VARS = ['--surface', '--border', '--shadow-lg', '--text', '--text-bright', '--accent', '--text-dim']

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

export function SuggestionTip() {
  const tip = useSyncExternalStore(
    (cb) => { _tipSubs.add(cb); return () => _tipSubs.delete(cb) },
    () => _tipData,
  )
  useEffect(() => {
    if (!tip) return
    const hide = () => setSuggestionTip(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('pointerdown', hide, true)
    window.addEventListener('wheel', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('wheel', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [tip])
  if (!tip) return null
  return (
    <span
      className="suggestion-chip-tip"
      style={{ position: 'fixed', left: tip.left, bottom: tip.bottom, ...tip.vars } as React.CSSProperties}
    >
      {tip.options.map((o, i) => (
        <span key={i} className="suggestion-tip-trigger">
          <b>{o.label}</b>{o.text ? <> — {o.text}</> : null}
        </span>
      ))}
      <span className="suggestion-tip-target">→ {tip.agentName} · click an option to pick it</span>
    </span>
  )
}

// One disjunctive group: ✕ on the left (dismiss the group), then the options
// `|`-separated (each clickable to pick → sends its command + clears the group).
// One shared hover on the whole group → a single tooltip listing the options.
function SuggestionGroup({ chips, agentName }: { chips: Suggestion[], agentName: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const fromAgent = suggestionOwnerId(chips[0])
  const key = groupKeyOf(chips[0])
  const showTip = () => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const vars: Record<string, string> = {}
    for (const v of TIP_VARS) vars[v] = cs.getPropertyValue(v)
    setSuggestionTip({
      left: r.left, bottom: window.innerHeight - r.top + 6, agentName, vars,
      options: chips.map(c => ({ label: c.label, text: c.text || '' })),
    })
  }
  const hideTip = () => setSuggestionTip(null)
  const pick = (c: Suggestion) => (e: React.SyntheticEvent) => {
    stopEventPropagation(e as any)
    if (c.command) sendMessage(c.targetId || c.from || '', c.command)
    hideTip()
    clearGroup(fromAgent, key)
  }
  const dismiss = (e: React.SyntheticEvent) => {
    stopEventPropagation(e as any)
    hideTip()
    clearGroup(fromAgent, key)
  }
  return (
    <span
      className="suggestion-group"
      ref={ref}
      onPointerDown={stopEventPropagation}
      onMouseEnter={showTip}
      onMouseLeave={hideTip}
    >
      {/* onPointerUp not onClick: these are text <span>s, dead on touch (a tap
          synthesizes no click). pointerup fires for mouse + finger + stylus. */}
      <span className="suggestion-chip-x" title="Dismiss" onPointerUp={dismiss}>✕</span>
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
    if (a) return agentDisplayLabel(a)
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
  // Exact friendly_name for routing/filtering; pretty_name is display-only.
  const agentFullName = (id: string) => {
    if (!id) return ''
    const a = agents.find((a: any) => a.id === id)
    return a?.friendly_name || (typeof id === 'string' ? id : String(id))
  }
  const agentPrettyName = (id: string) => {
    if (!id) return null
    const a = agents.find((a: any) => a.id === id)
    return a?.pretty_name ?? null
  }
  return {
    agentLabel,
    agentFullName,
    agentPrettyName,
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
      thread: getPref('fold-thread-lines'),
    },
    // The thread card's range view, in rows. Not a fold height -- the card is a
    // picture of what was read, and its bound is a count of things, not lines.
    threadRange: {
      front: getPref('thread-front-messages'),
      tail: getPref('thread-tail-messages'),
    },
  }
}

function addEventParticipantIds(ids: Set<string>, event: any) {
  if (!event) return
  for (const id of [event.from, event.from_id, event.agent, event.agent_id]) {
    if (typeof id === 'string' && id) ids.add(id)
  }
  if (Array.isArray(event.recipients)) {
    for (const id of event.recipients) {
      if (typeof id === 'string' && id) ids.add(id)
    }
  }
}

function agentRenderSignature(agent: any) {
  return [
    agent.id,
    agent.friendly_name,
    agent.name,
    !!agent.human,
    agent.metadata?.inPlanMode,
    agent.metadata?.permission_mode,
    agent.metadata?.planModeType,
  ]
}

function taskRenderSignature(task: any) {
  return [
    task.id,
    task.status,
    task.agent,
    task.delegated_by,
  ]
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

function decodeSemanticOperation(el: HTMLElement): any | null {
  const raw = el.getAttribute('data-semantic-operation')
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

function eventFromSearchResult(result: any) {
  const text = result.text ?? result.snippet ?? ''
  return result.source === 'session'
    ? { type: result.role === 'user' ? 'terminal_user' : 'terminal_assistant', from: result.agentId, recipients: [], text, timestamp: result.timestamp, id: result.id }
    : { ...result, text, id: result.id }
}

// `since`/`until` are relative to when the thread call ran, not to now: "2h"
// meant two hours before the agent read it. Anchor the shorthand on the
// descriptor's own timestamp so re-reading reproduces the window it asked for.
function threadWindowTimestamp(value: any, generatedAt: any): string | null {
  if (value == null || value === '') return null
  const s = String(value).trim().toLowerCase()
  const anchorMs = generatedAt ? Date.parse(String(generatedAt)) : NaN
  const anchor = Number.isFinite(anchorMs) ? anchorMs : Date.now()
  if (s === 'now') return new Date(anchor).toISOString()
  const m = s.match(/^-?(\d+(?:\.\d+)?)\s*(m(?:in(?:utes?)?)?|h(?:r(?:s)?|ours?)?|d(?:ays?)?)$/)
  if (m) {
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2][0] as 'm' | 'h' | 'd']
    return new Date(anchor - parseFloat(m[1]) * ms).toISOString()
  }
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// The window a thread card covers. One card can stand for several paged thread
// calls (mergeSemanticInspected collects their ranges), so it is their union:
// earliest `since`, latest `until`.
function threadWindow(descriptor: any) {
  const merged = Array.isArray(descriptor?.view?._semanticInspectedPages) ? descriptor.view._semanticInspectedPages : []
  let since: string | null = null
  let until: string | null = null
  let pageSize = 0
  for (const page of [descriptor?.inspected || {}, ...merged]) {
    const pageSince = threadWindowTimestamp(page?.since ?? page?.after, descriptor?.generatedAt)
    const pageUntil = threadWindowTimestamp(page?.until ?? page?.before, descriptor?.generatedAt)
    if (pageSince && (!since || pageSince < since)) since = pageSince
    if (pageUntil && (!until || pageUntil > until)) until = pageUntil
    const size = Number(page?.page_size ?? page?.pageSize)
    if (Number.isFinite(size) && size > pageSize) pageSize = size
  }
  return { since, until, pageSize }
}

// Mirror what `thread` itself asks the server for, so the card renders the call
// that was made: an agent read is `agent` plus the empty text query (which the
// server serves agent-only), a filter read is the normalized message filter,
// and event types stay unset unless the call named them.
function threadSearchRequest(descriptor: any, agentId: string | null, currentProject?: string) {
  const view = descriptor?.view || {}
  const filters: any = { eventOnly: true, historyOnly: true, currentProject, throwOnError: true }
  const requestedTypes = Array.isArray(view.types) ? view.types : []
  if (requestedTypes.length === 1) filters.eventType = requestedTypes[0]
  else if (requestedTypes.length > 1) filters.eventTypes = requestedTypes
  const { since, until, pageSize } = threadWindow(descriptor)
  if (since) filters.since = since
  if (until) filters.before = until
  if (agentId) {
    filters.agent = agentId
  } else {
    const raw = String(view.filter || descriptor?.filterExpression || '')
    let filterExpression = ''
    try {
      const parsed = parseSearchQuery(raw)
      if (!parsed.query && parsed.filters?.filterExpression) filterExpression = String(parsed.filters.filterExpression)
    } catch {
      filterExpression = ''
    }
    if (!filterExpression) {
      // Not a search-query expression — hand the raw filter to the message
      // grammar, the same second chance `thread` gives it. Throws on a filter
      // neither grammar accepts, which the view reports.
      parseMessageFilter(raw)
      filterExpression = raw
    }
    // An empty filter is not a thread read. searchFleet drops a falsy
    // filterExpression, so letting one through asks the server for the newest
    // events in the whole corpus and draws somebody else's conversation on this
    // card. Fail closed and let the view say so, the same way an unmatched name
    // in fleet-search yields an impossible id rather than everything.
    if (!filterExpression) throw new Error('thread call names no agent, task, or filter')
    filters.filterExpression = filterExpression
  }
  // Both bounds set means the call committed to a finite range, so `thread`
  // takes the whole window in one shot instead of a page.
  const limit = since && until ? 10_000 : (pageSize || 200)
  return { query: '', limit, filters }
}

function semanticSearchRequest(descriptor: any, limit: number, currentProject?: string, before?: string | null) {
  const view = descriptor?.view || {}
  const rawQuery = String(descriptor?.query || descriptor?.arg || view.query || '')
  let query = rawQuery
  let filters: any = {}
  try {
    const parsed = parseSearchQuery(rawQuery)
    query = parsed.query
    const parsedFilters: Record<string, any> = { ...(parsed.filters || {}) }
    delete parsedFilters.since
    delete parsedFilters.after
    delete parsedFilters.before
    filters = buildFleetSearchFilters(parsedFilters)
  } catch {
    filters = {}
  }
  if (descriptor?.filterExpression && !filters.filterExpression) filters.filterExpression = descriptor.filterExpression
  if (view.agent && !filters.agent && !filters.agentQuery) {
    if (String(view.agent).startsWith('fleet:')) filters.agent = view.agent
    else filters.agentQuery = view.agent
  }
  if (view.role) filters.role = view.role
  filters.throwOnError = true
  if (currentProject) filters.currentProject = currentProject
  if (before) filters.before = before
  return { query, limit, filters }
}

// The nick a thread row shows: the name its sender held at send time, plus the
// durable fleet id, and `→now:X` when the agent has since rotated — the same
// provenance tag the thread transcript carried.
function threadNick(id: any, periodName: any, nowName: any, agentLabel: (id: any) => string) {
  if (!id) return ''
  const nm = periodName === undefined ? (agentLabel(id) || null) : periodName
  let s = `${nm || '(nameless)'} ${id}`
  if (nowName != null && nowName !== nm) s += ` →now:${nowName}`
  return s
}

// Fleet events → the rows renderThreadRows draws. An activity event becomes the
// item renderActivityGroup already knows how to draw; everything else is one
// chat line.
function threadRowsFromEvents(events: any[], agentLabel: (id: any) => string) {
  return events.map((e: any) => {
    const timestamp = e.timestamp ? new Date(e.timestamp).toLocaleString() : ''
    if ((e.event_type || e.type) === 'activity') {
      return { timestamp, activity: convertChatEvent({ ...e }) }
    }
    const body = e.type === 'delegate'
      ? `[DELEGATE] ${e.description || ''}\n${e.message || e.text || ''}`
      : e.type === 'task_done'
        ? `[DONE] ${e.description || ''}`
        : (e.text || e.message || '')
    return {
      timestamp,
      from: threadNick(e.from_id || e.from, e.fromName, e.fromNameNow, agentLabel),
      to: threadNick(e.to_id || e.to, e.toName, e.toNameNow, agentLabel),
      body,
    }
  })
}

// A chat row rebuilds its React roots whenever its own HTML changes, which on a
// live stream is constantly -- measured at 15 rebuilds of one thread card during
// a single page load. A thread call is a point-in-time read, so keeping its
// drawn rows lets a rebuilt card redraw instead of re-reading the database and
// re-rendering every message. Bounded because a chat can scroll past many
// distinct threads.
//
// Keyed by the read, not by the semanticKey. semanticKey deliberately drops the
// range keys so paginated calls merge onto one card, and it never saw
// currentProject at all -- but both shape the request threadSearchRequest
// builds. Keyed on semanticKey alone, `thread(agent:"x", since:"1h")` and
// `thread(agent:"x")` over all history share one slot, and the first render
// wins for the life of the page. That is a card showing another call's thread.
const THREAD_HTML_CACHE = new Map<string, string>()
const THREAD_HTML_CACHE_MAX = 50

function rememberThreadHtml(key: string, html: string) {
  if (!key) return
  THREAD_HTML_CACHE.delete(key)
  THREAD_HTML_CACHE.set(key, html)
  while (THREAD_HTML_CACHE.size > THREAD_HTML_CACHE_MAX) {
    THREAD_HTML_CACHE.delete(THREAD_HTML_CACHE.keys().next().value as string)
  }
}

// A thread renders open, drawn by the same visualization the transcript used to
// feed. The messages come out of the database instead, so the gap marker in the
// middle expands to the actual messages rather than to another ellipsis.
function ThreadChatOperationView({
  descriptor,
  renderCtx,
  currentProject,
  host,
  restoreExpansions,
}: {
  descriptor: any
  renderCtx: any
  currentProject?: string
  host: HTMLElement
  restoreExpansions: (root: HTMLElement) => void
}) {
  const semanticKey = String(descriptor?.semanticKey || '')
  const { since: windowSince, until: windowUntil, pageSize: windowPageSize } = threadWindow(descriptor)
  const cacheKey = `${semanticKey}|${currentProject || ''}|${windowSince}|${windowUntil}|${windowPageSize}`
  const cached = THREAD_HTML_CACHE.get(cacheKey)
  const [html, setHtml] = useState(cached ?? '')
  const [loading, setLoading] = useState(cached == null)
  const [error, setError] = useState('')
  const [collapseTop, setCollapseTop] = useState('50%')
  const viewRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (force = false) => {
    if (!force && THREAD_HTML_CACHE.has(cacheKey)) return
    setLoading(true)
    setError('')
    try {
      let agentId: string | null = null
      const view = descriptor?.view || {}
      const agentArg = view.agent || (view.task_id
        ? (await fleetEphemeral('task-by-id', { task_id: view.task_id }))?.task?.agent
        : null)
      if (view.task_id && !view.agent && !agentArg) throw new Error(`Task ${view.task_id} not found`)
      if (agentArg) {
        const resolved = await fleetEphemeral('resolve-agent', { agent: agentArg })
        agentId = resolved?.agent?.id || String(agentArg)
      }
      const request = threadSearchRequest(descriptor, agentId, currentProject)
      const fetched = await searchFleet(request.query, request.limit, request.filters)
      const events = fetched
        .filter((r: any) => r.source === 'fleet')
        .sort((a: any, b: any) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
      const seen = new Set<string>()
      const deduped = events.filter((e: any) => {
        const key = e.id != null ? `id:${e.id}` : `${e.timestamp}|${e.from}|${e.type || ''}|${e.text ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      // An empty read says so. Rendering the empty wrapper instead leaves a
      // blank box, which is the thing that reads as broken rather than empty.
      const drawn = deduped.length
        ? renderThreadRows(threadRowsFromEvents(deduped, renderCtx.agentLabel), renderCtx)
        : ''
      rememberThreadHtml(cacheKey, drawn)
      setHtml(drawn)
    } catch (err: any) {
      setError(err?.message || 'thread read failed')
    } finally {
      setLoading(false)
    }
  }, [currentProject, descriptor, renderCtx, cacheKey])

  useEffect(() => { void load() }, [load])

  useLayoutEffect(() => {
    if (viewRef.current && html) restoreExpansions(viewRef.current)
  }, [html, restoreExpansions])

  useLayoutEffect(() => {
    const scroller = host.closest('.fleet-chat-log') as HTMLElement | null
    if (!scroller) return
    const update = () => setCollapseTop(`${Math.max(8, Math.round(scroller.clientHeight / 2))}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [host])

  // Two controls, which is what "1 expand and one collapsed" meant: the gap
  // marker in the middle expands, and this floats at the left edge to collapse.
  // It floats because the thing it undoes is what pushes it off screen -- Skip:
  // "a floating collapse control on the left edge", "collapse it back to the top
  // and bottom view easily from wherever you are."
  //
  // It collapses to the range view, not to nothing. Blanking the card destroyed
  // the only thing the card is for -- seeing the range an agent read -- which is
  // what "the collapse isn't to a pretty expanded state, it's just a fucking
  // nothing" was about.
  //
  // It is only present while the middle is open, because that is the only state
  // where it does anything. Collapsed, it would be a control that looks dead --
  // Skip: "your collapse button should be invisible when the card is collapsed."
  const collapseToRange = useCallback((event: any) => {
    stopEventPropagation(event)
    const root = viewRef.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('.pretty-more-rows').forEach(moreRows => {
      moreRows.style.display = 'none'
      const btn = moreRows.parentElement?.querySelector('.pretty-expand-btn') as HTMLElement | null
      if (btn) {
        if (btn.dataset.collapsedLabel) btn.textContent = btn.dataset.collapsedLabel
        btn.classList.remove('thread-fold-open')
      }
    })
    root.closest('.thread-shell')?.classList.remove('thread-middle-open')
  }, [])

  return (
    <div className="semantic-operation-expanded-shell thread-shell">
      <button type="button" className="semantic-operation-collapse" style={{ top: collapseTop }} onPointerUp={collapseToRange}>Collapse</button>
      <div className="semantic-operation-view">
        {error ? <div className="semantic-operation-status">{error} <button type="button" className="semantic-operation-more" onPointerUp={(e) => { stopEventPropagation(e); void load(true) }}>Retry</button></div> : null}
        {!error && !loading && !html ? <div className="semantic-operation-status">no results</div> : null}
        {loading ? <div className="semantic-operation-status">loading...</div> : null}
        {html ? <div ref={viewRef} dangerouslySetInnerHTML={{ __html: html }} /> : null}
      </div>
    </div>
  )
}

function SemanticChatOperationView({
  descriptor,
  renderCtx,
  pageSize,
  currentProject,
  host,
}: {
  descriptor: any
  renderCtx: any
  pageSize: number
  currentProject?: string
  host: HTMLElement
}) {
  const [results, setResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [before, setBefore] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [collapseTop, setCollapseTop] = useState('50%')
  const loadedRef = useRef(false)
  const searchVisibleLimitRef = useRef(pageSize)

  const loadPage = useCallback(async (reset = false) => {
    const cursor = reset ? null : before
    setLoading(true)
    setError('')
    try {
      const effectiveDescriptor = descriptor
      const displayLimit = descriptor?.kind === 'search'
        ? (reset ? pageSize : searchVisibleLimitRef.current + pageSize)
        : pageSize
      if (descriptor?.kind === 'search') searchVisibleLimitRef.current = displayLimit
      let requestLimit = displayLimit + 1
      let request = semanticSearchRequest(
        effectiveDescriptor,
        requestLimit,
        currentProject,
        descriptor?.kind === 'thread' ? cursor : null,
      )
      let fetched = await searchFleet(request.query, request.limit, request.filters)
      while (
        descriptor?.kind === 'thread'
        && fetched.length === requestLimit
        && fetched[displayLimit - 1]?.timestamp
        && fetched[fetched.length - 1]?.timestamp === fetched[displayLimit - 1]?.timestamp
        && requestLimit < 10_000
      ) {
        requestLimit = Math.min(10_000, requestLimit * 2)
        request = semanticSearchRequest(effectiveDescriptor, requestLimit, currentProject, cursor)
        fetched = await searchFleet(request.query, request.limit, request.filters)
      }
      let pageEnd = Math.min(displayLimit, fetched.length)
      const boundaryTimestamp = fetched[pageEnd - 1]?.timestamp
      if (descriptor?.kind === 'thread') {
        while (pageEnd < fetched.length && fetched[pageEnd]?.timestamp === boundaryTimestamp) pageEnd += 1
      }
      const page = fetched.slice(0, pageEnd)
      const ordered = descriptor?.kind === 'thread'
        ? page.slice().sort((a: any, b: any) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
        : rankSearchResults(page, request.query)
      setResults(prev => {
        const combined = reset || descriptor?.kind === 'search'
          ? ordered
          : descriptor?.kind === 'thread'
            ? [...ordered, ...prev]
            : [...prev, ...ordered]
        const seen = new Set<string>()
        return combined.filter((result: any) => {
          const key = `${result.source || ''}:${result.id || `${result.timestamp || ''}:${result.text || result.snippet || ''}`}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      })
      setHasMore(fetched.length > pageEnd)
      const oldest = page
        .map((r: any) => r.timestamp)
        .filter(Boolean)
        .sort()[0] || null
      setBefore(oldest)
    } catch (err: any) {
      setError(err?.message || 'search failed')
    } finally {
      setLoading(false)
    }
  }, [before, currentProject, descriptor, pageSize])

  useEffect(() => {
    setResults([])
    setBefore(null)
    setHasMore(true)
    loadedRef.current = false
    searchVisibleLimitRef.current = pageSize
  }, [descriptor?.semanticKey, pageSize, currentProject])

  useEffect(() => {
    const load = () => {
      if (loadedRef.current) return
      loadedRef.current = true
      void loadPage(true)
    }
    host.addEventListener('semantic-operation-expand', load)
    if (host.style.display !== 'none') load()
    return () => host.removeEventListener('semantic-operation-expand', load)
  }, [host, loadPage])

  useLayoutEffect(() => {
    const scroller = host.closest('.fleet-chat-log') as HTMLElement | null
    if (!scroller) return
    const update = () => setCollapseTop(`${Math.max(8, Math.round(scroller.clientHeight / 2))}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [host])

  const collapse = useCallback((event: any) => {
    stopEventPropagation(event)
    const op = host.closest('.semantic-chat-operation') as HTMLElement | null
    const btn = op?.querySelector('.pretty-expand-btn') as HTMLElement | null
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }, [host])

  return (
    <div className="semantic-operation-expanded-shell">
      <button type="button" className="semantic-operation-collapse" style={{ top: collapseTop }} onPointerUp={collapse}>Collapse</button>
      <div className="semantic-operation-view">
        {error ? <div className="semantic-operation-status">{error} <button type="button" className="semantic-operation-more" onPointerUp={(e) => { stopEventPropagation(e); loadedRef.current = true; void loadPage(true) }}>Retry</button></div> : null}
        {!error && results.length === 0 && !loading ? <div className="semantic-operation-status">no results</div> : null}
        {results.map((result, i) => {
          const html = renderChatLine(convertChatEvent(eventFromSearchResult(result)), renderCtx)
          return <div key={`${result.id || result.timestamp || i}:${i}`} className="semantic-operation-result" dangerouslySetInnerHTML={{ __html: html }} />
        })}
        {loading ? <div className="semantic-operation-status">loading...</div> : null}
        {!loading && hasMore ? <button type="button" className="semantic-operation-more" onPointerUp={(e) => { stopEventPropagation(e); void loadPage(false) }}>More</button> : null}
      </div>
    </div>
  )
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
  semanticRenderCtx,
  semanticOperationPageSize,
  currentProject,
}: {
  html: string
  postProcess: (html: string) => string
  itemKey: string
  expandedRowsRef: React.RefObject<Set<string>>
  semanticRenderCtx: any
  semanticOperationPageSize: number
  currentProject?: string
}) {
  recordChatRenderProbe('row-render', itemKey, { htmlLength: html.length })
  const processed = useMemo(() => probe.time('chat', 'chat-row-postprocess', () => postProcess(html), {
    itemKey,
    htmlLength: html.length,
  }), [html, postProcess, itemKey])
  const divRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    recordChatRenderProbe('row-mount', itemKey, { htmlLength: html.length })
    return () => recordChatRenderProbe('row-unmount', itemKey)
  }, [itemKey, html.length])

  useEffect(() => {
    recordChatRenderProbe('row-postprocess', itemKey, { htmlLength: html.length, processedLength: processed.length })
  }, [itemKey, html.length, processed.length])

  // Restore expand state after dangerouslySetInnerHTML replaces the DOM.
  useLayoutEffect(() => {
    const t0 = probe.isEnabled('chat') ? performance.now() : 0
    const el = divRef.current
    if (!el) return
    const mountedAtMs = Date.now()
    el.querySelectorAll<HTMLElement>('.chat-activity-card').forEach(card => {
      if (!card.dataset.browserMountedAtMs) {
        card.dataset.browserMountedAtMs = String(mountedAtMs)
        recordBrowserActivityRendered(ACTIVITY_DELIVERY_STAGES.BROWSER_RENDERED, [{
          from: card.dataset.agent,
          _dbId: card.dataset.msgId,
          timestamp: card.dataset.ts,
        }], 1)
      }
    })
    const expanded = expandedRowsRef.current
    // A thread's rows arrive after its read resolves, so the same restore runs
    // again once the view has drawn them.
    const restorePrettyExpansions = (root: HTMLElement) => {
      root.querySelectorAll<HTMLElement>('.pretty-more-rows').forEach((moreRows, i) => {
        const key = `${itemKey}:pretty:${i}`
        if (expanded.has(key) || expanded.has(itemKey)) {
          moreRows.style.display = ''
          const btn = moreRows.parentElement?.querySelector('.pretty-expand-btn') as HTMLElement | null
          if (btn) {
            if (!btn.dataset.collapsedLabel) btn.dataset.collapsedLabel = btn.textContent || 'Expand'
            btn.textContent = ''
            btn.classList.add('thread-fold-open')
          }
          moreRows.closest('.thread-shell')?.classList.add('thread-middle-open')
        }
      })
    }
    restorePrettyExpansions(el)
    el.querySelectorAll<HTMLElement>('.semantic-operation-body').forEach((body, i) => {
      const op = body.closest('.semantic-chat-operation')
      const key = `${itemKey}:semantic:${op?.getAttribute('data-semantic-key') || i}`
      // A thread renders open, so it is expanded unless this row was explicitly
      // collapsed. Restoring only remembered keys would close every thread the
      // moment its row re-rendered.
      const startsOpen = op?.classList.contains('semantic-chat-operation-open')
      if (expanded.has(key) || (startsOpen && body.style.display !== 'none')) {
        body.style.display = ''
        body.closest('.semantic-chat-operation')?.classList.add('semantic-operation-expanded')
        const btn = body.parentElement?.querySelector('.pretty-expand-btn') as HTMLElement | null
        if (btn) {
          if (!btn.dataset.semanticCollapsedLabel) btn.dataset.semanticCollapsedLabel = btn.textContent || 'Expand'
          btn.textContent = ''
          btn.classList.add('thread-fold-open')
        }
      }
    })
    const semanticRoots: any[] = []
    el.querySelectorAll<HTMLElement>('.semantic-operation-body').forEach(body => {
      const descriptor = decodeSemanticOperation(body)
      if (!descriptor) return
      const root = createRoot(body)
      root.render(
        descriptor.kind === 'thread'
          ? <ThreadChatOperationView
            descriptor={descriptor}
            renderCtx={semanticRenderCtx}
            currentProject={currentProject}
            host={body}
            restoreExpansions={restorePrettyExpansions}
          />
          : <SemanticChatOperationView
            descriptor={descriptor}
            renderCtx={semanticRenderCtx}
            pageSize={semanticOperationPageSize}
            currentProject={currentProject}
            host={body}
          />,
      )
      semanticRoots.push(root)
    })
    // A thread message that already fits is not collapsed. The renderer marks
    // every body, because it cannot know how tall rendered markdown lays out --
    // this is the half that measures. Without it a two-line message carries a
    // collapsed class that does nothing but lie about the row being cut off,
    // which is the defect the 8/01 version was written to avoid.
    el.querySelectorAll<HTMLElement>('.pretty-msg-body.thread-msg-collapsed').forEach(body => {
      if (body.scrollHeight <= body.clientHeight + 1) {
        body.classList.remove('thread-msg-collapsed')
        body.style.maxHeight = ''
      }
    })
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
    return () => {
      for (const root of semanticRoots) root.unmount()
    }
  }, [processed, itemKey, expandedRowsRef, semanticRenderCtx, semanticOperationPageSize, currentProject])

  return (
    <>
      <div ref={divRef} data-item-key={itemKey} dangerouslySetInnerHTML={{ __html: processed }} />
    </>
  )
}, (prev, next) => prev.html === next.html && prev.postProcess === next.postProcess && prev.itemKey === next.itemKey && prev.semanticOperationPageSize === next.semanticOperationPageSize && prev.currentProject === next.currentProject && prev.semanticRenderCtx === next.semanticRenderCtx)

function FleetChatInner({ shape }: { shape: any }) {
  const { addToast } = useToasts()
  recordFleetChatRender(shape)
  const editor = useEditor()
  const viewportId = useVisibilityViewportId()
  const doc = useContext(ProjectContext)
  const panel = useContext(PanelContext)
  const fleetStyleVars = useFleetStyleVars()
  const { w, h, filter, trafficMode = 'normal' } = shape.props as { w: number; h: number; filter: [string, string][][]; trafficMode?: ChatTrafficMode }
  const quietDmTraffic = quietTrafficSuppressesActivity(filter, trafficMode)
  void useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterOpenByPill, setFilterOpenByPill] = useState(false)
  const { startDrag: startUnreadRailDrag } = usePillDrag()
  const showUnreadAgentRail = useValue('show-unread-agent-rail', () => {
    const userId = getHumanId()
    const deviceId = getDeviceId()
    if (!userId || !deviceId) return false
    const ownedFleetShapes = editor.getCurrentPageShapes().filter((candidate: any) =>
      isFleetShapeForOwnerKey(candidate, userId, deviceId),
    )
    return isOnlyOwnedChat(ownedFleetShapes, shape.id)
  }, [editor, shape.id])

  // Keep a ref to the current filter so the rename effect can read it without a stale closure
  const filterRef = useRef(filter)
  filterRef.current = filter

  // Track previous agent friendly names to detect renames (populated after agents is declared below)
  const prevAgentNamesRef = useRef<Record<string, string>>({})

  const activeBullets = useSyncExternalStore(subscribeBulletContext, getBulletContexts)

  // DNF filter: [[[role,label],...],...]  — OR of AND-groups of [role, label] tuples
  const dnfFilter = filter.length > 0 ? filter : null
  const filterKey = JSON.stringify(filter)

  // Load lookup data for doc reference resolution
  const [lookup, setLookup] = useState<LookupData | null>(null)
  const [labelRegions, setLabelRegions] = useState<Record<string, LabelRegionInfo>>({})
  const [theoremMap, setTheoremMap] = useState<Record<string, TheoremMapEntry>>({})
  useEffect(() => {
    if (!doc?.projectName) return
    loadLookup(doc.projectName).then(setLookup)
    fetchProofInfo(doc.projectName).then(data => {
      if (data?.labelRegions) setLabelRegions(data.labelRegions)
    })
    fetchTheoremMap(doc.projectName).then(data => {
      if (data) setTheoremMap(data)
    })
  }, [doc?.projectName])

  const refResolver = useMemo(() => lookup ? buildRefResolver(lookup, theoremMap) : null, [lookup, theoremMap])

  // Live data from fleet-data.mjs via SSE (or playback data if inside a PlaybackFrame)
  const frameId = shape.parentId as string | undefined
  const agents = useFleetChatAgents(frameId)
  const agentById = useMemo(() => new Map(agents.map((agent: any) => [agent.id, agent])), [agents])
  // Derive send targets: unique agents in "to" clauses only. Declared here, above
  // the render memos, because the chat line renderer needs the panel's default
  // target set to decide whether a message's recipients are worth printing.
  const sendTargets = useMemo(() => {
    return fleetFilterSendTargets(filter, { agents })
  }, [filterKey, agents])
  // Keep sendTargets accessible from native event listeners without re-registering
  const sendTargetsRef = useRef<string[]>([])
  sendTargetsRef.current = sendTargets
  const sendTargetsKey = sendTargets.join(' ')
  const { statusTargetIds, hibernatingAgents } = useFleetStatusTargets(dnfFilter, frameId)
  // The chat owns its subscription-fed event buffer.
  const chatEventBufferKey = dnfFilter ? `chat:${shape.id}` : null
  const liveEvents = useFleetEvents(dnfFilter, frameId, chatEventBufferKey)
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
  const termCardHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Hover-intent: cursor must rest on a terminal card before the peek opens, so a
  // cursor merely passing through never triggers it.
  const termCardShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const termCardPendingIdRef = useRef<string | null>(null)

  const dismissTerminalNotification = useCallback((agentId: string) => {
    // Mark terminal events from this agent as read when dismissed, so they do
    // not re-pop on reload. Other unread chats for the recipient are untouched.
    const unreadEventIds = liveEvents
      .filter((e: any) =>
        (e._evType === 'terminal_card' || e._evType === 'terminal_attention') &&
        e.from === agentId &&
        e.read !== true && (e._dbId || e.id)
      )
      .map((e: any) => e._dbId || e.id)
    for (const eid of unreadEventIds) {
      fleetDurable('mark-event-read', { event_id: eid, agent: getHumanId() })
        .catch((e: Error) => console.warn('[fleet-chat] mark-read failed:', e.message))
    }
    setTermHoverPinned(false)
    setTermHoverVisible(false)
    pickTerminalHover(null)
  }, [liveEvents])

  // Esc interrupt: track last Esc timestamp for soft/hard distinction
  const escCountRef = useRef<number>(0)
  const interruptTempCounterRef = useRef<number>(0)
  // Set below, so the document-level Escape listener (deps []) always calls the
  // current function without re-binding.
  const runInterruptTierRef = useRef<(count: number, source: 'esc' | 'rail') => void>(() => {})
  // Track whether the user last clicked inside this fleet chat shape.
  // Voice/touch users don't focus the textarea, so activeElement-based checks fail.
  const chatActiveRef = useRef(false)
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

  // One buffer per chat: liveEvents is the id-keyed event view for this chat's
  // buffer. Live websocket events and history loads are inputs to that buffer.
  const events = liveEvents

  // Resolve a friendly name/label to fleet IDs for UI interactions such as
  // drag/drop. Chat/history/status scoping uses the maintained live-store target
  // view so roster heartbeat churn does not reopen filtered render paths.
  const resolveToFleetIds = useCallback((label: string): string[] => {
    if (label.startsWith('fleet:')) return [label]
    const matched = resolveFleetAgentLabelIds(label)
    return matched.length > 0 ? matched : [label]
  }, [])

  const resolveToFleetId = useCallback((label: string): string => {
    if (label.startsWith('fleet:')) return label
    return resolveToFleetIds(label)[0] || label
  }, [resolveToFleetIds])

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

  const virtuosoRef = useRef<VirtuosoHandle | null>(null)


  const chatLogRef = useRef<HTMLDivElement>(null)
  // chatLogEl tracks the scroller element in state so effects can attach
  // listeners as soon as Virtuoso mounts its scroll container.
  const [chatLogEl, setChatLogEl] = useState<HTMLDivElement | null>(null)
  const suppressNativeChipClickUntilRef = useRef(0)

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
          className={['fleet-chat-log', props.className].filter(Boolean).join(' ')}
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
    if (!doc?.projectName) return
    fetch(`/api/projects/${doc.projectName}/macros`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.macros) setPreambleMacros(data.macros) })
      .catch(e => console.warn('[fleet-chat] macros fetch failed:', e.message))
  }, [doc?.projectName])

  // Per-sender preamble: each message carries metadata.preambleRef.doc (the
  // sender's preamble document). We render that message's math with that doc's
  // macros so it looks the same for everyone, regardless of what the viewer has
  // loaded. Cache macros per doc; fetch any referenced doc we haven't seen yet.
  const [macrosByDoc, setMacrosByDoc] = useState<Record<string, Record<string, string>>>({})

  // Build context and render messages
  const prefTick = usePrefTick()
  const ctxRelevantAgentIds = useMemo<Set<string> | null>(() => {
    if (!dnfFilter || dnfFilter.length === 0) return null
    const ids = new Set<string>()
    for (const event of events) addEventParticipantIds(ids, event)
    for (const id of statusTargetIds || []) ids.add(id)
    for (const id of hibernatingAgents) ids.add(id)
    for (const id of thinkingAgents.keys()) ids.add(id)
    for (const id of compactingAgents.keys()) ids.add(id)
    for (const id of contextPercent.keys()) ids.add(id)
    for (const suggestion of suggestionsPending) {
      const ownerId = suggestionOwnerId(suggestion)
      if (ownerId) ids.add(ownerId)
    }
    return ids
  }, [filterKey, events, statusTargetIds, hibernatingAgents, thinkingAgents, compactingAgents, contextPercent, suggestionsPending])
  const ctxAgents = useMemo(() => {
    if (!ctxRelevantAgentIds) return agents
    return [...ctxRelevantAgentIds]
      .map(id => agentById.get(id))
      .filter(Boolean)
  }, [agents, agentById, ctxRelevantAgentIds])
  const ctxTasks = useMemo(() => {
    if (!ctxRelevantAgentIds) return tasks
    return tasks.filter((task: any) =>
      ctxRelevantAgentIds.has(task.agent) ||
      ctxRelevantAgentIds.has(task.delegated_by)
    )
  }, [tasks, ctxRelevantAgentIds])
  const ctxRenderKey = useMemo(() => JSON.stringify({
    agents: ctxAgents.map(agentRenderSignature),
    tasks: ctxTasks.map(taskRenderSignature),
    macros: Object.entries(preambleMacros).sort(),
    prefTick,
  }), [ctxAgents, ctxTasks, preambleMacros, prefTick])
  const contentRenderKey = useMemo(() => JSON.stringify({
    macros: Object.entries(preambleMacros).sort(),
    prefTick,
  }), [preambleMacros, prefTick])
  const ctx = useMemo(() => makeCtx(ctxAgents, ctxTasks, preambleMacros), [ctxRenderKey])
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const semanticOperationPageSize = Math.max(5, Number(getPref('semantic-operation-page-size')) || 40)

  const docRef = useRef<typeof doc>(doc)
  useEffect(() => { docRef.current = doc }, [doc])
  const shapeContainerRef = useRef<HTMLDivElement>(null)

  const openMarkdownColumn = useCallback((title: string, markdown: string, sourceEl: HTMLElement, source?: { path?: string; section?: string }) => {
    openChatMarkdownColumn({
      editor,
      sourceShapeId: shape.id,
      title,
      markdown,
      sourceEl,
      placementEl: shapeContainerRef.current,
      sourcePath: source?.path,
      sourceSection: source?.section,
      logPrefix: 'fleet-chat',
    })
  }, [editor, shape.id])

  // Incremental render cache: non-activity messages are independent and can be
  // cached by (msgKey, ctxVersion). When ctx changes (agent rename, task done),
  // bump ctxVersion to invalidate stale lines. This turns O(N) re-render on
  // every new message into O(1) for the common case of appending one message.
  const msgLineCache = useRef<Map<string, string>>(new Map())
  const activityGroupCache = useRef<Map<string, string>>(new Map())
  const prevContentRenderKeyRef = useRef(contentRenderKey)
  const capRenderCache = useCallback((cache: Map<string, string>, maxEntries: number) => {
    while (cache.size > maxEntries) {
      const first = cache.keys().next()
      if (first.done) break
      cache.delete(first.value)
    }
  }, [])
  if (prevContentRenderKeyRef.current !== contentRenderKey) {
    recordChatRenderProbe('render-cache-clear', shape.id, {
      prevLength: prevContentRenderKeyRef.current.length,
      nextLength: contentRenderKey.length,
      agentCount: ctxAgents.length,
      taskCount: ctxTasks.length,
    })
    prevContentRenderKeyRef.current = contentRenderKey
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
      // Match the server history contract: chronological by event timestamp,
      // with DB id only as the deterministic tie-breaker. Reconnect backfill is
      // rowid-based so it can recover missed rows, but rendering by rowid made
      // delayed terminal/activity/chat rows appear minutes out of chronological
      // place when they were persisted late. Pending optimistic sends have no
      // db id and naturally sort to the live tail until the server timestamp
      // arrives.
      .sort(compareChatMessagesChronologically)

    if (isManagedSurfaceProofFixtureEnabled()) {
      sorted.push(createManagedSurfaceProofMessage(shape.id))
    }

    probe.stop(chatSortTimer, { eventCount: events.length, resultCount: sorted.length })
    // What THIS panel believes its last message is, reported alongside what the
    // transport has seen. Their divergence is the freeze; carrying both in one
    // record is what makes it a subtraction instead of a timestamp join across
    // two series. Transition-only — see chat-freeze-probe.mjs.
    const tail: any = sorted.length ? sorted[sorted.length - 1] : null
    notePanelTail(String(shape.id), {
      messageCount: sorted.length,
      lastDbId: tail?._dbId ?? null,
      lastEventId: getLastEventId(),
      filterKey,
      bufferKey: chatEventBufferKey,
    })
    return sorted
  }, [events, quietDmTraffic])

  // Unread-per-sender for the rail, read from the rail's own to-me buffer. Same
  // count the browser-wide store used to answer: chat messages addressed to me
  // that I have not read, grouped by who sent them.
  const railIdentity = useFleetIdentity()
  const railMe = railIdentity.name || railIdentity.id || ''
  const railEvents = useFleetEvents(unreadRailFilter(railMe), undefined, unreadRailBufferKey(shape.id))
  const unreadRailCounts = useMemo(() => {
    const humanId = getHumanId()
    const counts: Record<string, number> = {}
    if (!humanId) return counts
    for (const event of railEvents) {
      if (event.type !== 'chat' || event.read === true || !event.from) continue
      counts[event.from] = (counts[event.from] || 0) + 1
    }
    return counts
  }, [railEvents])

  const displayedUnreadSenderIds = useMemo(() => {
    const humanId = getHumanId()
    const ids = new Set<string>()
    if (!humanId) return ids
    for (const message of chatMessages) {
      if (message.type === 'chat' && message.read !== true && message.to === humanId && message.from) {
        ids.add(message.from)
      }
    }
    return ids
  }, [chatMessages])

  // The scroller is durable for the shape lifetime. A second non-null identity
  // is therefore an invariant violation rather than a routine render event.
  const mountedChatLogRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!chatLogEl) return
    if (mountedChatLogRef.current && mountedChatLogRef.current !== chatLogEl) {
      log.metric('chat-scroll', 'durable chat viewport was replaced', { panelId: String(shape.id) })
    }
    mountedChatLogRef.current = chatLogEl
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

  // Build per-item raw HTML array — each item is an independent renderable unit.
  // This replaces the old joined renderedHtml string and enables virtualization.
  // Items tagged _queued render below the thinking indicator; _interrupt items
  // render between the indicator and the queue (they "jump the line"). The
  // status row is a real measured item so Virtuoso remains the only scroll
  // authority when status/suggestions change height.
  type RawItem = { key: string; html: string; _queued?: boolean; _interrupt?: boolean; _divider?: boolean; _status?: boolean }
  const msgLineCacheLimit = useMemo(
    () => Math.min(20_000, Math.max(1_000, chatMessages.length + 500)),
    [chatMessages.length],
  )
  const activityGroupCacheLimit = useMemo(
    () => Math.min(5_000, Math.max(250, Math.ceil(chatMessages.length / 4) + 250)),
    [chatMessages.length],
  )
  // Short hash of the version currently shown in the viewer (accounts for
  // scrubbing to a historical version). Build cards compare against this to
  // style themselves green (you're viewing this build) vs gray (stale).
  const viewingVersion = currentDocVersion(panel, editor)
  const rawItems = useMemo(() => {
    const rawItemsT0 = probe.isEnabled('chat') ? performance.now() : 0
    // Extend ctx with thinking state so renderChatLine can apply queued styling
    // sendTargets goes in so a line can tell whether its recipients ARE this
    // panel's default target — the set whose printing is omitted.
    const renderCtx = { ...ctx, thinkingAgents, sendTargets }
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
        contentRenderKey,
        activityGroup.map((a: any) => a._dbId ?? a._tempId ?? `${a.from}:${a.timestamp}:${a.text || ''}`).join(','),
      ].join('::')
      let html = activityGroupCache.current.get(cacheKey)
      const cached = !!html
      if (!html) {
        recordChatRenderProbe('activity-render', key, { groupSize })
        const browserRenderQueuedAtMs = Date.now()
        for (const activity of activityGroup) {
          activity._activityLatency = {
            ...(activity._activityLatency || {}),
            browserRenderQueuedAt: new Date(browserRenderQueuedAtMs).toISOString(),
            browserRenderQueuedAtMs,
          }
        }
        html = `<div class="chat-activity-inline-wrap">${renderActivityGroup(activityGroup, renderCtx)}</div>`
        activityGroupCache.current.set(cacheKey, html)
        capRenderCache(activityGroupCache.current, activityGroupCacheLimit)
      } else {
        recordChatRenderProbe('activity-cache-hit', key, { groupSize })
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
      const msgTs = m.timestamp ? new Date(m.timestamp).getTime() : 0
      // One event, many recipients: it is queued while ANY recipient it was
      // addressed to started thinking before it arrived.
      const queuedBehind = (m.recipients || []).some((id: string) => {
        const since = thinkingAgents?.get?.(id)
        return since && msgTs >= since
      })
      if (!queuedBehind) return false
      if (unqueuedAt && msgTs <= unqueuedAt) return false
      return true
    }

    for (let i = 0; i < chatMessages.length; i++) {
      const m = chatMessages[i]
      if (m._activity) {
        if (activityGroup.length > 0 && activityGroup[0].from !== m.from) flushActivity()
        activityGroup.push(m)
        activityGroupHasVisible = true
      } else if (m.metadata?.type === 'build_result') {
        flushActivity()
        buildResultCount++
        const { name: projectName, hash, summary, lintFindings = [], mirrorFailed, buildFailed, errors = [] } = m.metadata
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
        else if (projectName === doc) statusCls = (viewingVersion && viewingVersion === builtHash) ? 'build-result-current' : 'build-result-stale'
        const title = buildFailed
          ? `Build failed — <strong>${esc(projectName)}</strong>`
          : `Build <code>${esc(hash)}</code> — <strong>${esc(projectName)}</strong>`
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
        specialCount++
        const agentObjs: any[] = renderCtx.getAgents()
        // A kill-session addresses exactly one agent.
        const targetId = m.recipients?.[0] || ''
        const targetAgent = agentObjs.find((a: any) => a.id === targetId)
        const targetName = targetAgent?.friendly_name || targetId.replace('fleet:', '')
        const html = `<div class="kill-session-card"><span class="kill-session-icon">⚡</span><span class="kill-session-text">Session killed: <strong>${esc(targetName)}</strong></span></div>`
        items.push({ key: m._dbId || m._tempId || `${m.timestamp}:${m.from}:kill`, html })
      } else if (m.type === 'interrupt') {
        flushActivity()
        specialCount++
        const agentObjs: any[] = renderCtx.getAgents()
        // An interrupt addresses exactly one agent.
        const targetId = m.recipients?.[0] || ''
        const targetAgent = agentObjs.find((a: any) => a.id === targetId)
        const targetName = targetAgent?.friendly_name || targetId.replace('fleet:', '')
        const html = `<div class="kill-session-card"><span class="kill-session-icon">⏸</span><span class="kill-session-text">Interrupted: <strong>${esc(targetName)}</strong></span></div>`
        items.push({ key: m._dbId || m._tempId || `${m.timestamp}:${m.from}:interrupt`, html })
      } else {
        flushActivity()
        // Fold amends: if this message has amend events, show the viewed
        // version's text (+ its own source, so the chip is per-version) and a
        // V{n} ◀▶ stepper. Un-amended messages render untouched.
        let renderM = m
        const amends = (m._dbId != null) ? amendsByOrig.get(m._dbId) : undefined
        if (amends && amends.length) {
          const versions = [
            { text: m.text, metadata: m.metadata || null, inlineAttachments: m._inlineAttachments || null },
            ...amends.map((a: any) => ({ text: a.text, metadata: a.metadata || null, inlineAttachments: a._inlineAttachments || null })),
          ]
          const total = versions.length
          const viewIdx = Math.min(amendView.get(m._dbId) ?? (total - 1), total - 1)
          const backDis = viewIdx <= 0 ? ' disabled' : ''
          const fwdDis = viewIdx >= total - 1 ? ' disabled' : ''
          const oid = esc(String(m._dbId))
          const stepper = `<span class="amend-versions" data-orig="${oid}"><button class="amend-arrow"${backDis} data-orig="${oid}" data-total="${total}" data-dir="back" title="older version">◀</button><span class="amend-vlabel">V${viewIdx + 1}</span><button class="amend-arrow"${fwdDis} data-orig="${oid}" data-total="${total}" data-dir="fwd" title="newer version">▶</button></span>`
          const v = versions[viewIdx]
          const metadata = { ...(m.metadata || {}), ...(v.metadata || {}) }
          renderM = { ...m, text: v.text, metadata, _inlineAttachments: v.inlineAttachments || metadata.inline_attachments || m._inlineAttachments, _amendStepper: stepper }
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
        const participantRenderKey = [m.from, ...(m.recipients || []), m.agent, m.agent_id]
          .filter(Boolean)
          .map((id: string) => {
            const agent = agentById.get(id)
            return agent ? agentRenderSignature(agent).join('~') : id
          })
          .join('|')
        const instrumentedLineCtx = {
          ...lineCtx,
          renderMarkdown: (input: string) => {
            recordChatRenderProbe('markdown-render', String(itemKey), { inputLength: input.length })
            return lineCtx.renderMarkdown(input)
          },
        }
        const cacheKey = [
          contentRenderKey,
          thinkingKey,
          sendTargetsKey,
          itemKey,
          participantRenderKey,
          renderM.text || '',
          renderM._amendStepper || '',
          senderPreambleDoc || '',
          lineMacros === preambleMacros ? 'viewer' : senderPreambleDoc || 'sender',
          JSON.stringify(renderM.metadata?.source || null),
          chatLineAttachmentRenderSignature(renderM),
        ].join('::')
        let html = msgLineCache.current.get(cacheKey)
        const t0 = probe.isEnabled('chat') ? performance.now() : 0
        const cached = !!html
        if (!html) {
          recordChatRenderProbe('chat-line-render', String(itemKey), {
            type: m.type,
            evType: m._evType || '',
            textLength: String(renderM.text || '').length,
          })
          html = renderChatLine(renderM, instrumentedLineCtx)
          msgLineCache.current.set(cacheKey, html)
          capRenderCache(msgLineCache.current, msgLineCacheLimit)
        } else {
          recordChatRenderProbe('chat-line-cache-hit', String(itemKey), {
            type: m.type,
            evType: m._evType || '',
            textLength: String(renderM.text || '').length,
          })
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
        }
      }
    }
    flushActivity()
    if (probe.isEnabled('chat')) {
      const dt = performance.now() - rawItemsT0
      const detail = {
        messageCount: chatMessages.length,
        itemCount: items.length,
        chatLineCount,
        activityGroupCount,
        buildResultCount,
        specialCount,
        eventCount: events.length,
      }
      probe.record('chat', 'chat-build-raw-items', dt, detail)
      probe.record('chat', 'chat-build-items', dt, detail)
    }
    return items
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages, ctx, thinkingAgents, sendTargetsKey, unqueuedAt, viewingVersion, doc, amendsByOrig, amendView, macrosByDoc, preambleMacros, msgLineCacheLimit, activityGroupCacheLimit, contentRenderKey, agentById])

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
          const anchoredSrcLines = srcLineArr.filter((sl: any) => sl?.anchored !== false && Number.isFinite(Number(sl?.line)))
          const hlSrcLines = anchoredSrcLines.filter((sl: any) => sl.highlighted)
          const firstSrcLine = hlSrcLines.length > 0 ? hlSrcLines[0] : anchoredSrcLines[0]
          const anchor = meta?.sourceAnchor  // fallback for old shapes
          const anchoredAnchor = anchor?.anchored !== false && Number.isFinite(Number(anchor?.line)) ? anchor : null
          ref = {
            type: typePrefix || 'annotation',
            label: display,
            content: srcShape.props?.text || meta?.highlightText || '',
            color: srcShape.props?.color || meta?.glowColor,
            canvasBounds: refBounds ? { x: refBounds.x, y: refBounds.y, w: refBounds.w, h: refBounds.h } : undefined,
            shapeId: embeddedShapeId,
            highlightShapeId: highlight?.id,
            screenshotRef: refBounds ? `tlda-screenshot:page:page:${refBounds.x.toFixed(0)},${refBounds.y.toFixed(0)},${refBounds.w.toFixed(0)},${refBounds.h.toFixed(0)}` : undefined,
            file: firstSrcLine?.file || anchoredAnchor?.file,
            lineno: firstSrcLine?.line || anchoredAnchor?.line,
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
  // the first queued item gets _divider: true. Status/suggestions stay in the
  // measured list as the trailing row instead of a flex footer below Virtuoso.
  const allItems = useMemo(() => {
    const items = [...rawItems]
    let firstQueuedIdx = -1
    for (let i = 0; i < items.length; i++) {
      if (items[i]._queued) { firstQueuedIdx = i; break }
    }
    if (firstQueuedIdx > 0) {
      items[firstQueuedIdx - 1] = { ...items[firstQueuedIdx - 1], _divider: true }
    }
    items.push({ key: '__status__', html: '', _status: true })
    return items
  }, [rawItems])
  // Virtuoso needs a stable logical index when rows are prepended. Without it,
  // loading the previous subscription page reinterprets the new first row as
  // index zero and jumps the viewport to the oldest fetched message.
  const virtuosoFirstItemIndexRef = useRef(1_000_000)
  const previousVirtuosoItemKeysRef = useRef<string[]>([])
  const previousVirtuosoFilterKeyRef = useRef(filterKey)
  const nextVirtuosoItemKeys = allItems.map(item => item.key)
  if (previousVirtuosoFilterKeyRef.current !== filterKey) {
    previousVirtuosoFilterKeyRef.current = filterKey
    virtuosoFirstItemIndexRef.current = 1_000_000
  } else {
    const previousKeys = previousVirtuosoItemKeysRef.current
    const previousKeyIndexes = new Map(previousKeys.map((key, index) => [key, index]))
    for (let nextIndex = 0; nextIndex < nextVirtuosoItemKeys.length; nextIndex++) {
      const previousIndex = previousKeyIndexes.get(nextVirtuosoItemKeys[nextIndex])
      if (previousIndex === undefined) continue
      const prependedCount = nextIndex - previousIndex
      if (prependedCount > 0) {
        virtuosoFirstItemIndexRef.current -= prependedCount
      }
      break
    }
  }
  previousVirtuosoItemKeysRef.current = nextVirtuosoItemKeys
  const virtuosoFirstItemIndex = virtuosoFirstItemIndexRef.current
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

  const openMarkdownChipFromTarget = useCallback((target: HTMLElement, stopPropagation: () => void): boolean => {
    return openMarkdownChipFromTargetElement({ target, stopPropagation, openMarkdownColumn })
  }, [openMarkdownColumn])

  // Handle clicks on doc-link spans
  const handleDocLinkClick = useCallback((e: React.MouseEvent) => {
    // Plain URL links — open in new tab (TLDraw intercepts native <a> navigation)
    const chatLink = (e.target as HTMLElement).closest('.chat-link') as HTMLAnchorElement | null
    if (chatLink?.href) { e.preventDefault(); window.open(chatLink.href, '_blank'); return }

    // Also check for annotation chip clicks
    const chipTarget = (e.target as HTMLElement).closest('.ref-chip-annotation')
    if (chipTarget) { handleRefChipClick(e); return }

    if (openMarkdownChipFromTarget(e.target as HTMLElement, () => e.stopPropagation())) return

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
      const dvShape = mainEd.getCurrentPageShapes()
        .filter((s: any) => s.type === 'fleet-docview')
        .find((s: any) => {
          try { return JSON.parse(s.props?.sources || '["ref"]').includes('ref') } catch { return true }
        })
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
  }, [doc, refResolver, editor, handleRefChipClick, openMarkdownChipFromTarget])

  const inputAreaRef = useRef<HTMLDivElement>(null)
  const dragClearTimerRef = useRef<number | null>(null)
  const [dragLozenges, setDragLozenges] = useState<Array<'image' | 'file'> | null>(null)
  const [shapeDropActive, setShapeDropActive] = useState(false)
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
      if (dragCoordinator.isActive || hasActiveFleetPill()) return
      const chip = (e.target as HTMLElement).closest('.ref-chip[data-token], .apply-ref[data-token]') as HTMLElement | null
      if (!chip) return
      // Don't handle annotation chips here (they use AnnotationViewer)
      if (chip.classList.contains('ref-chip-annotation')) return
      // Delay to avoid accidental triggers
      await new Promise(r => setTimeout(r, 500))
      if (dragCoordinator.isActive || hasActiveFleetPill()) return
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
      if (!matchEvent) return

      // Remove any existing popover
      document.querySelector('.chip-hover-popover')?.remove()

      // Render the event as chat HTML
      const popover = document.createElement('div')
      popover.className = 'chip-hover-popover fleet-chat-shape'
      let rendered: string
      if (matchEvent._activity && ctxRef.current) {
        const matchIdx = liveEvents.indexOf(matchEvent)
        const agentId = matchEvent.from
        let start = matchIdx
        while (start > 0 && liveEvents[start - 1]._activity && liveEvents[start - 1].from === agentId) start--
        let end = matchIdx
        while (end < liveEvents.length - 1 && liveEvents[end + 1]._activity && liveEvents[end + 1].from === agentId) end++
        const group = liveEvents.slice(start, end + 1)
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

  useEffect(() => {
    return subscribeFleetChatInputDropPreview(shape.id, setShapeDropActive)
  }, [shape.id])

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
    function onNickOver(e: MouseEvent) {
      // Native tldraw pill translation does not use dragCoordinator. Both drag
      // paths suppress the name hover that would otherwise cover the filter UI.
      if (dragCoordinator.isActive || hasActiveFleetPill()) return
      const nick = (e.target as HTMLElement).closest('.agent-nick[data-agent-id]') as HTMLElement | null
      if (!nick) return
      const agentId = nick.dataset.agentId
      if (!agentId) return
      if (skillHideTimerRef.current) { clearTimeout(skillHideTimerRef.current); skillHideTimerRef.current = null }
      if (skillShowTimerRef.current) clearTimeout(skillShowTimerRef.current)
      skillShowTimerRef.current = setTimeout(() => {
        skillShowTimerRef.current = null
        if (dragCoordinator.isActive || hasActiveFleetPill()) return
        if (!nick.matches(':hover')) return
        const r = nick.getBoundingClientRect()
        setSkillHover({ agentId: agentId!, agentName: nick.textContent?.trim() || agentId!, rect: { left: r.left, bottom: r.bottom, top: r.top } })
      }, 450)
    }
    function onNickOut(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest?.('.agent-nick[data-agent-id]')) return
      if (skillShowTimerRef.current) { clearTimeout(skillShowTimerRef.current); skillShowTimerRef.current = null }
      skillHideTimerRef.current = setTimeout(() => setSkillHover(null), 220)
    }
    logEl.addEventListener('mouseover', onNickOver)
    logEl.addEventListener('mouseout', onNickOut)
    return () => {
      if (skillShowTimerRef.current) { clearTimeout(skillShowTimerRef.current); skillShowTimerRef.current = null }
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
      const nodes = logEl.querySelectorAll<HTMLElement>('.chat-timer-countdown[data-timer-until], .lc-task-schedule[data-timer-until]')
      for (const node of nodes) {
        const until = node.getAttribute('data-timer-until')
        const span = node.querySelector<HTMLElement>('.ticker-countdown')
        if (!until || !span) continue
        const r = Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 1000))
        const mins = Math.floor(r / 60)
        const secs = r % 60
        const timeStr = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}s`
        setTickerText(span, timeStr)
      }
      // ScheduleWakeup cards: same idea — recompute the "in Xm Ys" countdown each
      // second from the absolute fire epoch baked into data-fire-at.
      const schedNodes = logEl.querySelectorAll<HTMLElement>('.tool-pretty-schedule[data-fire-at]')
      for (const node of schedNodes) {
        const fireAt = parseInt(node.getAttribute('data-fire-at') || '0', 10)
        const span = node.querySelector<HTMLElement>('.schedule-time')
        if (!fireAt || !span) continue
        setTickerText(span, scheduleTimeLabel(fireAt))
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

  // Reader mode is the only scroll-intent state. Content/layout never changes it.
  const userScrolledUpRef = useRef(false)
  const viewportAnchorRef = useRef<{ key: string; top: number } | null>(null)
  // True while a finger-driven scroll is in flight: from touchdown through the
  // momentum glide that follows the release, until the scroller goes quiet.
  const touchScrollActiveRef = useRef(false)
  // A scrollTop delta is not evidence of reader intent: Virtuoso re-anchors
  // rows while their measured content changes, and those internal moves emit
  // the same scroll event as a person. Only a live input gesture may change
  // reader/follow mode.
  const explicitScrollInputRef = useRef(false)
  const explicitScrollInputTimerRef = useRef(0)
  const followInvariantTimerRef = useRef(0)
  const goToTailRunRef = useRef(0)
  const deferredGeometryReconcileRef = useRef(false)
  // The geometry seam records the scrollTop it writes. The next matching scroll
  // event updates measurements but cannot be interpreted as reader intent.
  const geometryReconcileScrollTopRef = useRef<number | null>(null)
  // Reactive bottom-position state. Drives the unified follow/jump button:
  // at bottom → follow-mode toggle (horseshoe); off bottom → ⇣ jump-to-bottom.
  // Position (not scroll-intent) is the right signal here — matches the spec
  // "at the bottom it toggles the mode; off the bottom it's click-to-go-down."
  const [atBottom, setAtBottom] = useState(true)
  const [termHoverVisible, setTermHoverVisible] = useState(false)
  const [termHoverPinned, setTermHoverPinned] = useState(false)
  // An explicit pick — an icon click or hover, a transcript terminal card, or
  // /terminal — names an agent this panel's filter need not name, so it is
  // recorded together with the filter it was made under. termHoverAgentId is
  // derived from it further down and falls back to the filter's own terminal
  // target, which is what makes the hover follow the filter instead of holding
  // whoever happened to be picked first.
  const [termHoverPick, setTermHoverPick] = useState<{ agentId: string; filterKey: string } | null>(null)
  // The transcript listeners are attached once per chatLogEl, so they read the
  // live filter key from a ref rather than a closure that would go stale.
  const filterKeyRef = useRef(filterKey)
  filterKeyRef.current = filterKey
  const pickTerminalHover = useCallback((agentId: string | null) => {
    setTermHoverPick(agentId ? { agentId, filterKey: filterKeyRef.current } : null)
  }, [])
  // Which agent the hover is currently PINNED to, readable from the delegated
  // transcript click listener. That listener is attached once per chatLogEl, so
  // it cannot read termHoverPinned/termHoverAgentId from its closure without
  // going stale — the card code it replaces used a functional setState for the
  // same reason.
  const termHoverPinnedIdRef = useRef<string | null>(null)
  const [composerDraftVersion, setComposerDraftVersion] = useState(0)
  const captureViewportAnchor = useCallback(() => {
    const el = chatLogRef.current
    if (!el || !userScrolledUpRef.current) {
      viewportAnchorRef.current = null
      return
    }
    const viewportTop = el.getBoundingClientRect().top
    const rows = el.querySelectorAll<HTMLElement>('[data-chat-item-key]')
    for (const row of rows) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom <= viewportTop + 0.5) continue
      const key = row.dataset.chatItemKey || ''
      const top = rect.top - viewportTop
      const previous = viewportAnchorRef.current
      // Observation only — this still re-baselines exactly as before, and that
      // re-baselining is the bug: the anchored row moved with no gesture behind
      // it, and recording the new position as the truth is what makes the drift
      // permanent and silent. What is missing is not the correction, it is the
      // measurement. `scrollTop`/`scrollHeight` are here because the last attempt
      // to correct this asked for 450px of scroll from an element with roughly
      // 106px of range, and that had to be inferred afterwards from a neighbouring
      // record. With the pair on the record it is a measurement, not an inference:
      // the correction is impossible whenever |drift| exceeds the range on offer.
      if (previous && previous.key === key
          && !(touchScrollActiveRef.current || explicitScrollInputRef.current)
          && Math.abs(top - previous.top) > 1) {
        log.metric('chat-anchor', 'anchor drifted with no input', {
          panelId: String(shape.id),
          anchorKey: key,
          drift: Math.round(top - previous.top),
          scrollTop: Math.round(el.scrollTop),
          scrollHeight: Math.round(el.scrollHeight),
          clientHeight: Math.round(el.clientHeight),
        })
      }
      viewportAnchorRef.current = { key, top }
      return
    }
    viewportAnchorRef.current = null
  }, [shape.id])

  const restoreViewportAnchor = useCallback(() => {
    const el = chatLogRef.current
    const anchor = viewportAnchorRef.current
    if (!el || !userScrolledUpRef.current || !anchor?.key || touchScrollActiveRef.current) return false
    const viewportTop = el.getBoundingClientRect().top
    const rows = el.querySelectorAll<HTMLElement>('[data-chat-item-key]')
    const row = [...rows].find(candidate => candidate.dataset.chatItemKey === anchor.key)
    if (!row) {
      // The anchored row left the DOM. Virtuoso unmounts rows outside its render
      // window, which is what a reanchor does — so this is the likely state
      // exactly when the viewport most needs holding. Nothing corrects the
      // position after this return and the reader drifts. The success case below
      // has always been recorded; this is the other half of the same story.
      log.metric('chat-anchor', 'anchor row gone; viewport left uncorrected', {
        panelId: String(shape.id),
        anchorKey: anchor.key,
        renderedRows: rows.length,
        top: el.scrollTop,
      })
      return false
    }
    const delta = row.getBoundingClientRect().top - viewportTop - anchor.top
    if (Math.abs(delta) <= 0.5) return true
    geometryReconcileScrollTopRef.current = el.scrollTop + delta
    el.scrollTop += delta
    geometryReconcileScrollTopRef.current = el.scrollTop
    log.metric('chat-anchor', 'preserved viewport across content resize', {
      panelId: String(shape.id),
      anchorKey: anchor.key,
      delta: Math.round(delta),
    })
    return true
  }, [shape.id])

  const reconcileViewportGeometry = useCallback(() => {
    const el = chatLogRef.current
    if (!el) return
    if (touchScrollActiveRef.current) {
      // Where the skip actually happens. restoreViewportAnchor has its own
      // touchScrollActive term, but this early return is its only caller's
      // first act, so that term never decides anything — instrumenting it
      // would have recorded a permanent zero. One record per gesture: the
      // deferred flag is already the dedupe.
      if (!deferredGeometryReconcileRef.current) {
        log.metric('chat-anchor', 'geometry reconcile deferred; touch gesture in flight', {
          panelId: String(shape.id),
          anchorKey: viewportAnchorRef.current?.key ?? null,
          scrolledUp: userScrolledUpRef.current,
          top: el.scrollTop,
        })
      }
      deferredGeometryReconcileRef.current = true
      return
    }
    deferredGeometryReconcileRef.current = false
    if (userScrolledUpRef.current && !hardLockedRef.current) {
      restoreViewportAnchor()
      captureViewportAnchor()
      return
    }
    geometryReconcileScrollTopRef.current = el.scrollHeight
    el.scrollTop = el.scrollHeight
    geometryReconcileScrollTopRef.current = el.scrollTop
  }, [captureViewportAnchor, restoreViewportAnchor, shape.id])

  useLayoutEffect(() => {
    const el = chatLogEl
    const list = el?.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
    if (!el || !list) return
    const observer = new ResizeObserver(reconcileViewportGeometry)
    observer.observe(list)
    return () => observer.disconnect()
  }, [chatLogEl, reconcileViewportGeometry])

  const termHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // This panel's composer text survives any shape recreation. See composerDraftStore.
  const composerDraftKey = `chat:${shape.id}`
  const composerVoiceTargetSnapshotRef = useRef<(() => VoiceTargetHandle) | null>(null)
  const termAutoPinnedRef = useRef(false)
  // Skill-state hover popover (hovering an agent name in chat)
  const [skillHover, setSkillHover] = useState<{ agentId: string; agentName: string; rect: { left: number; bottom: number; top: number } } | null>(null)
  const skillShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skillHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Hover panes are transient even when the element that opened them is replaced
  // before mouseout fires. Dismiss on the next action away from the source/pane,
  // or whenever the page loses interaction state.
  useEffect(() => {
    if (!skillHover) return
    const dismiss = () => setSkillHover(null)
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.fleet-skill-hover-pane')) return
      const nick = target?.closest<HTMLElement>('.agent-nick[data-agent-id]')
      if (nick?.dataset.agentId === skillHover.agentId) return
      dismiss()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    const onVisibilityChange = () => {
      if (document.hidden) dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    document.addEventListener('keydown', onKeyDown, { capture: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', dismiss)
    window.addEventListener('pagehide', dismiss)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
      document.removeEventListener('keydown', onKeyDown, { capture: true })
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('pagehide', dismiss)
    }
  }, [skillHover])
  const lastAttentionTsRef = useRef<string | null>(null)
  // Tracks which chat rows have been expanded (by item key) so the state
  // survives dangerouslySetInnerHTML re-renders.
  const expandedRowsRef = useRef<Set<string>>(new Set())
  // Hard lock is an explicit preference orthogonal to reader mode.
  const HARD_LOCKED_KEY = 'fleet-chat-hard-locked'
  const [hardLocked, setHardLocked] = useState(() => localStorage.getItem(HARD_LOCKED_KEY) === 'true')
  const hardLockedRef = useRef(hardLocked)
  useEffect(() => {
    hardLockedRef.current = hardLocked
    localStorage.setItem(HARD_LOCKED_KEY, String(hardLocked))
    setFleetEventsLiveTailPinned(shape.id, hardLocked || !userScrolledUpRef.current, chatEventBufferKey)
    noteFollowTransition(String(shape.id), 'hard-lock', {
      enabled: hardLocked,
      scrolledUp: userScrolledUpRef.current,
      bufferKey: chatEventBufferKey,
    })
  }, [hardLocked, shape.id, chatEventBufferKey])

  useEffect(() => {
    setFleetEventsLiveTailPinned(shape.id, hardLockedRef.current || !userScrolledUpRef.current, chatEventBufferKey)
    return () => clearFleetEventsLiveTailPinned(shape.id, chatEventBufferKey)
  }, [shape.id, chatEventBufferKey])

  const goToTail = useCallback((reason: string) => {
    const run = ++goToTailRunRef.current
    userScrolledUpRef.current = false
    viewportAnchorRef.current = null
    setFleetEventsLiveTailPinned(shape.id, true, chatEventBufferKey)
    let frame = 0
    let stableBottomFrames = 0
    let lastHeight = -1

    const step = () => {
      if (goToTailRunRef.current !== run) return

      try {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
      } catch (e) {
        log.metric('chat-scroll', 'go-to-tail scrollToIndex failed', {
          panelId: String(shape.id), reason, e: String(e),
        })
        return
      }

      requestAnimationFrame(() => {
        if (goToTailRunRef.current !== run) return
        const el = chatLogRef.current
        const gap = el ? el.scrollHeight - (el.scrollTop + el.clientHeight) : Number.POSITIVE_INFINITY
        const height = el?.scrollHeight ?? -1
        stableBottomFrames = isTrueBottomGap(gap) && height === lastHeight ? stableBottomFrames + 1 : 0
        lastHeight = height

        if (stableBottomFrames >= 1) {
          return
        }

        frame += 1
        if (frame < 12) {
          requestAnimationFrame(step)
        } else {
          log.metric('chat-scroll', 'go-to-tail stopped before stable true bottom', {
            panelId: String(shape.id),
            reason,
            gap,
            height,
          })
        }
      })
    }

    requestAnimationFrame(step)
  }, [shape.id, chatEventBufferKey])

  const checkFollowInvariant = useCallback((reason: string) => {
    if (followInvariantTimerRef.current) clearTimeout(followInvariantTimerRef.current)
    const run = () => {
      followInvariantTimerRef.current = 0
      if (userScrolledUpRef.current && !hardLockedRef.current) return
      const el = chatLogRef.current
      if (!el) return
      // An input gesture in flight is the reader, mid-move: repairing through it
      // throws them to the tail with a finger still on the glass. Both flags
      // clear on their own — touch settle, or 250ms after the last wheel — so
      // wait rather than overrule a gesture that has not finished deciding.
      if (touchScrollActiveRef.current || explicitScrollInputRef.current) {
        followInvariantTimerRef.current = window.setTimeout(run, FOLLOW_INVARIANT_MS)
        return
      }
      const gap = el.scrollHeight - (el.scrollTop + el.clientHeight)
      if (isTrueBottomGap(gap)) return
      log.metric('chat-scroll', 'follow invariant violated; repairing tail', {
        panelId: String(shape.id),
        reason,
        top: el.scrollTop,
        height: el.scrollHeight,
        clientHeight: el.clientHeight,
        gap,
        inputActive: touchScrollActiveRef.current || explicitScrollInputRef.current,
      })
      goToTail('follow-invariant-repair')
    }
    followInvariantTimerRef.current = window.setTimeout(run, FOLLOW_INVARIANT_MS)
  }, [goToTail, shape.id])

  const scrollToBottom = useCallback(() => {
    goToTail('jump-button')
  }, [goToTail])

  const enterReaderMode = useCallback((reason: string) => {
    if (hardLockedRef.current || userScrolledUpRef.current) return
    // Reader mode means "I am looking at something above the tail". At the
    // bottom there is nothing above to look at, so no gesture may enter it —
    // and the test lives here, in the one entry, rather than in each caller,
    // because every input device arrives at the same place by a different
    // route: a trackpad's sub-pixel ticks and a mouse's ~100px notches both
    // land on deltaY < 0, and a finger's rubber-band drag at the tail clears
    // TOUCH_READER_INTENT_PX without revealing anything.
    // Entering anyway strands the reader: resuming needs one scroll event over
    // UP_JITTER_EPS and there is no room below the bottom to produce one.
    const el = chatLogRef.current
    if (el && isTrueBottomGap(el.scrollHeight - (el.scrollTop + el.clientHeight))) return
    goToTailRunRef.current += 1
    userScrolledUpRef.current = true
    setFleetEventsLiveTailPinned(shape.id, false, chatEventBufferKey)
    noteFollowTransition(String(shape.id), 'follow-off', {
      reason,
      bufferKey: chatEventBufferKey,
    })
  }, [shape.id, chatEventBufferKey])

  // The exit, and the sibling of enterReaderMode: a gesture that settles at
  // the true bottom IS the reader returning. One rule; each device's settle
  // detector calls it, because "input finished" means something different to a
  // wheel (no ticks for 250ms) than to a finger (lifted, and the glide stopped).
  const resumeFollowIfSettledAtBottom = useCallback((reason: string) => {
    const el = chatLogRef.current
    if (!el || !userScrolledUpRef.current) return
    const gap = el.scrollHeight - (el.scrollTop + el.clientHeight)
    if (!isTrueBottomGap(gap)) return
    noteFollowTransition(String(shape.id), 'follow-on', {
      reason,
      top: el.scrollTop,
      height: el.scrollHeight,
      clientHeight: el.clientHeight,
      gap,
      bufferKey: chatEventBufferKey,
    })
    userScrolledUpRef.current = false
    viewportAnchorRef.current = null
    setFleetEventsLiveTailPinned(shape.id, true, chatEventBufferKey)
  }, [shape.id, chatEventBufferKey])

  useEffect(() => {
    const el = chatLogEl
    if (!el) return
    const markExplicitScrollInput = () => {
      explicitScrollInputRef.current = true
      if (explicitScrollInputTimerRef.current) clearTimeout(explicitScrollInputTimerRef.current)
      explicitScrollInputTimerRef.current = window.setTimeout(() => {
        explicitScrollInputTimerRef.current = 0
        explicitScrollInputRef.current = false
        // Wheel and trackpad settle here. Touch does not: this timer counts
        // from the last touchmove, and the momentum glide outlives it, so a
        // finger settles through armSettle below instead.
        if (!touchScrollActiveRef.current) resumeFollowIfSettledAtBottom('wheel-settle-at-bottom')
      }, 250)
    }
    const handleWheelCapture = (e: WheelEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (!target || !el.contains(target)) return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      markExplicitScrollInput()
      // Trackpad deltas commonly arrive below UP_JITTER_EPS one event at a
      // time. The wheel event itself proves reader intent, so enter reader
      // mode before Virtuoso can follow a concurrently arriving row — but
      // scroll FIRST, because enterReaderMode's at-bottom test has to read
      // where this tick landed, not where it started. Both statements run in
      // one synchronous block, so Virtuoso still cannot interleave.
      el.scrollTop += e.deltaY
      if (e.deltaY < 0) {
        enterReaderMode('wheel-up')
        captureViewportAnchor()
      }
    }
    // A touch-driven scroll runs past the release: the finger lifts and the
    // scroller keeps gliding. Treat it as in flight until scroll events stop
    // arriving, so nothing writes scrollTop and cancels the glide.
    let fingerDown = false
    let settleTimer = 0
    const armSettle = () => {
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => {
        settleTimer = 0
        if (!fingerDown) {
          touchScrollActiveRef.current = false
          // Touch's settle detector. Same rule as the wheel's above.
          resumeFollowIfSettledAtBottom('touch-settle-at-bottom')
          if (deferredGeometryReconcileRef.current) reconcileViewportGeometry()
        }
      }, TOUCH_SCROLL_SETTLE_MS)
    }
    // Where the finger went down, so a drag can be measured against it.
    let touchStartY = 0
    const onTouchStart = (e: TouchEvent) => {
      fingerDown = true
      touchScrollActiveRef.current = true
      touchStartY = e.touches[0]?.clientY ?? 0
      markExplicitScrollInput()
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0 }
    }
    // The touch counterpart of handleWheelCapture's enterReaderMode('wheel-up').
    // Per-event scroll deltas from a finger arrive below UP_JITTER_EPS, and a
    // live chat's content height moves on nearly every frame, so a genuine
    // scroll-up often clears neither bar decideFollowTransition sets. The
    // gesture itself is the evidence: a finger travelling DOWN the screen
    // reveals older content, which is the reader leaving the tail.
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY
      if (y === undefined) return
      markExplicitScrollInput()
      if (y - touchStartY > TOUCH_READER_INTENT_PX) enterReaderMode('touch-drag-up')
    }
    const onTouchEnd = () => {
      fingerDown = false
      armSettle()
    }
    let lastTop = el.scrollTop
    let lastHeight = el.scrollHeight
    const handle = () => {
      if (touchScrollActiveRef.current) armSettle()
      const top = el.scrollTop
      const height = el.scrollHeight
      const gap = el.scrollHeight - top - el.clientHeight
      const previousTop = lastTop
      const previousHeight = lastHeight
      const reconcileTarget = geometryReconcileScrollTopRef.current
      const geometryReconciliation = reconcileTarget !== null && Math.abs(top - reconcileTarget) <= 1
      if (reconcileTarget !== null) geometryReconcileScrollTopRef.current = null
      const { scrolledUp, action } = decideFollowTransition(
        { top, height, clientHeight: el.clientHeight, lastTop: previousTop, lastHeight: previousHeight },
        {
          scrolledUp: userScrolledUpRef.current,
          hardLocked: hardLockedRef.current,
          geometryReconciliation,
          userInputActive: touchScrollActiveRef.current || explicitScrollInputRef.current,
        },
      )
      lastTop = top
      lastHeight = height
      if (action === 'follow-off') {
        log.debug('chat-scroll', 'user scrolled UP → HOLD position, stop following (new messages will NOT yank)', { top, gap })
        noteFollowTransition(String(shape.id), action, {
          top,
          height,
          clientHeight: el.clientHeight,
          gap,
          lastTop: previousTop,
          lastHeight: previousHeight,
          bufferKey: chatEventBufferKey,
        })
        goToTailRunRef.current += 1
        userScrolledUpRef.current = scrolledUp
        captureViewportAnchor()
        setFleetEventsLiveTailPinned(shape.id, false, chatEventBufferKey)
      } else if (action === 'follow-on') {
        if (!isTrueBottomGap(gap)) {
          log.debug('chat-scroll', 'near-bottom scroll ignored until true bottom', { top, gap })
          captureViewportAnchor()
          return
        }
        log.debug('chat-scroll', 'user returned to true bottom → resume stick-to-bottom', { top, gap })
        noteFollowTransition(String(shape.id), action, {
          top,
          height,
          clientHeight: el.clientHeight,
          gap,
          lastTop: previousTop,
          lastHeight: previousHeight,
          bufferKey: chatEventBufferKey,
        })
        userScrolledUpRef.current = scrolledUp
        viewportAnchorRef.current = null
        setFleetEventsLiveTailPinned(shape.id, true, chatEventBufferKey)
      }
      if (userScrolledUpRef.current) captureViewportAnchor()
      else checkFollowInvariant('scroll-event')
    }
    document.addEventListener('wheel', handleWheelCapture, { capture: true, passive: false })
    el.addEventListener('scroll', handle, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      document.removeEventListener('wheel', handleWheelCapture, true)
      el.removeEventListener('scroll', handle)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      if (settleTimer) clearTimeout(settleTimer)
      if (explicitScrollInputTimerRef.current) clearTimeout(explicitScrollInputTimerRef.current)
      if (followInvariantTimerRef.current) clearTimeout(followInvariantTimerRef.current)
      explicitScrollInputTimerRef.current = 0
      followInvariantTimerRef.current = 0
      explicitScrollInputRef.current = false
      touchScrollActiveRef.current = false
    }
  }, [chatLogEl, shape.id, chatEventBufferKey, captureViewportAnchor, checkFollowInvariant, enterReaderMode, resumeFollowIfSettledAtBottom, reconcileViewportGeometry])

  // A committed filter change is a new conversation view and starts following.
  useEffect(() => {
    noteFollowTransition(String(shape.id), 'filter-reset', {
      filterKey,
      bufferKey: chatEventBufferKey,
    })
    goToTail('filter-change')
  }, [filterKey, shape.id, goToTail, chatEventBufferKey])

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
        if (overId === agentId) { pickTerminalHover(agentId); setTermHoverVisible(true) }
      }, 600)
    }
    const onOut = (e: MouseEvent) => {
      const leaving = (e.target as HTMLElement).closest('.lc-terminal-card')
      const entering = (e.relatedTarget as HTMLElement | null)?.closest?.('.lc-terminal-card')
      if (leaving && !entering) {
        // Cancel a pending open so a passthrough never resolves into a popup.
        if (termCardShowTimerRef.current) { clearTimeout(termCardShowTimerRef.current); termCardShowTimerRef.current = null }
        termCardPendingIdRef.current = null
        termCardHideTimerRef.current = setTimeout(() => {
          // A pinned pane stays; only the passthrough peek closes on mouse-out.
          if (!termHoverPinnedIdRef.current) setTermHoverVisible(false)
        }, 200)
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
    let suppressResendClickUntil = 0
    const resendFailedMessage = (resendBtn: HTMLElement) => {
      const to = resendBtn.dataset.resendTo
      const text = resendBtn.dataset.resendText
      const tempId = resendBtn.dataset.resendTempid
      if (!to || !text || !tempId) return
      updateOptimisticEvent(tempId, { _failed: false }, chatEventBufferKey)
      sendMessage(to, text, { _tempId: tempId })
        .then((result: any) => { if (!result?.ok) throw new Error('resend failed') })
        .catch(() => updateOptimisticEvent(tempId, { _failed: true }, chatEventBufferKey))
    }
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
        if (Date.now() >= suppressResendClickUntil) resendFailedMessage(resendBtn)
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
          fleetEphemeral('plan-mode-respond', { agent: agentId, response: 'approve' })
            .catch((err: Error) => sendMessage(getHumanId(), `⚠️ plan approve failed: ${err.message}`, {}))
        }
        return
      }
      const supervisedBtn = (e.target as HTMLElement).closest('.plan-supervised-btn') as HTMLElement
      if (supervisedBtn) {
        e.stopPropagation()
        const agentId = supervisedBtn.dataset.agentId
        if (agentId) {
          fleetEphemeral('plan-mode-respond', { agent: agentId, response: 'supervised' })
            .catch((err: Error) => sendMessage(getHumanId(), `⚠️ plan supervised-approve failed: ${err.message}`, {}))
        }
        return
      }
      const rejectBtn = (e.target as HTMLElement).closest('.plan-reject-btn') as HTMLElement
      if (rejectBtn) {
        e.stopPropagation()
        const agentId = rejectBtn.dataset.agentId
        if (agentId) {
          fleetEphemeral('plan-mode-respond', { agent: agentId, response: 'reject' })
            .catch((err: Error) => sendMessage(getHumanId(), `⚠️ plan reject failed: ${err.message}`, {}))
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
          fleetEphemeral('plan-mode-toggle', { agent: agentId })
            .then((data: any) => {
              if (data?.error) {
                sendMessage(getHumanId(), `⚠️ plan mode toggle failed for ${agentName}: ${data?.error || 'unknown error'}`, {})
              } else if (data?.mode) {
                const modeLabel = data.mode === 'plan' ? 'plan mode ✓' : data.mode === 'default' ? 'plan mode off ✓' : data.mode
                sendMessage(getHumanId(), `📋 ${agentName} → ${modeLabel}`, {})
              }
            })
            .catch((err: Error) => sendMessage(getHumanId(), `⚠️ plan mode toggle failed for ${agentName}: ${err.message}`, {}))
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
          fleetEphemeral('send-text', { agent: agentId, text: '1', enter: true })
          const eventId = lcApproveBtn.dataset.eventId || lcApproveBtn.closest('[data-msg-id]')?.getAttribute('data-msg-id')
          if (eventId) {
            fleetDurable('prompt-respond', { eventId, response: 'approved' })
              .then(() => updateEventById(eventId, { _promptResponse: 'approved', metadata: { approvedAt: new Date().toISOString() } }))
              .catch((e: Error) => console.warn('[fleet-chat] prompt approve failed:', e.message))
          }
          return
        }
      }
      const lcDenyBtn = (e.target as HTMLElement).closest('.lc-deny-btn') as HTMLElement | null
      if (lcDenyBtn) {
        const agentId = lcDenyBtn.dataset.agentId
        if (agentId) {
          fleetEphemeral('send-text', { agent: agentId, text: '3', enter: true })
          const eventId = lcDenyBtn.dataset.eventId || lcDenyBtn.closest('[data-msg-id]')?.getAttribute('data-msg-id')
          if (eventId) {
            fleetDurable('prompt-respond', { eventId, response: 'rejected' })
              .then(() => updateEventById(eventId, { _promptResponse: 'rejected', metadata: { rejectedAt: new Date().toISOString() } }))
              .catch((e: Error) => console.warn('[fleet-chat] prompt reject failed:', e.message))
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
          if (termHoverPinnedIdRef.current === agentId) {
            setTermHoverPinned(false)
            setTermHoverVisible(false)
            pickTerminalHover(null)
          } else {
            pickTerminalHover(agentId)
            setTermHoverPinned(true)
          }
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
        // A gap marker owns the rows next to it. Check that first: inside a
        // thread card the marker sits within the semantic operation, and
        // treating it as the card's own toggle would close the thread instead
        // of revealing its middle.
        const ownRows = expandBtn.nextElementSibling?.classList.contains('pretty-more-rows')
          ? expandBtn.nextElementSibling as HTMLElement
          : null
        const semanticOp = ownRows ? null : expandBtn.closest('.semantic-chat-operation') as HTMLElement | null
        const semanticBody = semanticOp?.querySelector('.semantic-operation-body') as HTMLElement | null
        if (semanticOp && semanticBody) {
          const wasExpanded = semanticBody.style.display !== 'none'
          if (!expandBtn.dataset.semanticCollapsedLabel) {
            expandBtn.dataset.semanticCollapsedLabel = expandBtn.textContent || 'Expand'
          }
          semanticBody.style.display = wasExpanded ? 'none' : ''
          semanticOp.classList.toggle('semantic-operation-expanded', !wasExpanded)
          if (!wasExpanded) semanticBody.dispatchEvent(new Event('semantic-operation-expand'))
          expandBtn.textContent = wasExpanded ? (expandBtn.dataset.semanticCollapsedLabel || 'Expand') : ''
          expandBtn.classList.toggle('thread-fold-open', !wasExpanded)
          const itemKey = expandBtn.closest('[data-item-key]')?.getAttribute('data-item-key')
          const semanticKey = semanticOp.getAttribute('data-semantic-key') || '0'
          if (itemKey) {
            const key = `${itemKey}:semantic:${semanticKey}`
            if (wasExpanded) expandedRowsRef.current.delete(key)
            else expandedRowsRef.current.add(key)
          }
          return
        }
        const moreRows = expandBtn.parentElement?.querySelector('.pretty-more-rows') as HTMLElement
        if (moreRows) {
          const wasExpanded = moreRows.style.display !== 'none'
          if (!expandBtn.dataset.collapsedLabel) {
            expandBtn.dataset.collapsedLabel = expandBtn.textContent || 'Expand'
          }
          moreRows.style.display = wasExpanded ? 'none' : ''
          // Open, the marker stops being a control and becomes the fold line --
          // Skip: "the expand doesn't flip to collapse when expanded but almost
          // vanishes. perhaps just a faint line running from spine across the
          // card like a fold line." Collapsing is the spine's job from here.
          expandBtn.textContent = wasExpanded ? (expandBtn.dataset.collapsedLabel || 'Expand') : ''
          expandBtn.classList.toggle('thread-fold-open', !wasExpanded)
          // The floating collapse only exists while there is something to
          // collapse; see ThreadChatOperationView.
          expandBtn.closest('.thread-shell')?.classList.toggle('thread-middle-open', !wasExpanded)
          const itemKey = expandBtn.closest('[data-item-key]')?.getAttribute('data-item-key')
          if (itemKey) {
            const allBtns = Array.from(expandBtn.closest('[data-item-key]')?.querySelectorAll('.pretty-expand-btn') || [])
            const key = `${itemKey}:pretty:${Math.max(0, allBtns.indexOf(expandBtn))}`
            if (wasExpanded) expandedRowsRef.current.delete(key)
            else expandedRowsRef.current.add(key)
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
      tapDownX = e.clientX
      tapDownY = e.clientY
    }
    const onTapUp = (e: PointerEvent) => {
      if (Math.abs(e.clientX - tapDownX) > 16 || Math.abs(e.clientY - tapDownY) > 16) return
      const t = e.target as HTMLElement
      const resend = t.closest('.chat-resend-btn') as HTMLButtonElement | null
      if (resend) {
        e.preventDefault()
        e.stopPropagation()
        suppressResendClickUntil = Date.now() + 500
        resendFailedMessage(resend)
        return
      }
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
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
        if (!resp.ok) {
          const detail = await resp.json().catch(() => null)
          throw new Error(detail?.error || `HTTP ${resp.status}`)
        }
        const { resolvedMessage, inlineAttachments } = await resp.json()
        const rendered = resolveInlineAttachments(resolvedMessage, inlineAttachments || [], renderMarkdownUtil)
        const wrapper = document.createElement('span')
        wrapper.innerHTML = rendered
        spinner.replaceWith(...Array.from(wrapper.childNodes))
      } catch (err) {
        const wrapper = document.createElement('span')
        wrapper.className = 'att-upload-failed'
        const reason = err instanceof Error ? err.message : String(err || 'unquote failed')
        wrapper.title = `Reference unavailable: ${reason}`
        wrapper.textContent = `⚠ ${text} unavailable: ${reason}`
        spinner.replaceWith(wrapper)
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
  // The three tiers, as one function, so the keyboard and the composer rail's
  // upward slider drive the same thing rather than two implementations that
  // drift. Skip: "we already have a keyboard version of the same control. And
  // drive it the same way exactly." `count` is the tier, not a keypress tally --
  // the keyboard derives it by counting Escapes, the slider by how far you drag.
  const runInterruptTier = useCallback((count: number, source: 'esc' | 'rail') => {
    const targets = sendTargetsRef.current
    if (targets.length === 0) return
    const now = Date.now()
    setUnqueuedAt(now)
    const agent = resolveToFleetIdRef.current(targets[0])
    const agentLabel = agentNamesRef.current[agent] || agent.replace('fleet:', '')
    log.info('esc', 'interrupt', { count, agent, agentLabel, source })
    const tempId = `esc-${++interruptTempCounterRef.current}-${now}`
    const ts = new Date().toISOString()
    setEscLevel(agent, count >= 3 ? 3 : count)
    if (count >= 3) {
      escCountRef.current = 0
      injectOptimisticEvent({ _tempId: tempId, _evType: 'system_notice', _isInterrupt: true, from: 'system', to: agent, text: `💀 Killing ${agentLabel}…`, timestamp: ts })
      fleetDurable('kill-session', { agent })
        .then((d: { error?: string }) => {
          updateOptimisticEvent(tempId, { text: d.error ? `⚠ Kill failed: ${d.error}` : `💀 Killed ${agentLabel}` })
          if (!d.error) confirmEscLevel(agent, 3)
          setTimeout(() => clearEscState(agent), 2000)
        })
        .catch(() => { updateOptimisticEvent(tempId, { text: `⚠ Kill failed (server unreachable)` }) })
    } else if (count === 2) {
      fleetEphemeral('interrupt', { agent })
        .then((d: { error?: string }) => {
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
      fleetEphemeral('soft-interrupt', { agent })
        .then((d: { error?: string; promoted?: boolean; reason?: string }) => {
          if (d.error) { updateOptimisticEvent(tempId, { text: `⚠ Soft interrupt failed: ${d.error}` }) }
          else if (d.promoted) { updateOptimisticEvent(tempId, { text: `⏸ Promoted queued message → ${agentLabel}` }); confirmEscLevel(agent, 1) }
          else if (d.reason === 'nothing-queued') { updateOptimisticEvent(tempId, { text: `· nothing queued for ${agentLabel} — no-op` }) }
          else { updateOptimisticEvent(tempId, { text: `⏸ Soft interrupt → ${agentLabel} (unconfirmed)` }) }
        })
        .catch(() => { updateOptimisticEvent(tempId, { text: `⚠ Soft interrupt failed (server unreachable)` }) })
    }
  }, [])
  runInterruptTierRef.current = runInterruptTier

  useEffect(() => {
    function onEscKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (!chatActiveRef.current) return
      const ta = inputRef.current as HTMLTextAreaElement | null
      if (ta && ta.value !== '') return
      const targets = sendTargetsRef.current
      if (targets.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      // Escalation is action-based: each Esc increments; any non-Esc action
      // (keydown, pointer, message send) resets. No timing window.
      escCountRef.current++
      runInterruptTierRef.current(escCountRef.current, 'esc')
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
      if (a.id) map[a.id] = agentDisplayLabel(a)
    }
    if (getHumanId()) map[getHumanId()] = getHumanName() || 'user'
    return map
  }, [agents])

  const agentExactNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      if (a.id) map[a.id] = agentExactName(a)
    }
    if (getHumanId()) map[getHumanId()] = getHumanName() || 'user'
    return map
  }, [agents])

  // Detect pill drag hovering over this chat — returns stable string to avoid flicker
  // Only agent/label pills trigger filter mode, not content pills (msg, code, etc.)
  const fleetPillCount = useFleetPillCount(editor)
  const pillOverKey = useValue('pill-over', () => {
    if (fleetPillCount === 0) return ''
    const over = fleetPillOverShape(editor, shape.id)
    if (!over) return ''
    const { props, centre, chatBounds } = over
    const role = centre.y < chatBounds.y + chatBounds.h / 2 ? 'to' : 'from'
    return `${role}\0${props.value}\0${props.displayName}\0${props.pillType}`
  }, [editor, shape.id, fleetPillCount])
  const pillOver = useMemo(() => {
    if (!pillOverKey) return null
    const [role, value, displayName, pillType] = pillOverKey.split('\0')
    return { role, value, displayName, pillType }
  }, [pillOverKey])

  // Auto-open filter mode when pill hovers over this chat
  useEffect(() => {
    if (pillOver && !filterOpen) {
      setFilterOpenByPill(true)
      setFilterOpen(true)
    } else if (!pillOver && filterOpenByPill) {
      setFilterOpenByPill(false)
      setFilterOpen(false)
    }
  }, [!!pillOver])

  const humanFilterLabel = getHumanName() || getHumanId() || 'user'
  const composerAgentLabel = useMemo(
    () => activeComposerAgentLabel(filter, sendTargets, agents),
    [filterKey, sendTargets, agents],
  )
  // Records the pointerdown that started on the traffic toggle, so a cycle only
  // fires on a deliberate tap (down AND up on the toggle, little movement) — not
  // on a stray touch or a scroll-drag that merely lifts off over it. This is the
  // `93aba2cd` spurious-filter-cycling fix.
  const composerTrafficMode = useMemo<ComposerTrafficFilterMode>(
    () => classifyFleetComposerTrafficMode(filter, trafficMode, humanFilterLabel, composerAgentLabel),
    [filterKey, trafficMode, humanFilterLabel, composerAgentLabel],
  )
  const selectComposerTrafficMode = useCallback((nextMode: ComposerTrafficFilterMode) => {
    if (!composerAgentLabel) return
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      props: {
        filter: filterForFleetComposerTrafficMode(nextMode, humanFilterLabel, composerAgentLabel),
        trafficMode: nextMode === 'dm-quiet' ? 'quiet' : 'normal',
      },
    })
  }, [composerAgentLabel, editor, humanFilterLabel, shape.id, shape.type])
  const cycleComposerTrafficMode = useCallback(() => {
    if (!composerAgentLabel) return
    selectComposerTrafficMode(nextFleetComposerTrafficMode(composerTrafficMode))
  }, [composerAgentLabel, composerTrafficMode, selectComposerTrafficMode])

  // --- Composer host callbacks ---------------------------------------------
  // The shared ChatComposer owns the textarea + voice registration + send-on-
  // enter; everything chat-specific (viewer context, ref attachments, plan-mode,
  // /terminal, file-drop, escalation reset) lives here and is passed back in.
  // Defined as a plain closure (recreated each render, like the old inline
  // handler) so there's no memoization-induced staleness. Every submit trigger
  // uses this one path.
  const composerSend = (text: string, targets: string[]) => {
    expireClearedComposerDraft()
    const tempId = `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`
    injectOptimisticEvent({
      _tempId: tempId,
      type: 'chat',
      event_type: 'chat',
      from: getHumanId(),
      // ONE event for the whole send. The optimistic row carries every target,
      // so a group send is one line here and reconciles against the one real
      // row the server writes for it.
      recipients: targets,
      text,
      timestamp: new Date().toISOString(),
      read: false,
    }, chatEventBufferKey)
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
            fleetEphemeral('plan-mode-respond', { agent: agentId, response: planResponse })
              .catch((e: Error) => console.warn('[fleet-chat] plan-mode-respond failed:', e.message))
          }
        }
      }
      const ENTER_PLAN_RE = /^\/plan\b|\blet'?s plan\b|\bplan mode\b|\bplanning mode\b|\bchat in planning\b|\bstay in planning\b|\bplan first\b|\bthink before\b/i
      if (ENTER_PLAN_RE.test(text)) {
        for (const agentId of targets) {
          const agentName = agentNames[agentId] || agentId
          fleetEphemeral('plan-mode-toggle', { agent: agentId })
            .then((data: any) => {
              if (data?.error) {
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
      if (doc?.projectName) sendOpts.preambleRef = { doc: doc.projectName, version: currentDocVersion(panel, editor) || null }
      // ONE send for the whole target set. `to` is a filter expression, so the
      // union of the targets is the expression that ORs them — one message, one
      // event, every recipient, instead of N independent sends nothing rejoins.
      const sendWithRetry = (attempt: number) => {
        sendMessage(targets.join('|'), text, sendOpts).then((result) => {
          if (!result.ok) throw new Error('send failed')
        }).catch(() => {
          if (attempt < 3) {
            setTimeout(() => sendWithRetry(attempt + 1), 2000 * attempt)
          } else {
            updateOptimisticEvent(tempId, { _failed: true }, chatEventBufferKey)
          }
        })
      }
      sendWithRetry(1)
    })()
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
      expireClearedComposerDraft()
      pickTerminalHover(targetId)
      setTermHoverPinned(true)
      ta.value = ''
      ta.style.height = ''
    }
    return true
  }

  const composerKeyActivity = () => {
    setComposerDraftVersion(v => v + 1)
    if ((inputRef.current as HTMLTextAreaElement | null)?.value) {
      expireClearedComposerDraft()
    }
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

  const agentRouteName = useCallback((agent: any) => (
    agent?.friendly_name || agent?.name || agent?.id || ''
  ), [])

  const agentDisplayName = useCallback((agent: any) => (
    agent?.friendly_name || agent?.name?.replace?.(/^fleet:/, '') || agent?.id?.replace?.(/^fleet:/, '') || ''
  ), [])

  // Resolve a send-target label to one agent. The agent name is an opaque
  // atom — you address an agent by its exact full name (or id, or a label it
  // carries). No suffix games: dawn is "base", day is "base:day", etc.
  const resolveTargetAgent = useCallback((label: string, agentList: any[]) => {
    if (label.startsWith('fleet:')) return agentList.find((a: any) => a.id === label) || null
    // A route name can have a LIVE holder plus one or more DEAD former holders:
    // a dead agent keeps its name for provenance (spec G.18), so the name
    // string outlives any single holder. The live holder IS the agent (G.22), so
    // prefer a non-dead match; fall back to a dead one only when the name has no
    // live holder (which keeps reanimate-by-name working for an all-dead name).
    const byName = agentList.filter((a: any) => agentRouteName(a) === label || a.id === label)
    if (byName.length) return byName.find((a: any) => !a.dead) || byName[0]
    const matched = agentList.filter((a: any) => !a.human && labelsForAgent(a).includes(label))
    return matched.length === 1 ? matched[0] : null
  }, [agentRouteName])

  const resolveTargetAgents = useCallback((label: string, agentList: any[]) => {
    if (label.startsWith('fleet:')) {
      const agent = agentList.find((a: any) => a.id === label)
      return agent ? [agent] : []
    }
    const byName = agentList.filter((a: any) => agentRouteName(a) === label || a.id === label)
    if (byName.length) return [byName.find((a: any) => !a.dead) || byName[0]]
    return agentList.filter((a: any) => !a.human && labelsForAgent(a).includes(label))
  }, [agentRouteName])

  const terminalComposerControls = useMemo<TerminalComposerControl[]>(() => {
    const seen = new Set<string>()
    const controls: TerminalComposerControl[] = []
    const diag: any[] = []
    for (const label of sendTargets) {
      const matches = resolveTargetAgents(label, agents)
      diag.push({
        label,
        matches: matches.map((agent: any) => ({
          fleetId: agent?.id || label,
          found: !!agent,
          tmux: agent?.tmux_session || null,
          dead: agent?.dead ?? null,
          hibernating: runtimeStatusName(agent) === 'hibernating',
          terminalReady: isTerminalAvailableForAgent(agent),
        })),
      })
      for (const agent of matches) {
        if (!agent?.id || seen.has(agent.id)) continue
        seen.add(agent.id)
        controls.push({
          id: agent.id,
          agent,
          label: agentDisplayName(agent) || agent.id.replace('fleet:', ''),
          unavailableReason: terminalUnavailableReason(agent),
        })
      }
    }
    if (!controls.length) {
      controls.push({
        id: '__no-terminal-target',
        agent: null,
        label: 'Terminal',
        unavailableReason: terminalUnavailableReason(null),
      })
    }
    log.info('terminal-icon', controls.some(control => !control.unavailableReason) ? 'resolved targets' : 'no available terminal target', {
      sendTargets,
      source: 'send-targets',
      fleetIds: controls.map(control => control.agent?.id).filter(Boolean),
      diag,
      agentCount: agents.length,
    })
    return controls
  }, [sendTargets, agents, resolveTargetAgents, agentDisplayName])

  // The hover's target is derived, not held: an explicit pick wins only while
  // the filter it was made under is still in force, and otherwise the target is
  // the filter's own terminal target. So re-filtering the chat re-aims the
  // terminal hover, the same way it re-aims the composer's send targets.
  const termHoverAgentId = useMemo(() => {
    if (termHoverPick && termHoverPick.filterKey === filterKey) return termHoverPick.agentId
    return terminalComposerControls.find(control => control.agent && !control.unavailableReason)?.agent?.id ?? null
  }, [termHoverPick, filterKey, terminalComposerControls])
  useEffect(() => {
    termHoverPinnedIdRef.current = termHoverPinned ? termHoverAgentId : null
  }, [termHoverPinned, termHoverAgentId])

  void composerDraftVersion
  const composerHasText = !!((inputRef.current as HTMLTextAreaElement | null)?.value)
  const canUnclearComposer = !composerHasText && !!peekClearedComposerDraft(composerDraftKey)

  const expireClearedComposerDraft = () => {
    dropClearedComposerDraft(composerDraftKey)
  }

  const resizeComposerTextarea = (ta: HTMLTextAreaElement) => {
    ta.style.height = ''
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
  }

  const toggleComposerClear = () => {
    const ta = inputRef.current as HTMLTextAreaElement | null
    if (!ta) return
    if (ta.value !== '') {
      stashClearedComposerDraft(composerDraftKey, {
        text: ta.value,
        voiceTarget: composerVoiceTargetSnapshotRef.current?.() ?? null,
      })
      ta.value = ''
      ta.style.height = ''
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      dumpVoiceTarget()
      return
    }
    const draft = takeClearedComposerDraft(composerDraftKey)
    if (!draft?.text) return
    ta.value = draft.text
    resizeComposerTextarea(ta)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    if (draft.voiceTarget) setVoiceTarget(ta, draft.voiceTarget as VoiceTargetHandle)
  }

  const deadTargetAgent = useMemo(() => {
    for (const label of sendTargets) {
      const agent = resolveTargetAgent(label, agents)
      if (agent?.dead) {
        // Spec G.22: a dead agent that shares its friendly name with a LIVE
        // holder is just provenance, never a reanimate target — the live holder
        // IS the agent. Only offer reanimate when the name has NO live holder
        // (the legitimate "the only holder is dead" case). This is what stops
        // dead namesakes nagging "reanimate?" in a chat with the live holder.
        const name = agentRouteName(agent)
        const hasLiveHolder = !!name && agents.some((a: any) => !a.dead && agentRouteName(a) === name)
        if (hasLiveHolder) continue
        return { id: agent.id, name: agentDisplayName(agent) || agent.id.replace('fleet:', '') }
      }
    }
    return null
  }, [sendTargets, agents, resolveTargetAgent, agentRouteName, agentDisplayName])

  // Resolve against the whole roster rather than the composer's send targets.
  // A terminal-card notification pins the hover for whichever agent raised it,
  // and that agent is usually not the one this panel is addressing; scoping the
  // lookup to send targets would close the pane the instant it opened.
  const selectedTerminalHoverAgent = useMemo(() => {
    if (!termHoverAgentId) return null
    const agent = agents.find((candidate: any) => candidate.id === termHoverAgentId)
    return agent && !terminalUnavailableReason(agent) ? (agent as TerminalAgent) : null
  }, [agents, termHoverAgentId])

  // Narrowed once here so the pane and its dismiss handler share one id.
  const activeTerminalHoverId = selectedTerminalHoverAgent?.id

  // Close the pane when its agent stops offering a terminal at all — the reason
  // the old scoped check existed, kept without the send-target coupling.
  useEffect(() => {
    if (!termHoverAgentId || selectedTerminalHoverAgent) return
    pickTerminalHover(null)
    setTermHoverPinned(false)
    setTermHoverVisible(false)
  }, [termHoverAgentId, selectedTerminalHoverAgent])

  // Reset auto-pin tracking when the selected terminal agent changes
  useEffect(() => {
    termAutoPinnedRef.current = false
    lastAttentionTsRef.current = null
  }, [termHoverAgentId])

  // (Terminal auto-pin on permission prompts removed — chat cards handle this now)

  // Detect impossible filter: filter is set but no AND group can match any known agent
  const filterHasMatchingAgent = useFleetFilterHasMatchingAgent(dnfFilter, frameId)
  const isImpossibleFilter = filter.length > 0 && !filterHasMatchingAgent

  // Attach click/tap handlers to the Virtuoso-owned scroll container.
  // Listener-based (not JSX prop) because the Scroller is memoized and
  // doesn't close over changing callbacks.
  useEffect(() => {
    const el = chatLogEl
    if (!el) return
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
      if (Date.now() < suppressNativeChipClickUntilRef.current) return
      if (e.timeStamp - lastTouchHandled < 700) return
      handleDocLinkClick(e as any)
    }
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('click', onClick)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('click', onClick)
    }
  }, [chatLogEl, handleDocLinkClick])

  // --- Chat log drag → ghost pill ---
  // Uses native capture-phase listeners because tldraw intercepts React events
  const DRAG_THRESHOLD = 5
  // UIKit's long-press recognizer defaults to 0.5s; Android's default long-press
  // timeout is 500ms.
  const TOUCH_DRAG_HOLD_MS = 500
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
    markdownChip?: boolean
    startX: number
    startY: number
    started: boolean
    captureEl: HTMLElement | null
    pointerId: number
    _onMain?: boolean
    held?: boolean
  } | null>(null)
  // Set by the drag effect below so the unmount-only cleanup can reach the
  // current cancelDrag closure without taking the effect's deps.
  const cancelDragRef = useRef<null | (() => void)>(null)

  // Tears down any hover pane already showing when a drag starts here. Whether a
  // drag is in flight is dragCoordinator.isActive, not a flag of our own.
  const suppressSkillHoverDuringChatDrag = useCallback(() => {
    if (skillShowTimerRef.current) {
      clearTimeout(skillShowTimerRef.current)
      skillShowTimerRef.current = null
    }
    if (skillHideTimerRef.current) {
      clearTimeout(skillHideTimerRef.current)
      skillHideTimerRef.current = null
    }
    setSkillHover(null)
  }, [])

  // Store agent name maps in refs so native listeners can access current values.
  const agentNamesRef = useRef(agentNames)
  agentNamesRef.current = agentNames
  const agentExactNamesRef = useRef(agentExactNames)
  agentExactNamesRef.current = agentExactNames
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
    const frame = fleetInteractionFrame(viewportId)

    // Document-level capture listeners: fires before tldraw's tl-container
    // listener can intercept. We scope to this chat by checking if the target
    // is inside our logEl.

    // The element a drag-claim started on — so a no-move TAP on a draggable
    // chip/link can re-fire its click on touch/stylus (see onPointerUp).
    let downTargetEl: HTMLElement | null = null
    let pendingDrag: typeof dragRef.current = null
    let pendingHoldTimer: ReturnType<typeof window.setTimeout> | null = null
    let heldTouchActionEl: HTMLElement | null = null
    let heldTouchActionValue = ''
    const isTouchLikePointer = (e: PointerEvent) => e.pointerType === 'touch' || e.pointerType === 'pen'
    const immediateTouchDragSelector = '.drag-handle, .chat-ts, .pretty-search-ts, .agent-nick, .tool-ref, .md-file-card, .ref-chip'

    function clearPendingDrag() {
      if (pendingHoldTimer !== null) {
        window.clearTimeout(pendingHoldTimer)
        pendingHoldTimer = null
      }
      pendingDrag = null
      downTargetEl = null
    }

    function armHeldTouchAction(el: HTMLElement) {
      heldTouchActionEl = el
      heldTouchActionValue = el.style.touchAction
      el.style.touchAction = 'none'
    }

    function restoreHeldTouchAction() {
      if (!heldTouchActionEl) return
      heldTouchActionEl.style.touchAction = heldTouchActionValue
      heldTouchActionEl = null
      heldTouchActionValue = ''
    }

    function claimDrag(drag: NonNullable<typeof dragRef.current>, target: HTMLElement, e: PointerEvent) {
      clearPendingDrag()
      e.stopImmediatePropagation()
      e.preventDefault()
      suppressSkillHoverDuringChatDrag()
      dragRef.current = drag
      downTargetEl = target

      // Use shared drag coordinator instead of per-drag capture listeners
      dragCoordinator.claim(onPointerMove, onPointerUp, cancelDrag)
    }

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
      editor.markEventAsHandled(e)

      const names = agentNamesRef.current
      const exactNames = agentExactNamesRef.current

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
            filePath, markdownChip: true,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }
      if (!drag) {
        const tldaCard = target.closest('.tlda-card') as HTMLElement
        if (tldaCard) {
          const tldaSrc = tldaCard.dataset.tldaSrc || ''
          const projectName = tldaCard.querySelector('.doc-name')?.textContent || ''
          // Use 'tlda:URL' to carry the full src URL for inline-doc creation
          drag = {
            pillId: null, pillType: 'doc' as any, value: `tlda:${tldaSrc}`,
            displayName: projectName, color: '#9370db', content: projectName,
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
          const displayName = names[agentId] || agentId.replace('fleet:', '')
          const exactName = exactNames[agentId] || agentId.replace('fleet:', '')
          drag = {
            pillId: null, pillType: 'agent' as any, value: exactName,
            displayName, color: '#7a9ec8',
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      if (!drag) return

      if (isTouchLikePointer(e) && !target.closest(immediateTouchDragSelector)) {
        pendingDrag = drag
        downTargetEl = target
        pendingHoldTimer = window.setTimeout(() => {
          pendingHoldTimer = null
          const heldDrag = pendingDrag
          const heldTarget = downTargetEl
          if (!heldDrag || !heldTarget) return
          pendingDrag = null
          downTargetEl = null
          heldDrag.held = true
          armHeldTouchAction(heldTarget)
          claimDrag(heldDrag, heldTarget, e)
        }, TOUCH_DRAG_HOLD_MS)
        return
      }
      claimDrag(drag, target, e)
    }

    function onPendingPointerMove(e: PointerEvent) {
      const drag = pendingDrag
      if (!drag || e.pointerId !== drag.pointerId) return
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
      clearPendingDrag()
    }

    function clearPendingPointer(e: PointerEvent) {
      const drag = pendingDrag
      if (!drag || e.pointerId !== drag.pointerId) return
      clearPendingDrag()
    }

    function cancelDrag() {
      const drag = dragRef.current
      dragRef.current = null
      restoreHeldTouchAction()
      if (drag?.pillId) {
        const mainEditor = (window as TldrawEditorWindow).__tldraw_editor__
        const onMain = !!drag._onMain
        const deleteEditor = onMain && mainEditor ? mainEditor : editor
        // Delete (and so record) before clearing ACTIVE — see fleet-pill-forensics.
        deleteFleetPill(deleteEditor, drag.pillId as TLShapeId, 'drag-cancel', { surface: 'chat' })
        markFleetPillInactive(String(drag.pillId))
      }
      const shapeEl = logEl!.closest('.fleet-shape') as HTMLElement | null
      if (shapeEl) shapeEl.style.boxShadow = ''
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
        const pagePos = fleetPointerEventPagePoint(editor, frame, e)
        const pillId = createShapeId()
        editor.createShape({
          id: pillId,
          type: 'fleet-pill' as any,
          x: pagePos.x - 35,
          y: pagePos.y - 9,
          props: transientFleetPillProps({
            w: 70, h: 18,
            pillType: drag.pillType,
            value: drag.value,
            displayName: drag.displayName,
            color: drag.color,
          }),
          meta: {
            ...(drag.sourceAgent ? { sourceAgent: drag.sourceAgent } : {}),
            ...(drag.filePath ? { filePath: drag.filePath } : {}),
            ...(drag.fileUrl ? { fileUrl: drag.fileUrl } : {}),
            ...(drag.markdownChip ? { markdownChip: true } : {}),
          },
        })
        drag.pillId = pillId as unknown as string
        markFleetPillActive(String(pillId))
        // Reset tldraw's state machine via API — avoids cancelling the real pointer stream.
        editor.cancel()
      }
      if (drag.pillId) {
        const pagePos = fleetPointerEventPagePoint(editor, frame, e)
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
        const movePill = (targetEditor: Editor, x: number, y: number) => {
          const update = {
            id: drag.pillId as TLShapeId,
            type: 'fleet-pill',
            x,
            y,
          } as unknown as Parameters<typeof targetEditor.updateShape>[0]
          targetEditor.updateShape(update)
        }

        if (mainEditor === editor) {
          const onMain = !!drag._onMain
          if (outside && !onMain) {
            const mainPos = clientPointToPage(mainEditor, { x: e.clientX, y: e.clientY })
            movePill(mainEditor, mainPos.x - 5, mainPos.y - 5)
            drag._onMain = true
            return
          } else if (!outside && onMain) {
            const panelPos = fleetPointerEventPagePoint(editor, frame, e)
            movePill(editor, panelPos.x - 35, panelPos.y - 9)
            drag._onMain = false
          } else if (onMain) {
            const mainPos = clientPointToPage(mainEditor, { x: e.clientX, y: e.clientY })
            movePill(mainEditor, mainPos.x - 5, mainPos.y - 5)
            return
          }
        } else if (mainEditor) {
          const onMain = !!drag._onMain
          if (outside && !onMain) {
            // Handoff: panel → main
            try {
              deleteFleetPill(editor, drag.pillId as TLShapeId, 'editor-handoff', { surface: 'chat' })
            } catch {
              // Drag-preview cleanup has no owned non-modal surface here. Do not
              // create the second preview if deleting the first one failed.
              return
            }
            const mainPos = clientPointToPage(mainEditor, { x: e.clientX, y: e.clientY })
            mainEditor.createShape({
              id: drag.pillId as any,
              type: 'fleet-pill' as any,
              x: mainPos.x - 5,
              y: mainPos.y - 5,
              props: transientFleetPillProps({
                w: 10, h: 10,
                pillType: drag.pillType,
                value: drag.value,
                displayName: drag.displayName,
                color: drag.color,
              }),
              meta: {
                ...(drag.sourceAgent ? { sourceAgent: drag.sourceAgent } : {}),
                ...(drag.filePath ? { filePath: drag.filePath } : {}),
                ...(drag.fileUrl ? { fileUrl: drag.fileUrl } : {}),
                ...(drag.markdownChip ? { markdownChip: true } : {}),
              },
            })
            drag._onMain = true
          } else if (!outside && onMain) {
            // Handoff back: main → panel
            try {
              deleteFleetPill(mainEditor, drag.pillId as TLShapeId, 'editor-handoff', { surface: 'chat' })
            } catch {
              // Drag-preview cleanup has no owned non-modal surface here. Do not
              // create the second preview if deleting the first one failed.
              return
            }
            const panelPos = fleetPointerEventPagePoint(editor, frame, e)
            editor.createShape({
              id: drag.pillId as any,
              type: 'fleet-pill' as any,
              x: panelPos.x - 35,
              y: panelPos.y - 9,
              props: transientFleetPillProps({
                w: 70, h: 18,  // chip form inside panel
                pillType: drag.pillType,
                value: drag.value,
                displayName: drag.displayName,
                color: drag.color,
              }),
            })
            drag._onMain = false
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
      restoreHeldTouchAction()
      if (!drag.started) {
        if (drag.held) {
          downTargetEl = null
          return
        }
        // No drag happened = a TAP on a draggable chip/link. This handler claimed
        // the pointer (capture-phase stopImmediatePropagation on pointerdown), so
        // the element's own click handler may never run. Open the chip directly
        // for every pointer type; suppress a follow-up native mouse click if the
        // browser still emits one.
        if (downTargetEl) {
          suppressNativeChipClickUntilRef.current = Date.now() + 700
          openMarkdownChipFromTarget(downTargetEl, () => {})
        }
        downTargetEl = null
        return
      }
      downTargetEl = null
      if (!drag.pillId) return
      markFleetPillInactive(String(drag.pillId))

      const onMain = !!drag._onMain
      const mainEditor = (window as TldrawEditorWindow).__tldraw_editor__
      const dropEditor = (onMain && mainEditor) ? mainEditor : editor
      const pagePos = onMain
        ? clientPointToPage(dropEditor, { x: e.clientX, y: e.clientY })
        : fleetPointerEventPagePoint(dropEditor, frame, e)
      dropPillOnTarget(
        dropEditor,
        drag.pillId as TLShapeId,
        drag.value,
        pagePos,
        drag.content,
        (message) => addToast({ title: message, severity: 'error' }),
      )
      try {
        deleteFleetPill(dropEditor, drag.pillId as TLShapeId, 'drag-drop', { surface: 'chat' })
      } catch {
        // The drop already ran; leftover transient preview cleanup has no owned
        // non-modal surface in this drag coordinator.
      }
    }

    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    document.addEventListener('pointermove', onPendingPointerMove, { capture: true })
    document.addEventListener('pointerup', clearPendingPointer, { capture: true })
    document.addEventListener('pointercancel', clearPendingPointer, { capture: true })
    cancelDragRef.current = cancelDrag

    return () => {
      clearPendingDrag()
      restoreHeldTouchAction()
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
      document.removeEventListener('pointermove', onPendingPointerMove, { capture: true })
      document.removeEventListener('pointerup', clearPendingPointer, { capture: true })
      document.removeEventListener('pointercancel', clearPendingPointer, { capture: true })
    }
  }, [addToast, chatLogEl, editor, viewportId, openMarkdownChipFromTarget, suppressSkillHoverDuringChatDrag])

  // Deleting an in-flight pill belongs to unmount alone, so it is its own effect.
  // It used to sit in the cleanup above, which re-runs on every dep change --
  // and chatLogEl is a dep. Dragging a pill over a chat opens filter mode, filter
  // mode unmounts the message list, the scroller's ref callback sets chatLogEl to
  // null, and the cleanup fired mid-drag and deleted the pill the user was still
  // holding. A drag is owned by the document-level dragCoordinator, so swapping
  // the log element out from under it is not a reason to end it.
  useEffect(() => () => {
    if (dragRef.current) cancelDragBeforeRelease(() => cancelDragRef.current?.(), () => dragCoordinator.release())
  }, [])

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
        <FleetPanelButtonGroup editor={editor} shape={shape}>
          <button
            className="fleet-filter-btn"
            onPointerDown={stopEventPropagation}
            onPointerUp={(e) => {
              stopEventPropagation(e)
              setFilterOpen(prev => !prev)
            }}
            title="Edit traffic filter"
          >
            {filterOpen
              ? <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 2h12v9H6l-4 3v-3z"/></svg>
              : <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 2h14M3 7h10M6 12h4"/></svg>
            }
          </button>
        </FleetPanelButtonGroup>

        <div
          className={filterOpen ? 'fleet-chat-body fleet-chat-body-filtering' : 'fleet-chat-body'}
          style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}
        >
          {/* Filter editing covers the durable reader without replacing it. */}
          {filterOpen && (
            <div className="fleet-filter-mode-overlay">
              <FleetChatFilterMode
                filter={filter}
                shapeId={shape.id}
                editor={editor}
                externalPillOver={pillOver}
              />
            </div>
          )}

          <>
              {showUnreadAgentRail && <FleetUnreadAgentRail unreadCounts={unreadRailCounts} displayedUnreadSenderIds={displayedUnreadSenderIds} startDrag={startUnreadRailDrag} />}
              {/* Messages — Virtuoso owns the scroll container and all virtualized
                  item measurement, including the status/suggestions trailing row. */}
              <Virtuoso
            ref={virtuosoRef}
            data={allItems}
            firstItemIndex={virtuosoFirstItemIndex}
            startReached={() => {
              if (chatEventBufferKey) requestEarlierChatHistory(chatEventBufferKey)
            }}
            style={{ flex: 1, minHeight: 0 }}
            initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
            alignToBottom
            followOutput={() => (!userScrolledUpRef.current || hardLockedRef.current) ? 'auto' : false}
            atBottomThreshold={1}
            atBottomStateChange={(atBottom) => {
              const t0 = probe.isEnabled('chat') ? performance.now() : 0
              const el = chatLogEl
              const gap = el ? (el.scrollHeight - (el.scrollTop + el.clientHeight)) : null
              setAtBottom(atBottom)
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
              <div
                className={'chat-row-wrap' + (item?._divider ? ' queue-divider' : '')}
                data-chat-item-key={String(item?.key ?? '')}
              >
                {item?._status ? (
                  <ThinkingStatus
                    thinkingAgents={thinkingAgents}
                    compactingAgents={compactingAgents}
                    contextPercent={contextPercent}
                    hibernatingAgents={hibernatingAgents}
                    statusTargetIds={statusTargetIds}
                    ctx={ctx}
                    itemCount={rawItems.length}
                    escalationState={escalationState}
                    suggestions={suggestionsPending}
                  />
                ) : (
                  <ChatMessageRow
                    html={item.html}
                    postProcess={postProcess}
                    itemKey={item.key}
                    expandedRowsRef={expandedRowsRef}
                    semanticRenderCtx={ctx}
                    semanticOperationPageSize={semanticOperationPageSize}
                    currentProject={doc?.projectName}
                  />
                )}
              </div>
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
            </>
        </div>

        {/* Input — outside scroll container, flex sibling with flexShrink:0 */}
        <div
          ref={inputAreaRef}
          className={`fleet-chat-input-area${shapeDropActive ? ' fleet-chat-input-drop-active' : ''}`}
          data-fleet-chat-input-drop-target={shape.id}
          style={{
            borderTop: '1px solid rgba(128, 128, 128, 0.15)',
            padding: 4,
            flexShrink: 0,
            position: 'relative',
            visibility: filterOpen ? 'hidden' : 'visible',
          }}
        >
          {/* Terminal hover pane — floats below the input area when the terminal icon is hovered or pinned */}
          {(termHoverVisible || termHoverPinned) && activeTerminalHoverId && (
            <TerminalHoverPane
              agentId={activeTerminalHoverId}
              agentName={agentNames[activeTerminalHoverId] || activeTerminalHoverId.replace('fleet:', '')}
              pinned={termHoverPinned}
              terminalInputAllowed={selectedTerminalHoverAgent.terminalInputAllowed === true}
              anchorRef={inputAreaRef}
              onDismiss={() => dismissTerminalNotification(activeTerminalHoverId)}
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
            onInterruptTier={(tier) => runInterruptTierRef.current(tier, 'rail')}
          />
          {deadTargetAgent && (
            <div
              className="fleet-dead-agent-notice"
            >
              <span>{deadTargetAgent.name} is dead</span>
              <span
                className="fleet-dead-reanimate"
                // text <span>: onPointerUp so a finger/stylus tap fires (no
                // synthesized click on touch); pointerup covers mouse too.
                onPointerUp={(e) => {
                  stopEventPropagation(e as any)
                  fleetDurable('reanimate', { agent: deadTargetAgent.id })
                }}
              >reanimate?</span>
            </div>
          )}
          <div style={{ position: 'relative' }}>
            {/* Ghost drop preview — purple lozenges per dragged file (picture
                glyph for images, document glyph otherwise) shown while a file is
                dragged over the field. */}
            {(dragLozenges || shapeDropActive) && (
              <div className="fleet-drop-ghost">
                {(dragLozenges ?? ['file']).map((kind, i) => (
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
            <PersistentCornerButtonSlider
              className="fleet-composer-gutter"
              onSelect={(action, value) => {
                if (action !== 'traffic' || !composerAgentLabel) return
                selectComposerTrafficMode(value as ComposerTrafficFilterMode)
              }}
            >
            {/* Unified follow / jump-to-bottom control. One button, fixed here:
                  - off bottom → ⇣ arrow; click jumps to bottom (does NOT change
                    follow mode — you return to the bottom first, then it's a
                    toggle again),
                  - at bottom → follow-mode toggle (horseshoe); open = smart-follow,
                    engaged (field lines) = hard-lock (always pinned).
                This replaces the separate floating ⇣ arrow. */}
            <button
              className={`fleet-hardlock-toggle${!atBottom ? ' jump-mode' : ''}`}
              data-composer-rail-action="follow"
              data-composer-rail-label={!atBottom ? 'Bottom' : hardLocked ? 'Lock' : 'Follow'}
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
                  if (next) goToTail('hard-lock-toggle')
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
            {/* Terminal peek icons — always present for the composer target.
                Unavailable targets stay visible and explain their route state. */}
            {terminalComposerControls.map((control) => {
              const agent = control.agent
              const unavailableReason = control.unavailableReason
              const isUnavailable = !!unavailableReason
              return (
              <button
                key={control.id}
                className={`fleet-terminal-icon${termHoverPinned && agent && termHoverAgentId === agent.id ? ' active' : ''}${isUnavailable ? ' unavailable' : ''}`}
                data-composer-rail-action={`terminal-${control.id}`}
                data-composer-rail-label={unavailableReason || 'Terminal'}
                aria-disabled={isUnavailable}
                onPointerDown={stopEventPropagation}
                onClick={(e) => {
                  stopEventPropagation(e as any)
                  if (!agent?.id || unavailableReason) return
                  const agentId = agent.id
                  if (termHoverPinned && termHoverAgentId === agentId) {
                    setTermHoverPinned(false)
                    setTermHoverVisible(false)
                    pickTerminalHover(null)
                  } else {
                    pickTerminalHover(agentId)
                    setTermHoverPinned(true)
                    setTermHoverVisible(true)
                  }
                }}
                onMouseEnter={() => {
                  if (termHideTimerRef.current) {
                    clearTimeout(termHideTimerRef.current)
                    termHideTimerRef.current = null
                  }
                  // The lifted label is the shared corner-button slider's job now;
                  // it reads data-composer-rail-label off this button. The bespoke
                  // rail preview state this used to set no longer exists.
                  if (!agent?.id || unavailableReason) return
                  pickTerminalHover(agent.id)
                  setTermHoverVisible(true)
                }}
                onMouseLeave={() => {
                  if (!termHoverPinned) {
                    termHideTimerRef.current = setTimeout(() => setTermHoverVisible(false), 80)
                  }
                }}
                title={unavailableReason || `${control.label} terminal`}
                aria-label={unavailableReason || `${control.label} terminal`}
              >
                <svg
                  width="10" height="10" viewBox={TERMINAL_GLYPH_VIEWBOX}
                  fill="none" stroke="currentColor" strokeWidth="1.5"
                  strokeLinecap="round" strokeLinejoin="round"
                  dangerouslySetInnerHTML={{
                    __html: TERMINAL_GLYPH_PATHS + (isUnavailable ? TERMINAL_GLYPH_UNAVAILABLE_PATH : ''),
                  }}
                />
              </button>
              )
            })}
            <button
              className={`fleet-composer-traffic-toggle fleet-composer-traffic-toggle-${composerTrafficMode}`}
              data-composer-rail-action="traffic"
              data-composer-rail-label="Traffic"
              data-composer-rail-values="dm-quiet,dm,agent"
              data-composer-rail-labels="DM|DM tools|All"
              data-composer-rail-current-value={composerTrafficMode}
              // Cycle from click, because the enclosing PersistentCornerButtonSlider
              // owns the gesture: it takes pointer capture on the rail, so this
              // button never sees its own pointer events, and it resolves a
              // no-travel press by calling button.click(). A drag release over a
              // different traffic slot selects that slot directly.
              //
              // This used to drive off pointerup instead, because a native tap on
              // a text label does not synthesize a click on iPad. That reasoning
              // was right and is now moot: the slider's click() is programmatic,
              // so it fires on touch and mouse alike, and the tap-vs-drag guard
              // that pointerup needed now lives in the slider.
              onClick={(e) => {
                stopEventPropagation(e)
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
                    : 'DM'}
            </button>
            {(composerHasText || canUnclearComposer) && (
              <button
                className={`fleet-composer-clear-toggle${canUnclearComposer ? ' unclear-mode' : ''}`}
                data-composer-rail-action="clear"
                data-composer-rail-label={canUnclearComposer ? 'Unclear' : 'Clear'}
                onClick={(e) => {
                  stopEventPropagation(e as any)
                  toggleComposerClear()
                  setComposerDraftVersion(v => v + 1)
                }}
                title={canUnclearComposer ? 'Restore cleared text' : 'Clear composer'}
                aria-label={canUnclearComposer ? 'Restore cleared composer text' : 'Clear composer text'}
              >
                {canUnclearComposer ? '↺' : '×'}
              </button>
            )}
            </PersistentCornerButtonSlider>
            <ChatComposer
              sendTargets={sendTargets}
              agentNames={agentNames}
              onSend={composerSend}
              onCommand={composerCommand}
              onKeyActivity={composerKeyActivity}
              onDrop={composerDrop}
              onDragOver={composerDragOver}
              inputRef={inputRef as any}
              isTouchDevice={_isTouchDevice}
              draftKey={composerDraftKey}
              voiceTargetSnapshotRef={composerVoiceTargetSnapshotRef}
              placeholder=""
              style={{
                width: '100%',
                background: 'transparent',
                border: '1px solid rgba(128, 128, 128, 0.15)',
                borderRadius: 4,
                // No right gutter reserved for the send hint. Skip: "the shit on
                // the right side takes up space. That's not supposed to take up
                // space. It should be a background, like the stuff on the left."
                // The hint overlays at background level instead of pushing the
                // text in.
                padding: '4px 8px',
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
 * Subscribe this chat's filter to the server for the shape/filter lifetime.
 *
 * The window is the panel's subscription history page, not a cap on live
 * delivery. There is no second history access path.
 */
const CHAT_FIRST_PAGE = 100

function useChatFilterSubscription(shape: any) {
  const { filter } = shape.props as { filter: [string, string][][] }
  const filterKey = JSON.stringify(filter ?? [])
  // Memoised on the filter's VALUE, not its identity: shape.props hands back a
  // fresh array each render, so depending on `filter` directly would resubscribe
  // on every render. This keeps the effect's dependency honest instead of
  // silencing exhaustive-deps.
  const dnf = useMemo(
    () => (filter && filter.length > 0 ? filter : null),
    [filterKey],   // eslint-disable-line react-hooks/exhaustive-deps -- filterKey IS filter, serialised
  )
  useEffect(() => {
    if (!dnf) return
    const bufferKey = `chat:${shape.id}`
    return subscribeChat(
      dnf,
      CHAT_FIRST_PAGE,
      // The panel's rows land in the panel's own buffer, which is what
      // useFleetEvents already reads. Always MERGE by id — never replace.
      //
      // A history page used to replace the buffer, on the reasoning that the
      // server had answered this filter from scratch. But a reconnect re-sends
      // the same subscription and gets the same history, so replacing emptied
      // and refilled the list under a reader who had not asked for anything —
      // and the scroller went to the top. Clearing on a genuine filter CHANGE is
      // handled where the filter is known, in fleet-data's eventBuffer.
      (events, meta) => { receiveFilterEvents(bufferKey, events, meta) },
      { humanId: getHumanId(), humanName: getHumanName(), correlationKey: bufferKey },
    )
  }, [dnf, shape.id])
}

/**
 * The unread rail's own subscription: everything addressed to me, whoever sent it.
 *
 * The rail exists to name the agents whose messages this chat is NOT showing, so
 * it cannot read the chat's buffer — that buffer holds exactly the conversation
 * already on screen. It used to read the browser-wide event store; that store no
 * longer takes global intake, so the rail asks the server the one question it
 * needs, on the same subscription mechanism every panel uses, and lands the
 * answer in its own buffer.
 *
 * Only the single-chat surface subscribes, which is the only surface that renders
 * the rail — so this is one extra subscription on a page with one chat, not a
 * second stream per panel.
 */
const UNREAD_RAIL_PAGE = 60

function unreadRailBufferKey(shapeId: string) {
  // `chat:` prefix marks the buffer server-fed — it holds exactly the rows the
  // server said match, with no second client-side predicate over them.
  return `chat:unread-rail:${shapeId}`
}

function unreadRailFilter(me: string): [string, string][][] | null {
  return me ? [[['to', me]]] : null
}

function useUnreadRailSubscription(shape: any) {
  const editor = useEditor()
  const identity = useFleetIdentity()
  const me = identity.name || identity.id || ''
  // The render-time predicate also excludes an open filter pane, which is panel
  // state the subscription cannot see. Subscribing while the pane is open costs
  // nothing: the rail simply is not rendered.
  const isOnlyChat = useValue('unread-rail-subscribe', () => {
    const userId = getHumanId()
    const deviceId = getDeviceId()
    if (!userId || !deviceId) return false
    const ownedFleetShapes = editor.getCurrentPageShapes().filter((candidate: any) =>
      isFleetShapeForOwnerKey(candidate, userId, deviceId),
    )
    return isOnlyOwnedChat(ownedFleetShapes, shape.id)
  }, [editor, shape.id])
  useEffect(() => {
    const dnf = unreadRailFilter(me)
    if (!isOnlyChat || !dnf) return
    const bufferKey = unreadRailBufferKey(shape.id)
    return subscribeChat(
      dnf,
      UNREAD_RAIL_PAGE,
      (events, meta) => { receiveFilterEvents(bufferKey, events, meta) },
      { humanId: getHumanId(), humanName: getHumanName(), correlationKey: bufferKey },
    )
  }, [isOnlyChat, me, shape.id])
}

const FleetChatComponent = memo(function FleetChatComponent({ shape }: { shape: any }) {
  useChatFilterSubscription(shape)
  useUnreadRailSubscription(shape)
  // Chat panels must not mount/unmount while the user pans horizontally. The
  // visible symptom is a flash even when the chat is idle, and the remount also
  // rebuilds the message/rendering hooks. Keep the chat mounted; the inner
  // render cache and live-store views handle event-side cost.
  return <FleetChatInner shape={shape} />
}, (prev, next) => prev.shape.props === next.shape.props)


const INTERRUPT_TIER_LABEL = ['', '⏸ soft interrupt', '⏹ interrupt', '💀 kill'] as const

function SendHint({
  filter: _filter,
  sendTargets,
  inputRef,
  onInterruptTier,
}: {
  filter: [string, string][][]
  sendTargets: string[]
  inputRef: React.RefObject<HTMLInputElement | null>
  onInterruptTier: (tier: number) => void
}) {
  // kind: '' (hidden) | 'empty' (no text, show target) | 'newline' | 'enter'
  const [kind, setKind] = useState<'' | 'empty' | 'newline' | 'enter'>('')
  // Tier under the finger while dragging up; 0 = not dragging or below the
  // first detent.
  const [dragTier, setDragTier] = useState(0)
  const dragRef = useRef<{ startY: number; step: number; tier: number } | null>(null)

  const hasTargets = sendTargets.length > 0

  // Drag up on the hint to interrupt, one detent per line: soft, hard, kill.
  // Skip: "it should be a slider itself, an upward slider. If you slide up a
  // full line it would be soft interrupt, another line hard interrupt, another
  // line kill. So we sort of have our interrupt controls available on touch
  // devices without keyboards." One detent is one composer line, measured off
  // the textarea so it tracks the font rather than a guessed constant.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!hasTargets) return
    stopEventPropagation(e)
    const ta = inputRef.current as HTMLTextAreaElement | null
    const lh = ta ? parseFloat(getComputedStyle(ta).lineHeight) : NaN
    const step = Number.isFinite(lh) && lh > 0 ? lh : 16
    dragRef.current = { startY: e.clientY, step, tier: 0 }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [hasTargets, inputRef])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    stopEventPropagation(e)
    const tier = Math.max(0, Math.min(3, Math.floor((d.startY - e.clientY) / d.step)))
    if (tier !== d.tier) { d.tier = tier; setDragTier(tier) }
  }, [])

  const endDrag = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    stopEventPropagation(e)
    dragRef.current = null
    setDragTier(0)
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    if (d.tier >= 1) onInterruptTier(d.tier)
  }, [onInterruptTier])

  const dragProps = hasTargets ? {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  } : {}

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

  // Mid-drag the hint says which tier is armed, so releasing is never a guess.
  if (dragTier > 0) {
    return (
      <span
        className={`fleet-chat-send-hint send-hint-arming send-hint-arming-${dragTier}`}
        {...dragProps}
      >
        {INTERRUPT_TIER_LABEL[dragTier]}
      </span>
    )
  }

  if (kind === '') return null
  if (kind === 'newline') return <span className="fleet-chat-send-hint" {...dragProps}>↵ newline</span>

  // 'empty' and 'enter' both show the target list. 'enter' prefixes the ↵ glyph; with no targets
  // it's just ↵.
  const enterPrefix = kind === 'enter' ? '↵ ' : ''
  if (!hasTargets) return <span className="fleet-chat-send-hint">↵</span>

  const targets = sendTargets.map((t, i) => (
    <span key={t} className="send-hint-target" style={{ display: 'inline-flex', alignItems: 'center' }}>
      {i > 0 ? ' + ' : null}
      <PrettyName prettyName={t} />
    </span>
  ))

  return (
    <span
      className="fleet-chat-send-hint"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}
      {...dragProps}
    >
      {enterPrefix}→&nbsp;{targets}
    </span>
  )
}

function FleetUnreadAgentRail({
  unreadCounts,
  displayedUnreadSenderIds,
  startDrag,
}: {
  unreadCounts: Record<string, number>
  displayedUnreadSenderIds: ReadonlySet<string>
  startDrag: (
    e: React.PointerEvent,
    pillType: 'agent' | 'label',
    value: string,
    displayName: string,
    color: string,
  ) => void
}) {
  const agents = useFleetAgents()
  const unreadRows = useMemo(
    () => getUnreadAgentRailRows(agents, unreadCounts, displayedUnreadSenderIds),
    [agents, unreadCounts, displayedUnreadSenderIds],
  )

  if (unreadRows.length === 0) return null
  return (
    <div className="fleet-unread-agent-rail" aria-label="Unread conversations">
      {unreadRows.map((row) => (
        <FleetAgentDirectoryNameColumn
          key={row.id || row.exactName}
          row={row}
          onAgentPointerDown={(event, agentRow) => startDrag(event, 'agent', agentRow.exactName, agentRow.displayName, agentRow.color)}
        />
      ))}
    </div>
  )
}

/** Filter mode — uses native click listeners to bypass tldraw event interception */
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

export function FleetChatFilterMode({
  filter,
  shapeId,
  editor,
  externalPillOver,
  surface = 'body',
}: {
  filter: [string, string][][]
  shapeId: any
  editor: any
  externalPillOver?: { role: string; value: string; displayName: string; pillType?: string } | null
  surface?: 'body' | 'overlay'
}) {
  // Native pointerup delegation on document capture — bypasses tldraw and works on touch.
  const filterModeRef = useRef<HTMLDivElement>(null)
  const viewportId = useVisibilityViewportId()
  const filterRef = useRef(filter)
  filterRef.current = filter
  const updateChatProps = useCallback((props: Record<string, unknown>) => {
    const shape = editor.getShape(shapeId)
    const wasLocked = !!shape?.isLocked
    if (wasLocked) editor.updateShape({ id: shapeId, type: 'fleet-chat', isLocked: false })
    editor.updateShape({
      id: shapeId,
      type: 'fleet-chat',
      props,
    })
    if (wasLocked) editor.updateShape({ id: shapeId, type: 'fleet-chat', isLocked: true })
  }, [editor, shapeId])
  const choiceAgents = useFleetAgents()
  const filterRows = useMemo(() => sortFleetAgentDirectoryRowsByRecency(getFleetAgentDirectoryRows(choiceAgents)), [choiceAgents])
  const { startDrag } = usePillDrag()

  useEffect(() => {
    function handlePointerUp(e: PointerEvent) {
      const target = e.target as HTMLElement
      const filterMode = filterModeRef.current
      if (!filterMode || !filterMode.contains(target)) return

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
        updateChatProps({ filter: newFilter })
        return
      }

      // Clear all
      if (target.closest('.fleet-filter-clear')) {
        updateChatProps({ filter: [] })
        return
      }
    }
    document.addEventListener('pointerup', handlePointerUp, { capture: true })
    return () => document.removeEventListener('pointerup', handlePointerUp, { capture: true })
  }, [shapeId, editor, updateChatProps])

  // Detect pill hovering over the shape — show two-pane drop preview
  const fleetPillCount = useFleetPillCount(editor)
  const pillOverKey = useValue('filter-pill-over', () => {
    if (fleetPillCount === 0) return ''
    const over = fleetPillOverShape(editor, shapeId)
    if (!over) return ''
    return `${over.props.value}\0${over.props.displayName}\0${over.props.pillType}`
  }, [editor, shapeId, fleetPillCount])

  const internalPillOver = useMemo(() => {
    if (!pillOverKey) return null
    const [value, displayName, pillType] = pillOverKey.split('\0')
    return { value, displayName, pillType }
  }, [pillOverKey])
  const pillOver = externalPillOver ?? internalPillOver
  const externalPane = fleetPillCount === 0 && (
    externalPillOver?.role === 'to' || externalPillOver?.role === 'from' || externalPillOver?.role === 'replace'
  )
    ? externalPillOver.role
    : null

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
    // Same-editor drags must use the filter-mode DOM panes: the visible active pane
    // and committed filter have to come from the same hit test. The external
    // role is only authoritative when this editor cannot see the pill shape.
    if (externalPane) return { pane: externalPane, idx: -1 }
    if (!pillOver) { lastGroupRef.current = null; return null }
    if (fleetPillCount === 0) { lastGroupRef.current = null; return null }
    const over = fleetPillOverShape(editor, shapeId)
    if (!over) { lastGroupRef.current = null; return null }
    const screenPt = pagePointToClient(editor, over.centre, viewportId)

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
  }, [editor, externalPane, pillOver, fleetPillCount])

  // Compute preview DNF for each pane based on hovered AND group
  const toGroupIdx = hoveredGroup?.pane === 'to' ? hoveredGroup.idx : -1
  const fromGroupIdx = hoveredGroup?.pane === 'from' ? hoveredGroup.idx : -1

  const toPreview = useMemo(() => {
    if (!pillOver) return null
    const role = pillOver.pillType === 'team' ? FLEET_TEAM_TO_ROLE : 'to'
    return buildFilterPreview(filter, role, pillOver.value, toGroupIdx)
  }, [pillOver, filter, toGroupIdx])

  const fromPreview = useMemo(() => {
    if (!pillOver) return null
    const role = pillOver.pillType === 'team' ? FLEET_TEAM_FROM_ROLE : 'from'
    return buildFilterPreview(filter, role, pillOver.value, fromGroupIdx)
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
      const replacePreview: [string, string][][] | null = fleetFilterForPillDrop(pillOver.pillType, pillOver.value)
      const activePaneRole = (hoveredGroup?.pane as 'to' | 'from' | 'replace' | null) ?? null
      const activePreview = activePaneRole === 'replace'
        ? replacePreview
        : activePaneRole === 'to'
          ? toPreview
          : activePaneRole === 'from'
            ? fromPreview
            : null
      const intentKey = activePaneRole && activePreview
        ? `${shapeId}:${activePaneRole}:${pillOver.value}:${hashUiIntentState(activePreview)}`
        : null
      filterDropPreview.shapeId = shapeId
      filterDropPreview.toPreview = toPreview
      filterDropPreview.fromPreview = fromPreview
      filterDropPreview.replacePreview = replacePreview
      filterDropPreview.activePaneRole = activePaneRole
      if (intentKey && activePreview && filterDropPreview.intentKey !== intentKey) {
        const tx = beginUiIntent('fleet-chat-filter-drop', {
          surface: 'fleet-chat-filter-overlay',
          input: { kind: 'pill' },
        })
        tx.validTarget({
          target: { shapeId, type: 'fleet-chat' },
          preview: {
            role: activePaneRole,
            filterHash: hashUiIntentState(activePreview),
            clauseCount: activePreview.length,
          },
        })
        filterDropPreview.intent = tx
        filterDropPreview.intentKey = intentKey
      }
    } else if (filterDropPreview.shapeId === shapeId) {
      // Only clear if WE are the current owner. If another chat has taken
      // ownership in the interim (multiple FleetChatFilterMode components mounted), leave its
      // state alone — otherwise this effect re-running on Chat A would wipe
      // the preview Chat B just published, and the next pointerup on B would
      // see a null shapeId and silently fall through to the position-based
      // fallback (the longstanding "this chat won't filter anymore" bug).
      filterDropPreview.shapeId = null
      filterDropPreview.toPreview = null
      filterDropPreview.fromPreview = null
      filterDropPreview.replacePreview = null
      filterDropPreview.activePaneRole = null
      filterDropPreview.intent = null
      filterDropPreview.intentKey = null
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
        filterDropPreview.intent = null
        filterDropPreview.intentKey = null
      }
    }
  }, [pillOver, toPreview, fromPreview, hoveredGroup, shapeId])

  // Render a single chip (role:label) — matches dashboard's chipHtml
  function renderChip(role: string, label: string, opts?: { ghost?: boolean; x?: { ci: number; ti: number } }) {
    const isTeam = role === FLEET_TEAM_FROM_ROLE || role === FLEET_TEAM_TO_ROLE
    const visibleRole = role === FLEET_TEAM_FROM_ROLE
      ? 'from'
      : role === FLEET_TEAM_TO_ROLE
        ? 'to'
        : role
    const teamParent = isTeam ? choiceAgents.find(agent => agent.id === label) : null
    const visibleLabel = teamParent ? agentDisplayLabel(teamParent) : label
    // The value is always the exact friendly_name (an opaque atom); PrettyName is
    // display-only. A plain non-agent label renders verbatim.
    return (
      <span className={`fleet-filter-chip fleet-filter-chip-${role}${opts?.ghost ? ' fleet-filter-chip-ghost' : ''}`}>
        <span className="fleet-filter-chip-role">{visibleRole}:</span>
        <span className="fleet-filter-chip-label">
          <PrettyName prettyName={visibleLabel} />
          {isTeam && <span> + team</span>}
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
    <div
      ref={filterModeRef}
      className={surface === 'overlay' ? 'fleet-filter-mode fleet-filter-mode-overlay' : 'fleet-filter-mode'}
      onPointerDown={stopEventPropagation}
    >
      {pillOver ? (
        /* Drop preview: left third = only/to+from, right side stacks to/from */
        <div className="fleet-filter-drop-panes">
          <div
            ref={replaceZoneRef}
            className={`fleet-filter-replace-zone${hoveredGroup?.pane === 'replace' ? ' fleet-filter-replace-zone-active' : ''}`}
          >
            <span className="fleet-filter-replace-label">only</span>
            {renderChip(pillOver.pillType === 'team' ? FLEET_TEAM_TO_ROLE : 'to', pillOver.value)}
            <span className="fleet-filter-replace-sep">+</span>
            {renderChip(pillOver.pillType === 'team' ? FLEET_TEAM_FROM_ROLE : 'from', pillOver.value)}
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
                {renderChip(pillOver.pillType === 'team' ? FLEET_TEAM_TO_ROLE : 'to', pillOver.value, { ghost: true })}
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
                {renderChip(pillOver.pillType === 'team' ? FLEET_TEAM_FROM_ROLE : 'from', pillOver.value, { ghost: true })}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Normal edit mode */
        <>
          <div className="fleet-filter-mode-header">
            <span style={{ fontSize: 9, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Filter</span>
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
          <div className="fleet-filter-choices fleet-agents-shape">
            <div className="fleet-agents-body">
              <FleetAgentDirectoryList
                rows={filterRows}
                onAgentPointerDown={(e, agentRow) => startDrag(e, 'agent', agentRow.exactName, agentRow.displayName, agentRow.color)}
                onLabelPointerDown={(e, label) => startDrag(e, 'label', label, label, fleetAgentLabelColor(label))}
              />
            </div>
          </div>
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
