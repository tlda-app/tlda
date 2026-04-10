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
 *   PROJECTS_DIR — project storage (default: server/projects/)
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { spawn } from 'child_process'
import blocked from 'blocked-at'

// Runtime guard: log event loop blocks with stack traces
blocked((ms, stack) => {
  process.stderr.write(`[blocked] ${ms}ms\n${stack.join('\n')}\n`)
}, { threshold: 200 })

// Runtime guard: warn on execSync in server process (tmux commands still use it)
// TODO: migrate tmux commands to async exec, then ban execSync entirely
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readdirSync, readFileSync, mkdirSync, openSync } from 'fs'
import { homedir } from 'os'
import { lookup as mimeLookup } from 'mime-types'
import { initProjectStore, listProjects } from './lib/project-store.mjs'
import { resetStaleBuildStates, killAllBuilds } from './lib/build-runner.mjs'
import projectRoutes from './routes/projects.mjs'
import { initAuth, isAuthEnabled, validateToken, extractToken, requireRead, loginRoute } from './lib/auth.mjs'
import { initSyncRooms, getOrCreateRoom, flushAllRooms, closeAllRooms, replayCachedSignals } from './lib/sync-rooms.mjs'
import { injectBridge, injectSlidesBridge, injectChapterTitle } from './lib/html-injector.mjs'
import { FleetStore } from './lib/fleet-store.mjs'
import { createFleetRouter } from './routes/fleet.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env from project root (for MYSCRIPT_APP_KEY, etc.)
try {
  const _envFile = join(__dirname, '..', '.env')
  const _envContent = readFileSync(_envFile, 'utf8')
  let _envCount = 0
  for (const line of _envContent.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)/)
    if (m && !process.env[m[1]]) { process.env[m[1]] = m[2].trim(); _envCount++ }
  }
  if (_envCount > 0) console.log(`[env] Loaded ${_envCount} vars from ${_envFile}`)
} catch (e) { console.warn('[env] Failed to load .env:', e.message) }

const PORT = process.env.PORT || 5176
const HOST = process.env.HOST || '0.0.0.0'
const PROJECTS_DIR = process.env.PROJECTS_DIR || join(__dirname, 'projects')

// Initialize stores
initProjectStore(PROJECTS_DIR)
initSyncRooms(PROJECTS_DIR)
resetStaleBuildStates()

// Fleet store (SQLite-backed agent registry + chat)
const fleetStore = (() => {
  try { return new FleetStore() }
  catch (e) { console.error('[fleet-store] init failed (non-fatal):', e.message); return null }
})()

// Fleet state: in-memory
const preambleStore = {}                    // target → { macro: definition }
const wsFleetClients = new Set()            // active /ws/fleet connections

function broadcastFleet(msg) {
  const data = JSON.stringify(msg)
  for (const ws of wsFleetClients) {
    try { if (ws.readyState === 1) ws.send(data) } catch { wsFleetClients.delete(ws) }
  }
}
function broadcastEvent(type, data) {
  broadcastFleet({ event: type, data })
}
function broadcastState() {
  if (!fleetStore) return
  broadcastFleet({
    agents: fleetStore.getAllAgents().filter(a => !a.dead),
    tasks: fleetStore.getActiveTasks(),
  })
}

// Wire fleet store events → WS broadcast
if (fleetStore) {
  fleetStore.onEvent?.((event) => broadcastEvent('fleet-event', event))
}

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

// Services health — checks tlda server (self), fleet server, Yjs sync
app.get('/health/services', async (req, res) => {
  const FLEET_URL = process.env.FLEET_SERVER || 'http://localhost:5199'
  const services = {
    tlda: { ok: true, uptime: process.uptime() },
    fleet: { ok: false, error: null },
    sync: { ok: true },
  }

  // Check fleet server (uses /api/state — fleet has no /health endpoint)
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2000)
    const r = await fetch(`${FLEET_URL}/api/state`, { signal: ctrl.signal })
    clearTimeout(timer)
    if (r.ok) {
      const data = await r.json()
      const agents = (data.agents || []).filter(a => !a.dead && !a.human).length
      services.fleet = { ok: true, agents }
    } else {
      services.fleet = { ok: false, error: `HTTP ${r.status}` }
    }
  } catch (e) {
    services.fleet = { ok: false, error: e.message }
  }

  res.json(services)
})

// Cookie login — set token as cookie, redirect to viewer
app.get('/auth/login', loginRoute)

// Auth level — tells the client what its token allows
app.get('/api/auth/me', (req, res) => {
  if (!isAuthEnabled()) return res.json({ level: 'rw', presenter: true })
  const token = extractToken(req)
  const level = validateToken(token)
  if (!level) return res.status(401).json({ error: 'Unauthorized' })
  res.json({ level, presenter: level === 'rw' })
})

// ---------- Local image serving ----------
// Serves local filesystem images for math notes (paths starting with / or ~)
app.get('/api/local-image', requireRead, (req, res) => {
  const { path: filePath } = req.query
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'Missing path' })
  const expanded = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : filePath
  if (!expanded.startsWith('/')) return res.status(400).json({ error: 'Path must be absolute' })
  if (!existsSync(expanded)) return res.status(404).json({ error: 'Not found' })
  const mimeType = mimeLookup(expanded) || 'application/octet-stream'
  res.set('Content-Type', mimeType)
  res.set('Cache-Control', 'public, max-age=3600')
  res.sendFile(resolve(expanded), { dotfiles: 'allow' })
})

// ---------- Doc asset serving ----------
// Serves from server/projects/{name}/output/ at /docs/{name}/*

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
            return res.sendFile(resolve(assetPath), { dotfiles: 'allow' })
          }
        }
      }
    } catch (e) { /* fall through to auth'd route */ }
  }
  next()
})

// Serve doc assets from projects output
app.use('/docs', (req, res, next) => {
  // Exempt site_libs (Quarto static assets) from auth — loaded by iframes which can't inject Authorization headers
  if (req.path.includes('/site_libs/')) return next()
  requireRead(req, res, next)
}, (req, res, next) => {
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
      return res.sendFile(resolve(histPath), { dotfiles: 'allow' })
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
              bodies.push(`<div class="tlda-chapter" id="chapter-${bodies.length + 1}">\n${bodyMatch[1]}\n</div>`)
            }
          }
          const combined = `<!DOCTYPE html>
<html><head>${headContent}
<style>
.tlda-chapter { border-bottom: 2px solid #e5e7eb; margin-bottom: 24px; padding-bottom: 24px; }
.tlda-chapter:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
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
    // For HTML files in html-format projects, inject the tlda bridge script
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
          if (project.format === 'markdown') {
            // Markdown: bridge already injected at build time; inject chapter title + prev/next at serve time.
            const html = readFileSync(projectPath, 'utf8')

            // Resolve chapter title: promote h1 to chapter title if present (matches aggregateBookToc logic)
            function memberTitle(memberName) {
              const tp = join(PROJECTS_DIR, memberName, 'output', 'toc.json')
              if (!existsSync(tp)) return memberName
              try {
                const toc = JSON.parse(readFileSync(tp, 'utf8'))
                return (toc.length > 0 && toc[0].level === 'section') ? toc[0].title : memberName
              } catch { return memberName }
            }

            const chapterTitle = memberTitle(name)

            // Find which book contains this member and compute prev/next
            let prev = null, next = null
            for (const p of listProjects()) {
              if (p.format !== 'book') continue
              const members = p.members || []
              const idx = members.indexOf(name)
              if (idx === -1) continue
              if (idx > 0) prev = { name: members[idx - 1], title: memberTitle(members[idx - 1]) }
              if (idx < members.length - 1) next = { name: members[idx + 1], title: memberTitle(members[idx + 1]) }
              break  // use first book found
            }

            const injected = injectChapterTitle(html, chapterTitle, prev, next)
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
    return res.sendFile(resolve(projectPath), { dotfiles: 'allow' })
  }

  res.status(404).json({ error: 'Not found' })
})

// ---------- API routes ----------

app.use('/api/projects', projectRoutes)

// Handwriting recognition (MyScript proxy)
import recognizeRoutes from './routes/recognize.mjs'
app.use('/api/recognize', recognizeRoutes)

// ---------- Fleet API (embedded) ----------
const fleetRouter = createFleetRouter({ fleetStore, broadcastEvent, broadcastState, preambleStore })
app.use(fleetRouter)

// ---------- KaTeX static assets ----------
// Served at /katex/ for markdown pages that use KaTeX-rendered math
const katexDir = join(__dirname, '..', 'node_modules', 'katex', 'dist')
if (existsSync(katexDir)) {
  app.use('/katex', express.static(katexDir))
}

// ---------- Viewer SPA ----------
// Serve built SPA from dist/ (Vite build output)
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

  const indexPath = join(distDir, 'index.html')
  if (existsSync(indexPath)) {
    return res.sendFile(indexPath)
  }

  res.status(404).send('Viewer not built. Run: npm run build')
})

// ---------- HTTP + WebSocket server ----------

const server = createServer(app)

const syncWss = new WebSocketServer({ noServer: true })
const fleetWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  // Auth check: token from ?token= query param, Authorization header, or cookie
  // Exempt /ws/fleet — fleet server handles its own access; this proxy
  // must always work so fleet chat (accessibility-critical) isn't blocked by cookie issues.
  if (isAuthEnabled() && !url.pathname.startsWith('/ws/fleet')) {
    const token = extractToken(req)
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

  // /ws/fleet — direct fleet WebSocket (no proxy)
  if (url.pathname === '/ws/fleet') {
    fleetWss.handleUpgrade(req, socket, head, (ws) => {
      const agentFilter = url.searchParams.get('agent') || null
      ws._agentFilter = agentFilter
      wsFleetClients.add(ws)

      // Send initial state
      if (fleetStore) {
        const initState = {
          agents: fleetStore.getAllAgents().filter(a => !a.dead),
          tasks: fleetStore.getActiveTasks(),
        }
        ws.send(JSON.stringify(initState))
      }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString())
          handleFleetWsMessage(ws, msg)
        } catch {}
      })
      ws.on('close', () => wsFleetClients.delete(ws))
      ws.on('error', () => wsFleetClients.delete(ws))
    })
    return
  }

  socket.destroy()
})

// ---------- Fleet WS message handler ----------
// Handles request/response messages from the fleet MCP (sendWS pattern)

function handleFleetWsMessage(ws, msg) {
  const { id, type } = msg
  const reply = (result) => {
    if (id) ws.send(JSON.stringify({ id, result }))
  }
  const error = (err) => {
    if (id) ws.send(JSON.stringify({ id, error: err }))
  }

  if (!fleetStore) { error('fleet store unavailable'); return }

  if (type === 'register') {
    const { id: agentId, name, tmux_session, cwd, labels, manager, session_id, metadata } = msg
    if (!agentId) { error('missing id'); return }
    const now = new Date().toISOString()
    const existing = fleetStore.getAgent?.(agentId)
    const agent = {
      id: agentId,
      friendly_name: name || existing?.friendly_name || null,
      tmux_session: tmux_session || existing?.tmux_session || null,
      session_id: session_id || existing?.session_id || null,
      session_ids: existing?.session_ids || [],
      cwd: cwd || existing?.cwd || null,
      labels: labels || existing?.labels || [],
      registered_at: existing?.registered_at || now,
      last_seen: now,
      dead: false,
      human: false,
      is_manager: !!manager,
      metadata: metadata ? JSON.stringify(metadata) : existing?.metadata || null,
    }
    if (session_id && !agent.session_ids.includes(session_id)) {
      agent.session_ids = [...(agent.session_ids || []), session_id].slice(-10)
    }
    fleetStore.upsertAgent(agent)
    fleetStore.share?.({ type: 'register', agent_id: agentId, from: agentId, to: agentId, text: `${name || agentId} registered` })
    broadcastState()
    reply({ ok: true, agent: fleetStore.getAgent?.(agentId) || agent })
    return
  }

  if (type === 'store-agents') {
    reply(fleetStore.getAllAgents())
    return
  }

  if (type === 'store-tasks') {
    const active = msg.active !== false
    reply(active ? fleetStore.getActiveTasks() : fleetStore.getAllTasks?.() || [])
    return
  }

  if (type === 'chat') {
    const { message: text, to, from, metadata } = msg
    if (!to || !text) { error('missing to or message'); return }
    const event = fleetStore.share?.({ type: 'chat', from, to, text, metadata: JSON.stringify(metadata || null) })
    if (!event) { error('store error'); return }
    // Add to unread
    fleetStore.addUnread?.(event.id, to)
    // Broadcast
    broadcastEvent('fleet-event', { type: 'chat', from, to, id: event.id, text, event_id: event.id })
    reply({ ok: true, event_id: event.id })
    return
  }

  if (type === 'heartbeat') {
    const { agent } = msg
    if (agent) fleetStore.updateHeartbeat?.(agent)
    reply({ ok: true })
    return
  }

  if (type === 'update-agent') {
    const { agent: agentData } = msg
    if (agentData?.id) {
      fleetStore.upsertAgent(agentData)
      broadcastState()
    }
    reply({ ok: true })
    return
  }

  if (type === 'agent-thinking') {
    broadcastEvent('agent-thinking', { agent: msg.agentId, thinking: !!msg.thinking })
    reply({ ok: true })
    return
  }

  if (type === 'agent-compacting') {
    broadcastEvent('agent-compacting', { agent: msg.agentId, compacting: !!msg.compacting })
    reply({ ok: true })
    return
  }

  if (type === 'agent-status') {
    const { agentId, state, tool, ts } = msg
    if (agentId && state && fleetStore) {
      fleetStore.updateAgentStatus?.(agentId, state, tool, ts)
      broadcastEvent('agent-status', { agent: agentId, state, tool, ts })
    }
    reply({ ok: true })
    return
  }

  // Unknown message type — don't error, just ignore (forward compatibility)
  if (id) reply({ ok: false, error: `unknown type: ${type}` })
}

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
          if (project.archived) continue
          documents[name] = {
            name: project.title || project.name || name,
            pages: project.pages || 0,
            format: project.format || 'svg',
            ...(project.sourceDoc && { sourceDoc: project.sourceDoc }),
            ...(project.members && { members: project.members }),
            ...(project.buildStatus && project.buildStatus !== 'success' && { buildStatus: project.buildStatus }),
            ...(project.session && { session: project.session, sessionAt: project.sessionAt }),
          }
        } catch (e) {
          console.error(`[manifest] Failed to read ${projectJsonPath}:`, e.message)
        }
      }
    }
  }

  return { documents }
}


// ---------- Graceful shutdown ----------

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return // prevent double-shutdown
  shuttingDown = true
  console.log('\nShutting down...')

  // 1. Kill all active build child processes (latexmk, dvisvgm, etc.)
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
  if (existsSync(distDir)) {
    console.log(`  Viewer SPA: ${distDir}`)
  } else {
    console.log(`  Viewer SPA: not built (run: npm run build)`)
  }

})
