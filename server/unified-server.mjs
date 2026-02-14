#!/usr/bin/env node
/**
 * Unified claude-tldraw server.
 *
 * Single process serving:
 *   - Yjs WebSocket sync (ws://host:PORT/{room} or /yjs/{room})
 *   - Static file serving for doc assets (/docs/{name}/*)
 *   - Project management API (/api/*)
 *   - Built viewer SPA (catch-all → index.html)
 *   - Health endpoint (/health)
 *
 * Usage:
 *   node server/unified-server.mjs
 *
 * Environment:
 *   PORT       — listen port (default: 5176)
 *   HOST       — bind address (default: 0.0.0.0)
 *   DATA_DIR   — Yjs persistence directory (default: server/data/)
 *   PROJECTS_DIR — project storage (default: server/projects/)
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { initPersistence, setupWSConnection, startPingInterval } from './lib/yjs-sync.mjs'
import { initProjectStore } from './lib/project-store.mjs'
import { resetStaleBuildStates } from './lib/build-runner.mjs'
import projectRoutes from './routes/projects.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = process.env.PORT || 5176
const HOST = process.env.HOST || '0.0.0.0'
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data')
const PROJECTS_DIR = process.env.PROJECTS_DIR || join(__dirname, 'projects')
const PUBLIC_DIR = process.env.PUBLIC_DIR || join(__dirname, 'public')

// Initialize persistence
initPersistence(DATA_DIR)
initProjectStore(PROJECTS_DIR)
resetStaleBuildStates()

// Express app
const app = express()
app.use(express.json({ limit: '50mb' }))

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() })
})

// ---------- Doc asset serving ----------
// Serves from server/projects/{name}/output/ at /docs/{name}/*
// Falls back to public/docs/{name}/* for legacy/dev compatibility

app.get('/docs/manifest.json', (req, res) => {
  const manifest = generateManifest()
  res.json(manifest)
})

// Serve doc assets: try projects output first, then legacy public/docs
app.use('/docs', (req, res, next) => {
  // Skip manifest (handled above)
  if (req.path === '/manifest.json') return next()

  // Extract name from /docs/{name}/rest-of-path
  const parts = req.path.slice(1).split('/')
  if (parts.length < 2) return next()
  const name = parts[0]
  const filePath = parts.slice(1).join('/')

  // Try project output first
  const projectPath = join(PROJECTS_DIR, name, 'output', filePath)
  if (existsSync(projectPath)) {
    return res.sendFile(resolve(projectPath))
  }

  // Fall back to public/docs (legacy/dev)
  const legacyPath = join(__dirname, '..', 'public', 'docs', name, filePath)
  if (existsSync(legacyPath)) {
    return res.sendFile(resolve(legacyPath))
  }

  res.status(404).json({ error: 'Not found' })
})

// ---------- API routes ----------

app.use('/api/projects', projectRoutes)

// ---------- Viewer SPA ----------
// Serve built SPA from server/public/ (Vite build output)
// Fall back to project root's public/ for dev compatibility

if (existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR))
}

// Also try the project root's dist/ (from `npm run build`)
const distDir = join(__dirname, '..', 'dist')
if (existsSync(distDir)) {
  app.use(express.static(distDir))
}

// SPA catch-all: serve index.html for client-side routing
app.get('/{*path}', (req, res) => {
  // Don't catch API or doc routes
  if (req.path.startsWith('/api/') || req.path.startsWith('/docs/')) {
    return res.status(404).json({ error: 'Not found' })
  }

  // Try server/public/index.html first, then dist/index.html
  for (const dir of [PUBLIC_DIR, distDir]) {
    const indexPath = join(dir, 'index.html')
    if (existsSync(indexPath)) {
      return res.sendFile(indexPath)
    }
  }

  res.status(404).send('Viewer not built. Run: npm run build')
})

// ---------- HTTP + WebSocket server ----------

const server = createServer(app)

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  let room = null

  if (url.pathname.startsWith('/yjs/')) {
    room = url.pathname.slice(5)
  } else if (!url.pathname.startsWith('/api/')) {
    // Backward compat: /{room}
    room = url.pathname.slice(1)
  }

  if (!room) {
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    setupWSConnection(ws, room)
  })
})

const stopPing = startPingInterval(wss)

// ---------- Manifest generation ----------

function generateManifest() {
  const documents = {}

  // Read from project.json files in server/projects/
  if (existsSync(PROJECTS_DIR)) {
    for (const name of readdirSync(PROJECTS_DIR)) {
      const projectJsonPath = join(PROJECTS_DIR, name, 'project.json')
      if (existsSync(projectJsonPath)) {
        try {
          const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'))
          documents[name] = {
            name: project.title || project.name || name,
            pages: project.pages || 0,
            format: project.format || 'svg',
            ...(project.sourceDoc && { sourceDoc: project.sourceDoc }),
          }
        } catch (e) {
          console.error(`[manifest] Failed to read ${projectJsonPath}:`, e.message)
        }
      }
    }
  }

  // Also include legacy docs from public/docs/manifest.json
  const legacyManifestPath = join(__dirname, '..', 'public', 'docs', 'manifest.json')
  if (existsSync(legacyManifestPath)) {
    try {
      const legacy = JSON.parse(readFileSync(legacyManifestPath, 'utf8'))
      for (const [name, config] of Object.entries(legacy.documents || {})) {
        if (!documents[name]) {
          documents[name] = config
        }
      }
    } catch (e) {
      console.error('[manifest] Failed to read legacy manifest:', e.message)
    }
  }

  return { documents }
}

// ---------- Graceful shutdown ----------

function shutdown() {
  console.log('\nShutting down...')
  stopPing()
  wss.close()
  server.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ---------- Global error handlers ----------
// Don't crash on stray errors — log and keep running

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err.message)
  console.error(err.stack)
})

process.on('unhandledRejection', (err) => {
  console.error('[server] Unhandled rejection:', err?.message || err)
})

// ---------- Start ----------

server.listen(PORT, HOST, () => {
  console.log(`Unified server running on http://${HOST}:${PORT}`)
  console.log(`  Yjs persistence: ${DATA_DIR}`)
  console.log(`  Projects: ${PROJECTS_DIR}`)
  if (existsSync(PUBLIC_DIR)) {
    console.log(`  Viewer SPA: ${PUBLIC_DIR}`)
  } else if (existsSync(distDir)) {
    console.log(`  Viewer SPA: ${distDir}`)
  } else {
    console.log(`  Viewer SPA: not built (run: npm run build)`)
  }
})
