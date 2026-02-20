// Yjs sync hook for TLDraw
// Syncs TLDraw store with a Yjs document over WebSocket
// Note: Page images (SVG backgrounds) are NOT synced - only annotations

import { useEffect, useRef } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { Editor, TLRecord } from 'tldraw'
import { SignalBus } from './signalBus'
import { appendToken } from './authToken'

interface YjsSyncOptions {
  editor: Editor
  roomId: string
  serverUrl?: string
  onInitialSync?: () => void
}

// Record types that should be synced between clients
// Session-specific records (instance, camera, pointer, instance_page_state) must NOT be synced
// Page backgrounds (SVG images) are created locally and must NOT be synced
const SYNC_TYPES = new Set(['shape', 'asset', 'page', 'document'])

function shouldSync(record: TLRecord): boolean {
  if (!record?.id || !record?.typeName) return false  // skip signals and non-TLDraw records
  if (record.id.includes('-page-')) return false  // page background images
  return SYNC_TYPES.has(record.typeName)
}

// Legacy name kept for compatibility
function isPageBackground(record: TLRecord): boolean {
  return !shouldSync(record)
}

// Module-level ref so other components can write signals into Yjs
let activeYRecords: Y.Map<TLRecord> | null = null
export function getYRecords() { return activeYRecords }

// Live URL from static annotations (set when loading annotations.json)
let staticLiveUrl: string | null = null
export function getLiveUrl() { return staticLiveUrl }

// Stable random viewer ID for this tab (prevents applying own signals)
const localViewerId = Math.random().toString(36).slice(2, 10)
export function getViewerId() { return localViewerId }

// --- Signal bus: one dispatch handles all signal types ---

const bus = new SignalBus()

type ReloadSignal = { type: 'partial', pages: number[], timestamp: number }
  | { type: 'full', timestamp: number }
const reloadHandle = bus.register<ReloadSignal>({ key: 'signal:reload' })
export const onReloadSignal = reloadHandle.on

export type ForwardSyncSignal =
  | { type: 'scroll', x: number, y: number, timestamp: number }
  | { type: 'highlight', x: number, y: number, page: number, timestamp: number }

// Forward-scroll and forward-highlight are two Yjs keys that map to one callback set.
// We register them separately but expose a unified onForwardSync.
type RawScrollSignal = { x: number; y: number; timestamp: number }
type RawHighlightSignal = { x: number; y: number; page: number; timestamp: number }

const scrollHandle = bus.register<RawScrollSignal>({ key: 'signal:forward-scroll' })
const highlightHandle = bus.register<RawHighlightSignal>({ key: 'signal:forward-highlight' })

type ForwardSyncCallback = (signal: ForwardSyncSignal) => void
const forwardSyncCallbacks = new Set<ForwardSyncCallback>()
// Wire both raw handles into the shared callback set
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

/** Write a signal into Yjs. Timestamp is added automatically. */
export function writeSignal(key: string, payload: Record<string, unknown>): void {
  const yRecords = activeYRecords
  if (!yRecords) return
  const doc = yRecords.doc!
  doc.transact(() => {
    yRecords.set(key as any, { ...payload, timestamp: Date.now() } as any)
  })
}

/** Read a signal from Yjs. Returns null if not found. */
export function readSignal<T = Record<string, unknown>>(key: string): (T & { timestamp: number }) | null {
  const yRecords = activeYRecords
  if (!yRecords) return null
  return (yRecords.get(key as any) as any) ?? null
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
async function loadStaticAnnotations(editor: Editor, onInitialSync?: () => void) {
  // Derive the annotations URL from the current document
  const params = new URLSearchParams(window.location.search)
  const docName = params.get('doc')
  if (!docName) return

  const base = import.meta.env.BASE_URL || '/'
  const url = `${base}docs/${docName}/annotations.json`

  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      console.log('[Yjs] No static annotations available')
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
      console.log(`[Yjs] Loaded ${toApply.length} static annotations from ${url}`)
      editor.store.mergeRemoteChanges(() => {
        editor.store.put(toApply)
      })
    }

    if (onInitialSync) onInitialSync()
  } catch (e) {
    console.log('[Yjs] Failed to load static annotations:', e)
  }
}

export function useYjsSync({ editor, roomId, serverUrl = 'ws://localhost:5176', onInitialSync }: YjsSyncOptions) {
  console.log(`[Yjs] useYjsSync called with roomId=${roomId}, serverUrl=${serverUrl}`)
  const docRef = useRef<Y.Doc | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    console.log(`[Yjs] Setting up sync for room ${roomId}`)
    const doc = new Y.Doc()
    docRef.current = doc
    let destroyed = false

    // --- IndexedDB local persistence ---
    // Persists all Yjs updates locally. On reload, restores from IDB before WS connects.
    // CRDT merge ensures no conflicts between local and server state.
    const idbProvider = new IndexeddbPersistence(roomId, doc)
    idbProvider.on('synced', () => {
      console.log(`[Yjs] IndexedDB synced for ${roomId}`)
    })

    // Y.Map to hold TLDraw records keyed by id
    const yRecords = doc.getMap<TLRecord>('tldraw')
    activeYRecords = yRecords

    // Track sync state
    let isRemoteUpdate = false
    let hasReceivedInitialSync = false
    let unsubscribe: (() => void) | null = null
    // IDs received from server — protected from spurious deletion during init
    const serverShapeIds = new Set<string>()
    let initProtectionActive = true

    // Track last state vector to send only changes since last send
    let lastSentStateVector: Uint8Array | null = null

    // --- WebSocket reconnection with exponential backoff ---
    let ws: WebSocket
    let reconnectDelay = 500
    const MAX_RECONNECT_DELAY = 30000

    // Binary WS protocol: [type byte][Yjs payload]
    const MSG_SYNC = 0x01
    const MSG_UPDATE = 0x02

    function sendBinary(type: number, payload: Uint8Array) {
      if (ws?.readyState !== WebSocket.OPEN) return
      const msg = new Uint8Array(1 + payload.length)
      msg[0] = type
      msg.set(payload, 1)
      ws.send(msg)
    }

    function parseMessage(data: ArrayBuffer | string): { type: 'sync' | 'update', payload: Uint8Array } | null {
      if (data instanceof ArrayBuffer) {
        const buf = new Uint8Array(data)
        if (buf.length > 0 && (buf[0] === MSG_SYNC || buf[0] === MSG_UPDATE)) {
          return { type: buf[0] === MSG_SYNC ? 'sync' : 'update', payload: buf.subarray(1) }
        }
      }
      // JSON fallback for backward compatibility
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
        if (msg.type === 'sync' || msg.type === 'update') {
          return { type: msg.type, payload: new Uint8Array(msg.data) }
        }
      } catch {}
      return null
    }

    // Send any doc update to the server (catches direct yRecords writes like ping signals)
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return  // don't echo back remote updates
      sendBinary(MSG_UPDATE, update)
    })

    function connect() {
      ws = new WebSocket(appendToken(`${serverUrl}/${roomId}`))
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        console.log(`[Yjs] Connected to ${roomId}`)
        reconnectDelay = 500  // reset backoff

        // On reconnect (not first connect), send our full state to merge with server
        if (hasReceivedInitialSync) {
          console.log('[Yjs] Reconnected — sending local state to server')
          sendBinary(MSG_UPDATE, Y.encodeStateAsUpdate(doc))
          lastSentStateVector = Y.encodeStateVector(doc)
        }
      }

      ws.onmessage = (event) => {
        try {
          const msg = parseMessage(event.data)
          if (!msg) return

          isRemoteUpdate = true
          try {
            Y.applyUpdate(doc, msg.payload, 'remote')
          } catch (e) {
            console.error('[Yjs] Failed to apply update:', e)
          }
          isRemoteUpdate = false

          // After receiving initial sync, set up bidirectional sync
          if (msg.type === 'sync' && !hasReceivedInitialSync) {
              hasReceivedInitialSync = true
              console.log(`[Yjs] Initial sync received (${yRecords.size} records from server)`)

              // Apply syncable records from server to editor
              const toApply: TLRecord[] = []
              yRecords.forEach((record, id) => {
                if (shouldSync(record)) {
                  toApply.push(record)
                  serverShapeIds.add(id)
                }
              })
              if (toApply.length > 0) {
                console.log(`[Yjs] Applying ${toApply.length} records to editor`)
                editor.store.mergeRemoteChanges(() => {
                  editor.store.put(toApply)
                })
              }

              // Call onInitialSync callback if provided
              if (onInitialSync) {
                console.log('[Yjs] Calling onInitialSync callback')
                onInitialSync()
              }

              try {
                setupBidirectionalSync()
                lastSentStateVector = Y.encodeStateVector(doc)

                // Event-driven init protection
                // Wait for SvgDocument to signal pages are ready instead of a fixed timer
                const onPagesReady = () => {
                  if (initProtectionActive) {
                    initProtectionActive = false
                    console.log(`[Yjs] Init protection expired (pages ready, ${serverShapeIds.size} shapes protected)`)
                  }
                  window.removeEventListener('tldraw-pages-ready', onPagesReady)
                }
                window.addEventListener('tldraw-pages-ready', onPagesReady)

                // Safety fallback: 30s max (in case event never fires)
                setTimeout(() => {
                  if (initProtectionActive) {
                    initProtectionActive = false
                    console.log(`[Yjs] Init protection expired (30s timeout, ${serverShapeIds.size} shapes protected)`)
                    window.removeEventListener('tldraw-pages-ready', onPagesReady)
                  }
                }, 30000)
              } catch (e) {
                console.error('[Yjs] Failed to setup bidirectional sync:', e)
              }
            }
        } catch (e) {
          console.error('[Yjs] Message error:', e)
        }
      }

      ws.onclose = () => {
        if (destroyed) return
        console.log(`[Yjs] Disconnected, reconnecting in ${reconnectDelay}ms`)
        setTimeout(() => {
          if (!destroyed) connect()
        }, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
      }

      ws.onerror = (err) => {
        console.error('[Yjs] WebSocket error:', err)

        // Fallback: load static annotations if sync server unavailable
        if (!hasReceivedInitialSync) {
          loadStaticAnnotations(editor, onInitialSync)
        }
      }
    }

    connect()

    // Sync Y.Map changes to TLDraw
    yRecords.observe((event) => {
      // Dispatch all signal changes through the bus
      event.changes.keys.forEach((change, key) => {
        if (key.startsWith('signal:')) {
          bus.dispatch(key, change.action, () => yRecords.get(key), !hasReceivedInitialSync)
        }
      })

      if (isRemoteUpdate) {
        try {
          // Apply remote changes to TLDraw
          const toAdd: TLRecord[] = []
          const toUpdate: TLRecord[] = []
          const toRemove: TLRecord['id'][] = []

          event.changes.keys.forEach((change, key) => {
            if (key.startsWith('signal:')) return  // skip signals
            if (change.action === 'add') {
              const record = yRecords.get(key)
              if (record && shouldSync(record)) toAdd.push(record)
            } else if (change.action === 'update') {
              const record = yRecords.get(key)
              if (record && shouldSync(record)) toUpdate.push(record)
            } else if (change.action === 'delete') {
              // Only remove shapes/assets/pages/documents
              if (SYNC_TYPES.has(key.split(':')[0])) {
                toRemove.push(key as TLRecord['id'])
              }
            }
          })

          editor.store.mergeRemoteChanges(() => {
            if (toRemove.length) editor.store.remove(toRemove)
            if (toAdd.length) editor.store.put(toAdd)
            if (toUpdate.length) editor.store.put(toUpdate)
          })
        } catch (e) {
          console.error('[Yjs] Failed to apply remote changes:', e)
        }
      }
    })

    function setupBidirectionalSync() {
      // If server had no data, push our local state (excluding page backgrounds)
      if (yRecords.size === 0) {
        console.log('[Yjs] Server empty, pushing local state')
        const allRecords = editor.store.allRecords()
        const toSync = allRecords.filter(r => !isPageBackground(r))
        console.log(`[Yjs] Syncing ${toSync.length} records (excluding ${allRecords.length - toSync.length} page backgrounds)`)
        doc.transact(() => {
          for (const record of toSync) {
            yRecords.set(record.id, record)
          }
        })
        // Send to server
        sendBinary(MSG_UPDATE, Y.encodeStateAsUpdate(doc))
      }

      // Incremental updates
      function sendUpdate() {
        if (ws?.readyState !== WebSocket.OPEN) return
        try {
          const sv = lastSentStateVector
          const update = sv
            ? Y.encodeStateAsUpdate(doc, sv)    // incremental: only changes since last send
            : Y.encodeStateAsUpdate(doc)         // full state on first send
          lastSentStateVector = Y.encodeStateVector(doc)
          console.log(`[Yjs] Sending update (${update.length} bytes)`)
          sendBinary(MSG_UPDATE, update)
        } catch (e) {
          console.error('[Yjs] Failed to send update:', e)
        }
      }

      // Throttle: send immediately on first change, debounce subsequent within 100ms
      let sendTimeout: ReturnType<typeof setTimeout> | null = null

      function throttledSend() {
        if (sendTimeout) {
          clearTimeout(sendTimeout)
        }
        sendTimeout = setTimeout(() => {
          sendTimeout = null
          sendUpdate()
        }, 100)
      }

      // Now listen for local changes and sync to server
      console.log('[Yjs] Setting up store listener for local changes')
      unsubscribe = editor.store.listen(({ changes }) => {
        if (isRemoteUpdate) return

        const added = Object.values(changes.added).filter(r => !isPageBackground(r))
        const updated = Object.values(changes.updated).filter(([,to]) => !isPageBackground(to))
        const removed = Object.values(changes.removed).filter(r => !isPageBackground(r))

        if (added.length || updated.length || removed.length) {
          console.log(`[Yjs] Local change: +${added.length} ~${updated.length} -${removed.length}`)
        }

        try {
          doc.transact(() => {
            for (const record of Object.values(changes.added)) {
              if (!isPageBackground(record)) {
                yRecords.set(record.id, record)
              }
            }
            for (const [, to] of Object.values(changes.updated)) {
              if (!isPageBackground(to)) {
                yRecords.set(to.id, to)
              }
            }
            for (const record of Object.values(changes.removed)) {
              if (!isPageBackground(record)) {
                // During init, don't delete shapes that came from the server
                // (TLDraw may spuriously remove them before pages fully load)
                if (initProtectionActive && serverShapeIds.has(record.id)) {
                  console.log(`[Yjs] Protecting server shape from deletion: ${record.id}`)
                  continue
                }
                yRecords.delete(record.id)
              }
            }
          })

          throttledSend()
        } catch (e) {
          console.error('[Yjs] Failed to sync local changes:', e)
        }
      }, { source: 'user', scope: 'document' })
    }

    return () => {
      destroyed = true
      activeYRecords = null
      if (unsubscribe) unsubscribe()
      ws?.close()
      idbProvider.destroy()
      doc.destroy()
    }
  }, [editor, roomId, serverUrl])
}
