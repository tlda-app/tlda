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

if (!process.argv.includes('--i-am-tlda-cli')) {
  console.error('Use `tlda server start` to run the server. Do not run unified-server.mjs directly.')
  process.exit(1)
}

import express from 'express'
import { createServer } from 'http'
import { createServer as createHttpsServer } from 'https'
import { WebSocketServer } from 'ws'
import { spawn } from 'child_process'
// Runtime guard: warn on execSync in server process (tmux commands still use it)
// TODO: migrate tmux commands to async exec, then ban execSync entirely
import path from 'path'
const { dirname, join, resolve } = path
import { fileURLToPath } from 'url'
import fs from 'fs'
const { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, openSync, statSync } = fs
import os from 'os'
const { homedir, hostname } = os
import { spawn as cpSpawn } from 'child_process'
import { lookup as mimeLookup } from 'mime-types'
import { DEFAULT_PORT, hasTls, getManagedBots } from '../shared/config.mjs'
import { BARE_METADATA, resolveAsset } from '../shared/doc-assets.mjs'
import { labelsForAgent, evalDnf } from '../shared/fleet-labels.mjs'
import { phaseFromName, baseName, PHASES } from '../shared/lineage-name.mjs'
import { initProjectStore, listProjects, readProject, getProjectsDir } from './lib/project-store.mjs'
import { resetStaleBuildStates, killAllBuilds, runBuild } from './lib/build-runner.mjs'
import projectRoutes, { processProjectPush } from './routes/projects.mjs'
import { initAuth, isAuthEnabled, validateToken, extractToken, requireRead, loginRoute } from './lib/auth.mjs'
import { initSyncRooms, getOrCreateRoom, flushAllRooms, closeAllRooms, replayCachedSignals, onGlobalEvent, broadcastSignal, getRoomRecords, listActiveRooms, updateShape, putShape } from './lib/sync-rooms.mjs'
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

const PORT = process.env.PORT || DEFAULT_PORT
const HOST = process.env.HOST || '0.0.0.0'
const PROJECTS_DIR = process.env.PROJECTS_DIR || join(__dirname, 'projects')

// Initialize stores
initProjectStore(PROJECTS_DIR)
initSyncRooms(PROJECTS_DIR)
resetStaleBuildStates()

// Fleet store (SQLite-backed agent registry + chat).
// TLDA_FLEET_DB overrides the default path — used by integration tests
// to isolate from the live /tmp/fleet.db.
const fleetStore = new FleetStore(process.env.TLDA_FLEET_DB)

// Name provenance: stamp each event/result row with the friendly name its
// sender/recipient ACTUALLY held at the row's timestamp (via name_history),
// plus the current name when it has since changed. Resolution lives here on the
// server where the DB is — the MCP and client just display fromName/toName and
// always pair them with the durable fleet id. Mutates rows in place and returns
// them. A null period name means the agent was nameless then (reach it by id).
function stampNames(rows) {
  if (!Array.isArray(rows)) return rows
  for (const r of rows) {
    const ts = r.timestamp
    if (r.from) {
      r.fromName = fleetStore.nameAt(r.from, ts)
      const cur = fleetStore.getAgent(r.from)?.friendly_name ?? null
      if (cur !== r.fromName) r.fromNameNow = cur
    }
    if (r.to) {
      r.toName = fleetStore.nameAt(r.to, ts)
      const cur = fleetStore.getAgent(r.to)?.friendly_name ?? null
      if (cur !== r.toName) r.toNameNow = cur
    }
    if (r.agentId) {
      r.agentName = fleetStore.nameAt(r.agentId, ts)
      const cur = fleetStore.getAgent(r.agentId)?.friendly_name ?? null
      if (cur !== r.agentName) r.agentNameNow = cur
    }
  }
  return rows
}

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

const _activeViewerDocs = new Set()

function _recomputeActiveViewers() {
  const prev = new Set(_activeViewerDocs)
  _activeViewerDocs.clear()
  for (const ws of _trackedWs) {
    if (ws._wsKind === 'sync' && ws._wsDocName?.startsWith('doc-')) {
      _activeViewerDocs.add(ws._wsDocName.slice(4))
    }
  }
  if (prev.size !== _activeViewerDocs.size || ![...prev].every(d => _activeViewerDocs.has(d))) {
    broadcastDaemonActiveViewers()
  }
}

function getActiveViewerProjects() { return _activeViewerDocs }

function trackWs(ws, meta) {
  ws._wsKind = meta.kind            // 'sync' | 'fleet'
  ws._wsDocName = meta.docName || null
  ws._wsSessionId = meta.sessionId
  ws._wsRemoteAddr = meta.remoteAddr
  ws._wsRemotePort = meta.remotePort
  ws._wsConnectedAt = Date.now()
  ws._wsLastInputAt = Date.now()
  ws._wsAlive = true
  ws.on('pong', () => { ws._wsAlive = true })
  _trackedWs.add(ws)
  if (meta.kind === 'sync') {
    ws.on('message', (raw) => {
      if (isSyncHeartbeat(raw)) return
      ws._wsLastInputAt = Date.now()
    })
  } else {
    ws.on('message', () => { ws._wsLastInputAt = Date.now() })
  }
  const cleanup = () => {
    _trackedWs.delete(ws)
    if (ws._wsKind === 'sync') _recomputeActiveViewers()
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
  if (meta.kind === 'sync') _recomputeActiveViewers()
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
    const byKind = {}
    for (const ws of _trackedWs) {
      if (ws.readyState !== 1) continue
      const idleMs = now - ws._wsLastInputAt
      const k = ws._wsKind || 'unknown'
      if (!byKind[k]) byKind[k] = { count: 0, maxIdleS: 0 }
      byKind[k].count++
      byKind[k].maxIdleS = Math.max(byKind[k].maxIdleS, Math.round(idleMs / 1000))
    }
    const summary = Object.entries(byKind).map(([k, v]) => `${k}:${v.count}(max-idle=${v.maxIdleS}s)`).join(' ')
    console.log(`[reaper] sweep: ${activeCount} active, 0 zombies — ${summary}`)
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

// --- WebSocket heartbeat ---
// Detect half-open connections (laptop sleep, network change) that TCP won't
// notice for minutes. Server pings every 30s; if a client doesn't pong before
// the next ping, terminate the socket. TLDraw's ClientWebSocketAdapter
// reconnects automatically once the close fires.
const WS_HEARTBEAT_INTERVAL_MS = 30_000
setInterval(() => {
  for (const ws of _trackedWs) {
    if (ws.readyState !== 1) continue
    if (ws._wsAlive === false) {
      console.log(`[heartbeat] terminating unresponsive ${ws._wsKind} ws=${ws._wsSessionId} doc=${ws._wsDocName || '-'}`)
      ws.terminate()
      continue
    }
    ws._wsAlive = false
    ws.ping()
  }
}, WS_HEARTBEAT_INTERVAL_MS).unref()

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
    } catch (e) {
      console.warn(`[server] stale daemon PID file: ${e.message}`)
    }
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

// ---- Managed-bot supervisor ----
// tlda keeps a configurable list of background "bots" alive — each is just a
// script that talks to the fleet API (the shipped example is Todd). No bot is
// special-cased; the list comes from config (getManagedBots). Each tick we check
// a bot's pidfile and respawn it (detached, own log) when its process is gone,
// with crash-loop backoff so a startup crash doesn't hot-loop. The supervisor
// owns the pidfile/log location and hands them to the bot via env, so the bot
// stays agnostic about where it lives.
function resolveBotScript(script) {
  if (script.startsWith('/')) return script
  // repo-relative — resolve against the repo root, accounting for a worktree.
  const d = dirname(fileURLToPath(import.meta.url))
  const m = d.match(/^(.+?)\/\.claude\/worktrees\//)
  const root = m ? m[1] : join(d, '..')
  return join(root, script)
}

const _botState = new Map() // name → { spawnInFlight, lastSpawnAt, rapidFails, backoffUntil, givingUpLogged }

function ensureManagedBot(spec) {
  const name = spec?.name
  if (!name || !spec.script) return
  const scriptPath = resolveBotScript(spec.script)
  const pidFile = join(homedir(), '.config', 'tlda', `${name}.pid`)
  const logFile = join(homedir(), '.config', 'tlda', `${name}.log`)
  let st = _botState.get(name)
  if (!st) { st = { spawnInFlight: false, lastSpawnAt: 0, rapidFails: 0, backoffUntil: 0, givingUpLogged: false }; _botState.set(name, st) }
  if (st.spawnInFlight) return
  const now = Date.now()
  if (now < st.backoffUntil) return
  // Already running? (pidfile process alive — the bot writes its own pid on start)
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (pid > 0) { try { process.kill(pid, 0); return } catch {} } // not alive → respawn
    } catch (e) { console.warn(`[bot-supervisor:${name}] stale pid file: ${e.message}`) }
  }
  if (!existsSync(scriptPath)) return
  // Crash-loop guard — same shape/budget as the daemon supervisor.
  if (st.lastSpawnAt > 0 && now - st.lastSpawnAt < DAEMON_FAST_DEATH_MS) {
    st.rapidFails++
    if (st.rapidFails >= DAEMON_MAX_RAPID_RESPAWNS) {
      st.backoffUntil = now + DAEMON_BACKOFF_MS
      if (!st.givingUpLogged) {
        console.error(`[bot-supervisor:${name}] crashed ${st.rapidFails}× in <${DAEMON_FAST_DEATH_MS}ms each — backing off ${DAEMON_BACKOFF_MS / 1000}s. Tail ${logFile} for the cause.`)
        st.givingUpLogged = true
      }
      st.rapidFails = 0
      return
    }
  } else if (st.lastSpawnAt > 0) {
    st.rapidFails = 0
  }
  st.spawnInFlight = true
  try {
    if (!existsSync(dirname(logFile))) mkdirSync(dirname(logFile), { recursive: true })
    const logFd = openSync(logFile, 'a')
    const child = cpSpawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined, TLDA_BOT_NAME: name, TLDA_BOT_PIDFILE: pidFile },
    })
    child.unref()
    st.lastSpawnAt = now
    st.givingUpLogged = false
    console.log(`[bot-supervisor:${name}] respawned`)
  } catch (e) {
    console.error(`[bot-supervisor:${name}] spawn failed: ${e.message}`)
  } finally {
    setTimeout(() => { st.spawnInFlight = false }, 3000)
  }
}

function ensureManagedBots() {
  for (const spec of getManagedBots()) {
    try { ensureManagedBot(spec) } catch (e) { console.error(`[bot-supervisor] ${spec?.name || '?'}: ${e.message}`) }
  }
}

// Pending RPCs awaiting a daemon `rpc-reply`. Keyed by RPC id.
// Each entry: { resolve, reject, timer, machine_id }.
const pendingRpcs = new Map()
let _rpcSeq = 0
const RPC_TIMEOUT_MS = 10_000

// ---------- Plan mode approval tracking ----------
//
// When a terminal frame shows the Claude Code plan mode approval prompt
// ("Would you like to proceed?"), we fire a plan_approval fleet event and
// track the pending approval so Skip's voice response can be routed back
// as a keystroke to the correct agent's tmux pane.
//
// keyed by agent_id → { tmux_session, machine_id, planText, lastHash, eventId }
const pendingPlanApprovals = new Map()

// Chat idempotency cache: _tempId → { eventIds, recipients, ts }
// Prevents duplicate DB rows when the browser retries a timed-out send.
const _chatTempIds = new Map()
const CHAT_TEMPID_TTL_MS = 60_000
setInterval(() => {
  const cutoff = Date.now() - CHAT_TEMPID_TTL_MS
  for (const [k, v] of _chatTempIds) { if (v.ts < cutoff) _chatTempIds.delete(k) }
}, 30_000).unref?.()

// detectPlanApproval removed — plan detection is handled by the daemon

// Fuzzy match Skip's reply to an affirmative or negative.
// Returns '1' (approve) or '3' (reject) — matching Claude Code's numbered menu.
function matchApprovalResponse(text) {
  const t = text.trim().toLowerCase()
  // Negative — check first so "no go ahead" isn't misread as affirmative
  if (/\b(no|nope|stop|cancel|wait|hold on|don'?t|not yet|abort|reject|denied)\b/.test(t)) return '3'
  if (/\b(yes|yeah|yep|yup|go ahead|do it|approve|proceed|proceed|sounds good|let'?s go|sure|absolutely|okay|ok)\b/.test(t)) return '1'
  return null
}

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
const _lastActivityAt = new Map()  // agentId → timestamp (ms) — last real activity (thinking, tool call, chat)
const _viewingContext = new Map()   // agentId → { doc, page, sourceLine, ... , updatedAt }
let _lastReaperStatus = null       // latest reaper snapshot from daemon
const _daemonWarnDedup = new Map() // project → { eventId, count, lastSeen, baseText }
const DAEMON_WARN_DEDUP_MS = 5 * 60 * 1000

// machine_id → ts when the CURRENT uninterrupted daemon connection began. Reset on
// every daemon-hello (i.e. every reconnect). Agent activity events arrive over the
// daemon WS, so if that WS flapped, an agent's activity wasn't delivered and its
// _lastActivityAt went stale — making an active agent *look* idle. See getWouldHibernate.
const _daemonConnectedSince = new Map()

const HIBERNATE_IDLE_MS = 20 * 60 * 1000

function touchActivity(agentId) {
  _lastActivityAt.set(agentId, Date.now())
}

function getWouldHibernate() {
  const now = Date.now()
  const result = {}
  for (const agentId of _aliveAgents) {
    // A dead/removed row can linger in this in-memory set: it's only pruned by
    // the daemon's agent-liveness reconciliation, which queries dead=0 rows and
    // therefore can never evict a row already flipped to dead. Such a ghost
    // would otherwise be hibernated on its ancient _lastActivityAt — and since
    // lineage twins share a tmux_session, that kill-session would take down the
    // LIVE agent occupying the session. Skip anything not currently alive.
    const agent = fleetStore?.getAgent(agentId)
    if (!agent || agent.dead) continue
    if (_thinkingState.has(agentId)) continue
    if (_compactingState.has(agentId)) continue
    const lastActive = _lastActivityAt.get(agentId)
    if (!lastActive) continue
    const idleMs = now - lastActive
    if (idleMs < HIBERNATE_IDLE_MS) continue
    // Gap-aware idle: a 20-min-idle reading is only trustworthy if the activity
    // feed (this agent's daemon WS) was continuously connected for that whole
    // window. If the daemon (re)connected within the window, activity events were
    // dropped during the gap — the agent may have been active the entire time, its
    // events just never arrived. Don't hibernate on an unreliable reading.
    const machineId = agent.machine_id
    if (machineId) {
      const connectedSince = _daemonConnectedSince.get(machineId)
      if (!connectedSince || (now - connectedSince) < HIBERNATE_IDLE_MS) continue
    }
    result[agentId] = Math.round(idleMs / 1000)
  }
  return result
}

// Last-broadcast agent snapshot: agentId → JSON string. Lets broadcastState
// emit only the agents that actually changed instead of the whole list, so a
// single status flip is O(1) on the wire rather than O(all agents). The full
// list still goes to each client once, on connect (see the /ws/fleet handler).
const _lastAgentJson = new Map()

function _broadcastStateNow() {
  if (!fleetStore) return
  // Live churn is ALIVE-only — we never re-diff the full ~1300-row roster on
  // every state change. Dead agents are delivered once via initState and stay
  // in the client as static, un-polled filter/chat targets (the panel hides
  // them client-side: FleetAgentsShape `if (a.dead) continue`). A dying agent
  // gets ONE final dead-flagged delta below, then drops out of the churn
  // forever — it is NOT `removed` (that would delete it from the client and
  // make it impossible to chat with / resurrect).
  const aliveAgents = fleetStore.getAliveAgents().map(a => {
    if (_thinkingState.has(a.id)) return { ...a, status: 'thinking' }
    if (_compactingState.has(a.id)) return { ...a, status: 'compacting' }
    return a
  })
  // Diff against the last broadcast: only changed/new agents go on the wire.
  const changed = []
  const seen = new Set()
  for (const a of aliveAgents) {
    seen.add(a.id)
    const json = JSON.stringify(a)
    if (_lastAgentJson.get(a.id) !== json) {
      changed.push(a)
      _lastAgentJson.set(a.id, json)
    }
  }
  // An agent that left the alive set since the last broadcast either DIED
  // (send one final dead-flagged update so the panel drops it but the client
  // keeps it as a target) or was DELETED from the DB (truly `removed`). Either
  // way, stop churning it.
  const removed = []
  for (const id of _lastAgentJson.keys()) {
    if (seen.has(id)) continue
    _lastAgentJson.delete(id)
    const rec = fleetStore.getAgent(id)
    if (rec && rec.dead) changed.push(rec)
    else if (!rec) removed.push(id)
  }
  // tasks + ephemeral maps (thinking/compacting/context) are bounded by the
  // active agent set, so they stay small — send them whole each time.
  broadcastFleet({
    event: 'agents-delta',
    data: {
      changed,
      removed,
      tasks: fleetStore.getActiveTasks(),
      thinking: Object.fromEntries(_thinkingState),
      compacting: Object.fromEntries(_compactingState),
      context: Object.fromEntries(_contextState),
    },
  })
}

// Debounced entry point: ~12 call sites fire broadcastState() and on boot a
// burst hits it 15+ times in a row, each doing a getAllAgents()+getActiveTasks()
// pass. Coalesce rapid calls into one run per 50ms — the agent-delta diff means
// no change is missed, and a 50ms delay on status updates is imperceptible.
let _broadcastTimer = null
function broadcastState() {
  if (_broadcastTimer) return
  _broadcastTimer = setTimeout(() => { _broadcastTimer = null; _broadcastStateNow() }, 50)
}

// Spawning a name that already belongs to a live agent isn't an error — the user
// "meant that one." Coerce it to a respawn (resume if hibernating, no-op if it's
// already running, both handled by fleet-spawn) and emit a synthetic activity
// event so the agent floats to the top of the panel's Active sort. Mirrors what
// `tlda agent spawn <name>` already does on the CLI. Explicit respawns skip this
// (they raise themselves when the resumed agent re-registers).
async function resolveSpawnTarget(name, respawn) {
  if (respawn || !name || !fleetStore) return { name, respawn }
  let existing = null
  try {
    existing = fleetStore.findAgent(name)
  } catch (e) {
    // findAgent throws when >1 live agents already share this name — a pre-existing
    // pathology, not something this spawn caused. Leave it as a fresh spawn, but
    // don't swallow it: surface the duplicate so it gets noticed.
    console.warn(`[spawn] name "${name}" matches multiple live agents — spawning fresh: ${e.message}`)
    return { name, respawn }
  }
  if (!existing || existing.dead) return { name, respawn }
  try {
    await fleetStore.share({
      type: 'activity', from: existing.id, to: existing.id,
      text: 'spawn', metadata: { tool: 'spawn', synthetic: true }, unread: false,
    })
    fleetStore._bustAgentsCache?.()
    broadcastState()
  } catch (e) {
    console.error(`[spawn] raise failed for ${existing.id}: ${e.message}`)
  }
  return { name: existing.friendly_name || name, respawn: true }
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
// watching its source files, and tell browsers to refresh their project
// list (the spawn form / agents panel) so it stays live without a reload.
onGlobalEvent((event) => {
  if (event?.type === 'project-changed') {
    broadcastDaemonProjectsUpdated()
    broadcastEvent('projects-updated', { name: event.name })
  }
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
    const { name: docName, hash, summary, lintFindings = [], mirrorFailed, editedBy } = event
    const text = mirrorFailed
      ? `⚠️ Mirror failed — ${docName} (${hash}): ${mirrorFailed}`
      : `Build ${hash} — ${docName}`
    const metadata = { type: 'build_result', name: docName, hash, summary: summary || null, lintFindings, mirrorFailed: mirrorFailed || null }

    // Address the card to the agent whose edit triggered this build (resolved by
    // the daemon at source-change time — robust, no time-window cross-reference)
    // plus any monitor subscribers. recentDocAgents was dropped: it required an
    // exact abspath+window match against build files and resolved empty in
    // practice, so build cards were never created at all.
    const subs = new Set(tldaFeedback.subscribers(docName))
    if (editedBy) subs.add(editedBy)

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
  if (event?.type === 'sync-error') {
    const { docName, shapeId, shapeType, error } = event
    const text = `**Sync validation error** in \`${docName}\`\n\`${shapeType}\` shape \`${shapeId}\`: ${error}`
    if (process.env.TLDA_DEBUG) {
      console.error(`[TLDA_DEBUG] FATAL sync error — crashing:\n  ${text}`)
      process.exit(1)
    }
    deliverTldaFeedbackChat({ from: 'fleet:tlda', to: SERVER_OWNER_ID, text, metadata: { type: 'sync_error', docName, shapeId, shapeType } })
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

// HSTS — after one visit over HTTPS, browser auto-upgrades localhost:5176 to HTTPS
if (hasTls) {
  app.use((req, res, next) => {
    res.header('Strict-Transport-Security', 'max-age=31536000')
    next()
  })
}

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
    const tabUrls = (tabs && tabs.length > 0) ? tabs : [`http://localhost:${DEFAULT_PORT}/`]
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

// Lazy-start the deepgram bridge. Browser hits this when voice=deepgram is selected.
// The deepgram bridge listens on TLS (wss) only when the mkcert localhost certs
// exist — the SAME condition bin/deepgram-bridge.mjs uses to choose its server.
// On Fly there are no mkcert certs, so the bridge runs on plain ws; matching the
// scheme here is what lets the proxy actually reach it off Skip's local machine.
const _dgCert = path.join(homedir(), '.config/tlda/localhost+2.pem')
const _dgKey = path.join(homedir(), '.config/tlda/localhost+2-key.pem')
const DEEPGRAM_BRIDGE_URL = (existsSync(_dgCert) && existsSync(_dgKey) ? 'wss' : 'ws') + '://127.0.0.1:8179'

app.post('/api/voice/deepgram/start', async (req, res) => {
  try {
    const WS = (await import('ws')).default
    const alreadyUp = await new Promise(resolve => {
      let done = false
      try {
        const ws = new WS(DEEPGRAM_BRIDGE_URL, { rejectUnauthorized: false })
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
    const bridgeScript = join(tldaRoot, 'bin', 'deepgram-bridge.mjs')
    const logPath = join(process.env.HOME || '', '.config', 'tlda', 'deepgram-bridge.log')
    const fd = openSync(logPath, 'a')
    const child = spawn('node', [bridgeScript], {
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: tldaRoot,
    })
    child.unref()
    console.log('[voice] deepgram bridge spawned (lazy-start, pid', child.pid, ')')
    res.json({ ok: true, started: true, pid: child.pid })
  } catch (err) {
    console.error('[voice] deepgram/start failed:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/voice/deepgram/stop', async (req, res) => {
  try {
    const { execSync } = await import('child_process')
    try { execSync('pkill -f "deepgram-bridge.mjs" 2>/dev/null', { timeout: 3000 }) } catch {}
    console.log('[voice] deepgram bridge stopped')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Probe the local deepgram bridge over TLS (the bridge runs an HTTPS WSS server
// when the mkcert certs exist — see bin/deepgram-bridge.mjs). The self-signed
// localhost cert is fine here, so rejectUnauthorized is off.
async function probeDeepgramBridge() {
  const WS = (await import('ws')).default
  return new Promise(resolve => {
    let done = false
    let ws
    const finish = (v) => { if (!done) { done = true; try { ws?.close() } catch {}; resolve(v) } }
    try {
      ws = new WS(DEEPGRAM_BRIDGE_URL, { rejectUnauthorized: false })
      ws.on('open', () => finish(true))
      ws.on('error', () => finish(false))
      setTimeout(() => finish(false), 800)
    } catch { resolve(false) }
  })
}

// Ensure the deepgram bridge is running, spawning it if needed. Used by the
// /voice/deepgram WS proxy so a device that can't reach 127.0.0.1:8179 (the
// iPad) still gets a live bridge. Concurrent callers share one spawn.
let _deepgramBridgeStarting = null
async function ensureDeepgramBridge() {
  if (await probeDeepgramBridge()) return true
  if (!_deepgramBridgeStarting) {
    _deepgramBridgeStarting = (async () => {
      const { spawn } = await import('child_process')
      const { openSync } = await import('fs')
      const { dirname, join } = await import('path')
      const { fileURLToPath } = await import('url')
      const here = dirname(fileURLToPath(import.meta.url))
      const tldaRoot = dirname(here)
      const bridgeScript = join(tldaRoot, 'bin', 'deepgram-bridge.mjs')
      const logPath = join(process.env.HOME || '', '.config', 'tlda', 'deepgram-bridge.log')
      const fd = openSync(logPath, 'a')
      const child = spawn('node', [bridgeScript], { detached: true, stdio: ['ignore', fd, fd], cwd: tldaRoot })
      child.unref()
      console.log('[voice] deepgram bridge spawned (proxy ensure, pid', child.pid, ')')
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 250))
        if (await probeDeepgramBridge()) return
      }
    })().finally(() => { _deepgramBridgeStarting = null })
  }
  await _deepgramBridgeStarting
  return probeDeepgramBridge()
}

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

// ---------- Browser-side log sink ----------
// Clients POST log entries here (one or many). Each entry is appended as a
// JSON line to ~/.config/tlda/client.log so we can tail/grep. Use this from
// the browser via src/logger.ts — every log.{debug,info,warn,error} call
// gets forwarded here automatically. See CLAUDE.md "Client logging".
const CLIENT_LOG_FILE = join(homedir(), '.config', 'tlda', 'client.log')
app.post('/api/log', (req, res) => {
  const body = req.body
  const entries = Array.isArray(body) ? body : [body]
  const lines = []
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const obj = {
      ts: e.ts || new Date().toISOString(),
      level: e.level || 'info',
      ns: e.ns || 'unknown',
      msg: e.msg ?? '',
      ...(e.data !== undefined ? { data: e.data } : {}),
      ...(e.session ? { session: e.session } : {}),
    }
    lines.push(JSON.stringify(obj))
  }
  if (lines.length) {
    fs.appendFile(CLIENT_LOG_FILE, lines.join('\n') + '\n', (err) => {
      if (err) console.log(`[client-log] append failed: ${err.message}`)
    })
  }
  res.json({ ok: true, n: lines.length })
})

// ---------- Fleet user prefs ----------
// Per-user key-value store backed by fleet_prefs table. User is identified by fleet ID.

// --- Reaper API ---

app.get('/api/reaper/status', requireRead, (req, res) => {
  res.json(_lastReaperStatus || { error: 'no data yet' })
})

app.post('/api/reaper/kill', requireRead, async (req, res) => {
  const { pid } = req.body
  if (!pid) return res.status(400).json({ error: 'missing pid' })
  const machineId = LOCAL_MACHINE_ID
  try {
    const result = await sendRpc(machineId, 'reaper-kill', { pid })
    res.json(result || { ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/reaper/sweep', requireRead, async (req, res) => {
  const machineId = LOCAL_MACHINE_ID
  try {
    const result = await sendRpc(machineId, 'reaper-sweep', {})
    res.json(result || { ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/fleet/viewing', requireRead, (req, res) => {
  const userId = req.query.user
  if (userId) {
    let ctx = _viewingContext.get(userId)
    if (!ctx && fleetStore) {
      const agent = fleetStore.findAgent(userId)
      if (agent) ctx = _viewingContext.get(agent.id)
    }
    return res.json(ctx || { error: 'no viewing context' })
  }
  const result = {}
  for (const [id, ctx] of _viewingContext) result[id] = ctx
  res.json(result)
})

// Goose model list for the spawn UI's autocomplete + validation. Single source
// of truth is `fleet-spawn --list-models` (GOOSE_MODELS/GOOSE_VERIFIED), so the
// UI never drifts from what fleet-spawn actually accepts. Cached 60s since it
// only changes when a model is verified. Shape: { default, models:[{alias,id,
// verified}], verified:[id…] }.
let _gooseModelsCache = null
let _gooseModelsCacheAt = 0
app.get('/api/fleet/models', requireRead, (req, res) => {
  if (_gooseModelsCache && Date.now() - _gooseModelsCacheAt < 60_000) return res.json(_gooseModelsCache)
  const script = join(__dirname, '..', 'bin', 'fleet-spawn.py')
  const child = cpSpawn('python3', [script, '--list-models'], { timeout: 10_000 })
  let out = '', err = '', done = false
  const fail = (msg) => { if (!done) { done = true; res.status(500).json({ error: msg }) } }
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('error', e => fail(`model list failed: ${e.message}`))
  child.on('close', code => {
    if (done) return
    if (code !== 0) return fail(`model list exited ${code}: ${err.slice(0, 200)}`)
    try {
      const data = JSON.parse(out)
      _gooseModelsCache = data
      _gooseModelsCacheAt = Date.now()
      done = true
      res.json(data)
    } catch (e) { fail(`model list parse error: ${e.message}`) }
  })
})

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

// ---------- Education enforcement ----------
// PreToolUse hooks call /check with tool+file info; server runs qualification
// check preventively and returns a pending skill (if any) in one round-trip.
const pendingEducation = new Map()

// Preventive check: hook sends tool+file, server runs qualifications inline
app.get('/api/education/check/:agentId', (req, res) => {
  const agentId = req.params.agentId
  const tool = req.query.tool || ''
  const file = req.query.file || ''

  // Run qualification check with the hook's tool+file info (preventive).
  // Pass the skill param too, so a Skill/Read of a skill is recorded
  // synchronously here — not only via the async daemon activity stream. This
  // closes the race where a sticky block would persist for a beat after the
  // agent actually read the skill.
  const skill = req.query.skill || ''
  const content = req.query.content || ''
  if (tool && _qualRules.length > 0) {
    const input = {}
    if (file) input.file_path = file
    if (skill) input.skill = skill
    if (content) input.content = content
    checkQualifications(agentId, tool, file, input)
  }

  // Return any owed skill(s). The block is STICKY: checkQualifications above
  // recomputes the owed set every call, so a retry of the same action re-blocks
  // until the agent reads the skill or dismisses it. (Clearing the per-call
  // signal here is fine — the next check re-derives it.)
  const entry = pendingEducation.get(agentId)
  if (!entry) return res.json({})
  pendingEducation.delete(agentId)
  res.json(entry)
})

// Legacy endpoints — kept for backward compat during transition
app.post('/api/education/pending', (req, res) => {
  const { agent, skill } = req.body
  if (!agent || !skill) return res.status(400).json({ error: 'Missing agent or skill' })
  pendingEducation.set(agent, { skill, ts: Date.now() })
  console.log(`[education] pending: ${agent} owes ${skill}`)
  res.json({ ok: true })
})

app.get('/api/education/pending/:agentId', (req, res) => {
  const entry = pendingEducation.get(req.params.agentId)
  if (!entry) return res.json({})
  res.json(entry)
})

app.delete('/api/education/pending/:agentId', (req, res) => {
  pendingEducation.delete(req.params.agentId)
  res.json({ ok: true })
})

// Manual dismiss — the one deliberate way past a sticky skill block. The agent
// must give a reason; the dismissal is recorded (so the block lifts) and a card
// is posted so Skip sees the skip and its justification.
app.post('/api/education/dismiss/:agentId', (req, res) => {
  const agentId = req.params.agentId
  const reason = (req.body?.reason || '').trim()
  if (!reason) return res.status(400).json({ error: 'A reason is required to dismiss a skill.' })
  const requested = Array.isArray(req.body?.skills) ? req.body.skills.filter(Boolean) : null

  const owedDetail = _qualAgentOwed.get(agentId)
  const toDismiss = (requested && requested.length)
    ? requested
    : (owedDetail ? [...owedDetail.keys()] : [])
  if (toDismiss.length === 0) return res.json({ ok: true, dismissed: [], note: 'nothing currently owed' })

  let dset = _qualAgentDismissed.get(agentId)
  if (!dset) { dset = new Map(); _qualAgentDismissed.set(agentId, dset) }
  const done = []
  for (const skillName of toDismiss) {
    const detail = owedDetail?.get(skillName) || { scope: 'session', trigger: '', triggerShort: '' }
    dset.set(qualDismissKey(skillName, detail.scope, detail.trigger), {
      skill: skillName, reason, scope: detail.scope, trigger: detail.triggerShort || null, ts: Date.now(),
    })
    owedDetail?.delete(skillName)
    done.push({ skill: skillName, scope: detail.scope, trigger: detail.triggerShort || null })
  }
  pendingEducation.delete(agentId)
  emitSkillDismissCard(agentId, done, reason)
  console.log(`[qualification] ${agentId} DISMISSED ${done.map(d => d.skill).join(', ')} — "${reason}"`)
  res.json({ ok: true, dismissed: done })
})

// Per-agent skill state — read vs owed vs dismissed (with reason). Powers the
// name-hover popover in fleet chat.
app.get('/api/education/skills/:agentId', (req, res) => {
  const agentId = req.params.agentId
  const readsSet = (fleetStore?.getSkillReads?.(agentId)) || _qualAgentReads.get(agentId) || new Set()
  const read = [...readsSet]
    .filter(k => typeof k === 'string' && k.startsWith('skill:'))
    .map(k => k.slice('skill:'.length))
    .sort()
  const owed = [...(_qualAgentOwed.get(agentId) || new Map()).entries()]
    .map(([skill, d]) => ({ skill, scope: d.scope, trigger: d.triggerShort || null }))
  const dismissed = [...(_qualAgentDismissed.get(agentId) || new Map()).values()]
    .map(d => ({ skill: d.skill, reason: d.reason, scope: d.scope, trigger: d.trigger || null }))
  const cards = (fleetStore?.getDrillCards?.(agentId)) || []
  res.json({ id: agentId, read, owed, dismissed, cards })
})

// Store a drill report card for an agent (the "how they performed" half of the
// education record), and post it to the agent's chat so they see their own card.
app.post('/api/education/card/:agentId', async (req, res) => {
  const agentId = req.params.agentId
  const { drill, gradient = null, pass = null, card = {}, chat = null } = req.body || {}
  if (!drill) return res.status(400).json({ error: 'Missing drill in body' })
  if (!fleetStore) return res.status(503).json({ error: 'fleet store unavailable' })
  fleetStore.addDrillCard(agentId, drill, { gradient, pass, card })
  // Post the card to the agent's chat (markdown), the same channel as any message.
  if (chat) {
    try {
      await fleetStore.share({
        type: 'chat', from: 'fleet:teacher', to: agentId, text: chat,
        metadata: { kind: 'drill-card', drill, gradient, pass },
      })
    } catch (e) { console.error('[education] card chat failed:', e.message) }
  }
  console.log(`[education] card: ${agentId} ${drill} → ${gradient}${pass != null ? (pass ? ' PASS' : ' FAIL') : ''}`)
  res.json({ ok: true })
})

// Post a single merged activity card for one or more dismissed skills.
async function emitSkillDismissCard(agentId, dismissed, reason) {
  if (!fleetStore) return
  const agent = fleetStore.getAgent?.(agentId)
  const label = agent?.friendly_name || agentId.slice(0, 12)
  const names = dismissed.map(d => d.skill).join(', ')
  const ctx = dismissed.find(d => d.trigger)?.trigger
  const text = `⊘ dismissed ${names}${ctx ? ` on ${ctx}` : ''} — "${reason}"`
  try {
    await fleetStore.share({
      type: 'activity',
      from: agentId,
      to: agentId,
      text,
      metadata: {
        kind: 'skill-dismiss',
        agentLabel: label,
        skills: dismissed.map(d => d.skill),
        scopes: dismissed.map(d => d.scope),
        trigger: ctx || null,
        reason,
      },
      unread: false,
    })
  } catch (e) {
    console.error(`[qualification] dismiss card failed: ${e.message}`)
  }
}

// ---------- Agent suggestion chips ----------
// Any agent can push its CURRENT set of clickable suggestion chips — actionable
// "you might want to do X" affordances rendered at the bottom of the chat. This
// is a generic fleet capability, not tied to any one agent: a Claude session
// uses the `suggest` MCP tool; a bot (e.g. the Todd example) hits this route
// directly. Replace-semantics PER agent — posting overwrites that agent's set,
// an empty array clears it — so agents never clobber each other. The broadcast
// carries the flattened set across all agents.
const _suggestions = new Map() // agentId → Suggestion[]

function flattenSuggestions() {
  const out = []
  for (const list of _suggestions.values()) out.push(...list)
  return out
}

app.post('/api/suggestions', (req, res) => {
  const { agentId, suggestions } = req.body || {}
  if (!agentId) return res.status(400).json({ error: 'Missing agentId' })
  if (!Array.isArray(suggestions)) return res.status(400).json({ error: 'Missing suggestions array' })
  if (suggestions.length === 0) _suggestions.delete(agentId)
  else _suggestions.set(agentId, suggestions.map(s => ({ ...s, from: agentId })))
  broadcastEvent('suggestions', { suggestions: flattenSuggestions() })
  res.json({ ok: true })
})

app.get('/api/suggestions', (_req, res) => {
  res.json({ suggestions: flattenSuggestions() })
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
function backingRegistryPath() { return join(getProjectsDir(), '..', 'data', 'backing-registry.json') }
// The registry is derived from live room shapes (self-healing): rebuild clears any
// stale entries and repopulates from the notes currently in active rooms, so a
// deleted/gone note can't keep its file-watch alive across a restart. Backed notes
// also re-register on mount, so rooms that load later repopulate themselves.
rebuildBackingFileRegistry().catch(e => console.error('[CRITICAL] backing registry rebuild failed:', e.message))

function backingFileRegister(filePath, docName) {
  if (!backingFileRegistry.has(filePath)) backingFileRegistry.set(filePath, new Set())
  backingFileRegistry.get(filePath).add(docName)
  sendWatchBackingFiles()
  persistBackingRegistry()
}

function backingFileUnregister(filePath, docName) {
  const docNames = backingFileRegistry.get(filePath)
  if (!docNames) return
  if (docName) {
    docNames.delete(docName)
    if (docNames.size > 0) { persistBackingRegistry(); return }
  }
  backingFileRegistry.delete(filePath)
  sendWatchBackingFiles()
  persistBackingRegistry()
}

function sendWatchBackingFiles() {
  if (daemonConnections.size === 0) return
  const files = [...backingFileRegistry.entries()].map(([filePath, docNames]) => ({
    filePath, docNames: [...docNames],
  }))
  for (const [, dws] of daemonConnections) {
    if (dws.readyState !== 1) continue
    try { dws.send(JSON.stringify({ type: 'watch-backing-files', files })) } catch (e) { console.warn(`[server] daemon send failed: ${e.message}`) }
  }
}

function persistBackingRegistry() {
  try {
    const data = [...backingFileRegistry.entries()].map(([filePath, docNames]) => ({
      filePath, docNames: [...docNames],
    }))
    writeFileSync(backingRegistryPath(), JSON.stringify(data, null, 2), 'utf8')
  } catch (e) { console.error(`[CRITICAL] failed to persist backing registry — file watches will be lost on restart: ${e.message}`) }
}

// Rebuild the registry purely from the notes currently in active rooms. Clearing
// first is what makes it self-healing: stale entries (notes since deleted) are
// dropped instead of surviving forever. At boot listActiveRooms() is typically
// empty, so the registry starts clean and fills in as rooms load and backed notes
// re-register on mount.
async function rebuildBackingFileRegistry() {
  backingFileRegistry.clear()
  for (const docName of listActiveRooms()) {
    try {
      const shapes = await getRoomRecords(docName, 'math-note')
      for (const shape of shapes) {
        if (shape.props?.backingFile) {
          if (!backingFileRegistry.has(shape.props.backingFile)) backingFileRegistry.set(shape.props.backingFile, new Set())
          backingFileRegistry.get(shape.props.backingFile).add(docName)
        }
      }
    } catch (e) { console.warn(`[server] failed to scan backing files for ${docName}: ${e.message}`) }
  }
  sendWatchBackingFiles()
  persistBackingRegistry()
}

// POST /api/backing-file-register — client registers a backing file watch
app.post('/api/backing-file-register', requireRead, (req, res) => {
  const { filePath, docName } = req.body || {}
  if (!filePath || !docName) return res.status(400).json({ error: 'Missing filePath or docName' })
  const expanded = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : filePath
  const roomName = docName.startsWith('doc-') ? docName : `doc-${docName}`
  backingFileRegister(expanded, roomName)
  res.json({ ok: true })
})

// POST /api/backing-file-unregister — client drops a backing file watch when its
// note is deleted, so the daemon stops watching a file no note is backed by.
app.post('/api/backing-file-unregister', requireRead, (req, res) => {
  const { filePath, docName } = req.body || {}
  if (!filePath) return res.status(400).json({ error: 'Missing filePath' })
  const expanded = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : filePath
  const roomName = docName ? (docName.startsWith('doc-') ? docName : `doc-${docName}`) : undefined
  backingFileUnregister(expanded, roomName)
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

// ---------- Fleet action HTTP routes ----------
// These mirror WS message handlers so UI buttons (fetch POST) can reach them.

app.post('/api/send-text', requireRead, async (req, res) => {
  const { agent: agentQuery, text, enter } = req.body || {}
  if (!agentQuery) return res.status(400).json({ error: 'Missing agent' })
  if (!fleetStore) return res.status(503).json({ error: 'Fleet not initialized' })
  const agent = fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  if (!agent.tmux_session) return res.status(400).json({ error: 'no tmux session' })
  const route = resolveRpc('send-text', agent)
  if (route.via === 'none') return res.status(503).json({ error: route.error })
  try {
    const result = await sendRpc(route.machine_id, 'send-text', { tmux_session: agent.tmux_session, text, enter: enter !== false })
    res.json(result || { ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/send-key', requireRead, async (req, res) => {
  const { agent: agentQuery, key } = req.body || {}
  if (!agentQuery || !key) return res.status(400).json({ error: 'Missing agent or key' })
  if (!fleetStore) return res.status(503).json({ error: 'Fleet not initialized' })
  const agent = fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  if (!agent.tmux_session) return res.status(400).json({ error: 'no tmux session' })
  const route = resolveRpc('send-key', agent)
  if (route.via === 'none') return res.status(503).json({ error: route.error })
  try {
    const result = await sendRpc(route.machine_id, 'send-key', { tmux_session: agent.tmux_session, key })
    res.json(result || { ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/interrupt', requireRead, async (req, res) => {
  const { agent: agentQuery } = req.body || {}
  if (!agentQuery) return res.status(400).json({ error: 'Missing agent' })
  if (!fleetStore) return res.status(503).json({ error: 'Fleet not initialized' })
  const agent = fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  if (!agent.tmux_session) return res.status(400).json({ error: 'no tmux session' })
  const route = resolveRpc('interrupt', agent)
  if (route.via === 'none') return res.status(503).json({ error: route.error })
  try {
    const result = await sendRpc(route.machine_id, 'interrupt', { agent_id: agent.id, tmux_session: agent.tmux_session })
    // Only emit the interrupt card when the agent actually halted. A soft promote
    // also produces a "[Request interrupted by user]" marker but the agent resumes;
    // `stopped` is what tells a real hard interrupt (card) from a soft one (no card).
    if (result?.stopped) {
      const interruptEvent = { type: 'interrupt', from: SERVER_OWNER_ID, to: agent.id, text: `Interrupted ${agent.friendly_name || agent.id}` }
      await fleetStore.share(interruptEvent)
    }
    broadcastState()
    res.json({ ok: true, agent: agent.friendly_name || agent.id, ...result })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Soft interrupt: promote a queued message above the spinner without stopping
// the agent. The daemon only acts if there's queued content; otherwise it's a
// no-op (we must NOT send an escape that would hard-interrupt). The result
// ({ promoted, reason }) is returned so the client can render a CONFIRMED card —
// no optimistic event is emitted here.
app.post('/api/soft-interrupt', requireRead, async (req, res) => {
  const { agent: agentQuery } = req.body || {}
  if (!agentQuery) return res.status(400).json({ error: 'Missing agent' })
  if (!fleetStore) return res.status(503).json({ error: 'Fleet not initialized' })
  const agent = fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  if (!agent.tmux_session) return res.status(400).json({ error: 'no tmux session' })
  const route = resolveRpc('soft-interrupt', agent)
  if (route.via === 'none') return res.status(503).json({ error: route.error })
  try {
    const result = await sendRpc(route.machine_id, 'soft-interrupt', { agent_id: agent.id, tmux_session: agent.tmux_session })
    res.json({ ok: true, agent: agent.friendly_name || agent.id, ...result })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/kill-session', requireRead, async (req, res) => {
  const { agent: agentQuery } = req.body || {}
  if (!agentQuery) return res.status(400).json({ error: 'Missing agent' })
  if (!fleetStore) return res.status(503).json({ error: 'Fleet not initialized' })
  const agent = fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  if (!agent.tmux_session) return res.status(400).json({ error: 'no tmux session' })
  const route = resolveRpc('kill-session', agent)
  if (route.via === 'none') return res.status(503).json({ error: route.error })
  try {
    const result = await sendRpc(route.machine_id, 'kill-session', { agent_id: agent.id, tmux_session: agent.tmux_session })
    fleetStore.markDead(agent.id)
    const killEvent = { type: 'kill-session', from: SERVER_OWNER_ID, to: agent.id, text: `Killed ${agent.friendly_name || agent.id}` }
    await fleetStore.share(killEvent)
    broadcastState()
    res.json({ ok: true, agent: agent.friendly_name || agent.id, ...result })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/plan-mode-respond', requireRead, async (req, res) => {
  const { agent: agentQuery, response } = req.body || {}
  if (!agentQuery) return res.status(400).json({ error: 'Missing agent' })
  if (!fleetStore) return res.status(503).json({ error: 'Fleet not initialized' })
  const agent = fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  if (!agent.tmux_session) return res.status(400).json({ error: 'no tmux session' })
  if (!['approve', 'supervised', 'reject'].includes(response)) return res.status(400).json({ error: 'response must be approve, supervised, or reject' })
  const rpcType = response === 'reject' ? 'send-key' : 'send-text'
  const route = resolveRpc(rpcType, agent)
  if (route.via === 'none') return res.status(503).json({ error: route.error })
  try {
    let result
    if (response === 'reject') {
      result = await sendRpc(route.machine_id, 'send-key', { tmux_session: agent.tmux_session, key: 'Escape' })
    } else {
      const key = response === 'approve' ? '1' : '2'
      result = await sendRpc(route.machine_id, 'send-text', { tmux_session: agent.tmux_session, text: key, enter: false })
    }
    fleetStore.updateAgentMeta?.(agent.id, { permission_mode: null, inPlanMode: false, planModeType: null })
    const pending = pendingPlanApprovals.get(agent.id)
    if (pending?.eventId) {
      const now = new Date().toISOString()
      const patch = response === 'reject' ? { rejectedAt: now } : { approvedAt: now, mode: response }
      try {
        fleetStore.updateEventMetadata(pending.eventId, patch)
        broadcastEvent('event-update', { id: pending.eventId, metadata_patch: patch })
      } catch (e) { console.warn(`[server] failed to update plan approval event: ${e.message}`) }
      pendingPlanApprovals.delete(agent.id)
    }
    broadcastState()
    res.json(result || { ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/prompt-respond', requireRead, async (req, res) => {
  const { eventId, response } = req.body || {}
  if (!eventId) return res.status(400).json({ error: 'Missing eventId' })
  if (!fleetStore) return res.status(503).json({ error: 'Fleet not initialized' })
  try {
    const patch = response === 'approved' ? { approvedAt: new Date().toISOString() } : { rejectedAt: new Date().toISOString() }
    fleetStore.updateEventMetadata(eventId, patch)
    broadcastEvent('event-update', { id: eventId, metadata_patch: patch })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
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
  // The ensure system (via buildCurrentPage) is the SINGLE staleness authority:
  // its isStale check decides whether to (re)compile the DVI and (re)render the
  // page, and returns the existing artifact untouched when it's fresh. We don't
  // recompute staleness here — a second copy of the rule could disagree with
  // isStale and serve a stale page.
  const livePageMatch = filePath.match(/^([^/]+)-page-(\d+)\.svg$/)
  if (livePageMatch) {
    const texBase = livePageMatch[1]
    const pageNum = parseInt(livePageMatch[2], 10)
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

  // Project-level metadata aliases — bare names (lookup.json, etc.) resolve to
  // the primary target's prefixed file. Shared with the MCP disk reader via
  // shared/doc-assets.mjs so the two resolution paths can't drift.
  if (BARE_METADATA.has(filePath)) {
    const aliased = resolveAsset(PROJECTS_DIR, name, filePath)
    if (aliased) {
      res.set('Cache-Control', 'no-cache')
      return res.sendFile(resolve(aliased), { dotfiles: 'allow' })
    }
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
            } catch (e) { console.warn(`[server] TOC/chapter title parsing failed for ${name}: ${e.message}`) }
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
  sendRpc, resolveRpc, daemonConnections, resolveSpawnTarget,
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

// ---------- HTTP(S) + WebSocket server ----------

const TLS_CERT = join(homedir(), '.config/tlda/localhost+2.pem')
const TLS_KEY  = join(homedir(), '.config/tlda/localhost+2-key.pem')
const useTls = existsSync(TLS_CERT) && existsSync(TLS_KEY)
const server = useTls
  ? createHttpsServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, app)
  : createServer(app)

const syncWss = new WebSocketServer({ noServer: true })
const fleetWss = new WebSocketServer({ noServer: true })
const daemonWss = new WebSocketServer({ noServer: true })
const terminalWss = new WebSocketServer({ noServer: true })
const voiceWss = new WebSocketServer({ noServer: true })

// Per-agent set of browser WebSockets watching that agent's terminal.
// When the first watcher attaches we send `start-terminal-watch` to the
// daemon; when the last one drops we send `stop-terminal-watch`. State
// is server-held so the daemon can resume cleanly after a reconnect.
const terminalWatchers = new Map() // agentId -> Set<ws>
// Last-known tmux window size per agent, reported by the daemon. The viewer
// renders its peek grid at this width so the live stream doesn't garble; cached
// so a late-joining watcher (the daemon won't re-send on a duplicate watch) can
// be told the size on connect.
const terminalSizes = new Map() // agentId -> { cols, rows }

function fanOutTerminalSize(agentId, cols, rows) {
  terminalSizes.set(agentId, { cols, rows })
  const set = terminalWatchers.get(agentId)
  if (!set) return
  const payload = JSON.stringify({ type: 'size', cols, rows })
  for (const w of set) {
    if (w.readyState === 1) { try { w.send(payload) } catch {} }
  }
}

function fanOutTerminalData(agentId, base64Data) {
  const set = terminalWatchers.get(agentId)
  if (!set) return
  const payload = JSON.stringify({ type: 'output', data: base64Data, encoding: 'base64' })
  for (const w of set) {
    if (w.readyState === 1) { try { w.send(payload) } catch {} }
  }
}

function fanOutTerminalDead(agentId) {
  const set = terminalWatchers.get(agentId)
  if (!set) return
  const payload = JSON.stringify({ type: 'error', message: 'session ended' })
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
      ws.addEventListener('close', (ev) => {
        if (ev.code === 4099) {
          console.error(`[sync] Client rejected from "${docName}" session=${sessionId}: code=4099 reason="${ev.reason}"`)
          console.error(`[sync] Check server logs above for SCHEMA VALIDATION FAILED details.`)
        }
      })
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
          const res = await sendRpc(agent.machine_id, 'start-terminal-watch', {
            agent_id: agent.id, tmux_session: agent.tmux_session, poll_ms: 500,
          })
          if (res && res.cols && res.rows) terminalSizes.set(agent.id, { cols: res.cols, rows: res.rows })
        } catch (e) {
          try { ws.send(JSON.stringify({ type: 'error', message: e.message })) } catch {}
        }
      }

      // Tell the viewer the agent's real tmux window size BEFORE seeding content,
      // so the peek grid is created at the right width and the seed doesn't wrap.
      const cachedSize = terminalSizes.get(agent.id)
      if (cachedSize && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'size', cols: cachedSize.cols, rows: cachedSize.rows })) } catch {}
      }

      // Seed with current terminal content so the card isn't blank on open.
      // The live attach stream only repaints on a fresh attach (and the daemon
      // skips the repaint if a watch already exists), so without this seed an
      // idle awake agent shows nothing. capture-pane takes `lines` and returns
      // the screen as `pane` (see rpcCapturePane in fleet-daemon.mjs).
      try {
        const { pane } = await sendRpc(agent.machine_id, 'capture-pane', {
          tmux_session: agent.tmux_session, lines: 80,
        })
        if (pane && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'output', data: Buffer.from(pane).toString('base64'), encoding: 'base64' }))
        }
      } catch (e) {
        console.warn(`[terminal] seed capture failed for ${agent.id} (${agent.tmux_session}): ${e.message}`)
      }

      ws.on('message', async (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg.type === 'input' && typeof msg.data === 'string') {
          try {
            await sendRpc(agent.machine_id, 'terminal-input', {
              tmux_session: agent.tmux_session, data: msg.data,
            })
          } catch (e) {
            try { ws.send(JSON.stringify({ type: 'error', message: e.message })) } catch {}
          }
        } else if (msg.type === 'resize' && msg.cols && msg.rows) {
          try {
            await sendRpc(agent.machine_id, 'terminal-resize', {
              tmux_session: agent.tmux_session, cols: msg.cols, rows: msg.rows,
            })
          } catch {}
        }
      })

      const cleanup = async () => {
        const set = terminalWatchers.get(agent.id)
        if (!set) return
        set.delete(ws)
        if (set.size === 0) {
          terminalWatchers.delete(agent.id)
          terminalSizes.delete(agent.id)
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
    const remotePort = req.socket.remotePort
    daemonWss.handleUpgrade(req, socket, head, (ws) => {
      ws._bootId = null
      ws._machineId = null
      ws._remoteAddr = remoteAddr  // captured so reaper can route kill RPC by chromium's source IP
      trackWs(ws, {
        kind: 'daemon',
        sessionId: `daemon-${Date.now().toString(36)}`,
        remoteAddr,
        remotePort,
      })
      ws.on('message', async (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        try { await handleDaemonWsMessage(ws, msg) }
        catch (e) { console.error('[daemon-ws] handler error:', e?.message) }
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
          // Full roster incl. dead. Panel filters dead client-side, but the
          // client needs dead agents present to chat them + show "resurrect?".
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

  // /voice/deepgram — same-origin relay to the local deepgram bridge. A device
  // that can't reach 127.0.0.1:8179 (the iPad, where localhost is the iPad
  // itself) connects here over the TLS the page is already authenticated on; we
  // pipe frames to/from the bridge. This keeps the iPad off iOS Web Speech,
  // whose restart earcon is the source of the constant beeping. The browser
  // sends binary PCM + text control messages and receives transcript JSON, so
  // the binary/text framing is preserved in both directions.
  if (url.pathname === '/voice/deepgram') {
    voiceWss.handleUpgrade(req, socket, head, async (browserWs) => {
      const WS = (await import('ws')).default
      let upstream = null
      let closed = false
      const pending = []

      const closeBoth = () => {
        if (closed) return
        closed = true
        try { browserWs.close() } catch {}
        try { upstream?.close() } catch {}
      }

      browserWs.on('message', (data, isBinary) => {
        if (upstream && upstream.readyState === WS.OPEN) {
          try { upstream.send(data, { binary: isBinary }) } catch {}
        } else {
          pending.push({ data, isBinary })
        }
      })
      browserWs.on('close', closeBoth)
      browserWs.on('error', closeBoth)

      const ready = await ensureDeepgramBridge()
      if (closed) return
      if (!ready) {
        try { browserWs.send(JSON.stringify({ type: 'status', status: 'error', error: 'bridge unavailable' })) } catch {}
        closeBoth()
        return
      }

      upstream = new WS(DEEPGRAM_BRIDGE_URL, { rejectUnauthorized: false })
      upstream.on('open', () => {
        for (const { data, isBinary } of pending) {
          try { upstream.send(data, { binary: isBinary }) } catch {}
        }
        pending.length = 0
      })
      upstream.on('message', (data, isBinary) => {
        if (browserWs.readyState === 1) {
          try { browserWs.send(data, { binary: isBinary }) } catch {}
        }
      })
      upstream.on('close', closeBoth)
      upstream.on('error', (err) => {
        console.warn('[voice-proxy] upstream error:', err.message)
        closeBoth()
      })
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

  // ---- Timer countdown widget (timer-set / timer-fire / timer-cancel) ----
  // Bridges the `timer` event the viewer renders as a live ticking bubble. Used
  // by both the MCP timer() tool and a bot's action countdowns — same wire
  // format, so bots speak the same language as real agents. timer-set stores +
  // broadcasts a pending timer; timer-fire/cancel patches it to a terminal state.
  if (type === 'timer-set') {
    const { agent, message, fire_at, to: toAgent } = msg
    const from = (agent && fleetStore.findAgent?.(agent)?.id) || agent || SERVER_OWNER_ID
    // Address the countdown to the conversation it belongs to (e.g. the agent
    // being handed off). A chat panel only renders events whose from/to matches
    // its target agent, so a countdown hardcoded to the owner never appears in
    // the panel the user triggered it from. Falls back to the owner.
    const to = (toAgent && fleetStore.findAgent?.(toAgent)?.id) || toAgent || SERVER_OWNER_ID
    const metadata = { pending: true, fire_at, message }
    const event = await fleetStore.share({ type: 'timer', from, to, text: `⏱ ${message}`, metadata })
    broadcastEvent('fleet-event', { type: 'timer', from, to, id: event.id, event_id: event.id, text: `⏱ ${message}`, metadata })
    reply({ ok: true, id: event.id })
    return
  }
  if (type === 'timer-fire' || type === 'timer-cancel') {
    const eventId = msg.event_id
    const state = type === 'timer-cancel' ? 'cancelled' : 'fired'
    if (eventId != null) {
      // Persist the terminal state; the live event-update below is what the
      // viewer actually reacts to, so a persist failure is logged, not fatal.
      try { fleetStore.updateEventMetadata?.(eventId, { pending: false, state }) }
      catch (e) { console.warn(`[timer] persist ${state} for event ${eventId} failed: ${e.message}`) }
      broadcastEvent('event-update', { id: eventId, metadata_patch: { pending: false, state } })
    }
    reply({ ok: true })
    return
  }

  if (type === 'register') {
    // Prefer agent_id over id: the MCP's sendWS() stamps a correlation `id`
    // onto every message, so the real fleet id arrives as agent_id. Falling
    // back to id keeps python fleet-spawn's ws_register (which sends id=fleet_id
    // directly, no correlation) working. Reading the bare `id` here was the
    // root cause of phantom UUID-keyed agent rows.
    const { agent_id, id: msgId, name, tmux_session, cwd, labels, manager, session_id, metadata, machine_id } = msg
    const agentId = agent_id || msgId
    if (!agentId) { error('missing id'); return }
    // Remember which agent owns this WS so we can clean up their tlda-feedback
    // subscriptions on close.
    ws._tldaAgentId = agentId
    const now = new Date().toISOString()
    const existing = fleetStore.getAgent?.(agentId)
    // The friendly name is set once (first registration) and is thereafter owned
    // by rename/rotation. Re-registration must NOT clobber it with the spawn name
    // — that would undo a lineage rotation. The terminal/window name lives in
    // tmux_session, independent of the friendly name. So only the *first* name
    // is taken from `name`; once set, it's preserved.
    const willSetName = !existing?.friendly_name && name
    if (willSetName) {
      const cols = fleetStore.checkNameAvailable([name], { excludeId: agentId, asFriendlyName: true })
      if (cols.length) {
        error(`Name "${name}" unavailable: ${cols.map(c => c.kind === 'pseudo_label' ? 'reserved routing label' : `collides with ${c.kind} on ${c.agent_id}`).join('; ')}`)
        return
      }
    }
    const agent = {
      id: agentId,
      friendly_name: existing?.friendly_name || name || null,
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
      metadata: metadata || existing?.metadata || null,
      machine_id: machine_id || existing?.machine_id || null,
    }
    if (session_id && !agent.session_ids.includes(session_id)) {
      agent.session_ids = [...(agent.session_ids || []), session_id].slice(-10)
    }
    try {
      fleetStore.upsertAgent(agent)
    } catch (e) {
      if (e.message?.includes('already taken')) {
        error(e.message)
        return
      }
      throw e
    }
    fleetStore.share?.({ type: 'register', agent_id: agentId, from: agentId, to: agentId, text: `${name || agentId} registered` })
    // Every non-human agent belongs to a lineage from birth, as its own `dawn`
    // (the worker). This guarantees a handoff always has a chain to rotate within
    // — a direct handoff promotes that dawn → day (manager). The lineage is an
    // overlay, so a failure here must never block registration.
    if (!agent.human && agent.friendly_name) {
      const stored = fleetStore.getAgent?.(agentId)
      if (stored && !stored.lineage_id) {
        try {
          // The name IS the lineage assignment: a "<base>:<phase>" name says which
          // lineage and which phase. Map straight onto the <base> lineage — don't
          // build a fresh lineage from the full suffixed name. A bare name → its
          // own lineage at dawn, exactly as before.
          const base = baseName(agent.friendly_name)
          const phase = phaseFromName(agent.friendly_name) || 'dawn'
          const lineage = fleetStore.getOrCreateLineage(base)
          fleetStore.assignPhase(agentId, lineage.id, phase)
        } catch (e) { console.error(`[lineage] auto-assign failed for ${agentId}: ${e.message}`) }
      }
    }
    // Registration implies a live claude process — mark alive immediately so
    // the agent shows "awake" right away. The daemon's next sweep confirms
    // or evicts within 30s.
    if (!agent.human) {
      _aliveAgents.add(agentId)
      touchActivity(agentId)
    }
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

  // Full roster INCLUDING dead agents — history tooling (get_thread,
  // search_logs) must keep dead agents addressable by name.
  if (type === 'store-agents-all') {
    reply(fleetStore.getAllAgents())
    return
  }

  if (type === 'store-tasks') {
    const active = msg.active !== false
    reply(active ? fleetStore.getActiveTasks() : fleetStore.getAllTasks?.() || [])
    return
  }

  // ---- jsonl-index: daemon pushes JSONL text entries for unified search ----
  if (type === 'jsonl-index') {
    try { fleetStore.insertSessionEntries(msg.entries || []) } catch (e) { console.error(`[jsonl-index] Failed to index ${(msg.entries || []).length} entries — search gaps possible:`, e.message); error(e.message); return }
    reply({ ok: true })
    return
  }

  // ---- fleet-search: unified search across fleet events + session JSONL text ----
  if (type === 'fleet-search') {
    try {
      // Support lineage search: agents[] (array of fleet IDs to union)
      let searchAgent = msg.agents?.length ? msg.agents : msg.agent;
      // A typed name fragment (agent:/from:) resolves on the SERVER to the set of
      // fleet ids it refers to — substring over current + historical names,
      // dawn-aware. An empty match yields an impossible id (an empty result set),
      // NOT an unfiltered search.
      if (msg.agentQuery) {
        const ids = fleetStore.resolveAgentQuery(msg.agentQuery);
        searchAgent = ids.length ? ids : [' __no_match__'];
      }
      const hasText = (msg.query || '').trim().length > 0;
      const results = stampNames(fleetStore.searchAll(msg.query || '', {
        limit: msg.limit, agent: searchAgent, role: msg.role, since: msg.since, before: msg.before,
        // No keyword + an agent filter → return that agent's whole history
        // instead of FTS-matching the literal query text.
        agentOnly: msg.agentOnly ?? (!hasText && !!searchAgent),
        fromOnly: msg.fromOnly,
      }))
      const context = {}
      if (msg.context_timestamps?.length) {
        for (const ts of msg.context_timestamps) {
          const ctx = fleetStore.getChatContext(ts, msg.context_window || 3)
          stampNames(ctx.before); stampNames(ctx.after)
          context[ts] = ctx
        }
      }
      reply({ results, context })
    } catch (e) { error(e.message) }
    return
  }

  // Interacting with a hibernating (non-dead, no live process) agent wakes
  // Idempotent waker: chat/delegate adds agent IDs to a Set.
  // A serial loop drains it — one spawn at a time, naturally deduped.
  const _wakeQueue = new Set()
  let _wakeDraining = false
  // Per-agent throttle so a repeatedly-failing wake doesn't spam Skip's chat.
  const _wakeFailWarned = new Map() // agentId → last-warned ms
  const WAKE_FAIL_WARN_MS = 5 * 60 * 1000
  function requestWake(agentId) {
    const agent = fleetStore.getAgent?.(agentId)
    if (!agent || agent.dead || agent.human) return
    _wakeQueue.add(agentId)
    if (!_wakeDraining) drainWakeQueue()
  }

  async function drainWakeQueue() {
    _wakeDraining = true
    while (_wakeQueue.size > 0) {
      const agentId = _wakeQueue.values().next().value
      _wakeQueue.delete(agentId)
      const agent = fleetStore.getAgent?.(agentId)
      if (!agent || agent.dead || agent.human) continue
      const machineIds = [...daemonConnections.keys()]
      if (machineIds.length === 0) continue
      try {
        const { alive } = await sendRpc(machineIds[0], 'check-alive', { tmux_session: agent.tmux_session })
          .catch(() => ({ alive: false }))
        if (alive) continue
        console.log(`[respawn] waking ${agent.friendly_name || agentId} (${agentId})`)
        await sendRpc(machineIds[0], 'spawn', { name: agent.friendly_name || agentId, respawn: true })
        const wakeTs = new Date().toISOString()
        fleetStore.db.prepare(
          'INSERT INTO events (type, timestamp, from_id, to_id, text, metadata) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('lifecycle', wakeTs, agentId, agentId, 'agent woken', null)
      } catch (e) {
        console.warn(`[respawn] failed for ${agentId}: ${e.message}`)
        // Surface the failure to Skip instead of failing silently (throttled
        // per-agent so a stuck wake doesn't spam chat).
        const _now = Date.now()
        if (!_wakeFailWarned.has(agentId) || _now - _wakeFailWarned.get(agentId) > WAKE_FAIL_WARN_MS) {
          _wakeFailWarned.set(agentId, _now)
          try {
            deliverTldaFeedbackChat({
              from: 'fleet:tlda',
              to: SERVER_OWNER_ID,
              text: `⚠️ Couldn't wake **${agent.friendly_name || agentId}** — ${e.message}`,
              metadata: { type: 'wake_failed', agentId },
            })
          } catch (notifyErr) {
            console.warn(`[respawn] could not surface wake failure for ${agentId}: ${notifyErr.message}`)
          }
        }
      }
    }
    _wakeDraining = false
  }

  if (type === 'amend') {
    // Amend = a NEW event of type 'amend' that REFERENCES the original chat
    // event (metadata.amends = <original id>). The original row is NEVER
    // mutated — fully immutable, an accountability trail. The client folds
    // amend events into their original message and renders the version (V{n})
    // stepper. Each version (original + each amend) carries its OWN
    // metadata.source, so the file-section provenance chip reflects whichever
    // version is being viewed (a string-form amend has no source → no chip).
    const { from: rawFrom, event_id, message: text, inline_attachments, source } = msg
    if (!text) { error('missing message'); return }
    const resolveSingle = (id) => {
      if (id === SERVER_OWNER_NAME) return SERVER_OWNER_ID
      const a = fleetStore?.findAgent(id); return a ? a.id : null
    }
    const from = rawFrom ? (resolveSingle(rawFrom) || rawFrom) : null
    if (!from) { reply({ ok: false, error: 'missing from' }); return }
    let target
    if (event_id != null) {
      target = fleetStore.getEventById(Number(event_id))
      if (!target) { reply({ ok: false, error: `no message with id ${event_id}` }); return }
      // getEventById aliases the sender column to `from` (not `from_id`).
      if (target.from !== from) { reply({ ok: false, error: `message ${event_id} was not sent by you` }); return }
    } else {
      target = fleetStore.getLatestChatFrom?.(from)
      if (!target) { reply({ ok: false, error: 'you have no message to amend' }); return }
    }
    // All amends chain off the ORIGINAL chat event. If the target is itself an
    // amend (agent passed an amend id), follow its reference to the original.
    const origId = (target.type === 'amend' && target.metadata?.amends) ? target.metadata.amends : target.id
    const orig = origId === target.id ? target : fleetStore.getEventById(Number(origId))
    if (!orig || orig.type !== 'chat') { reply({ ok: false, error: `cannot resolve original message for ${target.id}` }); return }

    const ts = new Date().toISOString()
    const meta = {
      amends: orig.id,
      ...(source ? { source } : {}),
      ...(inline_attachments ? { inline_attachments } : {}),
    }
    const result = fleetStore.db.prepare(
      'INSERT INTO events (type, timestamp, from_id, to_id, text, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('amend', ts, from, orig.to, text, JSON.stringify(meta))
    const amendId = Number(result.lastInsertRowid)
    reply({ ok: true, event_id: orig.id, amend_id: amendId })
    // Broadcast the amend event; the client folds it into the original message.
    broadcastEvent('fleet-event', {
      id: amendId,
      type: 'amend',
      timestamp: ts,
      from_id: from,
      to_id: orig.to,
      text,
      metadata: meta,
    })
    return
  }

  if (type === 'chat') {
    const { message: text, to: rawTo, from: rawFrom, metadata, inline_attachments, attachments, cc, context, preambleRef, source } = msg
    if (!rawTo || !text) { error('missing to or message'); return }
    // Idempotency: if the client retries with the same _tempId, return the
    // previously inserted event IDs instead of creating duplicates.
    if (msg._tempId && _chatTempIds.has(msg._tempId)) {
      const prev = _chatTempIds.get(msg._tempId)
      reply({ ok: true, event_ids: prev.eventIds, recipients: prev.recipients, _tempId: msg._tempId })
      return
    }
    const resolveSingle = (id) => {
      if (id === SERVER_OWNER_NAME) return SERVER_OWNER_ID
      const a = fleetStore?.findAgent(id); return a ? a.id : null
    }
    const from = rawFrom ? (resolveSingle(rawFrom) || rawFrom) : null
    // Normalize `to` to DNF: a single string becomes [[string]] (a singleton DNF).
    const dnf = Array.isArray(rawTo) ? rawTo : [[rawTo]]
    // Resolve DNF over agents, NEVER delivering to dead ones. A dead agent
    // isn't running and can't act on a message; delivering to it also
    // double-fans a filter when a dead twin shares a live agent's name (e.g.
    // an old `preread` row + the live `preread`) → the sender sees their
    // message twice. To reach a dead agent, resurrect it first (it goes live,
    // then matches here). No "prefer the live one" — dead is simply excluded.
    const allAgents = fleetStore.getAllAgents?.() || []
    const recipients = []
    for (const a of allAgents) {
      if (a.id === from) continue
      if (a.dead) continue
      // labelsForAgent (shared with the client filters) covers pseudo-labels,
      // friendly_name, id, and lineage tags. getAllAgents() hydrates
      // lineage_name + status, so no per-agent lineage lookup is needed here.
      if (evalDnf(dnf, labelsForAgent(a))) {
        recipients.push(a.id)
      }
    }
    // Server-owner pseudo-recipient: matched by literal id/name only, no label index.
    if (dnf.some(andGroup => andGroup.length === 1 && (andGroup[0] === SERVER_OWNER_ID || andGroup[0] === SERVER_OWNER_NAME))) {
      if (!recipients.includes(SERVER_OWNER_ID)) recipients.push(SERVER_OWNER_ID)
    }
    if (recipients.length === 0) { error(`No recipients matched: ${JSON.stringify(rawTo)}`); return }
    // Update sender heartbeat + activity tracking
    if (from) {
      fleetStore.updateHeartbeat?.(from)
      touchActivity(from)
    }
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
    const fromLabels = labelsForAgent(fleetStore.findAgent(from) || { id: from })
    const ts = new Date().toISOString()
    const eventIds = []
    const insertedEvents = []
    for (const to of recipients) {
      // Resolve wiretaps per recipient — tap labels are matched against this `to`.
      const toLabels = labelsForAgent(fleetStore.findAgent(to) || { id: to })
      const wiretapRecipients = []
      for (const tap of taps) {
        if (!tap.filter) continue
        if (tap.types && tap.types.length > 0 && !tap.types.includes('chat')) continue
        let matches = false
        try {
          const f = typeof tap.filter === 'string' ? JSON.parse(tap.filter) : tap.filter
          matches = f.some(clause =>
            clause.every(([role, label]) => {
              if (role === 'from') return fromLabels.includes(label)
              if (role === 'to') return toLabels.includes(label)
              return false
            })
          )
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
        ...(preambleRef ? { preambleRef } : {}),
        ...(chatReminder ? { chatReminder } : {}),
        ...(source ? { source } : {}),
      }
      const metaStr = Object.keys(combinedMetadata).length ? JSON.stringify(combinedMetadata) : null
      const result = fleetStore.db.prepare(
        'INSERT INTO events (type, timestamp, from_id, to_id, text, metadata) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('chat', ts, from, to, text, metaStr)
      const eventId = Number(result.lastInsertRowid)
      fleetStore.db.prepare('INSERT OR IGNORE INTO unread (event_id, to_id, read) VALUES (?, ?, 0)').run(eventId, to)
      eventIds.push(eventId)
      // Echo _tempId on the broadcast so a client whose WS reply was lost during
      // a hiccup can still bind this echo to its orphaned optimistic entry
      // (the reply, not the DB row, is what normally carries _tempId).
      insertedEvents.push({ id: eventId, type: 'chat', timestamp: ts, from_id: from, to_id: to, text, metadata: Object.keys(combinedMetadata).length ? combinedMetadata : null, ...(msg._tempId ? { _tempId: msg._tempId } : {}) })
    }
    // Cache _tempId for idempotent retries
    if (msg._tempId) _chatTempIds.set(msg._tempId, { eventIds, recipients, ts: Date.now() })
    // Reply FIRST so the client can reconcile optimistic events before broadcasts arrive.
    reply({ ok: true, event_ids: eventIds, recipients, _tempId: msg._tempId || null })
    for (const ev of insertedEvents) broadcastEvent('fleet-event', ev)
    for (const to of recipients) requestWake(to)

    // Plan mode approval routing: if Skip sends an affirmative/negative and
    // there's a pending plan approval for the targeted agent (or any agent),
    // route the keystroke to the agent's tmux pane.
    if (from === SERVER_OWNER_ID && pendingPlanApprovals.size > 0) {
      const key = matchApprovalResponse(text)
      if (key) {
        let approval = null
        for (const r of recipients) {
          if (pendingPlanApprovals.has(r)) { approval = pendingPlanApprovals.get(r); pendingPlanApprovals.delete(r); break }
        }
        if (!approval && pendingPlanApprovals.size === 1) {
          const [aid, a] = [...pendingPlanApprovals.entries()][0]
          approval = a; pendingPlanApprovals.delete(aid)
        }
        if (approval?.tmux_session && approval?.machine_id) {
          sendRpc(approval.machine_id, 'send-text', {
            tmux_session: approval.tmux_session,
            text: key,
            enter: false,
          }).catch(e => console.error(`[plan-approval] keystroke failed: ${e.message}`))
        }
      }
    }
    // "let's outline/plan" keyword: force plan mode on recipient agents
    const planKeywordMatch = from === SERVER_OWNER_ID && text.match(/\blet'?s\s+(\w+\s+){0,2}(outline|plan)\b/i)
    if (planKeywordMatch) {
      const keyword = planKeywordMatch[2].toLowerCase()
      for (const r of recipients) {
        const agent = fleetStore.findAgent(r)
        if (!agent?.tmux_session || !agent.machine_id) continue
        sendRpc(agent.machine_id, 'send-text', {
          tmux_session: agent.tmux_session,
          text: '/plan',
          enter: true,
        }).catch(e => console.error(`[outline-keyword] plan mode failed for ${r}: ${e.message}`))
        if (keyword === 'outline') {
          setTimeout(() => {
            sendRpc(agent.machine_id, 'send-text', {
              tmux_session: agent.tmux_session,
              text: 'Invoke the outline-before-writing skill now. Write your outline in the plan file, then share the plan file path in chat so it appears as a tappable note.',
              enter: true,
            }).catch(e => console.error(`[outline-keyword] skill nudge failed for ${r}: ${e.message}`))
          }, 2000)
        }
        fleetStore.updateAgentMeta?.(agent.id, { inPlanMode: true, planModeType: keyword })
        console.log(`[outline-keyword] forced plan mode on ${agent.friendly_name || r} (keyword: ${keyword})`)
      }
      broadcastState()
    }
    return
  }

  if (type === 'heartbeat') {
    const { agent } = msg
    if (agent) fleetStore.updateHeartbeat?.(agent)
    reply({ ok: true })
    return
  }

  if (type === 'viewing') {
    const { agent, context } = msg
    if (agent && context) _viewingContext.set(agent, { ...context, updatedAt: Date.now() })
    reply({ ok: true })
    return
  }

  if (type === 'load-history') {
    const limit = Math.min(parseInt(msg.limit || '50'), 1000)
    const before = msg.before || null
    const agents = Array.isArray(msg.agents) ? msg.agents : []
    try {
      let events = fleetStore.queryChatHistory({ before, agents, limit: limit + 1 })
        .map(e => ({ ...e, event_type: e.type, from: e.from, to: e.to, agent: e.agent_id }))
      const hasMore = events.length > limit
      if (hasMore) events.shift()
      events = events.filter(e => {
        const t = e.text || ''
        return !t.startsWith('<channel') && !t.startsWith('<task-notification') && !t.startsWith('<system-reminder')
      })
      const agentMap = { ...fleetStore.getAgentNameMap() }
      agentMap['web'] = agentMap[SERVER_OWNER_ID] || SERVER_OWNER_NAME
      const unreadIds = new Set()
      const _evIds = events.map(e => e.id).filter(id => id != null)
      if (_evIds.length) {
        const _ph = _evIds.map(() => '?').join(',')
        try {
          const rows = fleetStore.db.prepare(`SELECT event_id FROM unread WHERE read = 0 AND event_id IN (${_ph})`).all(..._evIds)
          for (const r of rows) unreadIds.add(r.event_id)
        } catch (e) { console.error('[fleet] unread query failed:', e.message) }
      }
      const resolved = events.map(e => ({
        ...e,
        read: !unreadIds.has(e.id),
        fromLabel: agentMap[e.from] || (e.from ? e.from.substring(0, 8) : ''),
        toLabel: agentMap[e.to] || agentMap[e.agent] || (e.to ? e.to.substring(0, 8) : ''),
      }))
      // Period-correct names: render each historical message with the name its
      // sender/recipient held AT send time, plus `*NameNow` when since rotated.
      // The client nick prefers these over the current-name fallback.
      stampNames(resolved)
      reply({ events: resolved, hasMore })
    } catch (e) {
      error(e.message)
    }
    return
  }

  if (type === 'delegate') {
    const { agent: agentQuery, description, message: taskMsg, success_criteria, blocked_by, from, requires_approval } = msg
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
      metadata: requires_approval ? { requires_approval: true } : undefined,
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
    requestWake(resolved.id)
    return
  }

  if (type === 'task-done') {
    const { agent: rawAgent, task_id, skip_qa, approval_id } = msg
    if (!rawAgent) { error('missing agent'); return }
    const agent = fleetStore.findAgent?.(rawAgent)?.id || rawAgent
    const task = task_id
      ? fleetStore.getTask?.(task_id)
      : fleetStore.getTaskByAgent?.(agent)
    if (!task) { error('no active task'); return }
    if (task.metadata?.requires_approval) {
      if (!approval_id) { error('This task requires approval. Pass approval_id (event ID of a human approval message).'); return }
      const evt = fleetStore.getEventById(approval_id)
      if (!evt) { error(`approval_id ${approval_id} not found`); return }
      const fromAgent = (evt.from_id || evt.from) ? fleetStore.getAgent(evt.from_id || evt.from) : null
      if (!fromAgent?.human) { error(`approval_id ${approval_id} is not from a human`); return }
    }
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
      if (agentData.friendly_name) {
        const cols = fleetStore.checkNameAvailable([agentData.friendly_name], { excludeId: agentData.id, asFriendlyName: true })
        if (cols.length) {
          error(`Name "${agentData.friendly_name}" unavailable: ${cols.map(c => c.kind === 'pseudo_label' ? 'reserved routing label' : `collides with ${c.kind} on ${c.agent_id}`).join('; ')}`)
          return
        }
      }
      try {
        fleetStore.upsertAgent(agentData)
      } catch (e) {
        if (e.message?.includes('already taken')) { error(e.message); return }
        throw e
      }
      broadcastState()
    }
    reply({ ok: true })
    return
  }

  if (type === 'agent-thinking') {
    if (msg.thinking) {
      _thinkingState.set(msg.agentId, Date.now())
      touchActivity(msg.agentId)
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

  // ---- lineage-assign: assign an agent to a lineage with a phase ----
  if (type === 'lineage-assign') {
    const { agent: agentQuery, phase, lineage: lineageQuery } = msg
    if (!agentQuery || !phase) { error('agent and phase required'); return }
    if (!PHASES.includes(phase)) { error(`phase must be one of: ${PHASES.join(', ')}`); return }
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const lineageName = lineageQuery || agent.friendly_name || agentQuery
    const lineage = fleetStore.getOrCreateLineage(lineageName)
    // Free the slot (age occupants one rung toward night, oldest retires)
    // instead of erroring on "occupied" — "free the names you need, then place."
    fleetStore.makeRoomForPhase(lineage.id, phase)
    fleetStore.assignPhase(agent.id, lineage.id, phase)
    broadcastState()
    reply({ ok: true, agent: agent.id, lineage: lineage.id, lineage_name: lineage.friendly_name, phase })
    return
  }

  // ---- lineage-retire: remove an agent from its lineage ----
  if (type === 'lineage-retire') {
    const { agent: agentQuery } = msg
    if (!agentQuery) { error('agent required'); return }
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.lineage_id) { error('agent is not in a lineage'); return }
    // Re-aim pending tasks to the new day
    const lineage = fleetStore.getLineage(agent.lineage_id)
    const dayAgent = fleetStore.getLineageDay(agent.lineage_id)
    if (dayAgent && dayAgent.id !== agent.id) {
      const pendingTasks = fleetStore.db.prepare(
        "SELECT id FROM tasks WHERE agent = ? AND status NOT IN ('done')"
      ).all(agent.id)
      for (const t of pendingTasks) {
        fleetStore.db.prepare('UPDATE tasks SET agent = ? WHERE id = ?').run(dayAgent.id, t.id)
      }
    }
    fleetStore.retireFromLineage(agent.id)
    broadcastState()
    reply({ ok: true, agent: agent.id, retired_from: lineage?.friendly_name || agent.lineage_id })
    return
  }

  // ---- lineage-transition: change an agent's phase within its lineage ----
  if (type === 'lineage-transition') {
    const { agent: agentQuery, phase } = msg
    if (!agentQuery || !phase) { error('agent and phase required'); return }
    if (!PHASES.includes(phase)) { error(`phase must be one of: ${PHASES.join(', ')}`); return }
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.lineage_id) { error('agent is not in a lineage'); return }
    // Free the target slot (age occupants one rung toward night, oldest retires)
    // instead of erroring. Handoffs only move an agent DOWN the chain (dawn→day/
    // dusk), so the moving agent sits above the target and isn't caught in the
    // cascade.
    fleetStore.makeRoomForPhase(agent.lineage_id, phase)
    fleetStore.transitionPhase(agent.id, phase)
    broadcastState()
    reply({ ok: true, agent: agent.id, phase })
    return
  }

  // ---- lineage-make-room: free a phase slot (age occupants toward night) ----
  // "Free the names you need, then place." Used by a handoff to reserve a slot
  // (e.g. :day for the briefer) before the new agent arrives.
  if (type === 'lineage-make-room') {
    const { phase, lineage: lineageQuery, agent: agentQuery } = msg
    if (!phase) { error('phase required'); return }
    if (!PHASES.includes(phase)) { error(`phase must be one of: ${PHASES.join(', ')}`); return }
    let lineage = lineageQuery ? fleetStore.getLineage(lineageQuery) : null
    if (!lineage && agentQuery) {
      const a = fleetStore.findAgent(agentQuery)
      if (a?.lineage_id) lineage = fleetStore.getLineage(a.lineage_id)
    }
    if (!lineage) { error('lineage not found'); return }
    fleetStore.makeRoomForPhase(lineage.id, phase)
    broadcastState()
    reply({ ok: true, lineage: lineage.id, phase })
    return
  }

  // ---- lineage-rotate: rotate an agent in at `dawn` ----
  // incoming → dawn (worker), dawn → day (manager), day → dusk (consultant),
  // dusk → loses its name and drops out of the slots (stays in the lineage as
  // history). Nothing is marked dead or unlinked. Direct handoff = one rotate;
  // briefing handoff = two (briefer in, then the new worker in).
  if (type === 'lineage-rotate') {
    const { agent: agentQuery, lineage: lineageQuery } = msg
    if (!agentQuery) { error('agent required'); return }
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const lineageName = lineageQuery || agent.friendly_name || agentQuery
    const lineage = fleetStore.getOrCreateLineage(lineageName)
    fleetStore.rotateLineageIn(lineage.id, agent.id)
    broadcastState()
    reply({ ok: true, agent: agent.id, lineage: lineage.id, lineage_name: lineage.friendly_name, phase: 'dawn' })
    return
  }

  // ---- lineage-roster: get the current roster for a lineage ----
  if (type === 'lineage-roster') {
    const { lineage: lineageQuery } = msg
    if (!lineageQuery) { error('lineage required'); return }
    const lineage = fleetStore.getLineage(lineageQuery)
    if (!lineage) { error('lineage not found'); return }
    const roster = fleetStore.getLineageRoster(lineage.id)
    const history = fleetStore.getLineageHistory(lineage.id)
    reply({ lineage, roster, history })
    return
  }

  // ---- label ----
  if (type === 'label') {
    const { agent: agentQuery, labels } = msg
    if (!agentQuery || !Array.isArray(labels)) { error('agent and labels[] required'); return }
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const cols = fleetStore.checkNameAvailable(labels, { excludeId: agent.id, asFriendlyName: false })
    if (cols.length) {
      const list = cols.map(c => c.kind === 'pseudo_label' ? `"${c.name}" is a reserved routing label` : `"${c.name}" is ${c.agent_id}'s friendly_name`).join('; ')
      error(`Label collision: ${list}. Pick a different label or rename the other agent first.`)
      return
    }
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
      await fleetStore.share(killEvent)
      broadcastState()
      reply({ ok: true, agent: agent.friendly_name || agent.id, ...result })
    } catch (e) { error(e.message) }
    return
  }

  // ---- hibernate-session ----
  if (type === 'hibernate-session') {
    const { agent: agentQuery } = msg
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.tmux_session) { error('no tmux session'); return }
    const route = resolveRpc('kill-session', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendRpc(route.machine_id, 'kill-session', { agent_id: agent.id, tmux_session: agent.tmux_session })
      clearEphemeralState(agent.id)
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
    const { name, model, doc, agent, respawn, effort } = msg
    let spawnName = name
    if (respawn && agent) {
      const a = fleetStore.findAgent(agent)
      spawnName = a?.friendly_name || agent
    }
    // Resolve-or-reject: validate args before anything else so an unresolvable
    // one fails loud here instead of silently producing a dead agent.
    const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
    if (effort && !EFFORT_LEVELS.includes(effort)) {
      error(`Unknown effort '${effort}' — valid: ${EFFORT_LEVELS.join(', ')}`); return
    }
    if (doc) {
      const known = listProjects().map(p => p.name)
      if (!known.includes(doc)) {
        error(`no project '${doc}'${known.length ? ` — known: ${known.sort().join(', ')}` : ''}`); return
      }
    }
    const machineIds = [...daemonConnections.keys()]
    if (machineIds.length === 0) { error('No fleet daemon connected — cannot spawn agents'); return }
    try {
      const resolved = await resolveSpawnTarget(spawnName, !!respawn)
      const result = await sendRpc(machineIds[0], 'spawn', {
        name: resolved.name || undefined, model: model || undefined,
        doc: doc || undefined, respawn: resolved.respawn, effort: effort || undefined,
      })
      broadcastState()
      if (result && result.ok === false) { error(result.error || 'spawn failed'); return }
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
    if (!['approve', 'supervised', 'reject'].includes(response)) { error('response must be approve, supervised, or reject'); return }
    const route = resolveRpc('send-text', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const key = response === 'approve' ? '1' : response === 'supervised' ? '2' : '3'
      let result = await sendRpc(route.machine_id, 'send-text', { tmux_session: agent.tmux_session, text: key, enter: false })
      fleetStore.updateAgentMeta?.(agent.id, { permission_mode: null, inPlanMode: false, planModeType: null })
      // Persist response on the plan_approval event
      const pending = pendingPlanApprovals.get(agent.id)
      if (pending?.eventId) {
        const now = new Date().toISOString()
        const patch = response === 'reject' ? { rejectedAt: now } : { approvedAt: now, mode: response }
        try {
          fleetStore.updateEventMetadata(pending.eventId, patch)
          broadcastEvent('event-update', { id: pending.eventId, metadata_patch: patch })
        } catch {}
        pendingPlanApprovals.delete(agent.id)
      }
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
  // Field is `tap_id`, NOT `id`: sendWS() stamps a correlation `id` onto every
  // RPC message, which would clobber a payload `id` (same reason task_id /
  // agent_id are used elsewhere).
  if (type === 'wiretap-remove') {
    const { tap_id: tapId } = msg
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
    const { limit: rawLimit = 50, before, agents } = msg
    const limit = Math.min(parseInt(rawLimit) || 50, 1000)
    try {
      let events = []
      const fleetEvents = fleetStore.queryChatHistory?.({ before, agents: Array.isArray(agents) ? agents : [], limit: limit + 1 }) || []
      events = fleetEvents.map(e => ({ ...e, event_type: e.type, from: e.from, to: e.to, agent: e.agent_id }))
      const hasMore = events.length > limit
      if (hasMore) events.shift()
      events = events.filter(e => { const t = e.text || ''; return !t.startsWith('<channel') && !t.startsWith('<task-notification') && !t.startsWith('<system-reminder') })
      const agentMap = fleetStore.getAgentNameMap()
      const unreadIds = new Set()
      const _evIds = events.map(e => e.id).filter(id => id != null)
      if (_evIds.length) {
        const _ph = _evIds.map(() => '?').join(',')
        try { const rows = fleetStore.db.prepare(`SELECT event_id FROM unread WHERE read = 0 AND event_id IN (${_ph})`).all(..._evIds); for (const r of rows) unreadIds.add(r.event_id) } catch (e) { console.error('[fleet] unread query failed:', e.message) }
      }
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
        // UNION of two indexed scans (see FleetStore.queryAgentEvents) — far
        // faster than `(from_id=? OR to_id=?)`. No COUNT: callers detect
        // overflow by fetching limit+1 and paginating forward.
        events = fleetStore.queryAgentEvents({ agent: evtAgent, types: evtTypes, sinceTs, untilTs, afterId, beforeId, limit })
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
      reply({ events: stampNames(events), lastId, total })
    } catch (e) { error(e.message) }
    return
  }

  // Unknown message type — don't error, just ignore (forward compatibility)
  if (id) reply({ ok: false, error: `unknown type: ${type}` })
}

// ---------- Skill qualification checking (server-side) ----------
//
// Rules live in ~/.claude/qualifications.json. Two rule types:
//   { "edit": "*.tex", "requires": ["writing-core"] }         — file extension trigger
//   { "tool": "playwright/*", "requires": ["testing-apps"] }  — tool call trigger
//
// Checked both reactively (daemon activity events) and preventively
// (PreToolUse hook calls /api/education/check with tool+file info).
// When an agent hasn't read a required skill, posts to pendingEducation
// which the hook returns as a blocking response.

// TLDA_QUALIFICATIONS_FILE overrides the default path — used by integration
// tests to exercise new rules without touching the live ~/.claude config.
const QUALIFICATIONS_FILE = process.env.TLDA_QUALIFICATIONS_FILE || path.join(os.homedir(), '.claude', 'qualifications.json')
let _qualRules = []
const _qualAgentReads = new Map()     // agentId → Set of skill keys + file paths
const _qualAgentDismissed = new Map() // agentId → Map<dismissKey, {skill, reason, scope, trigger, ts}> (dismissKey = skillName | skillName@filepath)
const _qualAgentOwed = new Map()      // agentId → Map<skillName, {scope, trigger, triggerShort}> — latest context per owed skill, for dismiss lookup

// Dismiss scope: dispositional skills (the `*` rule) and tool-triggered skills
// are session-scoped (one dismissal sticks for the session). Edit-specific
// skills are file-scoped (re-prompt on the next file).
function qualDismissKey(skillName, scope, trigger) {
  return scope === 'file' ? `${skillName}@${trigger}` : skillName
}

function loadQualifications() {
  try {
    if (!fs.existsSync(QUALIFICATIONS_FILE)) return
    const data = JSON.parse(fs.readFileSync(QUALIFICATIONS_FILE, 'utf8'))
    _qualRules = (data.rules || []).map(r => {
      const rule = { requires: r.requires || [] }
      if (r.edit) {
        rule.type = 'edit'
        rule.pattern = r.edit
        rule.re = qualGlobToRegex(r.edit)
      } else if (r.tool) {
        rule.type = 'tool'
        rule.pattern = r.tool
        rule.re = qualGlobToRegex(r.tool)
      }
      if (r.condition) rule.condition = r.condition
      return rule
    }).filter(r => r.type)
    console.log(`[qualification] loaded ${_qualRules.length} rules`)
  } catch (e) {
    console.error(`[qualification] failed to load: ${e.message}`)
  }
}

function qualGlobToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '[^/]')
  const withAlts = escaped.replace(/\\\{([^}]+)\\\}/g, (_, inner) =>
    '(' + inner.split(',').join('|') + ')')
  return new RegExp('^' + withAlts + '$')
}

function qualTrackRead(agentId, key) {
  if (!key) return
  if (!_qualAgentReads.has(agentId)) _qualAgentReads.set(agentId, new Set())
  _qualAgentReads.get(agentId).add(key)
  if (key.startsWith('skill:')) {
    // Reading the skill clears it from the owed set — the block lifts.
    const owed = _qualAgentOwed.get(agentId)
    if (owed) owed.delete(key.slice('skill:'.length))
    if (fleetStore) { try { fleetStore.addSkillRead(agentId, key) } catch {} }
  }
}

function qualLoadReadsFromDb() {
  if (!fleetStore) return
  try {
    const agents = fleetStore.getAllAgents()
    for (const agent of agents) {
      const reads = fleetStore.getSkillReads(agent.id)
      if (reads.size > 0) _qualAgentReads.set(agent.id, reads)
    }
  } catch {}
}

let _latexProjectDirs = null
let _latexProjectDirsAt = 0

function getLatexProjectDirs() {
  const now = Date.now()
  if (_latexProjectDirs && now - _latexProjectDirsAt < 30000) return _latexProjectDirs
  try {
    const projects = listProjects()
    _latexProjectDirs = projects
      .filter(p => p.format === 'svg' && p.sourceDir)
      .map(p => p.sourceDir.endsWith('/') ? p.sourceDir : p.sourceDir + '/')
    _latexProjectDirsAt = now
  } catch { _latexProjectDirs = [] }
  return _latexProjectDirs
}

function isInLatexProject(filePath) {
  const dirs = getLatexProjectDirs()
  return dirs.some(d => filePath.startsWith(d))
}

// "Math-heavy" chat detection for the content-conditioned `chat` gate. We want
// to catch a message that leans on rendered math — a display equation, or
// several inline bits — while NOT firing on prose that mentions a lone `$x$` or
// a dollar amount. Conservative on purpose: the gate blocks AGENTS (not Skip),
// and the recourse is trivial (read the skill once, dismiss, or drop the math),
// so a missed catch is cheaper than a false block.
function isMathHeavy(text) {
  if (!text || typeof text !== 'string') return false
  const hasDisplay =
    /\$\$[\s\S]+?\$\$/.test(text) ||            // $$ … $$
    /\\\[[\s\S]+?\\\]/.test(text) ||            // \[ … \]
    /\\begin\{(?:equation|align|gather|multline|eqnarray)\*?\}/.test(text)
  if (hasDisplay) return true
  // Count inline $…$ after removing any $$ display blocks so they aren't
  // double-counted. Require ≥2 so a single inline term doesn't trip it.
  const noDisplay = text.replace(/\$\$[\s\S]+?\$\$/g, '')
  const inline = noDisplay.match(/\$[^$\n]+?\$/g) || []
  return inline.length >= 2
}

// Evaluate a tool-rule `condition`. Returns true when the rule applies.
function qualToolConditionMet(condition, input) {
  if (condition === 'math-heavy') return isMathHeavy(input?.content)
  // Unknown condition → don't apply the rule (fail safe: never gate on a
  // condition the server doesn't understand).
  return false
}

function checkQualifications(agentId, tool, arg, input) {
  if (_qualRules.length === 0 || !fleetStore) return

  const reads = _qualAgentReads.get(agentId) || new Set()
  const dismissed = _qualAgentDismissed.get(agentId) || new Map()

  const matchingRules = []

  if ((tool === 'Read' || tool === 'Skill') && input) {
    if (tool === 'Read') {
      const fp = input.file_path || input.path || arg || ''
      if (fp) {
        qualTrackRead(agentId, fp)
        const skillMatch = fp.match(/[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/)
        if (skillMatch) qualTrackRead(agentId, 'skill:' + skillMatch[1])
      }
    }
    if (tool === 'Skill') {
      const skill = input.skill || ''
      if (skill) qualTrackRead(agentId, 'skill:' + skill)
    }
    return
  }

  if (tool === 'Edit' || tool === 'Write') {
    const fp = input?.file_path || input?.path || arg || ''
    if (!fp) return
    const basename = fp.split('/').pop()
    const inLatex = isInLatexProject(fp)
    for (const rule of _qualRules) {
      if (rule.type !== 'edit') continue
      if (rule.condition === 'latex-project' && !inLatex) continue
      if (rule.re.test(basename) || rule.re.test(fp)) {
        matchingRules.push({ rule, trigger: fp, triggerShort: basename })
      }
    }
  }

  // Normalize MCP tool names to the rule format. The hook sends raw CC names
  // (`mcp__tlda__report`); the daemon activity stream sends the already-
  // normalized `tlda/report`. Tool rules are written in the `namespace/tool`
  // form, so collapse the raw form to match either source.
  const toolNorm = tool && tool.startsWith('mcp__') ? tool.slice(5).replace(/__/g, '/') : tool
  for (const rule of _qualRules) {
    if (rule.type !== 'tool') continue
    // Content-conditioned tool rules (e.g. gate `chat` only when the message is
    // math-heavy). A condition that isn't met means the rule doesn't apply.
    if (rule.condition && !qualToolConditionMet(rule.condition, input)) continue
    if (rule.re.test(toolNorm)) {
      matchingRules.push({ rule, trigger: toolNorm, triggerShort: toolNorm })
    }
  }

  // Owed = required-by-a-matching-rule, not yet read, not dismissed. Computed
  // fresh every call (no warn-once suppression) so the block is STICKY: it
  // re-fires on every retry of the same action until the agent reads the skill
  // or explicitly dismisses it via dismiss_skill.
  const owedNow = []
  let owedDetail = _qualAgentOwed.get(agentId)
  for (const { rule, trigger, triggerShort } of matchingRules) {
    const scope = (rule.type === 'tool' || rule.pattern === '*') ? 'session' : 'file'
    for (const skillName of rule.requires) {
      if (reads.has('skill:' + skillName)) continue
      if (dismissed.has(qualDismissKey(skillName, scope, trigger))) continue
      if (!owedDetail) { owedDetail = new Map(); _qualAgentOwed.set(agentId, owedDetail) }
      if (!owedDetail.has(skillName)) {
        console.log(`[qualification] ${agentId} owes ${skillName} (triggered by ${triggerShort})`)
      }
      owedDetail.set(skillName, { scope, trigger, triggerShort })
      owedNow.push(skillName)
    }
  }
  if (owedNow.length > 0) {
    const skills = [...new Set(owedNow)]
    pendingEducation.set(agentId, { skill: skills[0], skills, ts: Date.now() })
  }
}

loadQualifications()
qualLoadReadsFromDb()
fs.watchFile(QUALIFICATIONS_FILE, { interval: 5000 }, () => {
  console.log('[qualification] reloading rules')
  loadQualifications()
})

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
        extraInputCommands: p.extraInputCommands || null,
      }
    })
}

function broadcastDaemonAgentsUpdated() {
  if (!fleetStore || daemonConnections.size === 0) {
    if (!fleetStore) console.warn('[fleet-daemon] broadcastDaemonAgentsUpdated: no fleetStore')
    return
  }
  for (const [mid, dws] of daemonConnections) {
    if (dws.readyState !== 1) {
      console.warn(`[fleet-daemon] broadcastDaemonAgentsUpdated: ws for ${mid} not open (readyState=${dws.readyState})`)
      continue
    }
    try {
      const agents = fleetStore.getAgentsByMachine(mid)
      dws.send(JSON.stringify({ type: 'agents-updated', agents }))
    } catch (e) {
      console.error(`[fleet-daemon] broadcastDaemonAgentsUpdated failed for ${mid}: ${e.message}`)
    }
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

function broadcastDaemonActiveViewers() {
  if (daemonConnections.size === 0) return
  const viewers = [...getActiveViewerProjects()]
  for (const [, dws] of daemonConnections) {
    if (dws.readyState !== 1) continue
    try { dws.send(JSON.stringify({ type: 'active-viewers', projects: viewers })) } catch {}
  }
}

/**
 * If the shadow repo HEAD is not a "Build at" commit (i.e. an agent committed
 * directly to the shadow repo since the last build), copy the changed files to
 * the server source directory and trigger a rebuild so Skip sees the changes.
 */
async function checkShadowAhead(projectName) {
  const project = readProject(projectName)
  if (!project || project.format !== 'svg') return

  const shadowDir = join(getProjectsDir(), projectName, 'shadow-repo')
  if (!existsSync(shadowDir)) return

  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileP = promisify(execFile)

    const { stdout: headLog } = await execFileP('git', ['log', '-1', '--format=%H %s'], { cwd: shadowDir })
    const trimmed = headLog.trim()
    if (!trimmed) return
    const spaceIdx = trimmed.indexOf(' ')
    const headHash = trimmed.slice(0, spaceIdx)
    const headMsg = trimmed.slice(spaceIdx + 1)

    if (headMsg.startsWith('Build at ')) return  // shadow is in sync with last build

    // Find most recent "Build at" commit
    const { stdout: buildLog } = await execFileP('git', ['log', '--format=%H %s', '--grep=^Build at '], { cwd: shadowDir })
    const firstBuildLine = buildLog.trim().split('\n')[0]
    if (!firstBuildLine) return
    const lastBuildHash = firstBuildLine.split(' ')[0]

    // Files changed in shadow since last build
    const { stdout: diffOut } = await execFileP('git', ['diff', '--name-only', lastBuildHash, 'HEAD'], { cwd: shadowDir })
    const changedFiles = diffOut.trim().split('\n').filter(Boolean)
    if (changedFiles.length === 0) return

    // Copy changed files from shadow HEAD into server source
    const srcDir = join(getProjectsDir(), projectName, 'source')
    for (const rel of changedFiles) {
      const shadowFile = join(shadowDir, rel)
      if (!existsSync(shadowFile)) continue
      const destFile = join(srcDir, rel)
      mkdirSync(path.dirname(destFile), { recursive: true })
      fs.copyFileSync(shadowFile, destFile)
    }

    console.log(`[shadow-ahead] ${projectName}: ${changedFiles.length} file(s) from agent commit(s) since ${lastBuildHash.slice(0, 7)}, triggering build`)
    runBuild(projectName).catch(e => console.warn(`[shadow-ahead] build failed for ${projectName}: ${e.message}`))
  } catch (e) {
    console.warn(`[shadow-ahead] ${projectName}: check failed: ${e.message}`)
  }
}

// Sync the doc-version sentinel in the Yjs room with the shadow repo's latest
// "Build at" commit. Called on daemon-hello so the sentinel is always current
// even after a forced server restart that didn't persist the Yjs snapshot.
async function syncSentinelFromShadow(projectName) {
  const project = readProject(projectName)
  if (!project || project.format !== 'svg') return

  const shadowDir = join(getProjectsDir(), projectName, 'shadow-repo')
  if (!existsSync(shadowDir)) return

  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileP = promisify(execFile)

    const { stdout } = await execFileP('git', ['log', '--format=%H %ai %s', '--grep=^Build at ', '-1'], { cwd: shadowDir })
    const line = stdout.trim()
    if (!line) return
    const parts = line.split(' ')
    const latestBuildHash = parts[0]
    const latestBuildAt = new Date(parts[1] + ' ' + parts[2]).getTime() || Date.now()

    const docName = `doc-${projectName}`
    const room = await getOrCreateRoom(docName)
    const current = room.getRecord?.('shape:doc-version--sentinel')
    const currentHash = current?.props?.commitHash

    if (currentHash === latestBuildHash) return  // already current

    console.log(`[sentinel-sync] ${projectName}: updating ${currentHash?.slice(0, 7) || 'none'} → ${latestBuildHash.slice(0, 7)}`)
    await putShape(docName, {
      id: 'shape:doc-version--sentinel',
      typeName: 'shape',
      type: 'doc-version',
      x: 0, y: 0, rotation: 0, index: 'a0',
      parentId: 'page:page',
      isLocked: true, opacity: 0, meta: {},
      props: { w: 1, h: 1, commitHash: latestBuildHash, timestamp: Date.now(), buildReadyAt: latestBuildAt },
    })
  } catch (e) {
    console.warn(`[sentinel-sync] ${projectName}: failed: ${e.message}`)
  }
}

// Set (or clear, with syncError=null) the mirror/shadow sync-failure state on a
// doc's version sentinel. Convergent Yjs state, so the SyncErrorPill shows it on
// every connected viewer and it survives reconnect until a successful sync clears
// it. Merges into the sentinel so build state (commitHash, errorsJson) is kept.
async function setSentinelSyncError(projectName, syncError) {
  const docName = `doc-${projectName}`
  const json = syncError ? JSON.stringify(syncError) : ''
  try {
    await updateShape(docName, 'shape:doc-version--sentinel', (cur) => ({
      ...cur,
      props: { ...cur.props, syncErrorJson: json },
    }))
  } catch (e) {
    // No sentinel yet = the doc has never built; there's nothing to annotate and
    // no viewer reading it. Skip quietly; any other failure is worth logging.
    if (!/not found/i.test(e?.message || '')) {
      console.warn(`[sync-error] ${projectName}: failed to update sentinel: ${e.message}`)
    }
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

async function handleDaemonWsMessage(ws, msg) {
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
    // Reset the activity-feed uptime clock: this (re)connect starts a fresh
    // continuous window. getWouldHibernate won't hibernate agents on this machine
    // until the feed has been up a full idle window, so a flap can't cause a
    // stale-_lastActivityAt false hibernate.
    _daemonConnectedSince.set(machine_id, Date.now())
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
          }).catch(e => console.warn(`[server] terminal-watch resume failed for ${a.id}: ${e.message}`))
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
        activeViewers: [...getActiveViewerProjects()],
      }))
    } catch (e) {
      console.error(`[fleet-daemon] welcome send failed: ${e.message}`)
    }
    // Send persisted backing file watch list to daemon.
    sendWatchBackingFiles()

    // Check each project's shadow repo for agent commits that haven't been built yet.
    // This catches the case where an agent committed directly to the shadow repo
    // (bypassing the push API) and no build was triggered.
    // Also sync the Yjs sentinel from the shadow repo's latest build — this corrects
    // stale sentinels left by forced server restarts that didn't flush Yjs to disk.
    for (const p of listProjects()) {
      if (p.format === 'svg' && p.sourceDir) {
        checkShadowAhead(p.name)
        syncSentinelFromShadow(p.name).catch(e => console.warn(`[sentinel-sync] ${p.name}: ${e.message}`))
      }
    }
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
        if (incoming.has(a.id)) {
          _aliveAgents.add(a.id)
        } else {
          _aliveAgents.delete(a.id)
          clearEphemeralState(a.id)
        }
      }
      broadcastState()
    }
    return
  }

  if (type === 'agent-session-observed') {
    // The daemon observed an alive agent's true live Claude session (from the
    // PID-keyed ~/.claude/sessions file) and it wasn't the registered primary.
    // Persist it: make it the primary session_id and merge into session_ids so
    // JSONL→agent attribution self-heals and survives restarts. This is the
    // automated form of the manual re-map that fixes dead activity cards.
    const { agent_id, session_id, cwd } = msg
    if (!fleetStore || !agent_id || !session_id) return
    const agent = fleetStore.getAgent(agent_id)
    if (!agent) return
    const ids = Array.isArray(agent.session_ids) ? [...agent.session_ids] : []
    const alreadyListed = ids.includes(session_id)
    if (!alreadyListed) ids.push(session_id)
    if (agent.session_id === session_id && alreadyListed) return // already current
    agent.session_id = session_id
    agent.session_ids = ids
    if (cwd && !agent.cwd) agent.cwd = cwd
    fleetStore.upsertAgent(agent)
    console.log(`[fleet-daemon] reconciled session for ${agent_id}: primary=${session_id} (${ids.length} known)`)
    broadcastDaemonAgentsUpdated()
    return
  }

  if (type === 'activity-event') {
    if (!fleetStore) return
    const { agent_id, tool, arg, input, ts, usage, prettyResult, origTool } = msg
    if (!agent_id) return
    touchActivity(agent_id)
    if (tool === '_usage') return // usage stats don't need DB storage
    try {
      await fleetStore.share({
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
    checkQualifications(agent_id, tool, arg, input)
    return
  }

  if (type === 'qualification-warning') {
    // Legacy: daemon still sends these but server now handles qualification
    // checking directly via activity-event. Ignore.
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
      await fleetStore.share({
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

  if (type === 'terminal-size') {
    if (msg.agent_id && msg.cols && msg.rows) fanOutTerminalSize(msg.agent_id, msg.cols, msg.rows)
    return
  }

  if (type === 'terminal-data') {
    if (msg.agent_id && msg.data) fanOutTerminalData(msg.agent_id, msg.data)
    return
  }

  if (type === 'terminal-dead') {
    if (msg.agent_id) fanOutTerminalDead(msg.agent_id)
    return
  }

  if (type === 'agent-context') {
    if (msg.agentId != null && msg.contextPercent != null) {
      _contextState.set(msg.agentId, { percent: msg.contextPercent, inputTokens: msg.inputTokens || 0 })
      broadcastEvent('agent-context', { agent: msg.agentId, percent: msg.contextPercent, inputTokens: msg.inputTokens || 0 })
    }
    return
  }

  if (type === 'reaper-status') {
    _lastReaperStatus = msg.data || msg
    broadcastEvent('reaper-status', _lastReaperStatus)
    return
  }

  if (type === 'plan-mode-prompt') {
    if (!fleetStore) return
    const { agent_id, plan_text, tmux_session } = msg
    if (!agent_id || !plan_text) return
    try {
      const agent = fleetStore.findAgent(agent_id)
      const machine_id = agent?.machine_id
      const event = await fleetStore.share({
        type: 'plan_approval',
        from: agent_id,
        to: SERVER_OWNER_ID,
        text: plan_text,
        metadata: { tmux_session: tmux_session || null, machine_id },
        unread: true,
        timestamp: new Date().toISOString(),
      })
      pendingPlanApprovals.set(agent_id, {
        tmux_session: tmux_session || agent?.tmux_session,
        machine_id,
        eventId: event?.id,
      })
      const existing = fleetStore.getAgent(agent_id)
      const planModeType = existing?.metadata?.planModeType || 'plan'
      fleetStore.updateAgentMeta?.(agent_id, { inPlanMode: true, planModeType })
      broadcastState()
    } catch (e) {
      console.error(`[fleet-daemon] plan-mode-prompt write: ${e.message}`)
    }
    return
  }

  if (type === 'terminal_attention') {
    if (!fleetStore) return
    const { agent_id, text, tmux_session, reason, snippet } = msg
    if (!agent_id) return
    const dedupKey = `${agent_id}:${reason || text}`
    const now = Date.now()
    if (!globalThis._termAttentionDedup) globalThis._termAttentionDedup = new Map()
    const lastTs = globalThis._termAttentionDedup.get(dedupKey)
    if (lastTs && now - lastTs < 30_000) return
    globalThis._termAttentionDedup.set(dedupKey, now)
    const agent = fleetStore.getAgent(agent_id)
    const label = agent?.friendly_name || agent_id.slice(0, 12)
    const event = await fleetStore.share({
      type: 'terminal_attention',
      from: agent_id,
      to: SERVER_OWNER_ID,
      text: text || `${label}: needs attention`,
      metadata: { agentId: agent_id, agentLabel: label, tmux_session: tmux_session || null, reason: reason || null, snippet: snippet || null },
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
        metadata: { agentId: agent_id, agentLabel: label, reason: reason || null, snippet: snippet || null },
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

  if (type === 'agent-thinking') {
    if (msg.agentId) {
      if (msg.thinking) {
        _thinkingState.set(msg.agentId, Date.now())
        touchActivity(msg.agentId)
      } else {
        _thinkingState.delete(msg.agentId)
      }
      broadcastEvent('agent-thinking', { agent: msg.agentId, thinking: !!msg.thinking })
    }
    return
  }

  if (type === 'agent-compacting') {
    if (msg.agentId) {
      if (msg.compacting) {
        _compactingState.set(msg.agentId, Date.now())
      } else {
        _compactingState.delete(msg.agentId)
      }
      broadcastEvent('agent-compacting', { agent: msg.agentId, compacting: !!msg.compacting })
    }
    return
  }

  if (type === 'source-change') {
    const { project, files, deletedFiles, editedBy } = msg
    if (!project) return
    // Hand off to the same pipeline used by HTTP /api/projects/:name/push.
    processProjectPush(project, { files, deletedFiles, editedBy }).then(result => {
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
    console.log(`[backing] file-content-changed: ${filePath}, registry size=${backingFileRegistry.size}, docNames=${docNames ? [...docNames].join(',') : 'NONE'}`)
    if (!docNames || docNames.size === 0) return
    for (const docName of docNames) {
      console.log(`[backing] broadcasting signal:file-updated to room ${docName}`)
      broadcastSignal(docName, 'signal:file-updated', { filePath, content: content ?? '' })
    }
    return
  }

  if (type === 'daemon-warning') {
    const { project, message, severity } = msg
    const baseText = project ? `⚠️ daemon sync error on **${project}**: ${message}` : `⚠️ daemon warning: ${message}`
    const now = Date.now()
    const metadata = { type: 'daemon_warning', docName: project, severity: severity || 'warning' }

    // Recipients: the server owner ALWAYS, plus any non-human agent currently
    // editing this project (cwd under its sourceDir). A sync/mirror failure has
    // to reach the affected agent too, not just Skip — otherwise it's silent
    // for the one who's about to lose work.
    const recipients = new Set([SERVER_OWNER_ID])
    if (project && fleetStore) {
      try {
        const sd = readProject(project)?.sourceDir
        if (sd) {
          // getAliveAgents() is ordered last_seen DESC, so the first cwd match is
          // the most-recently-active agent in that working copy = the one most
          // likely editing it. Alert that one, not every alive agent sharing the
          // cwd (a busy project can have a dozen, and flooding them all is its
          // own kind of silent — the signal drowns).
          for (const a of fleetStore.getAliveAgents()) {
            if (a.human || !a.cwd) continue
            if (a.cwd === sd || a.cwd.startsWith(sd + '/')) { recipients.add(a.id); break }
          }
        }
      } catch (e) {
        console.warn(`[daemon-warning] editing-agent lookup failed for ${project}: ${e.message}`)
        // Fall through to owner delivery — best-effort enrichment must never
        // silence the alert it's trying to enrich.
      }
    }

    // Critical, project-scoped warnings (mirror/shadow sync failure, divergence)
    // also raise the per-doc visual indicator via the version sentinel — the
    // enlarged sibling of the build-error badge.
    if (project && (severity || 'warning') === 'critical') {
      setSentinelSyncError(project, [{ message }])
    }

    // Per-(project, recipient) dedup so the ×N counter is correct for each.
    for (const to of recipients) {
      const key = `${project || ''}|${to}`
      const existing = _daemonWarnDedup.get(key)
      if (existing && (now - existing.lastSeen) < DAEMON_WARN_DEDUP_MS) {
        existing.count++
        existing.lastSeen = now
        const updatedText = `${existing.baseText} (×${existing.count})`
        fleetStore?.updateEventText(existing.eventId, updatedText)
        broadcastEvent('event-update', { id: existing.eventId, text: updatedText })
      } else {
        const event = fleetStore?.share?.({ type: 'chat', from: 'fleet:tlda', to, text: baseText, metadata })
        if (event) {
          fleetStore?.addUnread?.(event.id, to)
          broadcastEvent('fleet-event', { type: 'chat', from: 'fleet:tlda', to, id: event.id, text: baseText, event_id: event.id })
          _daemonWarnDedup.set(key, { eventId: event.id, count: 1, lastSeen: now, baseText })
        }
      }
    }
    return
  }

  if (type === 'daemon-sync-ok') {
    // The daemon reports a clean shadow sync — clear the per-doc sync-failure
    // indicator. (No chat: success is not news; it just lowers the alarm.)
    const { project } = msg
    if (project) {
      setSentinelSyncError(project, null)
      _daemonWarnDedup.delete(`${project}|${SERVER_OWNER_ID}`)
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
  const proto = useTls ? 'https' : 'http'
  console.log(`Unified server running on ${proto}://${HOST}:${PORT}`)
  if (useTls) console.log(`  TLS: ${TLS_CERT}`)
  console.log(`  Projects: ${PROJECTS_DIR}`)
  if (existsSync(distDir)) {
    console.log(`  Viewer SPA: ${distDir}`)
  } else {
    console.log(`  Viewer SPA: not built (run: npm run build)`)
  }

  // An isolated dev/test server (TLDA_DEV_SERVER=1) never runs the fleet
  // supervisors or the hibernate loop — it exists only to load schemas + serve
  // a throwaway doc, and must not touch the live fleet.
  if (process.env.TLDA_DEV_SERVER === '1') {
    console.log('[dev-server] isolated mode — daemon/bot supervisors and hibernate loop disabled')
  } else {
  // Start the local-daemon supervisor. Run an immediate check (so the daemon
  // is up shortly after server start) and then poll on an interval. The
  // daemon's own pidfile + connection-state checks gate actual respawn so
  // we don't burst-spawn while a daemon is starting.
  console.log(`[daemon-supervisor] watching for local daemon (machine_id=${LOCAL_MACHINE_ID})`)
  ensureLocalDaemon()
  setInterval(ensureLocalDaemon, DAEMON_SUPERVISOR_INTERVAL_MS).unref()

  // Keep the configured bots alive too — same cadence as the daemon supervisor.
  console.log(`[bot-supervisor] watching ${getManagedBots().map(b => b.name).join(', ') || '(none)'}`)
  ensureManagedBots()
  setInterval(ensureManagedBots, DAEMON_SUPERVISOR_INTERVAL_MS).unref()

  const HIBERNATE_CHECK_MS = 60_000
  setInterval(async () => {
    if (!fleetStore) return
    const wouldHib = getWouldHibernate()
    for (const agentId of Object.keys(wouldHib)) {
      const agent = fleetStore.getAgent(agentId)
      if (!agent || !agent.tmux_session) continue
      const route = resolveRpc('kill-session', agent)
      if (route.via === 'none') continue
      console.log(`[hibernate] auto-hibernating ${agent.friendly_name || agent.id} (idle ${wouldHib[agentId]}s)`)
      try {
        await sendRpc(route.machine_id, 'kill-session', { agent_id: agent.id, tmux_session: agent.tmux_session })
        clearEphemeralState(agent.id)
      } catch (e) {
        console.error(`[hibernate] failed to hibernate ${agent.friendly_name || agent.id}: ${e.message}`)
      }
    }
    broadcastState()
  }, HIBERNATE_CHECK_MS).unref()
  }
})
