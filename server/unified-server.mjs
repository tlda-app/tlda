#!/usr/bin/env node
/**
 * Unified tlda server.
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
 *   DATA_DIR   — (legacy, unused)
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
import { initProjectStore } from './lib/project-store.mjs'
import { resetStaleBuildStates, killAllBuilds } from './lib/build-runner.mjs'
import projectRoutes from './routes/projects.mjs'
import { initAuth, isAuthEnabled, validateToken, extractToken, requireRead } from './lib/auth.mjs'
import { initSyncRooms, getOrCreateRoom, getRoomRecords, putShape, updateShape, deleteShape, onShapeChange, flushAllRooms, closeAllRooms, replayCachedSignals } from './lib/sync-rooms.mjs'
import { injectBridge, injectSlidesBridge } from './lib/html-injector.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = process.env.PORT || 5176
const HOST = process.env.HOST || '0.0.0.0'
const PROJECTS_DIR = process.env.PROJECTS_DIR || join(__dirname, 'projects')
const PUBLIC_DIR = process.env.PUBLIC_DIR || join(__dirname, 'public')

// Initialize stores
initProjectStore(PROJECTS_DIR)
initSyncRooms(PROJECTS_DIR)
resetStaleBuildStates()

// Auth
initAuth()

// Express app
const app = express()
app.use(express.json({ limit: '50mb' }))

// CORS — allow cross-origin requests (needed when SPA is on a different domain, e.g. GitHub Pages)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), pid: process.pid })
})

// Auth level — tells the client what its token allows
app.get('/api/auth/me', (req, res) => {
  if (!isAuthEnabled()) return res.json({ level: 'rw', presenter: true })
  const token = extractToken(req)
  const level = validateToken(token)
  if (!level) return res.status(401).json({ error: 'Unauthorized' })
  res.json({ level, presenter: level === 'rw' })
})

// ---------- Doc asset serving ----------
// Serves from server/projects/{name}/output/ at /docs/{name}/*
// Falls back to public/docs/{name}/* for legacy/dev compatibility

app.get('/docs/manifest.json', requireRead, (req, res) => {
  const manifest = generateManifest()
  res.json(manifest)
})

// Serve sub-resources of html-format projects without auth (CSS, JS, fonts from site_libs)
// These are Quarto framework files loaded by iframes that can't pass auth headers
app.use('/docs', (req, res, next) => {
  const parts = req.path.slice(1).split('/')
  if (parts.length < 3) return next() // need at least /name/site_libs/...
  const name = parts[0]
  const filePath = parts.slice(1).join('/')
  // Skip auth for non-HTML sub-resources in html-format projects
  // (CSS, JS, fonts, figures — loaded by iframes that can't pass auth headers)
  if (!filePath.endsWith('.html')) {
    try {
      const projectJsonPath = join(PROJECTS_DIR, name, 'project.json')
      if (existsSync(projectJsonPath)) {
        const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'))
        if (project.format === 'html') {
          const assetPath = join(PROJECTS_DIR, name, 'output', filePath)
          if (existsSync(assetPath)) {
            res.set('Cache-Control', 'public, max-age=3600')
            return res.sendFile(resolve(assetPath))
          }
        }
      }
    } catch (e) { /* fall through to auth'd route */ }
  }
  next()
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

  // Combined HTML: concatenate all chapter bodies into one page
  if (filePath === '_combined.html') {
    try {
      const projectJsonPath = join(PROJECTS_DIR, name, 'project.json')
      const outputDir = join(PROJECTS_DIR, name, 'output')
      const pageInfoPath = join(outputDir, 'page-info.json')
      if (existsSync(projectJsonPath) && existsSync(pageInfoPath)) {
        const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'))
        if (project.format === 'html') {
          const pageInfo = JSON.parse(readFileSync(pageInfoPath, 'utf8'))
          // Find chapter list: either from first entry's chapters field, or all entries
          const chapters = pageInfo[0]?.chapters || pageInfo.map(e => ({ file: e.file, title: e.title }))
          // Use head from first chapter
          const firstHtml = readFileSync(join(outputDir, chapters[0].file), 'utf8')
          const headMatch = firstHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i)
          const headContent = headMatch ? headMatch[1] : ''
          // Extract body from each chapter
          const bodies = []
          for (const ch of chapters) {
            const chapterPath = join(outputDir, ch.file)
            if (!existsSync(chapterPath)) continue
            const chapterHtml = readFileSync(chapterPath, 'utf8')
            const bodyMatch = chapterHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
            if (bodyMatch) {
              bodies.push(`<div class="ctd-chapter" id="chapter-${bodies.length + 1}">\n${bodyMatch[1]}\n</div>`)
            }
          }
          const combined = `<!DOCTYPE html>
<html><head>${headContent}
<style>
.ctd-chapter { border-bottom: 2px solid #e5e7eb; margin-bottom: 24px; padding-bottom: 24px; }
.ctd-chapter:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
</style>
</head><body>${bodies.join('\n')}</body></html>`
          const injected = injectBridge(combined, `/docs/${name}/`)
          res.set('Cache-Control', 'no-cache')
          res.type('html').send(injected)
          return
        }
      }
    } catch (e) {
      console.error(`[docs] Error generating combined HTML for ${name}:`, e.message)
    }
    return res.status(404).json({ error: 'Not found' })
  }

  // Try project output first
  const projectPath = join(PROJECTS_DIR, name, 'output', filePath)
  if (existsSync(projectPath)) {
    res.set('Cache-Control', 'no-cache')
    // For HTML files in html-format projects, inject the ctd bridge script
    if (filePath.endsWith('.html')) {
      try {
        const projectJsonPath = join(PROJECTS_DIR, name, 'project.json')
        if (existsSync(projectJsonPath)) {
          const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'))
          if (project.format === 'slides') {
            // Slides format: inject the reveal.js bridge script
            const html = readFileSync(projectPath, 'utf8')
            const injected = injectSlidesBridge(html)
            res.type('html').send(injected)
            return
          }
          if (project.format === 'html') {
            const html = readFileSync(projectPath, 'utf8')
            // Look up chapter title and compute "Chapter N" numbering within parts
            let chapterTitle = ''
            let isFirstPage = false
            let navPrev = null
            let navNext = null
            try {
              const pageInfoPath = join(PROJECTS_DIR, name, 'output', 'page-info.json')
              const pageInfo = JSON.parse(readFileSync(pageInfoPath, 'utf8'))
              const idx = pageInfo.findIndex(p => p.file === filePath)
              isFirstPage = idx === 0
              // Compute prev/next chapter titles for navigation
              if (idx > 0) navPrev = pageInfo[idx - 1].title
              if (idx >= 0 && idx < pageInfo.length - 1) navNext = pageInfo[idx + 1].title
              if (idx >= 0 && pageInfo[idx].title) {
                const entry = pageInfo[idx]
                if (entry.tocLevel === 'part') {
                  // Parts keep their title as-is
                  chapterTitle = entry.title
                } else {
                  // Count chapter number within the current part
                  // Pages before the first part don't get chapter numbers
                  let chapterNum = 0
                  let inPart = false
                  for (let i = 0; i <= idx; i++) {
                    if (pageInfo[i].tocLevel === 'part') {
                      chapterNum = 0
                      inPart = true
                    } else if (!pageInfo[i].tocLevel && inPart) {
                      chapterNum++
                    }
                  }
                  // Strip "Lab N:", "Lecture N:", etc. prefixes
                  const stripped = entry.title.replace(/^(Lab|Lecture)\s+\d+[:.]\s*/i, '').replace(/^Lecture\s+\d+$/i, '')
                  chapterTitle = chapterNum > 0 && stripped
                    ? `Chapter ${chapterNum}: ${stripped}`
                    : chapterNum > 0
                      ? `Chapter ${chapterNum}`
                      : entry.title
                }
              }
            } catch (e) {}
            const injected = injectBridge(html, `/docs/${name}/`, chapterTitle, isFirstPage, { prev: navPrev, next: navNext })
            res.type('html').send(injected)
            return
          }
        }
      } catch (e) {
        // Fall through to sendFile on error
      }
    }
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

const syncWss = new WebSocketServer({ noServer: true })

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

  // @tldraw/sync protocol for shape CRDT sync + signal custom messages
  if (url.pathname.startsWith('/sync/')) {
    const docName = url.pathname.slice(6)
    if (!docName) { socket.destroy(); return }
    const sessionId = url.searchParams.get('sessionId') || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const room = getOrCreateRoom(docName)
    syncWss.handleUpgrade(req, socket, head, (ws) => {
      room.handleSocketConnect({ sessionId, socket: ws })
      // Replay cached signals (build-status, build-progress, heartbeat, etc.) to reconnecting clients
      setTimeout(() => replayCachedSignals(docName, sessionId), 500)
    })
    return
  }

  socket.destroy()
})

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
            ...(project.members && { members: project.members }),
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

  // 3. Flush and close @tldraw/sync rooms
  closeAllRooms()

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
