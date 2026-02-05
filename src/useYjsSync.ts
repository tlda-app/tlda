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

// Check if a record is a page background (should not be synced)
// Page images have IDs like "shape:docname-page-0" or "asset:docname-page-0"
function isPageBackground(record: TLRecord): boolean {
  return record.id.includes('-page-')
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

    // Track sync state
    let isRemoteUpdate = false
    let hasReceivedInitialSync = false
    let unsubscribe: (() => void) | null = null

    // Connect WebSocket
    const ws = new WebSocket(`${serverUrl}/${roomId}`)
    wsRef.current = ws

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
            Y.applyUpdate(doc, update)
          } catch (e) {
            console.error('[Yjs] Failed to apply update:', e)
          }
          isRemoteUpdate = false

          // After receiving initial sync, set up bidirectional sync
          if (msg.type === 'sync' && !hasReceivedInitialSync) {
            hasReceivedInitialSync = true
            console.log(`[Yjs] Initial sync received (${yRecords.size} records from server)`)
            yRecords.forEach((r, id) => console.log(`[Yjs]   Record: ${id} (${r.typeName}) meta:`, (r as any).meta))

            // Apply all existing records from server to editor
            const toApply: TLRecord[] = []
            yRecords.forEach((record, key) => {
              if (!key.includes('-page-')) {
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
    }

    // Sync Y.Map changes to TLDraw
    yRecords.observe((event) => {
      if (isRemoteUpdate) {
        try {
          // Apply remote changes to TLDraw
          const toAdd: TLRecord[] = []
          const toUpdate: TLRecord[] = []
          const toRemove: TLRecord['id'][] = []

          event.changes.keys.forEach((change, key) => {
            // Skip page backgrounds
            if (key.includes('-page-')) return

            if (change.action === 'add') {
              const record = yRecords.get(key)
              if (record) toAdd.push(record)
            } else if (change.action === 'update') {
              const record = yRecords.get(key)
              if (record) toUpdate.push(record)
            } else if (change.action === 'delete') {
              toRemove.push(key as TLRecord['id'])
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
      if (unsubscribe) unsubscribe()
      ws.close()
      doc.destroy()
    }
  }, [editor, roomId, serverUrl])
}
