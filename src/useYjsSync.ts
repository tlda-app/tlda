// Signal dispatch and read/write for the viewer.
// Signals arrive via @tldraw/sync custom messages (see SvgDocument.tsx onCustomMessage).
// Signal writes go via HTTP POST to /api/projects/:name/signal.
// Shape sync is handled by @tldraw/sync (see SvgDocument.tsx).

import { getSignalReplayMs } from '../shared/signals.ts'
import { SignalBus } from './signalBus'

// --- Module-level connection state ---

let activeProjectName: string | null = null
let activeServerUrl: string = ''

/** Local signal cache: populated by dispatchSignalDirect and writeSignal */
const signalCache = new Map<string, any>()

/**
 * Initialize the signal connection for a document.
 * Called from SvgDocument when the editor mounts.
 */
export function initSignalConnection(projectName: string, serverUrl: string) {
  activeProjectName = projectName
  // Convert ws:// to http:// for REST calls
  activeServerUrl = serverUrl.replace(/^ws(s?):\/\//, 'http$1://')
  signalCache.clear()
  console.log(`[Signal] Initialized for ${projectName} → ${activeServerUrl}`)
}

/** Tear down the signal connection. Called on cleanup. */
export function teardownSignalConnection() {
  console.log(`[Signal] Teardown for ${activeProjectName}`)
  activeProjectName = null
  signalCache.clear()
}

/** Check if signal connection is active (replaces getYRecords() null check) */
export function isSignalConnected(): boolean {
  return activeProjectName !== null
}

// Stable random viewer ID for this tab (prevents applying own signals)
const localViewerId = Math.random().toString(36).slice(2, 10)
export function getViewerId() { return localViewerId }

// --- Signal bus: one dispatch handles all signal types ---

const bus = new SignalBus()

function replayConfig(key: string): Pick<SignalDefWithTimestamp, 'initBehavior' | 'recentMs'> {
  const replayMs = getSignalReplayMs(key)
  return replayMs == null ? {} : { initBehavior: 'fire-if-recent', recentMs: replayMs }
}

type SignalDefWithTimestamp = {
  initBehavior?: 'discard' | 'fire-if-recent'
  recentMs?: number
}

/** Dispatch a signal directly (for custom messages from @tldraw/sync connection) */
export function dispatchSignalDirect(key: string, data: Record<string, unknown>) {
  signalCache.set(key, data)
  bus.dispatchDirect(key, data)
}

type ReloadSignal = { type: 'partial', pages: number[], timestamp: number }
  | { type: 'full', timestamp: number }
const reloadHandle = bus.register<ReloadSignal>({
  key: 'signal:reload',
  ...replayConfig('signal:reload'),
})
export const onReloadSignal = reloadHandle.on

const sourceChangedHandle = bus.register<{ timestamp: number }>({ key: 'signal:source-changed' })
export const onSourceChangedSignal = sourceChangedHandle.on

export type ProjectPartsChangedSignal = { files: string[], timestamp: number }
const projectPartsChangedHandle = bus.register<ProjectPartsChangedSignal>({ key: 'signal:project-parts-changed' })
export const onProjectPartsChangedSignal = projectPartsChangedHandle.on

export type ForwardSyncSignal =
  | { type: 'scroll', x: number, y: number, timestamp: number }
  | { type: 'highlight', x: number, y: number, page: number, timestamp: number }
  | { type: 'scroll-to-element', id: string }
  | { type: 'set-chat-target', agent: string, panel?: string, chatShapeId?: string }

// Forward-scroll and forward-highlight are two signal keys that map to one callback set.
type RawScrollSignal = { x: number; y: number; timestamp: number }
type RawHighlightSignal = { x: number; y: number; page: number; timestamp: number }

const scrollHandle = bus.register<RawScrollSignal>({ key: 'signal:forward-scroll' })
const highlightHandle = bus.register<RawHighlightSignal>({ key: 'signal:forward-highlight' })

type RawScrollToElementSignal = { id: string; timestamp: number }
const scrollToElementHandle = bus.register<RawScrollToElementSignal>({ key: 'signal:scroll-to-element' })

type RawSetChatTargetSignal = { agent: string; panel?: string; chatShapeId?: string; timestamp: number }
const setChatTargetHandle = bus.register<RawSetChatTargetSignal>({ key: 'signal:set-chat-target' })

type ForwardSyncCallback = (signal: ForwardSyncSignal) => void
const forwardSyncCallbacks = new Set<ForwardSyncCallback>()
scrollHandle.on((s) => { for (const cb of forwardSyncCallbacks) cb({ type: 'scroll', ...s }) })
highlightHandle.on((s) => { for (const cb of forwardSyncCallbacks) cb({ type: 'highlight', ...s }) })
scrollToElementHandle.on((s) => { for (const cb of forwardSyncCallbacks) cb({ type: 'scroll-to-element', id: s.id }) })
setChatTargetHandle.on((s) => { for (const cb of forwardSyncCallbacks) cb({ type: 'set-chat-target', agent: s.agent, panel: s.panel, chatShapeId: s.chatShapeId }) })

export function onForwardSync(cb: ForwardSyncCallback) {
  forwardSyncCallbacks.add(cb)
  return () => { forwardSyncCallbacks.delete(cb) }
}

export type ScreenshotRequest = {
  timestamp: number
  /** Optional canvas bounds — if provided, capture this region instead of the viewport */
  bounds?: { x: number; y: number; w: number; h: number }
  /** Optional page number — if provided (and no bounds), capture this page */
  page?: number
  /** Agent name requesting the screenshot */
  agent?: string
}
const screenshotHandle = bus.register<ScreenshotRequest>({
  key: 'signal:screenshot-request',
  ...replayConfig('signal:screenshot-request'),
})
export const onScreenshotRequest = screenshotHandle.on

export type ScreenshotBoundsSignal = {
  bounds: { x: number; y: number; w: number; h: number }
  agent?: string
  timestamp: number
}
const screenshotBoundsHandle = bus.register<ScreenshotBoundsSignal>({
  key: 'signal:screenshot-bounds',
  ...replayConfig('signal:screenshot-bounds'),
})
export const onScreenshotBounds = screenshotBoundsHandle.on

export type CameraLinkSignal = { x: number; y: number; z: number; viewerId: string; timestamp: number }
const cameraLinkHandle = bus.register<CameraLinkSignal>({
  key: 'signal:camera-link',
  accept: (s) => s.viewerId !== localViewerId,
})
export const onCameraLink = cameraLinkHandle.on

export type SlideFragmentSignal = {
  shapeId: string
  current: number
  total: number
  viewerId: string
  timestamp: number
}
export type SlideIndexSignal = {
  shapeId: string
  index: number
  viewerId: string
  timestamp: number
}
const slideIndexHandle = bus.register<SlideIndexSignal>({
  key: 'signal:slide-index',
  accept: (s) => s.viewerId !== localViewerId,
  ...replayConfig('signal:slide-index'),
})
export const onSlideIndex = slideIndexHandle.on

const slideFragmentHandle = bus.register<SlideFragmentSignal>({
  key: 'signal:slide-fragment',
  accept: (s) => s.viewerId !== localViewerId,
  ...replayConfig('signal:slide-fragment'),
})
export const onSlideFragment = slideFragmentHandle.on

export type BuildError = {
  message: string
  line?: number
  file: string
  context?: Array<{ line: number; text: string }>
  errorLine?: number
}
export type BuildWarning = {
  message: string
  line?: number | null
  file?: string | null
  category?: string
}
export type BuildStatusSignal = {
  error: string | null
  errors: BuildError[]
  warnings: BuildWarning[]
  timestamp: number
}
const buildStatusHandle = bus.register<BuildStatusSignal>({
  key: 'signal:build-status',
  ...replayConfig('signal:build-status'),
})
export const onBuildStatusSignal = buildStatusHandle.on

export type BuildProgressSignal = {
  phase: 'compiling' | 'converting' | 'hot' | 'done' | 'failed'
  detail: string | null  // e.g. 'compiled in 17.2s', 'pages 3,5', '192.1s', error message
  timestamp: number
}
const buildProgressHandle = bus.register<BuildProgressSignal>({
  key: 'signal:build-progress',
  ...replayConfig('signal:build-progress'),
})
export const onBuildProgressSignal = buildProgressHandle.on

// Compare: side-by-side version viewer signal. initBehavior: 'none' —
// do NOT fire cached signal on reconnect. The compare shapes persist in
// the Yjs store; re-firing would delete them (clearCompareShapes) and
// try to recreate, which fails if the editor isn't ready yet.
export type CompareSignal = { ref: string | null; hash7?: string; timestamp: number }
const compareHandle = bus.register<CompareSignal>({
  key: 'signal:compare',
  initBehavior: 'discard',
})
export const onCompareSignal = compareHandle.on

export type AgentAttentionSignal = { x: number; y: number; timestamp: number; agent?: string }
const agentAttentionHandle = bus.register<AgentAttentionSignal>({ key: 'signal:agent-attention' })
export const onAgentAttention = agentAttentionHandle.on

export type AgentHeartbeatSignal = { state: string; timestamp: number; agent?: string }
const agentHeartbeatHandle = bus.register<AgentHeartbeatSignal>({
  key: 'signal:agent-heartbeat',
  ...replayConfig('signal:agent-heartbeat'),
})
export const onAgentHeartbeat = agentHeartbeatHandle.on


// Diff review and summaries — register so callers can subscribe to changes
const diffReviewHandle = bus.register<{ reviews: Record<number, string>; timestamp: number }>({
  key: 'signal:diff-review',
  ...replayConfig('signal:diff-review'),
})
export const onDiffReview = diffReviewHandle.on

const diffSummariesHandle = bus.register<{ summaries: Record<number, string>; timestamp: number }>({
  key: 'signal:diff-summaries',
  ...replayConfig('signal:diff-summaries'),
})
export const onDiffSummaries = diffSummariesHandle.on

/**
 * Write a signal via HTTP POST. Timestamp is added automatically.
 * Also caches locally and dispatches to the signal bus so own UI reacts.
 */
export function writeSignal(key: string, payload: Record<string, unknown>): void {
  if (!activeProjectName) return
  const data = { ...payload, timestamp: Date.now() }
  // Cache locally
  signalCache.set(key, data)
  // Dispatch locally so own UI reacts immediately
  bus.dispatchDirect(key, data)
  // Fire-and-forget POST to server for broadcast to other clients.
  // Use a relative URL when the signal server is a different origin (dev proxy handles it).
  const signalPath = `/api/projects/${activeProjectName}/signal`
  const isCrossOrigin = activeServerUrl && typeof window !== 'undefined'
    && new URL(activeServerUrl).origin !== window.location.origin
  const signalUrl = isCrossOrigin ? signalPath : `${activeServerUrl}${signalPath}`
  fetch(signalUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, ...data }),
  }).catch(e => console.warn('[yjs] signal post failed:', e.message))
}

/** Read a signal from the local cache. Returns null if not found. */
export function readSignal<T = Record<string, unknown>>(key: string): (T & { timestamp: number }) | null {
  return signalCache.get(key) ?? null
}

export type PresenterSignal = { viewerId: string; active: boolean; timestamp: number }
const presenterHandle = bus.register<PresenterSignal>({
  key: 'signal:presenter',
  ...replayConfig('signal:presenter'),
})
export const onPresenterSignal = presenterHandle.on

export function broadcastPresenter(active: boolean) {
  writeSignal('signal:presenter', { viewerId: localViewerId, active })
}


export function broadcastCamera(x: number, y: number, z: number) {
  writeSignal('signal:camera-link', { x, y, z, viewerId: localViewerId })
}

export function broadcastSlideFragment(shapeId: string, current: number, total: number) {
  writeSignal('signal:slide-fragment', { shapeId, current, total, viewerId: localViewerId })
}

export function broadcastSlideIndex(shapeId: string, index: number) {
  writeSignal('signal:slide-index', { shapeId, index, viewerId: localViewerId })
}
