// Yjs sync hook for TLDraw
// Syncs TLDraw store with a Yjs document over WebSocket
// Note: Page images (SVG backgrounds) are NOT synced - only annotations

import { useEffect, useRef } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { Editor, TLRecord } from 'tldraw'

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

// Reload signal callback registration
type ReloadSignal = { type: 'partial', pages: number[], timestamp: number }
  | { type: 'full', timestamp: number }
type ReloadCallback = (signal: ReloadSignal) => void
const reloadCallbacks = new Set<ReloadCallback>()
export function onReloadSignal(cb: ReloadCallback) {
  reloadCallbacks.add(cb)
  return () => { reloadCallbacks.delete(cb) }
}
let lastReloadTimestamp = 0

// Forward sync signal callback registration (scroll, highlight from Claude)
export type ForwardSyncSignal =
  | { type: 'scroll', x: number, y: number, timestamp: number }
  | { type: 'highlight', x: number, y: number, page: number, timestamp: number }
type ForwardSyncCallback = (signal: ForwardSyncSignal) => void
const forwardSyncCallbacks = new Set<ForwardSyncCallback>()
export function onForwardSync(cb: ForwardSyncCallback) {
  forwardSyncCallbacks.add(cb)
  return () => { forwardSyncCallbacks.delete(cb) }
}
let lastScrollTimestamp = 0
let lastHighlightTimestamp = 0

// Screenshot request callback (MCP asks viewer to capture viewport)
type ScreenshotCallback = () => void
const screenshotCallbacks = new Set<ScreenshotCallback>()
export function onScreenshotRequest(cb: ScreenshotCallback) {
  screenshotCallbacks.add(cb)
  return () => { screenshotCallbacks.delete(cb) }
}
let lastScreenshotRequestTimestamp = 0

// Camera link: sync camera position between viewers
export type CameraLinkSignal = { x: number; y: number; z: number; viewerId: string; timestamp: number }
type CameraLinkCallback = (signal: CameraLinkSignal) => void
const cameraLinkCallbacks = new Set<CameraLinkCallback>()
export function onCameraLink(cb: CameraLinkCallback) {
  cameraLinkCallbacks.add(cb)
  return () => { cameraLinkCallbacks.delete(cb) }
}
let lastCameraLinkTimestamp = 0

// Ref viewer: sync click-to-reference state between viewers
export type RefViewerSignal = {
  refs: Array<{ label: string; region: { page: number; yTop: number; yBottom: number; displayLabel?: string } }> | null
  viewerId: string
  timestamp: number
}
type RefViewerCallback = (signal: RefViewerSignal) => void
const refViewerCallbacks = new Set<RefViewerCallback>()
export function onRefViewerSignal(cb: RefViewerCallback) {
  refViewerCallbacks.add(cb)
  return () => { refViewerCallbacks.delete(cb) }
}
let lastRefViewerTimestamp = 0

// Stable random viewer ID for this tab (prevents applying own signals)
const localViewerId = Math.random().toString(36).slice(2, 10)
export function getViewerId() { return localViewerId }

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

    // --- Fix 1: IndexedDB local persistence ---
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

    // --- Fix 4: Incremental updates ---
    // Track last state vector to send only changes since last send
    let lastSentStateVector: Uint8Array | null = null

    // --- Fix 2: WebSocket reconnection with exponential backoff ---
    let ws: WebSocket
    let reconnectDelay = 500
    const MAX_RECONNECT_DELAY = 30000

    // Send any doc update to the server (catches direct yRecords writes like ping signals)
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return  // don't echo back remote updates
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }))
      }
    })

    function connect() {
      ws = new WebSocket(`${serverUrl}/${roomId}`)
      wsRef.current = ws

      ws.onopen = () => {
        console.log(`[Yjs] Connected to ${roomId}`)
        reconnectDelay = 500  // reset backoff

        // On reconnect (not first connect), send our full state to merge with server
        if (hasReceivedInitialSync) {
          console.log('[Yjs] Reconnected — sending local state to server')
          const update = Y.encodeStateAsUpdate(doc)
          ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }))
          lastSentStateVector = Y.encodeStateVector(doc)
        }
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'sync' || msg.type === 'update') {
            isRemoteUpdate = true
            try {
              const update = new Uint8Array(msg.data)
              Y.applyUpdate(doc, update, 'remote')
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

                // --- Fix 3: Event-driven init protection ---
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
      // Check for signals (reload, forward sync)
      event.changes.keys.forEach((change, key) => {
        if (key === 'signal:reload' && (change.action === 'add' || change.action === 'update')) {
          const signal = yRecords.get(key) as unknown as ReloadSignal & Record<string, unknown>
          if (signal?.timestamp && signal.timestamp > lastReloadTimestamp) {
            lastReloadTimestamp = signal.timestamp
            console.log(`[Yjs] Reload signal: ${signal.type}`, signal)
            for (const cb of reloadCallbacks) cb(signal)
          }
        }

        // Forward sync: scroll
        if (key === 'signal:forward-scroll' && (change.action === 'add' || change.action === 'update')) {
          const signal = yRecords.get(key) as unknown as ForwardSyncSignal & { x: number, y: number, timestamp: number }
          if (!hasReceivedInitialSync) {
            // During initial sync, just record timestamp to skip stale signals
            if (signal?.timestamp) lastScrollTimestamp = signal.timestamp
          } else if (signal?.timestamp && signal.timestamp > lastScrollTimestamp) {
            lastScrollTimestamp = signal.timestamp
            console.log(`[Yjs] Forward scroll: (${signal.x}, ${signal.y})`)
            const { type: _, ...rest } = signal
            for (const cb of forwardSyncCallbacks) cb({ type: 'scroll', ...rest })
          }
        }

        // Screenshot request from MCP
        if (key === 'signal:screenshot-request' && (change.action === 'add' || change.action === 'update')) {
          const signal = yRecords.get(key) as unknown as { timestamp: number }
          if (!hasReceivedInitialSync) {
            // During initial sync, process recent requests (within 10s) instead of discarding
            if (signal?.timestamp) {
              if (Date.now() - signal.timestamp < 10000) {
                lastScreenshotRequestTimestamp = signal.timestamp
                console.log('[Yjs] Screenshot request received (during sync, recent)')
                for (const cb of screenshotCallbacks) cb()
              } else {
                lastScreenshotRequestTimestamp = signal.timestamp
              }
            }
          } else if (signal?.timestamp && signal.timestamp > lastScreenshotRequestTimestamp) {
            lastScreenshotRequestTimestamp = signal.timestamp
            console.log('[Yjs] Screenshot request received')
            for (const cb of screenshotCallbacks) cb()
          }
        }

        // Forward sync: highlight
        if (key === 'signal:forward-highlight' && (change.action === 'add' || change.action === 'update')) {
          const signal = yRecords.get(key) as unknown as ForwardSyncSignal & { x: number, y: number, page: number, timestamp: number }
          if (!hasReceivedInitialSync) {
            if (signal?.timestamp) lastHighlightTimestamp = signal.timestamp
          } else if (signal?.timestamp && signal.timestamp > lastHighlightTimestamp) {
            lastHighlightTimestamp = signal.timestamp
            console.log(`[Yjs] Forward highlight: page ${signal.page} (${signal.x}, ${signal.y})`)
            const { type: _hl, ...hlRest } = signal
            for (const cb of forwardSyncCallbacks) cb({ type: 'highlight', ...hlRest })
          }
        }

        // Camera link: sync camera between viewers
        if (key === 'signal:camera-link' && (change.action === 'add' || change.action === 'update')) {
          const signal = yRecords.get(key) as unknown as CameraLinkSignal
          if (!hasReceivedInitialSync) {
            if (signal?.timestamp) lastCameraLinkTimestamp = signal.timestamp
          } else if (signal?.timestamp && signal.timestamp > lastCameraLinkTimestamp && signal.viewerId !== localViewerId) {
            lastCameraLinkTimestamp = signal.timestamp
            for (const cb of cameraLinkCallbacks) cb(signal)
          }
        }

        // Ref viewer: sync click-to-reference between viewers
        if (key === 'signal:ref-viewer' && (change.action === 'add' || change.action === 'update')) {
          const signal = yRecords.get(key) as unknown as RefViewerSignal
          if (!hasReceivedInitialSync) {
            if (signal?.timestamp) lastRefViewerTimestamp = signal.timestamp
          } else if (signal?.timestamp && signal.timestamp > lastRefViewerTimestamp && signal.viewerId !== localViewerId) {
            lastRefViewerTimestamp = signal.timestamp
            for (const cb of refViewerCallbacks) cb(signal)
          }
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
        if (ws?.readyState === WebSocket.OPEN) {
          const update = Y.encodeStateAsUpdate(doc)
          ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }))
        }
      }

      // --- Fix 4: Incremental updates ---
      function sendUpdate() {
        if (ws?.readyState !== WebSocket.OPEN) return
        try {
          const sv = lastSentStateVector
          const update = sv
            ? Y.encodeStateAsUpdate(doc, sv)    // incremental: only changes since last send
            : Y.encodeStateAsUpdate(doc)         // full state on first send
          lastSentStateVector = Y.encodeStateVector(doc)
          console.log(`[Yjs] Sending update (${update.length} bytes)`)
          ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }))
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
