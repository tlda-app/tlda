/**
 * Yjs WebSocket sync module.
 *
 * Extracted from sync-server.js for use in the unified server.
 * Manages Y.Doc instances per room with file-based persistence.
 */

import * as Y from 'yjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync } from 'fs'
import { join } from 'path'

/** @type {Map<string, Y.Doc>} */
const docs = new Map()

let persistenceDir = null

/**
 * Initialize persistence directory.
 * Must be called before getDoc().
 */
export function initPersistence(dir) {
  persistenceDir = dir
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * Get or create a Y.Doc for a room.
 * Loads from disk on first access, saves on updates (debounced, atomic).
 */
export function getDoc(docName) {
  if (docs.has(docName)) {
    return docs.get(docName)
  }

  const doc = new Y.Doc()

  // Load from persistence
  if (persistenceDir) {
    const filePath = join(persistenceDir, `${docName}.yjs`)
    if (existsSync(filePath)) {
      try {
        const data = readFileSync(filePath)
        Y.applyUpdate(doc, new Uint8Array(data))
        console.log(`[yjs] Loaded ${docName} from disk`)
      } catch (e) {
        console.error(`[yjs] Failed to load ${docName}:`, e.message)
      }
    }

    // Save on updates (debounced)
    let saveTimeout = null
    doc.on('update', () => {
      if (saveTimeout) clearTimeout(saveTimeout)
      saveTimeout = setTimeout(() => {
        try {
          const state = Y.encodeStateAsUpdate(doc)
          const tmpPath = filePath + '.tmp'
          writeFileSync(tmpPath, Buffer.from(state))
          const fd = openSync(tmpPath, 'r')
          fsyncSync(fd)
          closeSync(fd)
          renameSync(tmpPath, filePath)
          console.log(`[yjs] Saved ${docName}`)
        } catch (e) {
          console.error(`[yjs] Failed to save ${docName}:`, e.message)
        }
      }, 1000)
    })
  }

  docs.set(docName, doc)
  return doc
}

/**
 * Handle a WebSocket connection for a given room.
 * Sends current state, then bidirectional sync.
 */
export function setupWSConnection(ws, docName) {
  const doc = getDoc(docName)

  if (!doc.conns) doc.conns = new Set()
  doc.conns.add(ws)

  // Ping/pong keepalive
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  // Send current state
  const state = Y.encodeStateAsUpdate(doc)
  ws.send(JSON.stringify({ type: 'sync', data: Array.from(state) }))

  // Handle incoming updates
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString())
      if (msg.type === 'update') {
        const update = new Uint8Array(msg.data)
        Y.applyUpdate(doc, update)

        // Broadcast to other clients
        for (const conn of doc.conns) {
          if (conn !== ws && conn.readyState === 1) {
            conn.send(JSON.stringify({ type: 'update', data: msg.data }))
          }
        }
      }
    } catch (e) {
      console.error('[yjs] Message error:', e.message)
    }
  })

  ws.on('close', () => {
    doc.conns.delete(ws)
    console.log(`[yjs] Client disconnected from ${docName} (${doc.conns.size} remaining)`)
  })

  console.log(`[yjs] Client connected to ${docName} (${doc.conns.size} total)`)
}

/**
 * Start ping interval to keep WebSocket connections alive.
 * Returns a cleanup function.
 */
export function startPingInterval(wss, intervalMs = 30000) {
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate()
      }
      ws.isAlive = false
      ws.ping()
    })
  }, intervalMs)

  return () => clearInterval(interval)
}
