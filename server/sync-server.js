#!/usr/bin/env node
// Yjs WebSocket sync server with file-based persistence
// Usage: node server/sync-server.js [port]

import { WebSocketServer } from 'ws'
import http from 'http'
import * as Y from 'yjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || process.argv[2] || 5176
const PERSISTENCE_DIR = process.env.DATA_DIR || join(__dirname, 'data')

// Ensure data directory exists
if (!existsSync(PERSISTENCE_DIR)) {
  mkdirSync(PERSISTENCE_DIR, { recursive: true })
}

// Store for active documents
const docs = new Map()

function getDoc(docName) {
  if (docs.has(docName)) {
    return docs.get(docName)
  }

  const doc = new Y.Doc()

  // Load from persistence
  const filePath = join(PERSISTENCE_DIR, `${docName}.yjs`)
  if (existsSync(filePath)) {
    try {
      const data = readFileSync(filePath)
      Y.applyUpdate(doc, new Uint8Array(data))
      console.log(`Loaded ${docName} from disk`)
    } catch (e) {
      console.error(`Failed to load ${docName}:`, e.message)
    }
  }

  // Save on updates (debounced)
  let saveTimeout = null
  doc.on('update', () => {
    if (saveTimeout) clearTimeout(saveTimeout)
    saveTimeout = setTimeout(() => {
      try {
        const state = Y.encodeStateAsUpdate(doc)
        writeFileSync(filePath, Buffer.from(state))
        console.log(`Saved ${docName}`)
      } catch (e) {
        console.error(`Failed to save ${docName}:`, e.message)
      }
    }, 1000)
  })

  docs.set(docName, doc)
  return doc
}

// Simple sync protocol
function setupWSConnection(ws, docName) {
  const doc = getDoc(docName)

  // Track this connection
  if (!doc.conns) doc.conns = new Set()
  doc.conns.add(ws)

  // Ping/pong keepalive to prevent proxy timeouts
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
      console.error('Message error:', e.message)
    }
  })

  ws.on('close', () => {
    doc.conns.delete(ws)
    console.log(`Client disconnected from ${docName} (${doc.conns.size} remaining)`)
  })

  console.log(`Client connected to ${docName} (${doc.conns.size} total)`)
}

// HTTP server for health check
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200)
    res.end('ok')
  } else {
    res.writeHead(404)
    res.end()
  }
})

// WebSocket server
const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  // Extract doc name from URL path: /doc-name
  const docName = req.url?.slice(1) || 'default'
  setupWSConnection(ws, docName)
})

// Ping all clients every 30 seconds to keep connections alive
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate()
    }
    ws.isAlive = false
    ws.ping()
  })
}, 30000)

wss.on('close', () => {
  clearInterval(pingInterval)
})

server.listen(PORT, () => {
  console.log(`Yjs sync server running on ws://localhost:${PORT}`)
  console.log(`Persistence dir: ${PERSISTENCE_DIR}`)
})
