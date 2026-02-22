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
import { spawn } from 'child_process'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readdirSync, readFileSync, mkdirSync, openSync } from 'fs'
import { homedir } from 'os'
import { initPersistence, setupWSConnection, startPingInterval, flushAll } from './lib/yjs-sync.mjs'
import { initProjectStore } from './lib/project-store.mjs'
import { resetStaleBuildStates, killAllBuilds } from './lib/build-runner.mjs'
import projectRoutes from './routes/projects.mjs'
import { initAuth, isAuthEnabled, validateToken, requireRead } from './lib/auth.mjs'

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

// Auth
initAuth()

// Express app
const app = express()
app.use(express.json({ limit: '50mb' }))

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), pid: process.pid })
})

// ---------- Doc asset serving ----------
// Serves from server/projects/{name}/output/ at /docs/{name}/*
// Falls back to public/docs/{name}/* for legacy/dev compatibility

app.get('/docs/manifest.json', requireRead, (req, res) => {
  const manifest = generateManifest()
  res.json(manifest)
})

// Serve doc assets: try projects output first, then legacy public/docs
app.use('/docs', requireRead, (req, res, next) => {
  // Skip manifest (handled above)
  if (req.path === '/manifest.json') return next()

  // Extract name from /docs/{name}/rest-of-path
  const parts = req.path.slice(1).split('/')
  if (parts.length < 2) return next()
  const name = parts[0]
  const filePath = parts.slice(1).join('/')

  // Serve history snapshots: /docs/{name}/history/{snapshotId}/page-N.svg
  if (filePath.startsWith('history/')) {
    const histPath = join(PROJECTS_DIR, name, filePath)
    if (existsSync(histPath)) {
      res.set('Cache-Control', 'public, max-age=86400') // snapshots are immutable
      return res.sendFile(resolve(histPath))
    }
    return res.status(404).json({ error: 'Not found' })
  }

  // Try project output first
  const projectPath = join(PROJECTS_DIR, name, 'output', filePath)
  if (existsSync(projectPath)) {
    res.set('Cache-Control', 'no-cache')
    return res.sendFile(resolve(projectPath))
  }

  // Fall back to public/docs (legacy/dev)
  const legacyPath = join(__dirname, '..', 'public', 'docs', name, filePath)
  if (existsSync(legacyPath)) {
    res.set('Cache-Control', 'no-cache')
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

  // Auth check: token from ?token= query param or Authorization header
  if (isAuthEnabled()) {
    const token = url.searchParams.get('token') ||
      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null)
    if (!validateToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
  }

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
            ...(project.buildStatus && project.buildStatus !== 'success' && { buildStatus: project.buildStatus }),
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

// ---------- Triage agent management ----------

const AGENT_ENABLED = process.argv.includes('--agent')
let agentProc = null
let agentRespawnTimer = null

function spawnTriageAgent() {
  const agentPath = resolve(__dirname, '../cli/lib/triage-agent.mjs')
  const logDir = join(homedir(), '.config', 'ctd')
  mkdirSync(logDir, { recursive: true })
  const logFd = openSync(join(logDir, 'agent.log'), 'a')

  const token = process.env.CTD_TOKEN || ''
  const env = { ...process.env, CTD_SERVER: `http://localhost:${PORT}` }
  if (token) env.CTD_TOKEN = token

  agentProc = spawn('node', [agentPath], {
    env,
    stdio: ['ignore', logFd, logFd],
    detached: false,
  })

  console.log(`[agent] Triage agent started (PID ${agentProc.pid})`)

  agentProc.on('exit', (code, signal) => {
    console.log(`[agent] Triage agent exited (code=${code}, signal=${signal})`)
    agentProc = null
    if (!shuttingDown) {
      console.log('[agent] Respawning in 5s...')
      agentRespawnTimer = setTimeout(spawnTriageAgent, 5000)
    }
  })
}

function stopTriageAgent() {
  if (agentRespawnTimer) {
    clearTimeout(agentRespawnTimer)
    agentRespawnTimer = null
  }
  if (agentProc) {
    agentProc.kill('SIGTERM')
    agentProc = null
  }
}

// ---------- Graceful shutdown ----------

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return // prevent double-shutdown
  shuttingDown = true
  console.log('\nShutting down...')

  // 1. Kill triage agent if running
  stopTriageAgent()

  // 2. Kill all active build child processes (latexmk, dvisvgm, etc.)
  killAllBuilds()

  // 2. Flush any pending Yjs saves to disk
  flushAll()

  // 3. Stop accepting new connections
  stopPing()
  wss.close()

  // 4. Close HTTP server, wait for in-flight requests (up to 5s)
  server.close(() => {
    console.log('Server closed cleanly.')
    process.exit(0)
  })

  // Safety net: force exit after 5s if server.close() hangs
  setTimeout(() => {
    console.error('Shutdown timed out, forcing exit.')
    process.exit(1)
  }, 5000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ---------- Global error handlers ----------
// Don't crash on stray errors — log and keep running

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err.message)
  console.error(err.stack)
  // Fatal errors that mean we can't serve — exit instead of zombieing
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    process.exit(1)
  }
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

  if (AGENT_ENABLED) {
    // Brief delay to let server fully initialize before agent connects
    setTimeout(spawnTriageAgent, 2000)
  }
})
