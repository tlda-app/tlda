// Signal dispatch and read/write for the viewer.
// Signals arrive via @tldraw/sync custom messages (see SvgDocument.tsx onCustomMessage).
// Signal writes go via HTTP POST to /api/projects/:name/signal.
// Shape sync is handled by @tldraw/sync (see SvgDocument.tsx).

import type { TLRecord } from 'tldraw'
import { SignalBus } from './signalBus'

// --- Module-level connection state ---

let activeDocName: string | null = null
let activeServerUrl: string = ''

/** Local signal cache: populated by dispatchSignalDirect and writeSignal */
const signalCache = new Map<string, any>()

/**
 * Initialize the signal connection for a document.
 * Called from SvgDocument when the editor mounts.
 */
export function initSignalConnection(docName: string, serverUrl: string) {
  activeDocName = docName
  // Convert ws:// to http:// for REST calls
  activeServerUrl = serverUrl.replace(/^ws(s?):\/\//, 'http$1://')
  signalCache.clear()
  console.log(`[Signal] Initialized for ${docName} → ${activeServerUrl}`)
}

/** Tear down the signal connection. Called on cleanup. */
export function teardownSignalConnection() {
  console.log(`[Signal] Teardown for ${activeDocName}`)
  activeDocName = null
  signalCache.clear()
}

/** Check if signal connection is active (replaces getYRecords() null check) */
export function isSignalConnected(): boolean {
  return activeDocName !== null
}

// Live URL from static annotations (set when loading annotations.json)
let staticLiveUrl: string | null = null
export function getLiveUrl() { return staticLiveUrl }

// Stable random viewer ID for this tab (prevents applying own signals)
const localViewerId = Math.random().toString(36).slice(2, 10)
export function getViewerId() { return localViewerId }

// --- Signal bus: one dispatch handles all signal types ---

const bus = new SignalBus()

/** Dispatch a signal directly (for custom messages from @tldraw/sync connection) */
export function dispatchSignalDirect(key: string, data: Record<string, unknown>) {
  signalCache.set(key, data)
  bus.dispatchDirect(key, data)
}

type ReloadSignal = { type: 'partial', pages: number[], timestamp: number }
  | { type: 'full', timestamp: number }
const reloadHandle = bus.register<ReloadSignal>({ key: 'signal:reload' })
export const onReloadSignal = reloadHandle.on

export type ForwardSyncSignal =
  | { type: 'scroll', x: number, y: number, timestamp: number }
  | { type: 'highlight', x: number, y: number, page: number, timestamp: number }

// Forward-scroll and forward-highlight are two signal keys that map to one callback set.
type RawScrollSignal = { x: number; y: number; timestamp: number }
type RawHighlightSignal = { x: number; y: number; page: number; timestamp: number }

const scrollHandle = bus.register<RawScrollSignal>({ key: 'signal:forward-scroll' })
const highlightHandle = bus.register<RawHighlightSignal>({ key: 'signal:forward-highlight' })

type ForwardSyncCallback = (signal: ForwardSyncSignal) => void
const forwardSyncCallbacks = new Set<ForwardSyncCallback>()
scrollHandle.on((s) => { for (const cb of forwardSyncCallbacks) cb({ type: 'scroll', ...s }) })
highlightHandle.on((s) => { for (const cb of forwardSyncCallbacks) cb({ type: 'highlight', ...s }) })

export function onForwardSync(cb: ForwardSyncCallback) {
  forwardSyncCallbacks.add(cb)
  return () => { forwardSyncCallbacks.delete(cb) }
}

const screenshotHandle = bus.register<{ timestamp: number }>({
  key: 'signal:screenshot-request',
  initBehavior: 'fire-if-recent',
  recentMs: 10000,
})
export const onScreenshotRequest = screenshotHandle.on

export type CameraLinkSignal = { x: number; y: number; z: number; viewerId: string; timestamp: number }
const cameraLinkHandle = bus.register<CameraLinkSignal>({
  key: 'signal:camera-link',
  accept: (s) => s.viewerId !== localViewerId,
})
export const onCameraLink = cameraLinkHandle.on

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
  initBehavior: 'fire-if-recent',
  recentMs: 600_000,  // show errors from last 10 min on reconnect
})
export const onBuildStatusSignal = buildStatusHandle.on

export type BuildProgressSignal = {
  phase: 'compiling' | 'converting' | 'hot' | 'done' | 'failed'
  detail: string | null  // e.g. 'compiled in 17.2s', 'pages 3,5', '192.1s', error message
  timestamp: number
}
const buildProgressHandle = bus.register<BuildProgressSignal>({
  key: 'signal:build-progress',
  initBehavior: 'fire-if-recent',
  recentMs: 300_000,  // show recent build progress on reconnect
})
export const onBuildProgressSignal = buildProgressHandle.on

export type AgentAttentionSignal = { x: number; y: number; timestamp: number; agent?: string }
const agentAttentionHandle = bus.register<AgentAttentionSignal>({ key: 'signal:agent-attention' })
export const onAgentAttention = agentAttentionHandle.on

export type AgentHeartbeatSignal = { state: string; timestamp: number; agent?: string }
const agentHeartbeatHandle = bus.register<AgentHeartbeatSignal>({
  key: 'signal:agent-heartbeat',
  initBehavior: 'fire-if-recent',
  recentMs: 30_000,
})
export const onAgentHeartbeat = agentHeartbeatHandle.on

export type RefViewerSignal = {
  refs: Array<{ label: string; region: { page: number; yTop: number; yBottom: number; displayLabel?: string } }> | null
  viewerId: string
  timestamp: number
}
const refViewerHandle = bus.register<RefViewerSignal>({
  key: 'signal:ref-viewer',
  accept: (s) => s.viewerId !== localViewerId,
})
export const onRefViewerSignal = refViewerHandle.on

// Diff review and summaries — register so callers can subscribe to changes
const diffReviewHandle = bus.register<{ reviews: Record<number, string>; timestamp: number }>({
  key: 'signal:diff-review',
  initBehavior: 'fire-if-recent',
  recentMs: 86_400_000,  // 24h
})
export const onDiffReview = diffReviewHandle.on

const diffSummariesHandle = bus.register<{ summaries: Record<number, string>; timestamp: number }>({
  key: 'signal:diff-summaries',
  initBehavior: 'fire-if-recent',
  recentMs: 86_400_000,  // 24h
})
export const onDiffSummaries = diffSummariesHandle.on

/**
 * Write a signal via HTTP POST. Timestamp is added automatically.
 * Also caches locally and dispatches to the signal bus so own UI reacts.
 */
export function writeSignal(key: string, payload: Record<string, unknown>): void {
  if (!activeDocName) return
  const data = { ...payload, timestamp: Date.now() }
  // Cache locally
  signalCache.set(key, data)
  // Dispatch locally so own UI reacts immediately
  bus.dispatchDirect(key, data)
  // Fire-and-forget POST to server for broadcast to other clients
  fetch(`${activeServerUrl}/api/projects/${activeDocName}/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, ...data }),
  }).catch(() => {})
}

/** Read a signal from the local cache. Returns null if not found. */
export function readSignal<T = Record<string, unknown>>(key: string): (T & { timestamp: number }) | null {
  return signalCache.get(key) ?? null
}

export type PresenterSignal = { viewerId: string; active: boolean; timestamp: number }
const presenterHandle = bus.register<PresenterSignal>({
  key: 'signal:presenter',
  initBehavior: 'fire-if-recent',
  recentMs: 600_000, // 10 min — presenter identity persists across brief reconnects
})
export const onPresenterSignal = presenterHandle.on

export function broadcastPresenter(active: boolean) {
  writeSignal('signal:presenter', { viewerId: localViewerId, active })
}

export function broadcastCamera(x: number, y: number, z: number) {
  writeSignal('signal:camera-link', { x, y, z, viewerId: localViewerId })
}

export function broadcastRefViewer(refs: RefViewerSignal['refs']) {
  writeSignal('signal:ref-viewer', { refs, viewerId: localViewerId })
}

/**
 * Load static annotations from annotations.json when no sync server is available.
 * Used in production (GitHub Pages) where annotations were baked in by publish-snapshot.
 */
export async function loadStaticAnnotations(editor: any, onInitialSync?: () => void) {
  // Derive the annotations URL from the current document
  const params = new URLSearchParams(window.location.search)
  const docName = params.get('doc')
  if (!docName) return

  const base = import.meta.env.BASE_URL || '/'
  const url = `${base}docs/${docName}/annotations.json`

  const SYNC_TYPES = new Set(['shape', 'asset', 'page', 'document'])

  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      console.log('[Sync] No static annotations available')
      return
    }

    const data = await resp.json()
    if (data.liveUrl) {
      staticLiveUrl = data.liveUrl
    }
    const records = data.records || {}
    const toApply: TLRecord[] = []

    for (const [id, record] of Object.entries(records)) {
      if ((id as string).startsWith('signal:')) continue
      const rec = record as TLRecord
      if (rec.typeName && SYNC_TYPES.has(rec.typeName) && !(rec.id as string).includes('-page-')) {
        toApply.push(rec)
      }
    }

    if (toApply.length > 0) {
      console.log(`[Sync] Loaded ${toApply.length} static annotations from ${url}`)
      editor.store.mergeRemoteChanges(() => {
        editor.store.put(toApply)
      })
    }

    if (onInitialSync) onInitialSync()
  } catch (e) {
    console.log('[Sync] Failed to load static annotations:', e)
  }
}
