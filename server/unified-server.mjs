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
import { existsSync, readdirSync, readFileSync, mkdirSync, openSync, statSync } from 'fs'
import os from 'os'
const { homedir, hostname } = os
import { spawn as cpSpawn } from 'child_process'
import { lookup as mimeLookup } from 'mime-types'
import { initProjectStore, listProjects, readProject, getProjectsDir } from './lib/project-store.mjs'
import { resetStaleBuildStates, killAllBuilds } from './lib/build-runner.mjs'
import projectRoutes, { processProjectPush } from './routes/projects.mjs'
import { initAuth, isAuthEnabled, validateToken, extractToken, requireRead, loginRoute } from './lib/auth.mjs'
import { initSyncRooms, getOrCreateRoom, flushAllRooms, closeAllRooms, replayCachedSignals, onGlobalEvent, broadcastSignal, getRoomRecords, listActiveRooms, updateShape } from './lib/sync-rooms.mjs'
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

// "Agent has a running claude process right now" — flat set keyed by agent_id.
// Populated by `agent-liveness` messages from each machine's daemon (every
// ~30s checkAgentLiveness pass) and seeded on register. The fleet store reads
// this via an installed oracle when computing each agent's awake/hibernating
// status. An agent leaves the set when (a) the daemon's next sweep reports
// it gone, (b) that machine's daemon disconnects, or (c) the agent is killed.
const _aliveAgents = new Set()              // Set<agent_id>

function isAgentAlive(agentId) { return _aliveAgents.has(agentId) }

if (fleetStore?.setLivenessOracle) fleetStore.setLivenessOracle(isAgentAlive)

// ─── Process reaper — zombie WebSocket detection ────────────────────
// Agents leave wakes of playwright chromium windows pointed at our
// /sync/<doc> and /ws/fleet endpoints. A "zombie" is a connection with
// no client→server message for ZOMBIE_THRESHOLD_MS. Server pushes don't
// count (we only attach an inbound listener); WebSocket ping/pong frames
// don't surface as 'message' events. Once detected, we ask the daemon
// on the chromium's machine to kill the orphan chromium PID (verified
// by binary path — only the playwright cache, never the user's real
// Google Chrome).
const _trackedWs = new Set()
// Defaults are 10-min idle / 60-s sweep. Override via env for tests (no
// production behavior change — these are plain timing knobs, not feature
// gates).
const ZOMBIE_THRESHOLD_MS = parseInt(process.env.REAPER_ZOMBIE_MS, 10) || 10 * 60 * 1000
const REAPER_INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS, 10) || 60 * 1000

// The tldraw sync client sends `{"type":"ping"}` every 5s as an
// application-level keepalive. We must NOT count those as real input or
// no /sync/ WS would ever look idle.
function isSyncHeartbeat(raw) {
  if (typeof raw === 'string') {
    if (raw.length > 30) return false
    return raw.includes('"ping"')
  }
  if (!raw || raw.length > 30) return false
  return raw.toString('utf8', 0, Math.min(raw.length, 30)).includes('"ping"')
}

function trackWs(ws, meta) {
  ws._wsKind = meta.kind            // 'sync' | 'fleet'
  ws._wsDocName = meta.docName || null
  ws._wsSessionId = meta.sessionId
  ws._wsRemoteAddr = meta.remoteAddr
  ws._wsRemotePort = meta.remotePort
  ws._wsConnectedAt = Date.now()
  ws._wsLastInputAt = Date.now()
  _trackedWs.add(ws)
  if (meta.kind === 'sync') {
    ws.on('message', (raw) => {
      if (isSyncHeartbeat(raw)) return
      ws._wsLastInputAt = Date.now()
    })
  } else {
    // /ws/fleet: no client-side periodic traffic from browsers; MCP-sent
    // `heartbeat` messages come from real agents and (correctly) mark them
    // active — the binary-path check in the daemon prevents us from
    // touching anything that isn't a playwright chromium anyway.
    ws.on('message', () => { ws._wsLastInputAt = Date.now() })
  }
  const cleanup = () => { _trackedWs.delete(ws) }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}

function normalizeAddr(a) {
  if (!a) return a
  if (a.startsWith('::ffff:')) return a.slice(7)  // IPv6-mapped IPv4
  if (a === '::1') return '127.0.0.1'             // IPv6 loopback
  return a
}

function findMachineForAddress(addr) {
  const norm = normalizeAddr(addr)
  for (const [machineId, dws] of daemonConnections) {
    if (normalizeAddr(dws._remoteAddr) === norm) return machineId
  }
  return null
}

async function reapZombies() {
  const now = Date.now()
  const zombies = []
  let activeCount = 0
  for (const ws of _trackedWs) {
    if (ws.readyState !== 1) continue
    const idleMs = now - ws._wsLastInputAt
    if (idleMs > ZOMBIE_THRESHOLD_MS) {
      zombies.push({
        kind: ws._wsKind,
        doc: ws._wsDocName,
        sessionId: ws._wsSessionId,
        addr: ws._wsRemoteAddr,
        port: ws._wsRemotePort,
        idleMs,
      })
    } else {
      activeCount++
    }
  }
  if (zombies.length === 0) {
    console.log(`[reaper] sweep: ${activeCount} active WS, 0 zombies`)
    return
  }
  console.log(`[reaper] sweep: ${activeCount} active WS, ${zombies.length} zombie WS`)
  for (const z of zombies) {
    const idleMin = Math.round(z.idleMs / 60000)
    console.log(`[reaper]   zombie ${z.kind} doc=${z.doc || '-'} session=${z.sessionId} addr=${z.addr}:${z.port} idle=${idleMin}m`)
    const machineId = findMachineForAddress(z.addr)
    if (!machineId) {
      console.log(`[reaper]   no daemon for ${z.addr}; skipping kill`)
      continue
    }
    try {
      const r = await sendRpc(machineId, 'kill-orphan-chromium', {
        port: z.port,
        addr: normalizeAddr(z.addr),
      })
      if (r?.killed) {
        console.log(`[reaper]   killed pid=${r.pid} binary=${r.binary || '(playwright)'} for session=${z.sessionId}`)
      } else {
        console.log(`[reaper]   no kill: ${r?.reason || 'unknown'}`)
      }
    } catch (e) {
      console.log(`[reaper]   kill RPC failed: ${e.message}`)
    }
  }
}

setInterval(reapZombies, REAPER_INTERVAL_MS).unref()

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
const DAEMON_SCRIPT = (() => {
  const d = dirname(fileURLToPath(import.meta.url))
  const m = d.match(/^(.+?)\/\.claude\/worktrees\//)
  return m ? join(m[1], 'bin', 'fleet-daemon.mjs') : join(d, '..', 'bin', 'fleet-daemon.mjs')
})()
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
      env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
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

// No server-side echo suppression. Dedup is client-side: the WS reply
// includes the event ID, which the client maps to its optimistic event
// before the echo arrives (WS message ordering guarantees this).

function broadcastFleet(msg) {
  const data = JSON.stringify(msg)
  for (const ws of wsFleetClients) {
    try { if (ws.readyState === 1) ws.send(data) } catch { wsFleetClients.delete(ws) }
  }
}
function broadcastEvent(type, data) {
  broadcastFleet({ event: type, data })
}
// Server-authoritative thinking/compacting state.
// Populated from agent-thinking / agent-compacting events, included in
// broadcastState() so state pushes never wipe client indicators.
const _thinkingState = new Map()   // agentId → timestamp (ms)
const _compactingState = new Map() // agentId → timestamp (ms)
const _contextState = new Map()    // agentId → { percent, inputTokens }

function broadcastState() {
  if (!fleetStore) return
  broadcastFleet({
    agents: fleetStore.getAllAgents(),
    tasks: fleetStore.getActiveTasks(),
    thinking: Object.fromEntries(_thinkingState),
    compacting: Object.fromEntries(_compactingState),
    context: Object.fromEntries(_contextState),
  })
}

// Wire fleet store events → WS broadcast
if (fleetStore) {
  fleetStore.onEvent?.((event) => broadcastEvent('fleet-event', event))
}

// Backfill session_entries from JSONL files (async, non-blocking).
if (fleetStore) {
  const CLAUDE_PROJECTS = join(os.homedir(), '.claude', 'projects')
  fleetStore.backfillSessionEntries(CLAUDE_PROJECTS).then(({ indexed, skipped }) => {
    if (indexed > 0) console.log(`[fleet-store] search backfill: indexed ${indexed} sessions (${skipped} already indexed)`)
  }).catch(e => console.error('[fleet-store] search backfill failed:', e.message))
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
    // Auto-spawn a QA watcher agent when new content is committed to the shadow repo.
    // version-committed is the semantic trigger (new prose exists); build-card is UI-level.
    // fleet-spawn.py pre-registers the agent before starting tmux, so findAgent() works
    // immediately after the spawn RPC resolves — no register hook or name-pattern needed.
    if (fleetStore) {
      const docName = event.name
      const qaName = `qa-${docName}`
      const existing = fleetStore.findAgent(qaName)
      if (!existing || existing.dead) {
        const machineIds = [...daemonConnections.keys()]
        if (machineIds.length > 0) {
          const taskDesc = `Watch the ${docName} writing project. Read the qa-writing-watch skill for your full spec.`
          sendRpc(machineIds[0], 'spawn', { name: qaName, fresh: !existing })
            .then(() => {
              const agent = fleetStore.findAgent(qaName)
              if (agent) {
                const taskId = `qa-task-${docName}-${Date.now()}`
                fleetStore.delegate('fleet:tlda', agent.id, taskId, taskDesc, { type: 'qa_watch', project: docName })
                console.log(`[qa-watch] delegated task to ${qaName} (${agent.id}) for project ${docName}`)
              } else {
                console.warn(`[qa-watch] spawn succeeded but agent ${qaName} not found in store`)
              }
            })
            .catch(e => console.warn(`[qa-watch] spawn failed for ${qaName}: ${e.message}`))
          console.log(`[qa-watch] spawning ${qaName} for project ${docName}`)
        }
      }
    }
  }
  if (event?.type === 'build-card' && fleetStore && event.name) {
    const { name: docName, hash, summary, lintFindings = [], mirrorFailed, lastMirrorSuccess, buildFiles } = event
    const text = mirrorFailed
      ? `⚠️ Mirror failed — ${docName} (${hash}): ${mirrorFailed}`
      : `Build ${hash} — ${docName}`
    const metadata = { type: 'build_result', name: docName, hash, summary: summary || null, lintFindings, mirrorFailed: mirrorFailed || null }

    // Notify monitoring subscribers
    const subs = new Set(tldaFeedback.subscribers(docName))

    // For mirror failures, also notify agents who used editor tools on the build files
    // since the last successful mirror — those are the agents who could be responsible.
    if (mirrorFailed && buildFiles?.length && lastMirrorSuccess) {
      for (const id of fleetStore.recentDocAgents(buildFiles, lastMirrorSuccess)) subs.add(id)
    }

    for (const agentId of subs) {
      fleetStore.chat('fleet:tlda', agentId, text, metadata)
    }
  }
  if (event?.type === 'scratch-build-failed' && fleetStore && event.agentId) {
    const { doc, agentId, label, errors = [] } = event
    const errorList = errors.map(e => `  • ${e}`).join('\n')
    const text = `**Scratch build failed** — \`${label}\` in ${doc}\n\n${errorList}`
    fleetStore.chat('fleet:tlda', agentId, text, { type: 'scratch_build_failed', doc, label })
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

// Lazy-start the whisper bridge. Browser hits this when voice=whisper is selected.
// Chrome Web Speech is the default; whisper only spins up when explicitly requested.
app.post('/api/voice/whisper/start', async (req, res) => {
  try {
    const WS = (await import('ws')).default
    // Already up?
    const alreadyUp = await new Promise(resolve => {
      let done = false
      try {
        const ws = new WS('ws://127.0.0.1:8179')
        ws.on('open', () => { done = true; ws.close(); resolve(true) })
        ws.on('error', () => { if (!done) { done = true; resolve(false) } })
        setTimeout(() => { if (!done) { done = true; try { ws.close() } catch {}; resolve(false) } }, 800)
      } catch { resolve(false) }
    })
    if (alreadyUp) return res.json({ ok: true, started: false })

    const { spawn } = await import('child_process')
    const { openSync } = await import('fs')
    const { dirname, join } = await import('path')
    const { fileURLToPath } = await import('url')
    const here = dirname(fileURLToPath(import.meta.url))
    const tldaRoot = dirname(here)
    const bridgeScript = join(tldaRoot, 'bin', 'whisper-bridge.mjs')
    const logPath = join(process.env.HOME || '', '.config', 'tlda', 'whisper-bridge.log')
    const fd = openSync(logPath, 'a')
    const child = spawn('node', [bridgeScript], {
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: tldaRoot,
    })
    child.unref()
    console.log('[voice] whisper bridge spawned (lazy-start, pid', child.pid, ')')
    res.json({ ok: true, started: true, pid: child.pid })
  } catch (err) {
    console.error('[voice] whisper/start failed:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/voice/whisper/stop', async (req, res) => {
  try {
    const { execSync } = await import('child_process')
    try { execSync('pkill -f "whisper-bridge.mjs" 2>/dev/null', { timeout: 3000 }) } catch {}
    try { execSync('pkill -f "whisper-stream " 2>/dev/null', { timeout: 3000 }) } catch {}
    console.log('[voice] whisper bridge + stream stopped')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
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
  if (!isAuthEnabled()) return res.json({ level: 'rw', presenter: true, dev: true })
  const token = extractToken(req)
  const level = validateToken(token)
  if (!level) return res.status(401).json({ error: 'Unauthorized' })
  res.json({ level, presenter: level === 'rw' })
})

// ---------- Fleet user prefs ----------
// Per-user key-value store backed by fleet_prefs table. User is identified by fleet ID.

app.get('/api/fleet/prefs', requireRead, (req, res) => {
  const userId = req.query.user
  if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Missing ?user= param' })
  if (!fleetStore) return res.status(503).json({ error: 'fleet store unavailable' })
  res.json(fleetStore.getAllFleetPrefs(userId))
})

app.get('/api/fleet/prefs/:key', requireRead, (req, res) => {
  const userId = req.query.user
  if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Missing ?user= param' })
  if (!fleetStore) return res.status(503).json({ error: 'fleet store unavailable' })
  const value = fleetStore.getFleetPref(userId, req.params.key)
  res.json({ key: req.params.key, value: value ?? null })
})

app.post('/api/fleet/prefs/:key', requireRead, (req, res) => {
  const { user: userId, value } = req.body
  if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Missing user in body' })
  if (value === undefined) return res.status(400).json({ error: 'Missing value in body' })
  if (!fleetStore) return res.status(503).json({ error: 'fleet store unavailable' })
  fleetStore.setFleetPref(userId, req.params.key, value)
  res.json({ ok: true })
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

// ---------- Backing file registry ----------
// Maps filePath → Set of docNames. Server tells daemon which files to watch.
// Registry is in-memory; rebuilt from room shapes on daemon connect.

/** @type {Map<string, Set<string>>} filePath → Set<docName> */
const backingFileRegistry = new Map()

function backingFileRegister(filePath, docName) {
  if (!backingFileRegistry.has(filePath)) backingFileRegistry.set(filePath, new Set())
  backingFileRegistry.get(filePath).add(docName)
  sendWatchBackingFiles()
}

function sendWatchBackingFiles() {
  if (daemonConnections.size === 0) return
  const files = [...backingFileRegistry.entries()].map(([filePath, docNames]) => ({
    filePath, docNames: [...docNames],
  }))
  for (const [, dws] of daemonConnections) {
    if (dws.readyState !== 1) continue
    try { dws.send(JSON.stringify({ type: 'watch-backing-files', files })) } catch {}
  }
}

// Rebuild registry from room shapes when daemon connects.
async function rebuildBackingFileRegistry() {
  backingFileRegistry.clear()
  for (const docName of listActiveRooms()) {
    try {
      const shapes = await getRoomRecords(docName, 'math-note')
      for (const shape of shapes) {
        if (shape.props?.backingFile) {
          backingFileRegister(shape.props.backingFile, docName)
        }
      }
    } catch {}
  }
}

// POST /api/backing-file-register — client registers a backing file watch
app.post('/api/backing-file-register', requireRead, (req, res) => {
  const { filePath, docName } = req.body || {}
  if (!filePath || !docName) return res.status(400).json({ error: 'Missing filePath or docName' })
  const expanded = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : filePath
  backingFileRegister(expanded, docName)
  res.json({ ok: true })
})

// POST /api/backing-file-write — write content to a file via daemon RPC
app.post('/api/backing-file-write', requireRead, async (req, res) => {
  const { filePath, content } = req.body || {}
  if (!filePath) return res.status(400).json({ error: 'Missing filePath' })
  const expanded = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : filePath
  try {
    await sendRpc(LOCAL_MACHINE_ID, 'write-backing-file', { filePath: expanded, content: content ?? '' })
    res.json({ ok: true })
  } catch (e) {
    res.status(503).json({ error: e.message })
  }
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
}, async (req, res, next) => {
  // Skip manifest (handled above)
  if (req.path === '/manifest.json') return next()

  // Extract name from /docs/{name}/rest-of-path
  const parts = req.path.slice(1).split('/')
  if (parts.length < 2) return next()
  const name = parts[0]
  const filePath = parts.slice(1).join('/')

  // Serve history snapshots: /docs/{name}/history/{snapshotId}/<texBase>-page-N.svg
  if (filePath.startsWith('history/')) {
    const histPath = join(PROJECTS_DIR, name, filePath)
    if (existsSync(histPath)) {
      res.set('Cache-Control', 'public, max-age=86400') // snapshots are immutable
      return res.sendFile(resolve(histPath), { dotfiles: 'allow' })
    }

    // On-demand shadow page generation: history/shadow-{hash7}/<texBase>-page-N.svg.
    // texBase is required so we know which target's page to render.
    const shadowPageMatch = filePath.match(/^history\/(shadow-([a-f0-9]{7}))\/(.+)-page-(\d+)\.svg$/)
    if (shadowPageMatch) {
      const hash7 = shadowPageMatch[2]
      const pageNum = parseInt(shadowPageMatch[4], 10)
      try {
        const { buildShadowPage } = await import('./lib/shadow-repo.mjs')
        const svgPath = await buildShadowPage(name, hash7, pageNum)
        res.set('Cache-Control', 'public, max-age=86400')
        return res.sendFile(resolve(svgPath), { dotfiles: 'allow' })
      } catch (e) {
        console.error(`[shadow] on-demand page failed: ${name}@${hash7} p${pageNum}: ${e.message}`)
        return res.status(404).json({ error: 'Shadow page unavailable', detail: e.message })
      }
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

  // On-demand current-column SVG: <texBase>-page-N.svg.
  // Outputs are flat under output/, prefixed by target's texBase. The ensure
  // system (via buildCurrentPage) decides whether to (re)compile the DVI and
  // (re)render the page; we just check whether the file is on disk.
  const livePageMatch = filePath.match(/^([^/]+)-page-(\d+)\.svg$/)
  if (livePageMatch) {
    const texBase = livePageMatch[1]
    const pageNum = parseInt(livePageMatch[2], 10)
    const outputBase = join(PROJECTS_DIR, name, 'output')
    const svgPath = join(outputBase, `${texBase}-page-${pageNum}.svg`)
    const dviPath = join(outputBase, `${texBase}.dvi`)
    const stampPath = join(PROJECTS_DIR, name, 'source.stamp')
    const buildStampPath = join(outputBase, 'build.stamp')
    const svgExists = existsSync(svgPath)
    const dviExists = existsSync(dviPath)
    const buildMtime = existsSync(buildStampPath) ? statSync(buildStampPath).mtimeMs : 0
    const sourceNewerThanBuild = existsSync(stampPath) && statSync(stampPath).mtimeMs > buildMtime
    const dviMtime = dviExists ? statSync(dviPath).mtimeMs : 0
    const needsBuild = !svgExists ||
      !dviExists ||
      statSync(svgPath).mtimeMs < dviMtime ||
      sourceNewerThanBuild
    if (needsBuild) {
      try {
        const { buildCurrentPage } = await import('./lib/shadow-repo.mjs')
        const built = await buildCurrentPage(name, pageNum, texBase)
        res.set('Cache-Control', 'no-cache')
        return res.sendFile(resolve(built), { dotfiles: 'allow' })
      } catch (e) {
        console.error(`[live] on-demand page failed: ${name}/${texBase} p${pageNum}: ${e.message}`)
        return res.status(404).json({ error: 'Page unavailable', detail: e.message })
      }
    }
  }

  // Project-level metadata aliases — bare names resolve to the primary
  // target's per-target file. These names predate multi-target; viewer code
  // fetches them as project-wide artifacts. Aliasing keeps callers simple
  // and the canonical "doc metadata" is the primary target's.
  const BARE_METADATA = new Set([
    'lookup.json', 'macros.json', 'proof-info.json',
    'source-map.json', 'theorem-map.json',
  ])
  if (BARE_METADATA.has(filePath)) {
    try {
      const projectJsonPath = join(PROJECTS_DIR, name, 'project.json')
      if (existsSync(projectJsonPath)) {
        const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'))
        const primaryTexBase = (project.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
        const aliased = join(PROJECTS_DIR, name, 'output', `${primaryTexBase}-${filePath}`)
        if (existsSync(aliased)) {
          res.set('Cache-Control', 'no-cache')
          return res.sendFile(resolve(aliased), { dotfiles: 'allow' })
        }
      }
    } catch { /* fall through */ }
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
function clearEphemeralState(agentId) {
  _thinkingState.delete(agentId)
  _compactingState.delete(agentId)
  _contextState.delete(agentId)
}
const fleetRouter = createFleetRouter({
  fleetStore, broadcastEvent, broadcastState, clearEphemeralState,
  suppressEchoFor: () => {},
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
// Assets use content-hashed filenames (long cache). index.html must be no-cache.
const distDir = join(__dirname, '..', 'dist')
if (existsSync(distDir)) {
  app.use(express.static(distDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.set('Cache-Control', 'no-cache')
      }
    }
  }))
}

// SPA catch-all: serve index.html for client-side routing
app.get('/{*path}', (req, res) => {
  // Don't catch API or doc routes
  if (req.path.startsWith('/api/') || req.path.startsWith('/docs/')) {
    return res.status(404).json({ error: 'Not found' })
  }

  const indexPath = join(distDir, 'index.html')
  if (existsSync(indexPath)) {
    res.set('Cache-Control', 'no-cache')
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

server.on('upgrade', async (req, socket, head) => {
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
    const room = await getOrCreateRoom(docName)
    const remoteAddr = req.socket.remoteAddress
    const remotePort = req.socket.remotePort
    syncWss.handleUpgrade(req, socket, head, (ws) => {
      trackWs(ws, { kind: 'sync', docName, sessionId, remoteAddr, remotePort })
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
    const remoteAddr = req.socket.remoteAddress
    daemonWss.handleUpgrade(req, socket, head, (ws) => {
      ws._bootId = null
      ws._machineId = null
      ws._remoteAddr = remoteAddr  // captured so reaper can route kill RPC by chromium's source IP
      ws.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        handleDaemonWsMessage(ws, msg)
      })
      ws.on('close', () => {
        if (ws._machineId && daemonConnections.get(ws._machineId) === ws) {
          daemonConnections.delete(ws._machineId)
          // The daemon is gone; we no longer have process-level visibility
          // on its machine's agents. Drop them from the alive set; they'll
          // appear hibernating until a daemon reconnects.
          const onMachine = fleetStore?.getAgentsByMachine?.(ws._machineId) || []
          for (const a of onMachine) _aliveAgents.delete(a.id)
          failPendingRpcsForMachine(ws._machineId, 'daemon disconnected')
          broadcastState()
          console.log(`[fleet-daemon] disconnected: machine_id=${ws._machineId}`)
        }
      })
      ws.on('error', () => {
        if (ws._machineId && daemonConnections.get(ws._machineId) === ws) {
          daemonConnections.delete(ws._machineId)
          const onMachine = fleetStore?.getAgentsByMachine?.(ws._machineId) || []
          for (const a of onMachine) _aliveAgents.delete(a.id)
          failPendingRpcsForMachine(ws._machineId, 'daemon ws error')
          broadcastState()
        }
      })
    })
    return
  }

  // /ws/fleet — direct fleet WebSocket (no proxy)
  if (url.pathname === '/ws/fleet') {
    const remoteAddr = req.socket.remoteAddress
    const remotePort = req.socket.remotePort
    fleetWss.handleUpgrade(req, socket, head, (ws) => {
      const agentFilter = url.searchParams.get('agent') || null
      ws._agentFilter = agentFilter
      wsFleetClients.add(ws)
      trackWs(ws, {
        kind: 'fleet',
        sessionId: `fleet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        remoteAddr,
        remotePort,
      })

      // Send initial state on connect
      if (fleetStore) {
        const initState = {
          agents: fleetStore.getAllAgents(),
          tasks: fleetStore.getActiveTasks(),
          thinking: Object.fromEntries(_thinkingState),
          compacting: Object.fromEntries(_compactingState),
          context: Object.fromEntries(_contextState),
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

async function handleFleetWsMessage(ws, msg) {
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
    // Registration implies a live claude process — mark alive immediately so
    // the agent shows "awake" right away. The daemon's next sweep confirms
    // or evicts within 30s.
    if (!agent.human) _aliveAgents.add(agentId)
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
    reply(fleetStore.getAliveAgents())
    return
  }

  if (type === 'store-tasks') {
    const active = msg.active !== false
    reply(active ? fleetStore.getActiveTasks() : fleetStore.getAllTasks?.() || [])
    return
  }

  // ---- jsonl-index: daemon pushes JSONL text entries for unified search ----
  if (type === 'jsonl-index') {
    try { fleetStore.insertSessionEntries(msg.entries || []) } catch (e) { error(e.message); return }
    reply({ ok: true })
    return
  }

  // ---- fleet-search: unified search across fleet events + session JSONL text ----
  if (type === 'fleet-search') {
    try {
      const results = fleetStore.searchAll(msg.query || '', {
        limit: msg.limit, agent: msg.agent, role: msg.role, since: msg.since,
      })
      const context = {}
      if (msg.context_timestamps?.length) {
        for (const ts of msg.context_timestamps) {
          context[ts] = fleetStore.getChatContext(ts, msg.context_window || 3)
        }
      }
      reply({ results, context })
    } catch (e) { error(e.message) }
    return
  }

  // Interacting with a hibernating (non-dead, no live process) agent wakes
  // it. `dead` means explicitly killed — never auto-respawns. Hibernation
  // is behavioral, not stored: it's "no process + you tried to interact."
  // Non-blocking — message is already in DB, agent picks it up via my_task() on wake.
  async function respawnIfNotDead(agentId) {
    const agent = fleetStore.getAgent?.(agentId)
    if (!agent || agent.dead || agent.human) return
    const machineIds = [...daemonConnections.keys()]
    if (machineIds.length === 0) return
    // Ask the daemon — on the agent's machine — whether the Claude process is running.
    // The daemon checks tmux session existence + pgrep for a claude process inside it.
    const { alive } = await sendRpc(machineIds[0], 'check-alive', { tmux_session: agent.tmux_session })
      .catch(() => ({ alive: false }))
    if (alive) return
    // Pass fleet ID directly — fleet-spawn accepts "fleet:xxx" and skips name→ID lookup
    sendRpc(machineIds[0], 'spawn', { name: agentId, respawn: true })
      .catch(e => console.warn(`[respawn] failed for ${agentId}: ${e.message}`))
    console.log(`[respawn] waking ${agent.friendly_name || agentId} (${agentId})`)
  }

  if (type === 'chat') {
    const { message: text, to: rawTo, from: rawFrom, metadata, inline_attachments, attachments, cc, context } = msg
    if (!rawTo || !text) { error('missing to or message'); return }
    const resolveSingle = (id) => {
      if (id === SERVER_OWNER_NAME) return SERVER_OWNER_ID
      const a = fleetStore?.findAgent(id); return a ? a.id : null
    }
    const from = rawFrom ? (resolveSingle(rawFrom) || rawFrom) : null
    // Normalize `to` to DNF: a single string becomes [[string]] (a singleton DNF).
    const dnf = Array.isArray(rawTo) ? rawTo : [[rawTo]]
    // Resolve DNF over all alive agents using labels + virtual + friendly_name + id.
    const allAgents = fleetStore.getAliveAgents?.() || []
    const recipients = []
    for (const a of allAgents) {
      if (a.id === from) continue
      const virtual = a.status === 'awake' ? ['awake'] : a.status === 'hibernating' ? ['hibernating'] : []
      const labels = [...(a.labels || []), ...virtual, a.friendly_name, a.id].filter(Boolean)
      if (dnf.some(andGroup => andGroup.every(term => labels.includes(term)))) {
        recipients.push(a.id)
      }
    }
    // Server-owner pseudo-recipient: matched by literal id/name only, no label index.
    if (dnf.some(andGroup => andGroup.length === 1 && (andGroup[0] === SERVER_OWNER_ID || andGroup[0] === SERVER_OWNER_NAME))) {
      if (!recipients.includes(SERVER_OWNER_ID)) recipients.push(SERVER_OWNER_ID)
    }
    if (recipients.length === 0) { error(`No recipients matched: ${JSON.stringify(rawTo)}`); return }
    // Update sender heartbeat
    if (from) fleetStore.updateHeartbeat?.(from)
    // Resolve CC (still single-string list)
    let ccResolved = cc && cc.length ? cc.map(resolveSingle).filter(Boolean) : null
    if (ccResolved && ccResolved.length === 0) ccResolved = null
    // Copy attachments to server-accessible path (once for all recipients)
    let processedAttachments = attachments
    if (attachments && attachments.length) {
      const UPLOAD_DIR = path.join(import.meta.dirname || '.', 'uploads')
      processedAttachments = attachments.map(a => {
        if (a.path && fs.existsSync(a.path)) {
          try {
            fs.mkdirSync(UPLOAD_DIR, { recursive: true })
            const name = `${Date.now()}-${path.basename(a.path)}`
            const dest = path.join(UPLOAD_DIR, name)
            fs.copyFileSync(a.path, dest)
            return { ...a, path: dest, originalPath: a.path }
          } catch { /* keep original */ }
        }
        return a
      })
    }
    const senderAgent = fleetStore.getAgent?.(from)
    const chatReminder = senderAgent?.metadata?.chatReminder || undefined
    const taps = fleetStore.getWiretaps?.() || []
    const fromLabels = [from, ...(fleetStore.findAgent(from)?.labels || [])].filter(Boolean)
    const ts = new Date().toISOString()
    const eventIds = []
    const insertedEvents = []
    for (const to of recipients) {
      // Resolve wiretaps per recipient — tap labels are matched against this `to`.
      const toLabels = [to, ...(fleetStore.findAgent(to)?.labels || [])].filter(Boolean)
      const wiretapRecipients = []
      for (const tap of taps) {
        if (!tap.filter) continue
        let matches = false
        try {
          const f = typeof tap.filter === 'string' ? JSON.parse(tap.filter) : tap.filter
          const fromMatch = !f.from || f.from.some(grp => grp.every(t => fromLabels.includes(t)))
          const toMatch = !f.to || f.to.some(grp => grp.every(t => toLabels.includes(t)))
          matches = fromMatch && toMatch
        } catch {}
        if (matches && tap.agent_id !== from && tap.agent_id !== to) {
          wiretapRecipients.push(tap.agent_id)
        }
      }
      const combinedMetadata = {
        ...(metadata || {}),
        ...(ccResolved ? { cc: ccResolved } : {}),
        ...(processedAttachments ? { attachments: processedAttachments } : {}),
        ...(inline_attachments ? { inline_attachments } : {}),
        ...(wiretapRecipients.length ? { wiretap_cc: wiretapRecipients } : {}),
        ...(context ? { context } : {}),
        ...(chatReminder ? { chatReminder } : {}),
      }
      const metaStr = Object.keys(combinedMetadata).length ? JSON.stringify(combinedMetadata) : null
      const result = fleetStore.db.prepare(
        'INSERT INTO events (type, timestamp, from_id, to_id, text, metadata) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('chat', ts, from, to, text, metaStr)
      const eventId = Number(result.lastInsertRowid)
      fleetStore.db.prepare('INSERT OR IGNORE INTO unread (event_id, to_id, read) VALUES (?, ?, 0)').run(eventId, to)
      eventIds.push(eventId)
      insertedEvents.push({ id: eventId, type: 'chat', timestamp: ts, from_id: from, to_id: to, text, metadata: Object.keys(combinedMetadata).length ? combinedMetadata : null })
    }
    // Reply FIRST so the client can reconcile optimistic events before broadcasts arrive.
    reply({ ok: true, event_ids: eventIds, recipients, _tempId: msg._tempId || null })
    for (const ev of insertedEvents) broadcastEvent('fleet-event', ev)
    for (const to of recipients) respawnIfNotDead(to)
    return
  }

  if (type === 'heartbeat') {
    const { agent } = msg
    if (agent) fleetStore.updateHeartbeat?.(agent)
    reply({ ok: true })
    return
  }

  if (type === 'load-history') {
    const limit = Math.min(parseInt(msg.limit || '50'), 1000)
    const before = msg.before || null
    const agent = msg.agent || null
    try {
      let events = fleetStore.queryChatHistory({ before, agent, limit: limit + 1 })
        .map(e => ({ ...e, event_type: e.type, from: e.from, to: e.to, agent: e.agent_id }))
      const hasMore = events.length > limit
      if (hasMore) events.shift()
      events = events.filter(e => {
        const t = e.text || ''
        return !t.startsWith('<channel') && !t.startsWith('<task-notification') && !t.startsWith('<system-reminder')
      })
      const allAgents = fleetStore.getAllAgents()
      const agentMap = {}
      for (const a of allAgents) agentMap[a.id] = a.friendly_name || a.name || a.id
      agentMap['web'] = agentMap[SERVER_OWNER_ID] || SERVER_OWNER_NAME
      const unreadIds = new Set()
      try {
        const rows = fleetStore.db.prepare('SELECT event_id FROM unread WHERE read = 0').all()
        for (const r of rows) unreadIds.add(r.event_id)
      } catch {}
      const resolved = events.map(e => ({
        ...e,
        read: !unreadIds.has(e.id),
        fromLabel: agentMap[e.from] || (e.from ? e.from.substring(0, 8) : ''),
        toLabel: agentMap[e.to] || agentMap[e.agent] || (e.to ? e.to.substring(0, 8) : ''),
      }))
      reply({ events: resolved, hasMore })
    } catch (e) {
      error(e.message)
    }
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
    respawnIfNotDead(resolved.id)
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
    if (msg.thinking) {
      _thinkingState.set(msg.agentId, Date.now())
    } else {
      _thinkingState.delete(msg.agentId)
    }
    broadcastEvent('agent-thinking', { agent: msg.agentId, thinking: !!msg.thinking })
    reply({ ok: true })
    return
  }

  if (type === 'agent-compacting') {
    if (msg.compacting) {
      _compactingState.set(msg.agentId, Date.now())
    } else {
      _compactingState.delete(msg.agentId)
    }
    broadcastEvent('agent-compacting', { agent: msg.agentId, compacting: !!msg.compacting })
    reply({ ok: true })
    return
  }

  if (type === 'agent-context') {
    if (msg.agentId != null && msg.contextPercent != null) {
      _contextState.set(msg.agentId, { percent: msg.contextPercent, inputTokens: msg.inputTokens || 0 })
      broadcastEvent('agent-context', { agent: msg.agentId, percent: msg.contextPercent, inputTokens: msg.inputTokens || 0 })
    }
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

  // ---- rename ----
  if (type === 'rename') {
    const { agent: agentQuery, name: newName } = msg
    if (!agentQuery || newName == null) { error('agent and name required'); return }
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (newName) {
      const conflict = fleetStore.db.prepare('SELECT id FROM agents WHERE friendly_name = ? AND dead = 0 AND id != ?').get(newName, agent.id)
      if (conflict || newName === SERVER_OWNER_NAME) { error(`Name "${newName}" already in use`); return }
    }
    fleetStore.db.prepare('UPDATE agents SET friendly_name = ? WHERE id = ?').run(newName || null, agent.id)
    broadcastState()
    reply({ ok: true, agent: agent.id, name: newName || null })
    return
  }

  // ---- label ----
  if (type === 'label') {
    const { agent: agentQuery, labels } = msg
    if (!agentQuery || !Array.isArray(labels)) { error('agent and labels[] required'); return }
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    agent.labels = labels
    fleetStore.upsertAgent(agent)
    broadcastState()
    reply({ ok: true, agent: agent.id, labels })
    return
  }

  // ---- kick ----
  if (type === 'kick') {
    const { agent: agentQuery } = msg
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const route = resolveRpc('kick', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendRpc(route.machine_id, 'kick', { agent_id: agent.id })
      broadcastEvent('fleet-event', { type: 'kick', to: agent.id, from: SERVER_OWNER_ID, text: 'manual kick' })
      reply(result)
    } catch (e) { error(e.message) }
    return
  }

  // ---- kill-session ----
  if (type === 'kill-session') {
    const { agent: agentQuery } = msg
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.tmux_session) { error('no tmux session'); return }
    const route = resolveRpc('kill-session', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendRpc(route.machine_id, 'kill-session', { agent_id: agent.id, tmux_session: agent.tmux_session })
      fleetStore.markDead(agent.id)
      const killEvent = { type: 'kill-session', from: SERVER_OWNER_ID, to: agent.id, text: `Killed ${agent.friendly_name || agent.id}` }
      fleetStore.share(killEvent)
      broadcastState()
      reply({ ok: true, agent: agent.friendly_name || agent.id, ...result })
    } catch (e) { error(e.message) }
    return
  }

  // ---- interrupt ----
  if (type === 'interrupt') {
    const { agent: agentQuery } = msg
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.tmux_session) { error('no tmux session'); return }
    const route = resolveRpc('interrupt', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendRpc(route.machine_id, 'interrupt', { agent_id: agent.id, tmux_session: agent.tmux_session })
      reply({ ok: true, agent: agent.friendly_name || agent.id, ...result })
    } catch (e) { error(e.message) }
    return
  }

  // ---- spawn ----
  if (type === 'spawn') {
    const { name, model, doc, agent, respawn } = msg
    let spawnName = name
    if (respawn && agent) {
      const a = fleetStore.findAgent(agent)
      spawnName = a?.friendly_name || agent
    }
    const machineIds = [...daemonConnections.keys()]
    if (machineIds.length === 0) { error('No fleet daemon connected — cannot spawn agents'); return }
    try {
      const result = await sendRpc(machineIds[0], 'spawn', {
        name: spawnName || undefined, model: model || undefined,
        doc: doc || undefined, respawn: !!respawn,
      })
      broadcastState()
      reply(result)
    } catch (e) { error(e.message) }
    return
  }

  // ---- send-key ----
  if (type === 'send-key') {
    const { agent: agentQuery, key } = msg
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.tmux_session) { error('no tmux session'); return }
    const route = resolveRpc('send-key', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendRpc(route.machine_id, 'send-key', { tmux_session: agent.tmux_session, key })
      reply(result)
    } catch (e) { error(e.message) }
    return
  }

  // ---- send-text ----
  if (type === 'send-text') {
    const { agent: agentQuery, text, enter } = msg
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.tmux_session) { error('no tmux session'); return }
    const route = resolveRpc('send-text', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendRpc(route.machine_id, 'send-text', { tmux_session: agent.tmux_session, text, enter: enter !== false })
      reply(result)
    } catch (e) { error(e.message) }
    return
  }

  // ---- capture-pane ----
  if (type === 'capture-pane') {
    const { agent: agentQuery, lines } = msg
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.tmux_session) { error('no tmux session'); return }
    const route = resolveRpc('capture-pane', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendRpc(route.machine_id, 'capture-pane', { tmux_session: agent.tmux_session, lines: lines || 50 })
      reply(result)
    } catch (e) { error(e.message) }
    return
  }

  // ---- plan-mode-respond ----
  if (type === 'plan-mode-respond') {
    const { agent: agentQuery, response } = msg
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.tmux_session) { error('no tmux session'); return }
    if (response !== 'approve' && response !== 'reject') { error('response must be approve or reject'); return }
    const op = response === 'approve' ? 'send-text' : 'send-key'
    const route = resolveRpc(op, agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      let result
      if (response === 'approve') {
        result = await sendRpc(route.machine_id, 'send-text', { tmux_session: agent.tmux_session, text: '1', enter: true })
      } else {
        result = await sendRpc(route.machine_id, 'send-key', { tmux_session: agent.tmux_session, key: 'Escape' })
      }
      fleetStore.updateAgentMeta?.(agent.id, { permission_mode: null })
      broadcastState()
      reply(result)
    } catch (e) { error(e.message) }
    return
  }

  // ---- plan-mode-toggle ----
  if (type === 'plan-mode-toggle') {
    const { agent: agentQuery } = msg
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.tmux_session) { error('no tmux session'); return }
    const route = resolveRpc('capture-pane', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const parseCCMode = (pane) => {
        if (/plan mode on/i.test(pane)) return 'plan'
        if (/accept edits on/i.test(pane)) return 'acceptEdits'
        return 'default'
      }
      const cap1 = await sendRpc(route.machine_id, 'capture-pane', { tmux_session: agent.tmux_session, lines: 5 })
      const currentMode = parseCCMode(cap1?.content || '')
      const btabs = currentMode === 'plan' ? 1 : currentMode === 'acceptEdits' ? 1 : 2
      for (let i = 0; i < btabs; i++) {
        await sendRpc(route.machine_id, 'send-key', { tmux_session: agent.tmux_session, key: 'BTab' })
        if (i < btabs - 1) await new Promise(r => setTimeout(r, 150))
      }
      if (btabs > 0) await new Promise(r => setTimeout(r, 300))
      const cap2 = await sendRpc(route.machine_id, 'capture-pane', { tmux_session: agent.tmux_session, lines: 5 })
      const finalMode = parseCCMode(cap2?.content || '')
      fleetStore.updateAgentMeta?.(agent.id, { permission_mode: finalMode === 'default' ? null : finalMode })
      broadcastState()
      reply({ ok: true, mode: finalMode, was: currentMode })
    } catch (e) { error(e.message) }
    return
  }

  // ---- mark-event-read ----
  if (type === 'mark-event-read') {
    const { event_id, agent: rawAgent } = msg
    if (!event_id || !rawAgent) { error('event_id and agent required'); return }
    const agent = fleetStore.findAgent(rawAgent)
    const agentId = agent?.id || rawAgent
    const changed = fleetStore.markEventRead?.(parseInt(event_id, 10), agentId)
    if (changed) broadcastEvent('read-receipt', { event_ids: [parseInt(event_id, 10)], agent: agentId })
    reply({ ok: true, changed: !!changed })
    return
  }

  // ---- terminal-card ----
  if (type === 'terminal-card') {
    const { from: rawFrom, reason } = msg
    if (!rawFrom) { error('missing from'); return }
    const agent = fleetStore.findAgent(rawFrom)
    if (!agent) { error(`Agent not found: "${rawFrom}"`); return }
    if (!agent.tmux_session) { error('agent has no tmux_session'); return }
    if (!agent.machine_id) { error('agent has no machine_id'); return }
    const label = agent.friendly_name || agent.id.slice(0, 12)
    const text = reason ? `${label}: ${reason}` : `${label}: terminal requested`
    const event = fleetStore.share?.({
      type: 'terminal_card', from: agent.id, to: SERVER_OWNER_ID, text,
      metadata: JSON.stringify({ reason: reason || null, agentId: agent.id, agentLabel: label }),
    })
    broadcastEvent('fleet-event', {
      type: 'terminal_card', from: agent.id, to: SERVER_OWNER_ID,
      id: event?.id, event_id: event?.id, text,
      metadata: { reason: reason || null, agentId: agent.id, agentLabel: label },
    })
    reply({ ok: true, event_id: event?.id })
    return
  }

  // ---- wiretap-add ----
  if (type === 'wiretap-add') {
    const { agent, filter } = msg
    if (!agent || !filter) { error('missing agent or filter'); return }
    const tap = fleetStore.addWiretap(agent, filter)
    reply(tap)
    return
  }

  // ---- wiretap-remove ----
  if (type === 'wiretap-remove') {
    const { id: tapId } = msg
    if (!tapId || isNaN(parseInt(tapId))) { error('invalid id'); return }
    fleetStore.removeWiretap(parseInt(tapId))
    reply({ ok: true })
    return
  }

  // ---- wiretap-list ----
  if (type === 'wiretap-list') {
    const { agent } = msg
    const taps = agent ? fleetStore.getWiretapsByAgent?.(agent) : fleetStore.getWiretaps?.()
    reply(taps || [])
    return
  }

  // ---- retract ----
  if (type === 'retract') {
    const { agent: rawAgent, task_id } = msg
    if (!rawAgent) { error('missing agent'); return }
    const agentId = fleetStore.findAgent(rawAgent)?.id || rawAgent
    const task = task_id ? fleetStore.getTask?.(task_id) : fleetStore.getTaskByAgent?.(agentId)
    if (!task) { error('no active task'); return }
    fleetStore.removeTask?.(task.id)
    broadcastState()
    reply({ ok: true, task_id: task.id })
    return
  }

  // ---- shared-docs-set ----
  if (type === 'shared-docs-set') {
    const { doc, path: docPath, title, agent, ephemeral } = msg
    if (!doc) { error('missing doc'); return }
    const now = new Date().toISOString()
    fleetStore.db.prepare(`
      INSERT INTO shared_docs (doc, path, title, agent, ephemeral, shared_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc) DO UPDATE SET path=excluded.path, title=excluded.title, agent=excluded.agent, ephemeral=excluded.ephemeral, updated_at=excluded.updated_at
    `).run(doc, docPath || null, title || null, agent || null, ephemeral ? 1 : 0, now, now)
    reply({ ok: true })
    return
  }

  // ---- shared-docs-get ----
  if (type === 'shared-docs-get') {
    const docs = fleetStore.db.prepare('SELECT * FROM shared_docs ORDER BY updated_at DESC').all() || []
    reply(docs)
    return
  }

  // ---- mark-dead ----
  if (type === 'mark-dead') {
    const { agent: agentId } = msg
    if (!agentId) { error('missing agent'); return }
    fleetStore.markDead(agentId)
    broadcastState()
    reply({ ok: true })
    return
  }

  // ---- chat-history ----
  if (type === 'chat-history') {
    const { limit: rawLimit = 50, before, agent } = msg
    const limit = Math.min(parseInt(rawLimit) || 50, 1000)
    try {
      let events = []
      const fleetEvents = fleetStore.queryChatHistory?.({ before, agent, limit: limit + 1 }) || []
      events = fleetEvents.map(e => ({ ...e, event_type: e.type, from: e.from, to: e.to, agent: e.agent_id }))
      const hasMore = events.length > limit
      if (hasMore) events.shift()
      events = events.filter(e => { const t = e.text || ''; return !t.startsWith('<channel') && !t.startsWith('<task-notification') && !t.startsWith('<system-reminder') })
      const allAgents = fleetStore.getAllAgents()
      const agentMap = {}
      for (const a of allAgents) agentMap[a.id] = a.friendly_name || a.name || a.id
      const unreadIds = new Set()
      try { const rows = fleetStore.db.prepare('SELECT event_id FROM unread WHERE read = 0').all(); for (const r of rows) unreadIds.add(r.event_id) } catch {}
      const resolved = events.map(e => ({
        ...e,
        read: !unreadIds.has(e.id),
        fromLabel: agentMap[e.from] || (e.from ? e.from.substring(0, 8) : ''),
        toLabel: agentMap[e.to] || agentMap[e.agent] || (e.to ? e.to.substring(0, 8) : ''),
      }))
      const nextCursor = hasMore && events.length > 0 ? events[0].timestamp : null
      reply({ events: resolved, hasMore, nextCursor })
    } catch (e) { error(e.message) }
    return
  }

  // ---- store-events ----
  if (type === 'store-events') {
    const afterId = parseInt(msg.after || '0')
    const beforeId = msg.before ? parseInt(msg.before) : null
    // Timestamp-based pagination (ISO strings). Used by get_thread/MCP.
    const sinceTs = msg.since || null
    const untilTs = msg.until || null
    const limit = Math.min(parseInt(msg.limit || '200'), 5000)
    const evtAgent = msg.agent || null
    const evtType = msg.event_type || null
    // event_types (array) takes precedence over event_type (single)
    const evtTypes = Array.isArray(msg.event_types) && msg.event_types.length ? msg.event_types : evtType ? [evtType] : null
    try {
      let events
      let total = null
      const cols = 'id, type, timestamp, from_id as "from", to_id as "to", text, metadata, task_id, agent_id'
      if (evtAgent) {
        const agentWhere = '(from_id = ? OR to_id = ?)'
        const baseParams = [evtAgent, evtAgent]
        // Build optional type filter clause
        const typeClause = evtTypes ? `type IN (${evtTypes.map(() => '?').join(',')})` : null
        const typeParams = evtTypes || []
        const where = typeClause ? `${agentWhere} AND ${typeClause}` : agentWhere
        const allBaseParams = [...baseParams, ...typeParams]
        if (sinceTs || untilTs) {
          // Timestamp pagination: filter by timestamp range, return earliest matches in
          // chronological order. Also report `total` for the matching range so the
          // caller can show "showing N of M".
          const tsClauses = []
          const tsParams = []
          if (sinceTs) { tsClauses.push('timestamp > ?'); tsParams.push(sinceTs) }
          if (untilTs) { tsClauses.push('timestamp <= ?'); tsParams.push(untilTs) }
          const tsWhere = `${where} AND ${tsClauses.join(' AND ')}`
          const q = `SELECT ${cols} FROM events WHERE ${tsWhere} ORDER BY timestamp ASC LIMIT ?`
          events = fleetStore.db.prepare(q).all(...allBaseParams, ...tsParams, limit)
          const totalRow = fleetStore.db.prepare(
            `SELECT COUNT(*) AS c FROM events WHERE ${tsWhere}`
          ).get(...allBaseParams, ...tsParams)
          total = totalRow?.c ?? null
        } else {
          const q = afterId
            ? `SELECT ${cols} FROM events WHERE ${where} AND id > ? ORDER BY id ASC LIMIT ?`
            : beforeId
            ? `SELECT ${cols} FROM events WHERE ${where} AND id < ? ORDER BY id DESC LIMIT ?`
            : `SELECT ${cols} FROM events WHERE ${where} ORDER BY timestamp ASC LIMIT ?`
          events = afterId ? fleetStore.db.prepare(q).all(...allBaseParams, afterId, limit)
            : beforeId ? fleetStore.db.prepare(q).all(...allBaseParams, beforeId, limit)
            : fleetStore.db.prepare(q).all(...allBaseParams, limit)
          if (beforeId) events.reverse()
          // total for this agent+type filter so callers see "X of Y"
          const totalRow = fleetStore.db.prepare(
            `SELECT COUNT(*) AS c FROM events WHERE ${where}`
          ).get(...allBaseParams)
          total = totalRow?.c ?? null
        }
      } else if (evtTypes) {
        const typeClause = `type IN (${evtTypes.map(() => '?').join(',')})`
        events = fleetStore.db.prepare(`SELECT ${cols} FROM events WHERE ${typeClause} AND id > ? ORDER BY id ASC LIMIT ?`).all(...evtTypes, afterId, limit)
      } else if (beforeId) {
        events = fleetStore.db.prepare(`SELECT ${cols} FROM events WHERE id < ? ORDER BY id DESC LIMIT ?`).all(beforeId, limit)
        events.reverse()
      } else {
        events = fleetStore.getEventsSince(afterId, limit)
      }
      const lastId = fleetStore.getLastEventId()
      reply({ events, lastId, total })
    } catch (e) { error(e.message) }
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
    // Rebuild backing file registry from current rooms and push watch list to daemon.
    rebuildBackingFileRegistry().then(() => sendWatchBackingFiles()).catch(() => {})
    return
  }

  // From here on, the daemon must be identified.
  if (!ws._machineId) return

  if (type === 'agent-liveness') {
    // Daemon's list of its machine's agents whose claude processes are
    // currently running. Treated as a full replacement for that machine:
    // any agent on this machine that the daemon didn't mention is dropped
    // from the alive set (it's hibernating now).
    if (Array.isArray(msg.agent_ids)) {
      const incoming = new Set(msg.agent_ids)
      const agentsOnThisMachine = fleetStore?.getAgentsByMachine?.(ws._machineId) || []
      for (const a of agentsOnThisMachine) {
        if (incoming.has(a.id)) _aliveAgents.add(a.id)
        else _aliveAgents.delete(a.id)
      }
      broadcastState()
    }
    return
  }

  if (type === 'activity-event') {
    if (!fleetStore) return
    const { agent_id, tool, arg, input, ts, usage, prettyResult, origTool } = msg
    if (!agent_id) return
    if (tool === '_usage') return // usage stats don't need DB storage
    try {
      fleetStore.share({
        type: 'activity',
        from: agent_id,
        to: agent_id,
        text: tool === '_text' ? (arg || '') : (tool || ''),
        metadata: { tool: tool || '', arg: arg || '', input: input || null, ...(usage ? { usage } : {}), ...(prettyResult ? { prettyResult } : {}), ...(origTool ? { origTool } : {}) },
        unread: false,
        timestamp: ts || new Date().toISOString(),
      })
    } catch (e) {
      console.error(`[fleet-daemon] activity write: ${e.message}`)
    }
    return
  }

  if (type === 'qualification-warning') {
    if (!fleetStore) return
    const { agent_id, file, required, message: warnMsg } = msg
    if (!agent_id || !warnMsg) return
    try {
      const event = fleetStore.share({
        type: 'chat',
        from: agent_id,
        to: SERVER_OWNER_ID,
        text: warnMsg,
        metadata: { type: 'qualification_warning', file, required },
      })
      if (event) {
        fleetStore.addUnread?.(event.id, SERVER_OWNER_ID)
        broadcastEvent('fleet-event', { ...event, type: 'chat' })
      }
    } catch (e) {
      console.error(`[fleet-daemon] qualification-warning write: ${e.message}`)
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

  if (type === 'agent-context') {
    if (msg.agentId != null && msg.contextPercent != null) {
      _contextState.set(msg.agentId, { percent: msg.contextPercent, inputTokens: msg.inputTokens || 0 })
      broadcastEvent('agent-context', { agent: msg.agentId, percent: msg.contextPercent, inputTokens: msg.inputTokens || 0 })
    }
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
    const { agent_id, text, tmux_session, reason } = msg
    if (!agent_id) return
    const agent = fleetStore.getAgent(agent_id)
    const label = agent?.friendly_name || agent_id.slice(0, 12)
    const event = fleetStore.share({
      type: 'terminal_attention',
      from: agent_id,
      to: SERVER_OWNER_ID,
      text: text || `${label}: needs attention`,
      metadata: { agentId: agent_id, agentLabel: label, tmux_session: tmux_session || null, reason: reason || null },
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
        metadata: { agentId: agent_id, agentLabel: label, reason: reason || null },
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

  if (type === 'file-content-changed') {
    const { filePath, content } = msg
    if (!filePath) return
    const docNames = backingFileRegistry.get(filePath)
if (!docNames || docNames.size === 0) return
    for (const docName of docNames) {
      broadcastSignal(docName, 'signal:file-updated', { filePath, content: content ?? '' })
    }
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

  // Idle-hibernation: kill tmux sessions for agents that have had no activity for a while.
  // "Activity" = any event from or to the agent in the events table (chat, activity card,
  // delegate, etc.). Heartbeats and last_seen are network signals — not used here.
  // The process dies, RAM is freed. The agent enters hibernation (no process, but
  // `dead=0`). Auto-respawn fires when anyone next messages them.
  const IDLE_HIBERNATE_MS = 20 * 60 * 1000  // 20 minutes
  setInterval(() => {
    if (!fleetStore) return
    const cutoff = new Date(Date.now() - IDLE_HIBERNATE_MS).toISOString()
    const idle = fleetStore.db.prepare(
      `SELECT a.* FROM agents a
       WHERE a.dead = 0 AND a.human = 0 AND a.tmux_session IS NOT NULL
       AND COALESCE(
         (SELECT MAX(e.timestamp) FROM events e WHERE e.from_id = a.id OR e.to_id = a.id),
         a.registered_at
       ) < ?`
    ).all(cutoff)
    for (const agent of idle) {
      const machineIds = [...daemonConnections.keys()]
      if (machineIds.length === 0) continue
      console.log(`[hibernate] ${agent.friendly_name || agent.id} — no activity since before ${cutoff}`)
      sendRpc(machineIds[0], 'kill-session', { agent_id: agent.id, tmux_session: agent.tmux_session })
        .catch(() => {})
      // NOTE: do NOT markDead — idling just hibernates, doesn't kill the agent
      // identity. dead=1 is reserved for explicit kills.
    }
    if (idle.length > 0) broadcastState()
  }, 5 * 60 * 1000).unref()  // check every 5 minutes
})
