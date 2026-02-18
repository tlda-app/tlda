/**
 * Yjs WebSocket sync module.
 *
 * Extracted from sync-server.js for use in the unified server.
 * Manages Y.Doc instances per room with file-based persistence.
 *
 * Binary WS protocol: single-byte type prefix + Yjs binary payload.
 *   0x01 = sync (initial state)
 *   0x02 = update (incremental)
 * JSON fallback: accepts { type: 'sync'|'update', data: number[] } for
 * backward compatibility with older clients / MCP.
 */

import * as Y from 'yjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync } from 'fs'
import { join } from 'path'

// Binary message type bytes
const MSG_SYNC = 0x01
const MSG_UPDATE = 0x02

/** Encode a binary WS message: [type byte][payload] */
function encodeBinary(type, payload) {
  const msg = Buffer.alloc(1 + payload.length)
  msg[0] = type
  payload.copy ? payload.copy(msg, 1) : msg.set(payload, 1)
  return msg
}

/**
 * Parse an incoming WS message. Returns { type: 'sync'|'update', data: Uint8Array }.
 * Accepts binary (preferred) or JSON (fallback).
 */
function parseMessage(raw) {
  if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer || raw instanceof Uint8Array) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    if (buf.length > 0 && (buf[0] === MSG_SYNC || buf[0] === MSG_UPDATE)) {
      return {
        type: buf[0] === MSG_SYNC ? 'sync' : 'update',
        data: buf.subarray(1),
      }
    }
  }
  // JSON fallback
  const str = typeof raw === 'string' ? raw : raw.toString()
  const msg = JSON.parse(str)
  return { type: msg.type, data: new Uint8Array(msg.data) }
}

/** @type {Map<string, Y.Doc>} */
const docs = new Map()

// Track pending save timeouts so flushAll can cancel and save immediately
const pendingSaves = new Map() // docName → { timeout, filePath, doc }

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

    // Save on updates (debounced with maxWait) + broadcast server-side mutations to WS clients
    let saveTimeout = null
    let maxWaitTimeout = null
    const DEBOUNCE_MS = 1000
    const MAX_WAIT_MS = 10000 // force save at least every 10s under heavy activity

    function doSave() {
      if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null }
      if (maxWaitTimeout) { clearTimeout(maxWaitTimeout); maxWaitTimeout = null }
      pendingSaves.delete(docName)
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
    }

    function scheduleSave() {
      if (saveTimeout) clearTimeout(saveTimeout)
      saveTimeout = setTimeout(doSave, DEBOUNCE_MS)
      // Start max-wait timer on first update in this batch
      if (!maxWaitTimeout) {
        maxWaitTimeout = setTimeout(doSave, MAX_WAIT_MS)
      }
      pendingSaves.set(docName, { doSave })
    }

    doc.on('update', (update, origin) => {
      // Broadcast server-side updates (origin !== 'ws-client') to all connections
      if (origin !== 'ws-client' && doc.conns) {
        const msg = encodeBinary(MSG_UPDATE, update)
        for (const conn of doc.conns) {
          if (conn.readyState === 1) conn.send(msg)
        }
      }
      scheduleSave()
    })
  }

  docs.set(docName, doc)
  return doc
}

/**
 * Immediately flush all pending Yjs saves. Call before shutdown.
 */
export function flushAll() {
  for (const [docName, { doSave }] of pendingSaves) {
    console.log(`[yjs] Flushing pending save for ${docName}`)
    doSave()
  }
}

/**
 * Handle a WebSocket connection for a given room.
 * Sends current state as binary, then bidirectional sync.
 */
export function setupWSConnection(ws, docName) {
  const doc = getDoc(docName)

  if (!doc.conns) doc.conns = new Set()
  doc.conns.add(ws)

  // Ping/pong keepalive
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  // Send current state as binary
  const state = Y.encodeStateAsUpdate(doc)
  ws.send(encodeBinary(MSG_SYNC, state))

  // Handle incoming updates (binary or JSON)
  ws.on('message', (message) => {
    try {
      const { type, data } = parseMessage(message)
      if (type === 'update') {
        Y.applyUpdate(doc, data, 'ws-client')

        // Broadcast to other clients as binary
        const relay = encodeBinary(MSG_UPDATE, data)
        for (const conn of doc.conns) {
          if (conn !== ws && conn.readyState === 1) {
            conn.send(relay)
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
