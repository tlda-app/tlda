// Yjs sync hook for TLDraw
// Syncs TLDraw store with a Yjs document over WebSocket
// Note: Page images (SVG backgrounds) are NOT synced - only annotations

import { useEffect, useRef } from 'react'
import * as Y from 'yjs'
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

export function broadcastCamera(x: number, y: number, z: number) {
  const yRecords = activeYRecords
  if (!yRecords) return
  const doc = yRecords.doc!
  doc.transact(() => {
    yRecords.set('signal:camera-link' as any, {
      x, y, z,
      viewerId: localViewerId,
      timestamp: Date.now(),
    } as any)
  })
}

export function broadcastRefViewer(refs: RefViewerSignal['refs']) {
  const yRecords = activeYRecords
  if (!yRecords) return
  const doc = yRecords.doc!
  doc.transact(() => {
    yRecords.set('signal:ref-viewer' as any, {
      refs,
      viewerId: localViewerId,
      timestamp: Date.now(),
    } as any)
  })
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

    // Y.Map to hold TLDraw records keyed by id
    const yRecords = doc.getMap<TLRecord>('tldraw')
    activeYRecords = yRecords

    // Track sync state
    let isRemoteUpdate = false
    let hasReceivedInitialSync = false
    let unsubscribe: (() => void) | null = null

    // Connect WebSocket
    const ws = new WebSocket(`${serverUrl}/${roomId}`)
    wsRef.current = ws

    // Send any doc update to the server (catches direct yRecords writes like ping signals)
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return  // don't echo back remote updates
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }))
      }
    })

    ws.onopen = () => {
      console.log(`[Yjs] Connected to ${roomId}`)
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
            yRecords.forEach((r, id) => console.log(`[Yjs]   Record: ${id} (${r.typeName}) meta:`, (r as any).meta))

            // Apply syncable records from server to editor
            const toApply: TLRecord[] = []
            yRecords.forEach((record) => {
              if (shouldSync(record)) {
                toApply.push(record)
              }
            })
            if (toApply.length > 0) {
              console.log(`[Yjs] Applying ${toApply.length} records to editor:`)
              toApply.forEach(r => console.log(`[Yjs]   Applying: ${r.id} meta:`, (r as any).meta))
              editor.store.mergeRemoteChanges(() => {
                editor.store.put(toApply)
              })
              // Check what's in the store after applying
              const shapes = editor.getCurrentPageShapes()
              const nonPage = shapes.filter(s => !s.id.includes('-page-'))
              console.log(`[Yjs] After apply, non-page shapes:`, nonPage.map(s => ({ id: s.id, meta: s.meta })))
            }

            // Call onInitialSync callback if provided
            if (onInitialSync) {
              console.log('[Yjs] Calling onInitialSync callback')
              onInitialSync()
            }

            try {
              setupBidirectionalSync()
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
      console.log('[Yjs] Disconnected')
    }

    ws.onerror = (err) => {
      console.error('[Yjs] WebSocket error:', err)

      // Fallback: load static annotations if sync server unavailable
      if (!hasReceivedInitialSync) {
        loadStaticAnnotations(editor, onInitialSync)
      }
    }

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
            for (const cb of forwardSyncCallbacks) cb({ type: 'scroll', ...signal })
          }
        }

        // Screenshot request from MCP
        if (key === 'signal:screenshot-request' && (change.action === 'add' || change.action === 'update')) {
          const signal = yRecords.get(key) as unknown as { timestamp: number }
          if (!hasReceivedInitialSync) {
            if (signal?.timestamp) lastScreenshotRequestTimestamp = signal.timestamp
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
            for (const cb of forwardSyncCallbacks) cb({ type: 'highlight', ...signal })
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
        if (ws.readyState === WebSocket.OPEN) {
          const update = Y.encodeStateAsUpdate(doc)
          ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }))
        }
      }

      // Throttle sending updates to server
      let sendTimeout: ReturnType<typeof setTimeout> | null = null
      let pendingSend = false

      function sendUpdate() {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            const update = Y.encodeStateAsUpdate(doc)
            console.log(`[Yjs] Sending update (${update.length} bytes, ${yRecords.size} records)`)
            ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }))
          } catch (e) {
            console.error('[Yjs] Failed to send update:', e)
          }
        } else {
          console.warn(`[Yjs] Cannot send - WebSocket state: ${ws.readyState}`)
        }
        pendingSend = false
      }

      function throttledSend() {
        if (sendTimeout) return // Already scheduled
        if (pendingSend) {
          sendTimeout = setTimeout(() => {
            sendTimeout = null
            sendUpdate()
          }, 100) // Throttle to max 10 updates/second
        } else {
          pendingSend = true
          sendUpdate()
        }
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
          added.forEach(r => console.log(`[Yjs]   Added: ${r.id} (${r.typeName}) meta:`, (r as any).meta))
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
      activeYRecords = null
      if (unsubscribe) unsubscribe()
      ws.close()
      doc.destroy()
    }
  }, [editor, roomId, serverUrl])
}
