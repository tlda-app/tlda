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
import os from 'os'
const { homedir, hostname } = os
import { spawn as cpSpawn } from 'child_process'
import { lookup as mimeLookup } from 'mime-types'
import { initProjectStore, listProjects, readProject, getProjectsDir } from './lib/project-store.mjs'
import { resetStaleBuildStates, killAllBuilds } from './lib/build-runner.mjs'
import projectRoutes, { processProjectPush } from './routes/projects.mjs'
import { initAuth, isAuthEnabled, validateToken, extractToken, requireRead, loginRoute } from './lib/auth.mjs'
import { initSyncRooms, getOrCreateRoom, flushAllRooms, closeAllRooms, replayCachedSignals, onGlobalEvent } from './lib/sync-rooms.mjs'
import * as tldaFeedback from './lib/tlda-feedback.mjs'
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

// Fleet store (SQLite-backed agent registry + chat).
// TLDA_FLEET_DB overrides the default path — used by integration tests
// to isolate from the live /tmp/fleet.db.
const fleetStore = (() => {
  try { return new FleetStore(process.env.TLDA_FLEET_DB) }
  catch (e) { console.error('[fleet-store] init failed (non-fatal):', e.message); return null }
})()

// Fleet state: in-memory
const wsFleetClients = new Set()            // active /ws/fleet connections

// Daemon connections — keyed by machine_id. Each value is the live WS for
// that machine's fleet-daemon. Used for RPC routing and for pushing
// agents-updated / projects-updated messages.
const daemonConnections = new Map()         // machine_id -> ws

// Local-machine daemon supervisor.
//
// The fleet daemon is a per-machine subprocess that watches Claude Code
// session JSONLs and pushes activity-card / terminal events to the server.
// When the daemon dies for any reason, no one resurrects it and the user
// silently loses activity cards, terminal cards, and source watching.
//
// The server is the natural supervisor: it knows when a daemon connects
// and disconnects via daemonConnections, and it knows its own machine_id
// (the hostname). On a periodic check, if no daemon is connected for the
// local machine, spawn one. Skip flagged this as brittleness — the cost
// of a misfire (an extra short-lived daemon) is much smaller than the
// cost of silent feature loss.
const LOCAL_MACHINE_ID = (hostname() || '').split('.')[0] || 'localhost'
// Server owner — the human running this server process. Used as fallback
// identity for MCP agents and CLI operations. Browser users identify
// themselves via WS 'login' (returning) or 'register' (new) messages.
const SERVER_OWNER_NAME = process.env.TLDA_USER || (() => { try { return os.userInfo()?.username } catch { return 'user' } })()
const SERVER_OWNER_ID = `fleet:${SERVER_OWNER_NAME}`
const SERVER_BOOT_ID = Date.now()   // unique per server start; daemon uses this to detect restarts
const DAEMON_SUPERVISOR_INTERVAL_MS = 10_000
const DAEMON_LOG_FILE = join(homedir(), '.config', 'tlda', 'fleet-daemon.log')
const DAEMON_PID_FILE = join(homedir(), '.config', 'tlda', 'fleet-daemon.pid')
const DAEMON_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fleet-daemon.mjs')
// Crash-loop guard: if the daemon dies fast >= MAX_RAPID_RESPAWNS times in a
// row, give up until manual intervention. The supervisor would otherwise
// hot-loop and burn CPU + log spam if the daemon has a startup crash.
const DAEMON_FAST_DEATH_MS = 30_000   // < 30s alive == "fast death"
const DAEMON_MAX_RAPID_RESPAWNS = 3
const DAEMON_BACKOFF_MS = 5 * 60_000  // back off 5 minutes after giving up
let _daemonSpawnInFlight = false
let _daemonRespawnCount = 0
let _daemonRapidFails = 0
let _daemonLastSpawnAt = 0
let _daemonBackoffUntil = 0
let _daemonGivingUpLogged = false

function noteDaemonHealthyConnect() {
  // Called when a daemon connects successfully — reset the rapid-fail
  // counter so a single crash much later doesn't count toward the loop
  // budget. The "fast death" check below is the real arbiter.
  _daemonRapidFails = 0
  _daemonGivingUpLogged = false
}

function ensureLocalDaemon() {
  if (_daemonSpawnInFlight) return
  const now = Date.now()
  if (now < _daemonBackoffUntil) return
  // Already connected? Done.
  const ws = daemonConnections.get(LOCAL_MACHINE_ID)
  if (ws && ws.readyState === 1) return
  // PID file exists and process alive? It's just not connected yet — give it
  // a moment, don't double-spawn.
  if (existsSync(DAEMON_PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(DAEMON_PID_FILE, 'utf8').trim(), 10)
      if (pid > 0) {
        try { process.kill(pid, 0); return } catch {} // not alive → fall through to respawn
      }
    } catch {}
  }
  if (!existsSync(DAEMON_SCRIPT)) return

  // Crash-loop check: if the previous spawn died within DAEMON_FAST_DEATH_MS,
  // bump the rapid-fail counter; if too many in a row, back off.
  if (_daemonLastSpawnAt > 0 && now - _daemonLastSpawnAt < DAEMON_FAST_DEATH_MS) {
    _daemonRapidFails++
    if (_daemonRapidFails >= DAEMON_MAX_RAPID_RESPAWNS) {
      _daemonBackoffUntil = now + DAEMON_BACKOFF_MS
      if (!_daemonGivingUpLogged) {
        console.error(`[daemon-supervisor] daemon crashed ${_daemonRapidFails}× in <${DAEMON_FAST_DEATH_MS}ms each — backing off ${DAEMON_BACKOFF_MS / 1000}s. Tail ${DAEMON_LOG_FILE} for the cause.`)
        _daemonGivingUpLogged = true
      }
      _daemonRapidFails = 0
      return
    }
  } else if (_daemonLastSpawnAt > 0) {
    // Long-lived daemon died — single failure, don't count toward the loop.
    _daemonRapidFails = 0
  }

  _daemonSpawnInFlight = true
  try {
    if (!existsSync(dirname(DAEMON_LOG_FILE))) mkdirSync(dirname(DAEMON_LOG_FILE), { recursive: true })
    const logFd = openSync(DAEMON_LOG_FILE, 'a')
    const child = cpSpawn(process.execPath, [DAEMON_SCRIPT], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    })
    child.unref()
    _daemonRespawnCount++
    _daemonLastSpawnAt = now
    console.log(`[daemon-supervisor] respawned local fleet daemon (count=${_daemonRespawnCount}, rapid_fails=${_daemonRapidFails})`)
  } catch (e) {
    console.error(`[daemon-supervisor] spawn failed: ${e.message}`)
  } finally {
    // Brief lockout so we don't burst-spawn while the new daemon is coming up.
    setTimeout(() => { _daemonSpawnInFlight = false }, 3000)
  }
}

// Pending RPCs awaiting a daemon `rpc-reply`. Keyed by RPC id.
// Each entry: { resolve, reject, timer, machine_id }.
const pendingRpcs = new Map()
let _rpcSeq = 0
const RPC_TIMEOUT_MS = 10_000

/**
 * Send an RPC to the daemon owning a specific machine and wait for its
 * reply. Returns a promise that resolves with `result` or rejects with an
 * Error. If no daemon is connected for `machineId`, rejects synchronously
 * with a `NoDaemonError` so callers can return 503 immediately.
 *
 * Per spec: 10s timeout, no retry. If the WS drops mid-RPC the pending
 * entry is rejected with a `daemon disconnected` error.
 */
class NoDaemonError extends Error {
  constructor(machineId) {
    super(`No fleet-daemon connected for machine "${machineId}"`)
    this.code = 'NO_DAEMON'
    this.machineId = machineId
  }
}

function sendRpc(machineId, op, params = {}) {
  return new Promise((resolve, reject) => {
    if (!machineId) return reject(new NoDaemonError('(unknown)'))
    const dws = daemonConnections.get(machineId)
    if (!dws || dws.readyState !== 1) return reject(new NoDaemonError(machineId))
    const id = `rpc-${++_rpcSeq}-${Date.now().toString(36)}`
    const timer = setTimeout(() => {
      pendingRpcs.delete(id)
      reject(new Error(`RPC timeout after ${RPC_TIMEOUT_MS}ms (op=${op}, machine=${machineId})`))
    }, RPC_TIMEOUT_MS)
    pendingRpcs.set(id, { resolve, reject, timer, machine_id: machineId })
    try {
      dws.send(JSON.stringify({ type: 'rpc', id, op, ...params }))
    } catch (e) {
      clearTimeout(timer)
      pendingRpcs.delete(id)
      reject(e)
    }
  })
}

// When a daemon WS drops, fail any in-flight RPCs that targeted it. The
// HTTP caller decides whether to retry.
function failPendingRpcsForMachine(machineId, reason = 'daemon disconnected') {
  for (const [id, entry] of [...pendingRpcs]) {
    if (entry.machine_id === machineId) {
      clearTimeout(entry.timer)
      pendingRpcs.delete(id)
      entry.reject(new Error(reason))
    }
  }
}

// Set before a share() call to suppress the SSE echo on the originating WS connection.
// Cleared immediately after share() returns (listeners fire synchronously inside share()).
let _suppressEchoWs = null

function suppressEchoFor(connId) {
  if (!connId) return
  for (const ws of wsFleetClients) {
    if (ws._connId === connId) { _suppressEchoWs = ws; return }
  }
}

function broadcastFleet(msg) {
  const data = JSON.stringify(msg)
  const suppress = _suppressEchoWs
  _suppressEchoWs = null  // reset after one use (share() fires listeners synchronously)
  for (const ws of wsFleetClients) {
    if (ws === suppress) continue  // don't echo back to the sender
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

// Ensure server owner exists as a human agent in the DB on startup
if (fleetStore) {
  fleetStore.upsertAgent({
    id: SERVER_OWNER_ID,
    friendly_name: SERVER_OWNER_NAME,
    human: true,
    dead: false,
    labels: [],
    registered_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  })
}

// Full chat delivery pipeline used by tlda-feedback (push-channel
// notifications for doc annotations). Mirrors the WS 'chat' handler:
// share → addUnread → broadcast. Calling only fleetStore.share leaves
// the message invisible to getUnread, so the recipient's MCP never
// surfaces it as a <channel> system-reminder.
function deliverTldaFeedbackChat({ from, to, text, metadata }) {
  if (!fleetStore) return
  const metadataJson = metadata ? JSON.stringify(metadata) : JSON.stringify(null)
  const event = fleetStore.share?.({ type: 'chat', from, to, text, metadata: metadataJson })
  if (!event) return
  fleetStore.addUnread?.(event.id, to)
  broadcastEvent('fleet-event', { type: 'chat', from, to, id: event.id, text, event_id: event.id })
}

// When a project is created or its sourceDir changes, push the new
// project list to all connected fleet-daemons so they can start
// watching its source files.
onGlobalEvent((event) => {
  if (event?.type === 'project-changed') broadcastDaemonProjectsUpdated()
  if (event?.type === 'version-committed') {
    broadcastDaemonVersionCommitted(event.name, event.hash)
  }
})

// ---------- RPC routing ----------
//
// `resolveRpc(op, agent)` decides where a fleet operation runs. The
// design is "all local ops go through the daemon for the owning
// machine". If no daemon is connected for that machine, the caller
// must return 503 — there is no inline fallback (per Phase 3 of the
// spec; surfacing the gap is the whole point).
//
// `op`    — operation name (e.g. 'send-key', 'capture-pane', 'spawn').
// `agent` — agent record from the fleet store, or null for machine-
//           targeted ops like spawn (not yet supported).
//
// Returns:
//   { via: 'daemon', machine_id, daemon: <ws> }   on success
//   { via: 'none', error: '...', code: 503 }      if no daemon
function resolveRpc(op, agent) {
  if (!agent || !agent.machine_id) {
    return { via: 'none', code: 503, error: `agent has no machine_id (op=${op})` }
  }
  const dws = daemonConnections.get(agent.machine_id)
  if (!dws || dws.readyState !== 1) {
    return { via: 'none', code: 503, error: `no fleet-daemon connected for machine "${agent.machine_id}" (op=${op})` }
  }
  return { via: 'daemon', machine_id: agent.machine_id, daemon: dws }
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

// Kill playwright Chromium processes that may be poisoning Chrome's speech service.
// Called by voice.mjs watchdog when it detects unrecoverable mic failure.
app.post('/api/voice/kill-playwright', async (req, res) => {
  try {
    const { execSync } = await import('child_process')
    // Kill any Chromium processes launched by playwright (identified by user-data-dir pattern)
    try { execSync('pkill -9 -f playwright_chromiumdev_profile 2>/dev/null', { timeout: 5000 }) } catch {}
    try { execSync('pkill -9 -f "remote-debugging-port.*no-startup-window" 2>/dev/null', { timeout: 5000 }) } catch {}
    console.log('[voice] killed playwright Chromium processes')
    res.json({ ok: true })
  } catch (err) {
    console.error('[voice] kill-playwright failed:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Full Chrome restart — kills Chrome, waits, reopens with saved tabs.
// Called by voice.mjs triple-shift when the speech service is wedged.
// Only works when the server runs on the same machine as the browser.
app.post('/api/voice/restart-chrome', async (req, res) => {
  const { tabs } = req.body || {}
  res.json({ ok: true }) // respond immediately — Chrome is about to die
  try {
    const { execSync, exec } = await import('child_process')
    // Kill playwright first
    try { execSync('pkill -9 -f playwright_chromiumdev_profile 2>/dev/null', { timeout: 5000 }) } catch {}
    // Force-kill Chrome (graceful quit doesn't always work)
    try { execSync('pkill -9 -f "Google Chrome" 2>/dev/null', { timeout: 5000 }) } catch {}
    // Wait for Chrome to fully die
    for (let i = 0; i < 20; i++) {
      try { execSync('pgrep -f "Google Chrome.app/Contents/MacOS/Google Chrome" > /dev/null 2>&1', { timeout: 2000 }); } catch { break }
      execSync('sleep 0.5')
    }
    execSync('sleep 1')
    // Reopen Chrome with debug flags
    const tabUrls = (tabs && tabs.length > 0) ? tabs : ['http://localhost:5176/']
    const urlArgs = tabUrls.map(u => `"${u}"`).join(' ')
    exec(`open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=$HOME/.chrome-debug --remote-allow-origins='*' ${urlArgs}`)
    console.log('[voice] Chrome restarted with', tabUrls.length, 'tabs')
  } catch (err) {
    console.error('[voice] restart-chrome failed:', err.message)
  }
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
const fleetRouter = createFleetRouter({
  fleetStore, broadcastEvent, broadcastState, suppressEchoFor,
  sendRpc, resolveRpc, daemonConnections,
})
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
const daemonWss = new WebSocketServer({ noServer: true })
const terminalWss = new WebSocketServer({ noServer: true })

// Per-agent set of browser WebSockets watching that agent's terminal.
// When the first watcher attaches we send `start-terminal-watch` to the
// daemon; when the last one drops we send `stop-terminal-watch`. State
// is server-held so the daemon can resume cleanly after a reconnect.
const terminalWatchers = new Map() // agentId -> Set<ws>

function fanOutTerminalFrame(agentId, frame) {
  const set = terminalWatchers.get(agentId)
  if (!set) return
  const payload = JSON.stringify({ type: 'output', data: frame.pane || '' })
  for (const w of set) {
    if (w.readyState === 1) { try { w.send(payload) } catch {} }
  }
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  // Auth check: token from ?token= query param, Authorization header, or cookie
  // Exempt /ws/fleet — fleet server handles its own access; this proxy
  // must always work so fleet chat (accessibility-critical) isn't blocked
  // by cookie issues.
  // /ws/fleet-daemon is also exempt for the same accessibility reason: a
  // misconfigured token should not be allowed to silently kill the local
  // daemon and take down activity cards / terminal cards. Token rotation
  // affects new connections only — established daemons stay up.
  if (isAuthEnabled() && !url.pathname.startsWith('/ws/fleet') && url.pathname !== '/ws/fleet-daemon') {
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

  // /ws/terminal — browser-side terminal card connection. Routes through
  // the appropriate fleet-daemon via start/stop-terminal-watch RPCs.
  if (url.pathname === '/ws/terminal') {
    const agentId = url.searchParams.get('agent')
    if (!agentId || !fleetStore) { socket.destroy(); return }
    const agent = fleetStore.findAgent(agentId)
    if (!agent || !agent.machine_id) {
      // Decline cleanly with a JSON message before close so the UI shows
      // a useful error instead of "WebSocket error".
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        try { ws.send(JSON.stringify({ type: 'error', message: 'agent has no machine_id; daemon not registered' })) } catch {}
        try { ws.close() } catch {}
      })
      return
    }
    if (!agent.tmux_session) {
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        try { ws.send(JSON.stringify({ type: 'error', message: 'agent has no tmux session' })) } catch {}
        try { ws.close() } catch {}
      })
      return
    }
    terminalWss.handleUpgrade(req, socket, head, async (ws) => {
      ws._agentId = agent.id
      ws._tmuxSession = agent.tmux_session
      ws._machineId = agent.machine_id

      // Add to watcher set; start the daemon poll if first.
      let set = terminalWatchers.get(agent.id)
      if (!set) { set = new Set(); terminalWatchers.set(agent.id, set) }
      set.add(ws)
      const isFirst = set.size === 1

      if (isFirst) {
        try {
          await sendRpc(agent.machine_id, 'start-terminal-watch', {
            agent_id: agent.id, tmux_session: agent.tmux_session, poll_ms: 500,
          })
        } catch (e) {
          try { ws.send(JSON.stringify({ type: 'error', message: e.message })) } catch {}
        }
      } else {
        // Existing watcher already triggered the daemon — tell the new
        // browser to wait for the next polled frame. (No replay.)
      }

      ws.on('message', async (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg.type === 'input' && typeof msg.data === 'string') {
          // Forward raw input as send-text RPC. send-text supports
          // arbitrary bytes via tmux send-keys -- "<text>".
          try {
            await sendRpc(agent.machine_id, 'send-text', {
              tmux_session: agent.tmux_session, text: msg.data, enter: false,
            })
          } catch (e) {
            try { ws.send(JSON.stringify({ type: 'error', message: e.message })) } catch {}
          }
        }
        // resize messages: ignored — tmux send-keys doesn't change pane size.
      })

      const cleanup = async () => {
        const set = terminalWatchers.get(agent.id)
        if (!set) return
        set.delete(ws)
        if (set.size === 0) {
          terminalWatchers.delete(agent.id)
          try {
            await sendRpc(agent.machine_id, 'stop-terminal-watch', {
              tmux_session: agent.tmux_session,
            })
          } catch {}
        }
      }
      ws.on('close', cleanup)
      ws.on('error', cleanup)
    })
    return
  }

  // /ws/fleet-daemon — fleet daemon connection. Owned by bin/fleet-daemon.mjs.
  // The daemon pushes activity-event / terminal-chat / source-change
  // messages and (Phase 2) handles RPC requests routed by machine_id.
  if (url.pathname === '/ws/fleet-daemon') {
    daemonWss.handleUpgrade(req, socket, head, (ws) => {
      ws._bootId = null
      ws._machineId = null
      ws.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        handleDaemonWsMessage(ws, msg)
      })
      ws.on('close', () => {
        if (ws._machineId && daemonConnections.get(ws._machineId) === ws) {
          daemonConnections.delete(ws._machineId)
          failPendingRpcsForMachine(ws._machineId, 'daemon disconnected')
          console.log(`[fleet-daemon] disconnected: machine_id=${ws._machineId}`)
        }
      })
      ws.on('error', () => {
        if (ws._machineId && daemonConnections.get(ws._machineId) === ws) {
          daemonConnections.delete(ws._machineId)
          failPendingRpcsForMachine(ws._machineId, 'daemon ws error')
        }
      })
    })
    return
  }

  // /ws/fleet — direct fleet WebSocket (no proxy)
  if (url.pathname === '/ws/fleet') {
    fleetWss.handleUpgrade(req, socket, head, (ws) => {
      const agentFilter = url.searchParams.get('agent') || null
      ws._agentFilter = agentFilter
      ws._connId = Math.random().toString(36).slice(2)  // unique per-connection ID
      wsFleetClients.add(ws)

      // Send initial state (includes connId so the client can suppress its own echoes)
      if (fleetStore) {
        const initState = {
          agents: fleetStore.getAllAgents().filter(a => !a.dead),
          tasks: fleetStore.getActiveTasks(),
          connId: ws._connId,
        }
        ws.send(JSON.stringify(initState))
      }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString())
          handleFleetWsMessage(ws, msg)
        } catch {}
      })
      ws.on('close', () => {
        wsFleetClients.delete(ws)
        // Unsubscribe the agent from all tlda-feedback watches so stale
        // subscriptions don't accumulate across MCP respawns.
        if (ws._tldaAgentId) tldaFeedback.unsubscribeAll(ws._tldaAgentId)
      })
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
    const { id: agentId, name, tmux_session, cwd, labels, manager, session_id, metadata, machine_id } = msg
    if (!agentId) { error('missing id'); return }
    // Remember which agent owns this WS so we can clean up their tlda-feedback
    // subscriptions on close.
    ws._tldaAgentId = agentId
    const now = new Date().toISOString()
    const existing = fleetStore.getAgent?.(agentId)
    // Reject if another live agent already holds this name
    if (name) {
      const nameRows = fleetStore.db.prepare('SELECT id FROM agents WHERE friendly_name = ? AND dead = 0 AND id != ?').all(name, agentId)
      if (nameRows.length > 0) {
        error(`Name "${name}" already in use by ${nameRows[0].id}`)
        return
      }
    }
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
      human: !!msg.human,
      is_manager: !!manager,
      metadata: metadata ? JSON.stringify(metadata) : existing?.metadata || null,
      // machine_id: optional. The fleet MCP doesn't send it yet — once it
      // does, the server will know which fleet-daemon owns this agent and
      // can route RPCs (Phase 2). Until then, agents stay with NULL.
      machine_id: machine_id || existing?.machine_id || null,
    }
    if (session_id && !agent.session_ids.includes(session_id)) {
      agent.session_ids = [...(agent.session_ids || []), session_id].slice(-10)
    }
    fleetStore.upsertAgent(agent)
    fleetStore.share?.({ type: 'register', agent_id: agentId, from: agentId, to: agentId, text: `${name || agentId} registered` })
    broadcastState()
    // If the agent has a machine_id, push the updated agent list to that
    // machine's daemon so it can start watching the new JSONL.
    if (agent.machine_id) broadcastDaemonAgentsUpdated()
    reply({ ok: true, agent: fleetStore.getAgent?.(agentId) || agent })
    return
  }

  // Login: browser sends { type: "login", name: "skip" } to log in as an
  // existing agent. Never creates — just attaches this WS to the agent.
  if (type === 'login') {
    const { name } = msg
    if (!name || typeof name !== 'string') { error('missing name'); return }
    const sanitized = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!sanitized) { error('invalid name'); return }
    // Find existing agent by friendly_name
    const nameRows = fleetStore.db.prepare('SELECT * FROM agents WHERE friendly_name = ? AND dead = 0').all(sanitized)
    if (nameRows.length === 0) {
      error(`No agent named "${sanitized}". Register first.`)
      return
    }
    const agent = fleetStore._hydrateAgent(nameRows[0])
    fleetStore.upsertAgent({ ...agent, last_seen: new Date().toISOString() })
    ws._tldaHumanId = agent.id
    broadcastState()
    reply({ id: agent.id, name: agent.friendly_name, human: !!agent.human })
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
    const { message: text, to, from, metadata, inline_attachments, attachments, cc, context } = msg
    if (!to || !text) { error('missing to or message'); return }
    // Fleet MCP sends inline_attachments / attachments / cc / context at the
    // top level of the msg. Fold them into the metadata JSON so the receiver
    // pipeline (fleet-data.mjs → chat-render.mjs / my_task) can find them.
    const combinedMetadata = {
      ...(metadata || {}),
      ...(cc ? { cc } : {}),
      ...(attachments ? { attachments } : {}),
      ...(inline_attachments ? { inline_attachments } : {}),
      ...(context ? { context } : {}),
    }
    _suppressEchoWs = ws  // suppress echo back to the originating WS connection (reset by broadcastFleet)
    const event = fleetStore.share?.({
      type: 'chat',
      from,
      to,
      text,
      metadata: Object.keys(combinedMetadata).length ? combinedMetadata : null,
    })
    if (!event) { error('store error'); return }
    // No manual broadcast — share() already fires the listener that
    // broadcasts via fleetStore.onEvent → broadcastEvent('fleet-event', ...).
    // A second manual broadcast here used to produce duplicate messages
    // in receivers (one with the trimmed metadata shape, one with the full
    // store record).
    reply({ ok: true, event_id: event.id })
    return
  }

  if (type === 'heartbeat') {
    const { agent } = msg
    if (agent) fleetStore.updateHeartbeat?.(agent)
    reply({ ok: true })
    return
  }

  if (type === 'delegate') {
    const { agent: agentQuery, description, message: taskMsg, success_criteria, blocked_by, from } = msg
    if (!agentQuery || !description) { error('missing agent or description'); return }
    const resolved = fleetStore.findAgent(agentQuery)
    if (!resolved) { error(`agent not found: ${agentQuery}`); return }
    const taskId = `${resolved.id.slice(0, 10)}-${Date.now().toString(36)}`
    const now = new Date().toISOString()
    const task = {
      id: taskId, agent: resolved.id, description,
      message: taskMsg || description,
      delegated_by: from || null, delegated_at: now,
      status: blocked_by?.length ? 'blocked' : 'pending',
      acknowledged: false,
      blockedBy: blocked_by || undefined,
      success_criteria: success_criteria || undefined,
    }
    fleetStore.upsertTask(task)
    const fromAgent = from ? fleetStore.findAgent(from) : null
    fleetStore.delegate?.(from, resolved.id, taskId, description, {
      fromLabel: fromAgent?.friendly_name || from || '',
      toLabel: resolved.friendly_name || resolved.id,
      criteria: success_criteria || [],
      message: taskMsg || '',
    })
    broadcastState()
    reply({ ok: true, task_id: taskId })
    return
  }

  if (type === 'task-done') {
    const { agent: rawAgent, task_id, skip_qa } = msg
    if (!rawAgent) { error('missing agent'); return }
    const agent = fleetStore.findAgent?.(rawAgent)?.id || rawAgent
    const task = task_id
      ? fleetStore.getTask?.(task_id)
      : fleetStore.getTaskByAgent?.(agent)
    if (!task) { error('no active task'); return }
    if (!skip_qa && fleetStore.getQaAgentIds) {
      const qaIds = fleetStore.getQaAgentIds()
      if (qaIds.length > 0) {
        const qaStatus = fleetStore.getQaStatus(task.id)
        if (qaStatus.status === 'no_report') { error('Submit a report() first'); return }
        if (qaStatus.status === 'rejected') { error(`QA rejected: ${qaStatus.notes || 'no details'}. Fix and re-report.`); return }
        if (qaStatus.status === 'pending') {
          const approved = qaStatus.approved_by || []
          error(`Waiting for QA sign-off (${approved.length}/${qaIds.length} approved)`)
          return
        }
      }
    }
    task.status = 'done'
    task.completed_at = new Date().toISOString()
    let eventId = null
    fleetStore.upsertTask(task)
    const inserted = fleetStore.taskDone?.(agent, task.id, task.description)
    eventId = inserted?.id || null
    broadcastState()
    reply({ ok: true, task_id: task.id, event_id: eventId })
    return
  }

  if (type === 'delete-task') {
    const { task_id } = msg
    if (!task_id) { error('missing task_id'); return }
    const task = fleetStore.getTask?.(task_id)
    if (!task) { error('task not found'); return }
    fleetStore.removeTask?.(task_id)
    broadcastState()
    reply({ ok: true, task_id })
    return
  }

  if (type === 'my-task') {
    const agentId = msg.agent
    if (!agentId) { error('missing agent'); return }
    fleetStore.updateHeartbeat(agentId)
    const task = fleetStore.getTaskByAgent?.(agentId) || null
    const unread = fleetStore.getUnread?.(agentId) || []
    // peek=true: caller just wants to see unread (e.g., the channel-WS
    // flush-on-reconnect path that displays a count). Don't mark read in
    // that case — the actual my_task() call from the agent will do the
    // marking. Without this, peek silently consumes the unread queue and
    // the subsequent my_task() returns nothing.
    if (unread.length && !msg.peek) {
      const readIds = fleetStore.markRead?.(agentId) || []
      if (readIds.length) broadcastEvent('read-receipt', { event_ids: readIds, agent: agentId })
    }
    broadcastState()
    reply({ task, messages: unread })
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

  // ---- tlda-monitor: subscribe to per-doc feedback notifications ----
  // The agent calls `monitor_add(doc)` as an MCP tool → fleet MCP forwards
  // here → we attach shape-change + signal listeners for that doc → when
  // feedback fires, we push a fleet chat message from fleet:tlda to the
  // subscribed agent(s). Replaces the old PostToolUse polling hook.
  if (type === 'tlda-monitor-add') {
    const { agentId, doc } = msg
    if (!agentId || !doc) { error('missing agentId or doc'); return }
    try {
      tldaFeedback.subscribe(agentId, doc, deliverTldaFeedbackChat)
      reply({ ok: true, doc, subscriptions: tldaFeedback.list(agentId) })
    } catch (e) { error(e.message) }
    return
  }
  if (type === 'tlda-monitor-remove') {
    const { agentId, doc } = msg
    if (!agentId || !doc) { error('missing agentId or doc'); return }
    tldaFeedback.unsubscribe(agentId, doc)
    reply({ ok: true, subscriptions: tldaFeedback.list(agentId) })
    return
  }
  if (type === 'tlda-monitor-list') {
    const { agentId } = msg
    if (!agentId) { error('missing agentId'); return }
    reply({ ok: true, subscriptions: tldaFeedback.list(agentId) })
    return
  }

  // Unknown message type — don't error, just ignore (forward compatibility)
  if (id) reply({ ok: false, error: `unknown type: ${type}` })
}

// ---------- Fleet daemon WS message handler ----------
//
// Messages from fleet-daemon.mjs over `/ws/fleet-daemon`. The daemon owns
// JSONL watching, terminal chat extraction, and document source watching
// on its local machine; the server is the hub that stores events and
// broadcasts to browsers.
//
// Phase 1 message types (daemon → server):
//   - daemon-hello       initial identification
//   - activity-event     tool_use / text block extracted from JSONL
//   - terminal-chat      user-typed line in an agent's terminal
//   - source-change      project source file change
//
// Phase 1 message types (server → daemon):
//   - daemon-welcome     agents + projects to watch
//   - daemon-evict       another daemon claimed your machine_id
//   - agents-updated     agent list changed
//   - projects-updated   project list changed
//
// Phase 2 will add `rpc` (server → daemon) and `rpc-reply` (daemon →
// server) for tmux operations.

// Server-side terminal-chat dedup. Claude Code can write duplicate user
// messages to the JSONL (e.g. across compaction). Multiple daemons would
// compound this. The daemon also dedups within its own offset, but the
// authoritative dedup is here in the DB.
const _terminalDedupStmt = fleetStore?.db.prepare(
  `SELECT 1 FROM events WHERE timestamp = ? AND from_id = ? AND to_id = ? AND substr(text, 1, 500) = ? AND type = 'chat' LIMIT 1`
)

function projectsForDaemon() {
  // Returns the project list a daemon needs to watch source dirs for,
  // including each project's relevant-files set (from the last build's
  // .fls). The daemon uses this to watch ONLY the files the build
  // actually reads — not the entire sourceDir.
  return listProjects()
    .filter(p => p.sourceDir && !p.archived)
    .map(p => {
      let watchFiles = null
      try {
        const rfPath = join(PROJECTS_DIR, p.name, 'output', 'relevant-files.json')
        if (existsSync(rfPath)) {
          const rf = JSON.parse(readFileSync(rfPath, 'utf8'))
          // Filter to only author-dir paths (not the server mirror paths)
          watchFiles = (rf.files || [])
            .filter(f => f.startsWith(p.sourceDir))
            .map(f => f.slice(p.sourceDir.length + 1))  // relative paths
        }
      } catch {}
      return {
        name: p.name,
        sourceDir: p.sourceDir,
        format: p.format || 'svg',
        watchFiles,  // null = no .fls yet, watch main file only
        mainFile: p.mainFile || null,
      }
    })
}

function broadcastDaemonAgentsUpdated() {
  if (!fleetStore || daemonConnections.size === 0) return
  for (const [mid, dws] of daemonConnections) {
    if (dws.readyState !== 1) continue
    try {
      dws.send(JSON.stringify({
        type: 'agents-updated',
        agents: fleetStore.getAgentsByMachine(mid),
      }))
    } catch {}
  }
}

function broadcastDaemonProjectsUpdated() {
  if (daemonConnections.size === 0) return
  const projects = projectsForDaemon()
  for (const [, dws] of daemonConnections) {
    if (dws.readyState !== 1) continue
    try { dws.send(JSON.stringify({ type: 'projects-updated', projects })) } catch {}
  }
}

function broadcastDaemonVersionCommitted(projectName, hash) {
  if (daemonConnections.size === 0) return
  const project = readProject(projectName)
  const repoPath = join(getProjectsDir(), projectName, 'shadow-repo')
  for (const [, dws] of daemonConnections) {
    if (dws.readyState !== 1) continue
    try {
      dws.send(JSON.stringify({
        type: 'version-committed',
        project: projectName,
        hash,
        repoPath,
        autoSync: project?.autoSync !== false,
      }))
    } catch {}
  }
}

function handleDaemonWsMessage(ws, msg) {
  const { type } = msg

  if (type === 'daemon-hello') {
    const { machine_id, user, hostname, version, boot_id } = msg
    if (!machine_id) return
    // Eviction protocol: if another daemon already holds this machine_id,
    // compare boot_ids. Newer (larger) boot_id wins; older gets evicted
    // with a `daemon-evict` message and disconnected.
    const existing = daemonConnections.get(machine_id)
    if (existing && existing !== ws) {
      const existingBoot = existing._bootId || 0
      const incomingBoot = boot_id || 0
      if (incomingBoot >= existingBoot) {
        try {
          existing.send(JSON.stringify({
            type: 'daemon-evict',
            reason: 'another daemon claimed this machine_id',
            replaced_by_boot_id: incomingBoot,
          }))
        } catch {}
        try { existing.close() } catch {}
        daemonConnections.delete(machine_id)
      } else {
        // Incoming is older — reject it instead.
        try {
          ws.send(JSON.stringify({
            type: 'daemon-evict',
            reason: 'a newer daemon already holds this machine_id',
            replaced_by_boot_id: existingBoot,
          }))
        } catch {}
        try { ws.close() } catch {}
        return
      }
    }
    ws._machineId = machine_id
    ws._bootId = boot_id
    ws._user = user
    ws._hostname = hostname
    ws._version = version
    daemonConnections.set(machine_id, ws)
    if (machine_id === LOCAL_MACHINE_ID) noteDaemonHealthyConnect()
    console.log(`[fleet-daemon] connected: machine_id=${machine_id} user=${user}@${hostname} v=${version} boot_id=${boot_id}`)

    // Resume any active terminal watches for agents on this machine.
    // The browser-side watcher set is server-held; the daemon comes back
    // empty after a restart so we re-fire start-terminal-watch.
    if (fleetStore) {
      const onMachine = fleetStore.getAgentsByMachine(machine_id)
      for (const a of onMachine) {
        if (a.tmux_session && terminalWatchers.has(a.id)) {
          sendRpc(machine_id, 'start-terminal-watch', {
            agent_id: a.id, tmux_session: a.tmux_session, poll_ms: 500,
          }).catch(() => {})
        }
      }
    }

    // Send daemon-welcome with agents + projects this machine should
    // watch. Agents are filtered by machine_id; legacy NULL agents will
    // be invisible to daemons until the MCP starts sending machine_id.
    const agentsForMachine = fleetStore?.getAgentsByMachine(machine_id) || []
    try {
      ws.send(JSON.stringify({
        type: 'daemon-welcome',
        server_boot_id: SERVER_BOOT_ID,
        agents: agentsForMachine,
        projects: projectsForDaemon(),
      }))
    } catch (e) {
      console.error(`[fleet-daemon] welcome send failed: ${e.message}`)
    }
    return
  }

  // From here on, the daemon must be identified.
  if (!ws._machineId) return

  if (type === 'activity-event') {
    if (!fleetStore) return
    const { agent_id, tool, arg, input, ts, usage, prettyResult } = msg
    if (!agent_id) return
    if (tool === '_usage') return // usage stats don't need DB storage
    try {
      fleetStore.share({
        type: 'activity',
        from: agent_id,
        to: agent_id,
        text: tool === '_text' ? (arg || '') : (tool || ''),
        metadata: { tool: tool || '', arg: arg || '', input: input || null, ...(usage ? { usage } : {}), ...(prettyResult ? { prettyResult } : {}) },
        unread: false,
        timestamp: ts || new Date().toISOString(),
      })
    } catch (e) {
      console.error(`[fleet-daemon] activity write: ${e.message}`)
    }
    return
  }

  if (type === 'terminal-chat') {
    if (!fleetStore || !_terminalDedupStmt) return
    const { agent_id, from, text: rawText, ts, session_id } = msg
    if (!agent_id || !rawText || !ts) return
    const text = rawText.length > 2000 ? rawText.slice(0, 2000) : rawText
    try {
      const existing = _terminalDedupStmt.get(ts, from || SERVER_OWNER_ID, agent_id, text.slice(0, 500))
      if (existing) return // duplicate, swallow silently
      fleetStore.share({
        type: 'chat',
        from: from || SERVER_OWNER_ID,
        to: agent_id,
        text,
        metadata: { source: 'terminal', session_id: session_id || null },
        unread: false,
        timestamp: ts,
      })
    } catch (e) {
      console.error(`[fleet-daemon] terminal-chat write: ${e.message}`)
    }
    return
  }

  if (type === 'terminal-frame') {
    if (msg.agent_id) fanOutTerminalFrame(msg.agent_id, msg)
    return
  }

  if (type === 'plan-mode-prompt') {
    if (!fleetStore) return
    const { agent_id, plan_text, tmux_session } = msg
    if (!agent_id || !plan_text) return
    try {
      fleetStore.share({
        type: 'chat',
        from: agent_id,
        to: SERVER_OWNER_ID,
        text: plan_text,
        metadata: { type: 'plan_approval', tmux_session: tmux_session || null },
        unread: true,
        timestamp: new Date().toISOString(),
      })
    } catch (e) {
      console.error(`[fleet-daemon] plan-mode-prompt write: ${e.message}`)
    }
    return
  }

  if (type === 'terminal_attention') {
    if (!fleetStore) return
    const { agent_id, text, tmux_session } = msg
    if (!agent_id) return
    const agent = fleetStore.getAgent(agent_id)
    const label = agent?.friendly_name || agent_id.slice(0, 12)
    const event = fleetStore.share({
      type: 'terminal_attention',
      from: agent_id,
      to: SERVER_OWNER_ID,
      text: text || `${label}: needs attention`,
      metadata: { agentId: agent_id, agentLabel: label, tmux_session: tmux_session || null },
    })
    if (event) {
      fleetStore.addUnread?.(event.id, SERVER_OWNER_ID)
      broadcastEvent('fleet-event', {
        type: 'terminal_attention',
        from: agent_id,
        to: SERVER_OWNER_ID,
        id: event.id,
        event_id: event.id,
        text: text || `${label}: needs attention`,
        metadata: { agentId: agent_id, agentLabel: label },
      })
    }
    return
  }

  if (type === 'rpc-reply') {
    const entry = pendingRpcs.get(msg.id)
    if (!entry) return // unknown / already-timed-out RPC
    clearTimeout(entry.timer)
    pendingRpcs.delete(msg.id)
    if (msg.error) entry.reject(new Error(msg.error))
    else entry.resolve(msg.result)
    return
  }

  if (type === 'source-change') {
    const { project, files, deletedFiles } = msg
    if (!project) return
    // Hand off to the same pipeline used by HTTP /api/projects/:name/push.
    processProjectPush(project, { files, deletedFiles }).then(result => {
      if (!result.ok) {
        console.error(`[fleet-daemon] source-change ${project}: ${result.error || 'unknown'}`)
      }
    }).catch(e => {
      console.error(`[fleet-daemon] source-change ${project} crashed: ${e.message}`)
    })
    return
  }

  // Unknown — ignore.
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
            autoSync: project.autoSync !== false,
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

  // Start the local-daemon supervisor. Run an immediate check (so the daemon
  // is up shortly after server start) and then poll on an interval. The
  // daemon's own pidfile + connection-state checks gate actual respawn so
  // we don't burst-spawn while a daemon is starting.
  console.log(`[daemon-supervisor] watching for local daemon (machine_id=${LOCAL_MACHINE_ID})`)
  ensureLocalDaemon()
  setInterval(ensureLocalDaemon, DAEMON_SUPERVISOR_INTERVAL_MS).unref()
})
