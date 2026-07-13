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

import './lib/observability/otel-node.mjs'
import express from 'express'
import { createServer } from 'http'
import { createServer as createHttpsServer } from 'https'
import { createSecureContext } from 'tls'
import { WebSocketServer } from 'ws'
import { spawn, spawn as cpSpawn } from 'child_process'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
// Runtime guard: warn on execSync in server process (tmux commands still use it)
// TODO: migrate tmux commands to async exec, then ban execSync entirely
import path from 'path'
const { basename, dirname, join, resolve } = path
import { fileURLToPath } from 'url'
import fs from 'fs'
const { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, openSync, statSync } = fs
import os from 'os'
const { homedir, hostname } = os
import { randomUUID } from 'crypto'
import { lookup as mimeLookup } from 'mime-types'
import { DEFAULT_PORT, getActiveConfigName, getFleetServerUrl, hasTls, loadConfig, resolveConfig } from '../shared/config.mjs'
import { normalizeUsageStatus } from '../shared/usage-status.mjs'
import { BARE_METADATA, resolveAsset } from '../shared/doc-assets.mjs'
import { listModels as listSpawnModels } from '../agent-launch/models.mjs'
import { readDaemonConfig, readDaemonConfigForCwd, withDaemonModelAliases } from '../agent-launch/permission-ledger.mjs'
import { labelsForAgent, parseFilter, parseMessageFilter, evalExpr } from '../shared/fleet-labels.mjs'
import { parseAgentSelector as parseUnifiedAgentSelector } from '../shared/unified-filter-grammar.mjs'
import { phaseFromName, baseName, PHASES, prettyNameForFriendlyName } from '../shared/lineage-name.mjs'
import { daemonHelloDecision, resolveMainDaemonScript } from '../shared/daemon-identity.mjs'
import { resolveServerIsolation } from '../shared/server-identity.mjs'
import { initProjectStore, listProjects, readProject, updateProject, getProjectsDir, readProjectPartsManifest } from './lib/project-store.mjs'
import { resumeOverleafPollers } from './lib/overleaf-sync.mjs'
import { resetStaleBuildStates, killAllBuilds, setShadowMirrorHandler } from './lib/build-runner.mjs'
import { dispatchBuild, killAllDispatchedBuilds } from './lib/build-dispatch.mjs'
import { writeSentinel } from './lib/sentinel.mjs'
import projectRoutes, { processProjectPush } from './routes/projects.mjs'
import { initAuth, isAuthEnabled, validateToken, extractToken, requireRead, loginRoute } from './lib/auth.mjs'
import { initSyncRooms, getOrCreateRoom, flushAllRooms, closeAllRooms, replayCachedSignals, onGlobalEvent, broadcastSignal, getRoomRecords, listActiveRooms, updateShape, putShape } from './lib/sync-rooms.mjs'
import * as tldaFeedback from './lib/tlda-feedback.mjs'
import { injectBridge, injectSlidesBridge, injectChapterTitle } from './lib/html-injector.mjs'
import { FleetStore } from './lib/fleet-store.mjs'
import { applyNativeTaskEvents } from './lib/native-task-wrapper.mjs'
import { resolveMachine } from './lib/tailscale-peers.mjs'
import { createFleetRouter } from './routes/fleet.mjs'
import { normalizeRegionPolicy } from './lib/spawn-policy.mjs'
import { buildRuntimeStatus } from './lib/runtime-status.mjs'
import { resolveSpawnMachine, SPAWN_MACHINE_PREF_KEY } from './lib/spawn-routing.mjs'
import { resolveFreshSpawnAvailabilityModels } from './lib/spawn-availability-models.mjs'
import { decideTaskRenudges, isWakeBreakerOpen, wakeBreakerBackoffMs } from './lib/task-renudge.mjs'
import { completeTaskLifecycle } from './lib/task-lifecycle.mjs'
import { decideReportClose } from '../bots/todd/report-close-guard.mjs'
import { rejectMatchingWsRequests, startWsRequest } from '../shared/fleet-transport.mjs'
import { isPlanModeResponse, planModeResponseKey } from './lib/plan-mode-response.mjs'
import { SpawnBounceError, SpawnLibrarian, resolveSpawnCollision } from '../shared/spawn-librarian.ts'
import { MailboxLibrarian } from '../shared/mailbox-librarian.ts'
import { trimTerminalSeedBlankRows } from '../shared/terminal-seed.mjs'
import { daemonSingletonLockPath, inspectSingletonLock } from '../agent-runtime/singleton-lock.mjs'
import { partialSkillReadSummaries, recordPartialSkillReads } from '../shared/partial-skill-reads.mjs'
import { daemonAddress, describeAgentAddress } from '../shared/agent-move-target.mjs'
import { readBuildInfo } from './lib/build-info.mjs'
import { ServerDaemonOutbox } from './lib/server-daemon-outbox.mjs'
import { DaemonAgentEvents } from './lib/daemon-agent-events.mjs'
import { createDaemonWsControlPlane } from './lib/daemon-ws-control-plane.mjs'
import { clearTrustedHeartbeatProbes, shouldSkipHeartbeatSweepForLag, shouldTerminateForMissedPong, socketCanAcceptMore } from '../shared/fleet-ws-flow.mjs'
import {
  DELIVERY_CHANNELS,
  INBOX_STATUSES,
  decideInboxDelivery,
  normalizeDeliveryChannel,
  normalizeInboxStatus,
  normalizeMessagePriority,
  parsePriorityPhrase,
  shouldWakeBatchedMessage,
  validateDeliveryChannel,
} from '../shared/inbox-attention.mjs'
import {
  MATERIALIZATION_MAX_BYTES,
  initializeRecipientRefs,
  isMaterializableAttachment,
  setRecipientAttachmentState,
} from '../shared/inbox-reference-materialization.mjs'
import { realizeProjectMarkdownArtifact } from './lib/project-artifact-materializer.mjs'
import { createBackendLogger } from './lib/observability/logger.mjs'
import {
  createControlPlaneTraceStore,
  createTraceId,
  renderControlPlaneTraceMarkdown,
  traceIdFromFleetEvent,
} from './lib/observability/control-plane-trace.mjs'
import {
  buildTelemetryStatusSnapshot,
  renderTelemetryStatusMarkdown,
} from './lib/observability/telemetry-status.mjs'
import { createNotificationAttemptRecorder } from './lib/notification-attempts.mjs'
import { daemonEventFailureIncident } from './lib/daemon-event-failures.mjs'
import { buildDaemonActivityRecord } from './lib/daemon-activity-ingest.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fleetWsLog = createBackendLogger('fleet-ws')
const notificationAttemptLog = createBackendLogger('notification-attempts')
const terminalBridgeLog = createBackendLogger('terminal-bridge')
const syncSignalLog = createBackendLogger('sync-signals')
const daemonEventLog = createBackendLogger('daemon-events')
const controlPlaneTraces = createControlPlaneTraceStore()
const SERVER_PERF_MAX_EVENTS = Number(process.env.TLDA_SERVER_PERF_MAX_EVENTS || 500)
const serverPerfEvents = []

function wsSummary() {
  const byKind = {}
  for (const ws of _trackedWs) {
    const kind = ws?._wsKind || 'unknown'
    byKind[kind] = (byKind[kind] || 0) + 1
  }
  return { total: _trackedWs.size, byKind }
}

function recordServerPerfEvent(type, detail = {}) {
  const event = {
    ts: new Date().toISOString(),
    t: performance.now(),
    type,
    detail,
    eventLoopLag: lastEventLoopLag,
    ws: wsSummary(),
  }
  serverPerfEvents.push(event)
  if (serverPerfEvents.length > SERVER_PERF_MAX_EVENTS) {
    serverPerfEvents.splice(0, serverPerfEvents.length - SERVER_PERF_MAX_EVENTS)
  }
}

const serverIsolation = resolveServerIsolation({ env: process.env, scriptPath: fileURLToPath(import.meta.url) })
if (serverIsolation.refuseReason) {
  console.error(serverIsolation.refuseReason)
  process.exit(1)
}

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
initSyncRooms(PROJECTS_DIR, { onSignalFailure: reportSyncSignalFailure })
resetStaleBuildStates()

// Fleet store (SQLite-backed agent registry + chat).
// TLDA_FLEET_DB overrides the default path — used by integration tests
// to isolate from the live /tmp/fleet.db.
const fleetStore = new FleetStore(process.env.TLDA_FLEET_DB, { taskDoc: true })
const serverDaemonOutbox = new ServerDaemonOutbox(fleetStore.db)
const daemonAgentEvents = new DaemonAgentEvents(fleetStore.db)
const serverDaemonOutboxInflight = new Map()

const TASK_DOC_STARTUP_FLUSH_DELAY_MS = Number(process.env.TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS ?? -1)
function scheduleStartupTaskDocFlush() {
  if (TASK_DOC_STARTUP_FLUSH_DELAY_MS < 0) return
  setTimeout(() => {
    Promise.resolve(fleetStore.flushTaskDocs?.()).catch(e => {
      console.warn(`[task-doc] startup flush failed: ${e.message}`)
    })
  }, TASK_DOC_STARTUP_FLUSH_DELAY_MS).unref?.()
}
scheduleStartupTaskDocFlush()

const SESSION_BACKFILL_STARTUP_DELAY_MS = Number(process.env.TLDA_SESSION_BACKFILL_STARTUP_DELAY_MS || 60_000)

const HOT_OP_WARN_MS = Number(process.env.TLDA_HOT_OP_WARN_MS || 50)
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
eventLoopDelay.enable()
let lastEventLoopLag = { maxMs: 0, meanMs: 0, at: Date.now() }
let lastHeartbeatLagAt = 0
setInterval(() => {
  lastEventLoopLag = {
    maxMs: Number(eventLoopDelay.max) / 1e6,
    meanMs: Number(eventLoopDelay.mean) / 1e6,
    at: Date.now(),
  }
  if (lastEventLoopLag.maxMs >= WS_HEARTBEAT_LAG_GRACE_MS) lastHeartbeatLagAt = lastEventLoopLag.at
  if (lastEventLoopLag.maxMs >= HOT_OP_WARN_MS) {
    console.warn(`[event-loop-lag] max=${lastEventLoopLag.maxMs.toFixed(1)}ms mean=${lastEventLoopLag.meanMs.toFixed(1)}ms`)
    recordServerPerfEvent('event-loop-lag', {
      maxMs: lastEventLoopLag.maxMs,
      meanMs: lastEventLoopLag.meanMs,
    })
  }
  eventLoopDelay.reset()
}, 1000).unref()

async function measureHotOp(label, details, fn) {
  const start = performance.now()
  try {
    return await fn()
  } finally {
    const ms = performance.now() - start
    if (ms >= HOT_OP_WARN_MS) {
      const suffix = details ? ` ${details}` : ''
      console.warn(`[hot-op] ${label} ${ms.toFixed(1)}ms${suffix} lag_max=${lastEventLoopLag.maxMs.toFixed(1)}ms lag_mean=${lastEventLoopLag.meanMs.toFixed(1)}ms`)
      recordServerPerfEvent('hot-op', { label, details, durationMs: ms })
    }
  }
}

function logWsClose(kind, ws, code, reason) {
  if (code === 1006 || lastEventLoopLag.maxMs >= HOT_OP_WARN_MS) {
    const identity = ws?._daemonKey || ws?._tldaAgentId || ws?._agentFilter || ws?._connId || 'unknown'
    console.warn(`[ws-close] kind=${kind} code=${code} identity=${identity} reason=${reason || ''} lag_max=${lastEventLoopLag.maxMs.toFixed(1)}ms lag_mean=${lastEventLoopLag.meanMs.toFixed(1)}ms`)
    recordServerPerfEvent('ws-close', { kind, code, identity, reason: reason || '' })
  }
}

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
const agentFleetConnections = new Map()     // agent_id -> latest /ws/fleet connection

// Daemon connections — keyed by machine_id:env_name. Each value is the live WS
// for that daemon config lane. Used for RPC routing and for pushing
// agents-updated / projects-updated messages.
const daemonConnections = new Map()         // machine_id:env_name -> ws
const daemonWelcomeSeenAt = new Map()       // machine_id:env_name -> last successful hello setup

// "Server currently believes this agent is live" — flat set keyed by agent_id.
// Populated by login, agent activity, thinking/status events, and explicit wake
// probes. The fleet store reads this via an installed oracle when computing each
// agent's awake/hibernating status. Daemon disconnect/reconnect windows are not
// proof of hibernation: after a deploy or local restart, stale "awake" is safer
// than hiding every working agent on the machine.
const _aliveAgents = new Set()              // Set<agent_id>
const _aliveSince = new Map()               // agent_id -> first ms in current alive run

function isAgentAlive(agentId) { return _aliveAgents.has(agentId) }

function isReservedShellAgent(agent) {
  return !!agent?.metadata?.shell
}

function markAgentAlive(agentId, now = Date.now()) {
  const wasAlive = _aliveAgents.has(agentId)
  if (!wasAlive || !_aliveSince.has(agentId)) _aliveSince.set(agentId, now)
  _aliveAgents.add(agentId)
  if (!wasAlive) {
    fleetStore?.refreshAgentLiveness?.(agentId)
    // Recovery: an agent transitioning to alive (login/reconnect) clears its
    // wake breaker so a restored session is nudged again immediately (§4.2).
    _wakeBreaker.delete(agentId)
  }
}

function markAgentNotAlive(agentId) {
  const wasAlive = _aliveAgents.has(agentId)
  _aliveAgents.delete(agentId)
  _aliveSince.delete(agentId)
  clearEphemeralState(agentId)
  if (wasAlive) fleetStore?.refreshAgentLiveness?.(agentId)
}

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
  // Liveness is client evidence, never an artefact of when the server happened
  // to run its heartbeat sweep. A stalled event loop can delay a whole sweep.
  ws._wsLastPongAt = Date.now()
  ws._wsLastPingAt = 0
  recordServerPerfEvent('ws-open', {
    kind: ws._wsKind,
    doc: ws._wsDocName,
    sessionId: ws._wsSessionId,
    remoteAddr: ws._wsRemoteAddr,
  })
  ws.on('pong', () => { ws._wsLastPongAt = Date.now() })
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
    recordServerPerfEvent('ws-cleanup', {
      kind: ws._wsKind,
      doc: ws._wsDocName,
      sessionId: ws._wsSessionId,
      connectedForMs: Date.now() - ws._wsConnectedAt,
    })
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
  for (const [daemonKey, dws] of daemonConnections) {
    if (normalizeAddr(dws._remoteAddr) === norm) return daemonKey
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
const WS_HEARTBEAT_LAG_GRACE_MS = Number(process.env.TLDA_WS_HEARTBEAT_LAG_GRACE_MS || 1000)
const WS_HEARTBEAT_LAG_COOLDOWN_MS = Number(process.env.TLDA_WS_HEARTBEAT_LAG_COOLDOWN_MS || WS_HEARTBEAT_INTERVAL_MS * 2)
let nextHeartbeatSweepDueAt = Date.now() + WS_HEARTBEAT_INTERVAL_MS
setInterval(() => {
  const now = Date.now()
  const sweepDelayMs = Math.max(0, now - nextHeartbeatSweepDueAt)
  nextHeartbeatSweepDueAt = now + WS_HEARTBEAT_INTERVAL_MS
  // A delayed sweep is evidence of server-side starvation, not client death.
  // Preserve existing sockets and require a fresh trusted ping before any
  // later termination, instead of killing the whole fleet in a catch-up burst.
  if (shouldSkipHeartbeatSweepForLag(
    lastEventLoopLag.maxMs,
    WS_HEARTBEAT_LAG_GRACE_MS,
    lastHeartbeatLagAt,
    now,
    WS_HEARTBEAT_LAG_COOLDOWN_MS,
    sweepDelayMs,
  )) {
    if (sweepDelayMs >= WS_HEARTBEAT_LAG_GRACE_MS) lastHeartbeatLagAt = now
    clearTrustedHeartbeatProbes(_trackedWs)
    console.warn(`[heartbeat] skipping sweep during/recent event-loop lag max=${lastEventLoopLag.maxMs.toFixed(1)}ms delay=${sweepDelayMs.toFixed(1)}ms`)
    recordServerPerfEvent('heartbeat-skip-lag', {
      lagMaxMs: lastEventLoopLag.maxMs,
      sweepDelayMs,
      cooldownMs: WS_HEARTBEAT_LAG_COOLDOWN_MS,
    })
    return
  }
  for (const ws of _trackedWs) {
    if (ws.readyState !== 1) continue
    if (shouldTerminateForMissedPong(ws._wsLastPongAt, ws._wsLastPingAt, now, WS_HEARTBEAT_INTERVAL_MS)) {
      console.log(`[heartbeat] terminating unresponsive ${ws._wsKind} ws=${ws._wsSessionId} doc=${ws._wsDocName || '-'}`)
      recordServerPerfEvent('heartbeat-terminate', {
        kind: ws._wsKind,
        doc: ws._wsDocName,
        sessionId: ws._wsSessionId,
        lastPongAgoMs: ws._wsLastPongAt ? now - ws._wsLastPongAt : null,
        lastPingAgoMs: ws._wsLastPingAt ? now - ws._wsLastPingAt : null,
      })
      ws.terminate()
      continue
    }
    ws._wsLastPingAt = now
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
const SERVER_ENV_NAME = getActiveConfigName(loadConfig())
const LOCAL_DAEMON_ADDRESS = daemonAddress(LOCAL_MACHINE_ID, SERVER_ENV_NAME)
// Server owner — the human running this server process. Used as fallback
// identity for MCP agents and CLI operations. Browser users identify
// themselves via WS 'login' (returning) or 'register' (new human) messages.
const SERVER_OWNER_NAME = process.env.TLDA_USER || (() => { try { return os.userInfo()?.username } catch { return 'user' } })()
const SERVER_OWNER_ID = `fleet:${SERVER_OWNER_NAME}`
const SERVER_BOOT_ID = Date.now()   // unique per server start; daemon uses this to detect restarts
const DAEMON_SUPERVISOR_INTERVAL_MS = 10_000
const DAEMON_LOG_FILE = join(homedir(), '.config', 'tlda', 'fleet-daemon.log')
const DAEMON_PID_FILE = join(homedir(), '.config', 'tlda', 'fleet-daemon.pid')
const DAEMON_CONFIG_DIR = join(homedir(), '.config', 'tlda')
function daemonLockFile() {
  return daemonSingletonLockPath({
    configDir: DAEMON_CONFIG_DIR,
    origin: `${process.env.TLDA_SERVER || resolveConfig().database.http}#${SERVER_ENV_NAME}`,
  })
}
const DAEMON_SCRIPT = (() => {
  const d = dirname(fileURLToPath(import.meta.url))
  return resolveMainDaemonScript(fileURLToPath(import.meta.url)) || join(d, '..', 'bin', 'fleet-daemon.mjs')
})()
// Crash-loop guard: if the daemon dies fast >= MAX_RAPID_RESPAWNS times in a
// row, give up until manual intervention. The supervisor would otherwise
// hot-loop and burn CPU + log spam if the daemon has a startup crash.
const DAEMON_FAST_DEATH_MS = 30_000   // < 30s alive == "fast death"
const DAEMON_MAX_RAPID_RESPAWNS = 3
const DAEMON_BACKOFF_MS = 5 * 60_000  // back off 5 minutes after giving up
const DAEMON_LOCK_HELD_BACKOFF_MS = 60_000
let _daemonSpawnInFlight = false
let _daemonRespawnCount = 0
let _daemonRapidFails = 0
let _daemonLastSpawnAt = 0
let _daemonBackoffUntil = 0
let _daemonGivingUpLogged = false
let _daemonLockHeldLoggedAt = 0

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
  const ws = daemonConnections.get(LOCAL_DAEMON_ADDRESS)
  if (ws && ws.readyState === 1) return
  // The daemon owns an origin-keyed singleton lock. If any live daemon already
  // holds this server's origin lock, that is the authoritative answer: do not
  // spawn a competing child from this server, even if this stale/local server
  // has no daemon WS.
  try {
    const lockPath = daemonLockFile()
    const lock = inspectSingletonLock({ lockPath })
    if (lock.held) {
      _daemonBackoffUntil = Math.max(_daemonBackoffUntil, now + DAEMON_LOCK_HELD_BACKOFF_MS)
      if (now - _daemonLockHeldLoggedAt >= DAEMON_LOCK_HELD_BACKOFF_MS) {
        const h = lock.holder || {}
        console.warn(
          `[daemon-supervisor] singleton lock held by pid=${h.pid ?? '?'} ` +
          `install=${h.installPath ?? '?'}; not spawning ${DAEMON_SCRIPT}`,
        )
        _daemonLockHeldLoggedAt = now
      }
      return
    }
  } catch (e) {
    _daemonBackoffUntil = Math.max(_daemonBackoffUntil, now + DAEMON_LOCK_HELD_BACKOFF_MS)
    console.error(`[daemon-supervisor] cannot inspect singleton lock: ${e.message}; not spawning`)
    return
  }
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
    const child = spawn(process.execPath, [DAEMON_SCRIPT], {
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
// Each entry is the shared ws-request-policy shape plus { machine_id, env_name }.
const pendingRpcs = new Map()
let _rpcSeq = 0
const RPC_TIMEOUT_MS = 10_000
const SPAWN_RPC_TIMEOUT_MS = 120_000
const DAEMON_RPC_RECONNECT_GRACE_MS = Number(process.env.TLDA_DAEMON_RPC_RECONNECT_GRACE_MS || 15_000)
const pendingRpcFailureTimers = new Map()

// ---------- Plan mode approval tracking ----------
//
// When a terminal frame shows the Claude Code plan mode approval prompt
// ("Would you like to proceed?"), we fire a plan_approval fleet event and
// track the pending approval so Skip's voice response can be routed back
// as a keystroke to the correct agent's tmux pane.
//
// keyed by agent_id → { tmux_session, machine_id, planText, lastHash, eventId }
const pendingPlanApprovals = new Map()

// Chat idempotency cache: _tempId → { eventIds, recipients, receipts, ts }
// Prevents duplicate DB rows when the browser retries a timed-out send.
const _chatTempIds = new Map()
const CHAT_TEMPID_TTL_MS = 60_000
setInterval(() => {
  const cutoff = Date.now() - CHAT_TEMPID_TTL_MS
  for (const [k, v] of _chatTempIds) { if (v.ts < cutoff) _chatTempIds.delete(k) }
}, 30_000).unref?.()

const TASK_RENUDGE_SWEEP_MS = Number(process.env.TLDA_TASK_RENUDGE_SWEEP_MS || 60_000)
const TASK_RENUDGE_INTERVAL_MS = Number(process.env.TLDA_TASK_RENUDGE_INTERVAL_MS || 5 * 60_000)
const TASK_RENUDGE_SWEEP_LIMIT = 100
const _taskRenudged = new Map()
const _taskWakeQueue = new Map()
let _taskRenudgeCursor = null

// Per-agent wake circuit breaker. Consecutive terminal wake failures (a session
// that can't be resolved → endless `launch-failed`) put an agent into exponential
// backoff so runTaskRenudgeSweep stops respawning it every 5 min. Reset on real
// recovery (markAgentAlive) or a successful wake. Keyed by agentId.
const _wakeBreaker = new Map() // agentId -> { fails, nextTs, lastError }
const WAKE_BREAKER_BASE_MS = TASK_RENUDGE_INTERVAL_MS // 5 min, first backoff step
const WAKE_BREAKER_CAP_MS = Number(process.env.TLDA_WAKE_BREAKER_CAP_MS || 2 * 60 * 60_000) // 2h ceiling (also a slow self-heal probe)
let _taskWakeDraining = false

function terminalNudgeKind(agent) {
  const kind = agent?.metadata?.kind || agent?.kind
  return kind === 'codex' || kind === 'goose'
}

function deliveryChannelFor(agent) {
  return normalizeDeliveryChannel(agent?.metadata?.deliveryChannel)
}

function shouldSendWakeNudge(agent, nudgeText) {
  if (!nudgeText || !agent?.tmux_session) return false
  return deliveryChannelFor(agent) === 'tmux' || terminalNudgeKind(agent)
}

async function sendWakeNudge(daemonKey, agent, tmuxSession, nudgeText, phase, logTag = 'wake-nudge') {
  if (!shouldSendWakeNudge(agent, nudgeText)) return
  await sendRpcResilient(daemonKey, 'send-text', {
    tmux_session: tmuxSession,
    text: nudgeText,
    enter: true,
    enter_delay_ms: agent?.metadata?.kind === 'codex' ? 400 : 0,
  })
}

function livenessFromCheckAliveResult(agentId, tmuxSession, result) {
  if (result?.state) return { ...result, agent_id: result.agent_id || agentId, tmux_session: result.tmux_session || tmuxSession }
  if (typeof result?.alive === 'boolean') {
    return {
      type: 'agent-liveness',
      agent_id: agentId,
      tmux_session: tmuxSession,
      state: result.alive ? 'alive' : 'dead',
      reason: result.alive ? undefined : 'daemon check-alive: tmux session absent',
      ts: new Date().toISOString(),
    }
  }
  return {
    type: 'agent-liveness',
    agent_id: agentId,
    tmux_session: tmuxSession,
    state: 'unknown',
    reason: 'daemon check-alive returned no liveness state',
    ts: new Date().toISOString(),
  }
}

function requestTaskWake(agentId, nudgeText = null, keys = []) {
  const agent = fleetStore?.getAgent?.(agentId)
  if (!agent || agent.dead || agent.human) return
  const prev = _taskWakeQueue.get(agentId)
  // Queue value carries the task keys riding this wake so the drain can refresh
  // their renudge throttle on success (§5). Multiple tasks for one agent collapse
  // to a single wake (dedup by agentId); their keys accumulate.
  const mergedKeys = [...new Set([...(prev?.keys || []), ...keys])]
  _taskWakeQueue.set(agentId, { nudgeText: nudgeText || prev?.nudgeText || null, keys: mergedKeys })
  if (!_taskWakeDraining) drainTaskWakeQueue()
}

// A successful wake clears the agent's circuit breaker and refreshes the 5-min
// renudge throttle for every task key that rode this wake (§4.1 + §5). Moving the
// throttle stamp here — off the pre-attempt sweep — means a failing agent's
// throttle never stays warm; it's gated by the breaker's backoff instead.
function onTaskWakeSuccess(agentId, keys = []) {
  _wakeBreaker.delete(agentId)
  const now = Date.now()
  for (const key of keys) _taskRenudged.set(key, { ts: now })
}

async function drainTaskWakeQueue() {
  _taskWakeDraining = true
  while (_taskWakeQueue.size > 0) {
    const [agentId, entry] = _taskWakeQueue.entries().next().value
    _taskWakeQueue.delete(agentId)
    const nudgeText = entry?.nudgeText || null
    const taskKeys = entry?.keys || []
    const agent = fleetStore?.getAgent?.(agentId)
    if (!agent || agent.dead || agent.human) continue
    const daemonKeys = [...daemonConnections.keys()]
    if (daemonKeys.length === 0) continue
    const daemonKey = agent.machine_id && agent.env_name ? agentDaemonAddress(agent) : daemonKeys[0]
    try {
      if (!agent.machine_id) throw new Error(`agent ${agent.friendly_name || agentId} has no machine_id; cannot route task re-nudge`)
      const ownerDaemon = daemonConnections.get(daemonKey)
      if (!ownerDaemon || ownerDaemon.readyState !== 1) throw new Error(`No fleet-daemon connected for ${daemonKey}`)
      const serverAlive = isAgentAlive(agentId)
      const liveness = serverAlive
        ? await sendRpcResilient(daemonKey, 'check-alive', { tmux_session: agent.tmux_session })
          .then(result => livenessFromCheckAliveResult(agentId, agent.tmux_session, result))
          .catch(e => ({
            type: 'agent-liveness',
            agent_id: agentId,
            tmux_session: agent.tmux_session,
            state: 'unknown',
            reason: e.message,
            ts: new Date().toISOString(),
          }))
        : {
            type: 'agent-liveness',
            agent_id: agentId,
            tmux_session: agent.tmux_session,
            state: 'unknown',
            reason: 'server liveness says hibernating',
            ts: new Date().toISOString(),
          }
      spawnLibrarian.observeLiveness({ ...liveness, agent_id: liveness.agent_id || agentId })
      const decision = spawnLibrarian.decideWake(agent, { ...liveness, agent_id: liveness.agent_id || agentId }, { serverAlive })
      if (decision.action === 'deliver') {
        await sendWakeNudge(daemonKey, agent, agent.tmux_session, nudgeText, 'deliver', 'task-renudge')
        onTaskWakeSuccess(agentId, taskKeys)
        continue
      }
      if (decision.action === 'queue') {
        setTimeout(() => requestTaskWake(agentId, nudgeText, taskKeys), 2000).unref?.()
        continue
      }
      if (decision.action === 'hold') continue
      if (decision.action === 'surface') {
        broadcastEvent('agent-wedged', { agentId, reason: decision.message, ts: new Date().toISOString() })
        continue
      }
      // Wake carries NO privilege check (hibernation is transparent) — pass no
      // requester; the daemon resumes the agent with its own privileges. agent_id
      // lets the daemon find that agent's own grant.
      const spawnResult = await sendRpc(daemonKey, 'spawn', { name: agentId, agent_id: agentId, respawn: true })
      if (!spawnResult?.ok) {
        // Don't drop a failed re-nudge silently — surface via the catch (agent-wedged).
        throw new Error(spawnResult?.error || spawnResult?.reason || 'daemon returned ok:false with no reason')
      }
      await sendWakeNudge(daemonKey, agent, spawnResult?.tmux_session || agent.tmux_session, nudgeText, 'post-respawn', 'task-renudge')
      onTaskWakeSuccess(agentId, taskKeys)
    } catch (e) {
      // Record a terminal wake failure → open/extend the agent's circuit breaker
      // (exponential backoff) so runTaskRenudgeSweep stops respawning it every
      // 5 min (§2). Covers the `!spawnResult.ok` throw (launch-failed) and any
      // RPC/transport error; a transient failure self-clears on the next success.
      const b = _wakeBreaker.get(agentId) || { fails: 0 }
      b.fails += 1
      b.lastError = e.message
      b.nextTs = Date.now() + wakeBreakerBackoffMs(b.fails, WAKE_BREAKER_BASE_MS, WAKE_BREAKER_CAP_MS)
      _wakeBreaker.set(agentId, b)
      console.warn(`[task-renudge] failed for ${agentId} (fails=${b.fails}, backoff until ${new Date(b.nextTs).toISOString()}): ${e.message}`)
      broadcastEvent('agent-wedged', {
        agentId,
        reason: `task re-nudge failed: ${e.message}`,
        ts: new Date().toISOString(),
      })
    }
  }
  _taskWakeDraining = false
}

function taskInboxStatusFor(agentId) {
  const status = fleetStore?.getAgent?.(agentId)?.metadata?.inboxStatus
  return normalizeInboxStatus(status)
}

function taskWakePreview(raw, max = 120) {
  const s = String(raw || '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function taskDelegateWakeText(description, agentId) {
  const status = taskInboxStatusFor(agentId)
  const prefix = status[0].toUpperCase() + status.slice(1)
  return `📬 ${prefix} new task assigned: ${taskWakePreview(description)}\nCall inbox() to see it.`
}

function runTaskRenudgeSweep() {
  if (!fleetStore) return
  const page = fleetStore.getActiveTasksPage?.({ limit: TASK_RENUDGE_SWEEP_LIMIT, cursor: _taskRenudgeCursor }) || { tasks: [], nextCursor: null }
  const tasks = page.tasks || []
  _taskRenudgeCursor = page.nextCursor || null
  const taskStates = tasks.map(task => fleetStore.getTaskDeliveryState?.(task)).filter(Boolean)
  const agentIds = taskStates.map(state => state?.task?.agent).filter(Boolean)
  const nudges = decideTaskRenudges({
    taskStates,
    agents: fleetStore.getAgentsByIds?.(agentIds) || [],
    now: Date.now(),
    lastRenudged: _taskRenudged,
    renudgeIntervalMs: TASK_RENUDGE_INTERVAL_MS,
    wakeBreaker: _wakeBreaker,
  })
  for (const nudge of nudges) {
    // The renudge throttle is stamped on SUCCESSFUL wake (onTaskWakeSuccess), not
    // here (§5) — so a failing agent's 5-min throttle never stays warm; its
    // backoff is governed solely by the breaker. Pass the task key through so the
    // drain can stamp it on delivery.
    requestTaskWake(nudge.task.agent, taskDelegateWakeText(nudge.task.description || nudge.event.text || nudge.task.id, nudge.task.agent), [nudge.key])
  }
}

if (TASK_RENUDGE_SWEEP_MS > 0) {
  setInterval(runTaskRenudgeSweep, TASK_RENUDGE_SWEEP_MS).unref?.()
}

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
 * Per spec: timeout, no automatic replay. If the WS drops mid-RPC the pending
 * entry survives a short reconnect grace, then rejects if the daemon does not
 * come back before either that grace or the request's own deadline.
 */
class NoDaemonError extends Error {
  constructor(machineId, envName) {
    super(`No fleet-daemon connected for ${describeAgentAddress(machineId, envName)}`)
    this.code = 'NO_DAEMON'
    this.machineId = machineId
    this.envName = envName
  }
}

async function sendRpc(machineId, op, params = {}, opts = {}) {
  let targetMachine = machineId
  let envName = params.daemon_env_name
  if (!envName && typeof machineId === 'string' && machineId.includes(':')) {
    const parts = machineId.split(':')
    targetMachine = parts[0]
    envName = parts[1]
  }
  if (!machineId || !envName) return Promise.reject(new NoDaemonError(machineId || '(unknown)', envName || '(unknown)'))
  const key = daemonAddress(targetMachine, envName)
  let dws = daemonConnections.get(key)
  if (!dws || dws.readyState !== 1) {
    if (op === 'spawn' && daemonWelcomeSeenAt.has(key) && opts.waitForReconnect !== false) {
      try {
        await waitForDaemonReady(key, DAEMON_RPC_RECONNECT_GRACE_MS)
        dws = daemonConnections.get(key)
      } catch {
        // Reconnect grace expired; fall through to the normal NoDaemonError path.
      }
    }
  }
  if (!dws || dws.readyState !== 1) {
    if (op === 'spawn') logSpawnDaemonMiss(key, 'sendRpc(spawn)', { hasWs: !!dws, readyState: dws?.readyState ?? 'missing', route: params.spawnRoute || 'unknown' })
    return Promise.reject(new NoDaemonError(targetMachine, envName))
  }
  const id = `rpc-${++_rpcSeq}-${Date.now().toString(36)}`
  // Per-attempt deadline is a caller-passed param (event-based default): control ops
  // wrapped in sendRpcResilient pass a short per-attempt timeout so a stale-but-"open"
  // WS is abandoned quickly and retried on the fresh reconnect, rather than blocking
  // the full 10s each time.
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : (op === 'spawn' ? SPAWN_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS)
  const promise = startWsRequest({
    pending: pendingRpcs,
    id,
    type: `rpc:${op}`,
    deadlineMs: timeoutMs,
    makeDeadlineError: () => new Error(`RPC timeout after ${timeoutMs}ms (op=${op}, daemon=${key})`),
    send: () => {
      try {
        dws.send(JSON.stringify({ type: 'rpc', id, op, ...params }))
        return true
      } catch (e) {
        pendingRpcs.get(id)?.reject(e)
        return true
      }
    },
  })
  const entry = pendingRpcs.get(id)
  if (entry) {
    entry.machine_id = targetMachine
    entry.env_name = envName
  }
  return promise
}

function rpcErrorMessage(error) {
  if (typeof error === 'string') return error
  if (error?.message && typeof error.message === 'string') return error.message
  try { return JSON.stringify(error) } catch { return String(error) }
}

function logSpawnDaemonMiss(machineId, context, detail = {}) {
  if (!daemonWelcomeSeenAt.has(machineId)) return
  const ageMs = Date.now() - daemonWelcomeSeenAt.get(machineId)
  console.error(`[spawn-route] no routable daemon at spawn after welcome: machine_id=${machineId} age_ms=${ageMs} has_ws=${detail.hasWs ?? 'unknown'} ready_state=${detail.readyState ?? 'unknown'} route=${detail.route || 'unknown'} context=${context}`)
}

// When a daemon WS drops, fail any in-flight RPCs that targeted it. The
// HTTP caller decides whether to retry. A short grace prevents one heartbeat
// flap from synchronously rejecting every in-flight request for that daemon.
function failPendingRpcsForDaemon(machineId, envName, reason = 'daemon disconnected') {
  const key = daemonAddress(machineId, envName)
  if (pendingRpcFailureTimers.has(key)) return
  const timer = setTimeout(() => {
    pendingRpcFailureTimers.delete(key)
    const dws = daemonConnections.get(key)
    if (dws && dws.readyState === 1) return
    rejectMatchingWsRequests(
      pendingRpcs,
      entry => entry.machine_id === machineId && entry.env_name === envName,
      () => new Error(reason)
    )
  }, DAEMON_RPC_RECONNECT_GRACE_MS)
  timer.unref?.()
  pendingRpcFailureTimers.set(key, timer)
}

// ── Event-based RPC retry across a transient daemon reconnect ──────────────────
// Base sendRpc() is deliberately "10s timeout, no retry" — the caller decides. But
// durable *control* ops (send-text / wake-nudge, check-alive, spawn-availability)
// should NOT hard-fail while the daemon WS is mid-reconnect (Fly deploy flap, 1006
// churn, off-launchd restart). Per Skip: the deadline is a caller-passed param with an
// event-based default — the op queues and completes on the reconnect event. This
// wrapper waits (event-driven, not a busy-poll) for the daemon to (re)register and
// retries, bounded by a total deadline. sendRpc() itself still does not replay a
// request after it has been sent; fresh spawn calls only wait for a daemon that is
// already inside the reconnect grace before their first send.
const RPC_RECONNECT_DEADLINE_MS = 30_000
const RPC_RESILIENT_ATTEMPT_MS = 5_000
const daemonReadyWaiters = new Map() // daemonKey -> Set<{ resolve, timer }>

// Called when a daemon (re)registers — wakes anything waiting to retry an RPC to it.
function notifyDaemonReady(daemonKey) {
  const pendingFailure = pendingRpcFailureTimers.get(daemonKey)
  if (pendingFailure) {
    clearTimeout(pendingFailure)
    pendingRpcFailureTimers.delete(daemonKey)
  }
  const set = daemonReadyWaiters.get(daemonKey)
  if (!set) return
  daemonReadyWaiters.delete(daemonKey)
  for (const w of set) { clearTimeout(w.timer); w.resolve() }
}

// Resolves immediately if a ready WS exists for the key, else when one registers,
// else rejects at the deadline. Purely event-driven (notifyDaemonReady + a timer).
function waitForDaemonReady(daemonKey, deadlineMs) {
  const dws = daemonConnections.get(daemonKey)
  if (dws && dws.readyState === 1) return Promise.resolve()
  if (!(deadlineMs > 0)) return Promise.reject(new Error(`daemon ${daemonKey} not connected`))
  return new Promise((resolve, reject) => {
    let set = daemonReadyWaiters.get(daemonKey)
    if (!set) { set = new Set(); daemonReadyWaiters.set(daemonKey, set) }
    const w = { resolve, timer: null }
    w.timer = setTimeout(() => {
      set.delete(w)
      if (set.size === 0) daemonReadyWaiters.delete(daemonKey)
      reject(new Error(`daemon ${daemonKey} did not reconnect within ${deadlineMs}ms`))
    }, deadlineMs)
    set.add(w)
  })
}

function rpcDaemonKey(machineId, params = {}) {
  if (params.daemon_env_name) return daemonAddress(machineId, params.daemon_env_name)
  if (typeof machineId === 'string' && machineId.includes(':')) {
    const [m, e] = machineId.split(':')
    return daemonAddress(m, e)
  }
  return machineId
}

function isTransientRpcError(err) {
  if (err?.code === 'NO_DAEMON') return true
  const m = rpcErrorMessage(err)
  return /RPC timeout after|daemon disconnected|not connected|did not reconnect/i.test(m)
}

// Event-based retry across reconnect for idempotent control ops. Retries only on
// transient (reconnect-class) failures; op-level errors propagate immediately.
async function sendRpcResilient(machineId, op, params = {}, { totalDeadlineMs = RPC_RECONNECT_DEADLINE_MS, attemptTimeoutMs = RPC_RESILIENT_ATTEMPT_MS } = {}) {
  const key = rpcDaemonKey(machineId, params)
  const start = Date.now()
  let lastErr = null
  while (true) {
    const remaining = totalDeadlineMs - (Date.now() - start)
    if (remaining <= 0) break
    const dws = daemonConnections.get(key)
    if (!dws || dws.readyState !== 1) {
      try { await waitForDaemonReady(key, remaining) } catch (e) { lastErr = e; break }
    }
    try {
      return await sendRpc(machineId, op, params, { timeoutMs: Math.min(attemptTimeoutMs, Math.max(1, totalDeadlineMs - (Date.now() - start))) })
    } catch (e) {
      lastErr = e
      if (!isTransientRpcError(e)) throw e
      // A stale-but-"open" WS would re-hit the same dead socket; wait for a fresh
      // ready daemon (the close handler evicts the dead WS, the new hello notifies).
      const left = totalDeadlineMs - (Date.now() - start)
      if (left <= 0) break
      try { await waitForDaemonReady(key, left) } catch (we) { lastErr = we; break }
    }
  }
  throw lastErr || new Error(`RPC ${op} to ${key} failed after ${totalDeadlineMs}ms`)
}

setShadowMirrorHandler(async ({ name, hash, bundleBase64 }) => {
  const project = readProject(name)
  const machineId = project?.lastSourceMachineId || null
  const envName = project?.lastSourceEnvName || null
  if (!machineId || !envName) {
    throw new Error(`no source daemon recorded for ${name}`)
  }
  const result = await sendRpc(daemonAddress(machineId, envName), 'mirror-shadow-ref', {
    project: name,
    hash,
    bundleBase64,
  })
  return { ...result, machine_id: machineId, env_name: envName }
})

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
  const traceId = traceIdFromFleetEvent(data)
  if (traceId) {
    controlPlaneTraces.append({
      trace_id: traceId,
      component: 'server',
      operation: `broadcast.${type}`,
      status: 'queued',
      detail: {
        event_type: data?.type,
        event_id: data?.id || data?.event_id,
        from: data?.from_id || data?.from,
        to: data?.to_id || data?.to,
      },
    })
  }
  broadcastFleet({ event: type, data })
}

function compactObject(obj = {}) {
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

function describeFleetWsPeer(ws) {
  const parts = []
  if (ws?._tldaAgentId) parts.push(`agent=${ws._tldaAgentId}`)
  if (ws?._tldaHumanId) parts.push(`human=${ws._tldaHumanId}`)
  if (ws?._agentFilter) parts.push(`filter=${ws._agentFilter}`)
  if (ws?._connId) parts.push(`conn=${ws._connId}`)
  return parts.length ? parts.join(' ') : 'anonymous fleet ws'
}

async function surfaceFleetWsError(ws, msg, err) {
  try {
    const type = msg?.type || 'unparsed'
    const requestId = msg?.id || null
    const peer = describeFleetWsPeer(ws)
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error && err.stack ? err.stack : message
    let rpcReplyFailure = null

    if (requestId && !msg?._fleetReplied && ws?.readyState === 1) {
      try {
        ws.send(JSON.stringify({ id: requestId, error: { message } }))
        msg._fleetReplied = true
      } catch (sendErr) {
        rpcReplyFailure = sendErr?.stack || sendErr?.message || String(sendErr)
      }
    }

    const fullStack = rpcReplyFailure
      ? `${stack}\n\nRPC error reply failed:\n${rpcReplyFailure}`
      : stack
    fleetWsLog.error({ peer, type, requestId, stack: fullStack }, 'fleet WS message failed')

    if (!fleetStore) return
    const text = [
      '**Fleet runtime error**',
      `peer: \`${peer}\``,
      `message type: \`${type}\`${requestId ? `, request: \`${requestId}\`` : ''}`,
      '',
      '```',
      fullStack.slice(0, 4000),
      '```',
    ].join('\n')
    const event = await fleetStore.chat('fleet:tlda', SERVER_OWNER_ID, text, {
      type: 'fleet_runtime_error',
      wsPeer: peer,
      messageType: type,
      requestId,
    })
    if (event) {
      broadcastEvent('fleet-event', {
        type: 'chat',
        from: 'fleet:tlda',
        to: SERVER_OWNER_ID,
        id: event.id,
        text,
        event_id: event.id,
        metadata: event.metadata || null,
      })
    }
  } catch (reportErr) {
    fleetWsLog.error({
      originalError: err?.stack || err?.message || String(err),
      reportingError: reportErr?.stack || reportErr?.message || String(reportErr),
    }, 'fleet WS error reporting failed')
  }
}

async function handleFleetWsFrame(ws, raw) {
  let msg = null
  try {
    msg = JSON.parse(raw.toString())
    await handleFleetWsMessage(ws, msg)
  } catch (err) {
    await surfaceFleetWsError(ws, msg, err)
  }
}

function hasOpenFleetSocketForAgent(agentId, exceptWs = null) {
  for (const client of wsFleetClients) {
    if (client !== exceptWs && client._tldaAgentId === agentId && client.readyState === 1) return true
  }
  return false
}

const spawnLibrarian = new SpawnLibrarian({
  loginDeadlineMs: Number(process.env.TLDA_SPAWN_LOGIN_DEADLINE_MS || 60_000),
  wedgedWindowMs: Number(process.env.TLDA_WEDGED_JOIN_MS || 90_000),
  onWedged: ({ agent_id, liveness }) => {
    const agent = fleetStore?.getAgent?.(agent_id)
    const label = agent?.friendly_name || agent_id
    const metadata = {
      type: 'agent_wedged',
      agentId: agent_id,
      agentLabel: label,
      tmux_session: liveness?.tmux_session || agent?.tmux_session || null,
      reason: liveness?.reason || 'delivered chat produced no agent-activity advance',
      ts: new Date().toISOString(),
    }
    // Wedged is convergent agent state — surface it via the agent-wedged event
    // (consumed by the per-agent status line), NOT as a chat message. Posting it
    // to chat spammed every idle recipient of a broadcast/fan-out delivery. (Skip 6/27)
    broadcastEvent('agent-wedged', metadata)
    broadcastState(agent)
  },
  onLateLogin: (agent) => {
    const label = agent.friendly_name || agent.id
    const metadata = { type: 'spawn_late_login', agentId: agent.id, agentLabel: label, ts: new Date().toISOString() }
    broadcastEvent('spawn-late-login', metadata)
    deliverTldaFeedbackChat({
      from: 'fleet:tlda',
      to: SERVER_OWNER_ID,
      text: `**Late login**: \`${label}\` logged in after the spawn deadline — it is now available.`,
      metadata,
    })
    broadcastState(agent)
  },
})
const mailboxLibrarian = new MailboxLibrarian({
  onExpire: (entry) => {
    if (entry.kind !== 'spawn') return
    deliverTldaFeedbackChat({
      from: 'fleet:tlda',
      to: entry.ownerId,
      text: `**Spawn mailbox ${entry.id} failed**: deadline exceeded for \`${entry.meta?.name || entry.meta?.agentId || 'spawn'}\`.`,
      metadata: { type: 'mailbox_complete', mailbox_id: entry.id, mailbox_kind: entry.kind, status: 'failed' },
    })
  },
})
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
const MY_TASK_TASK_LIMIT = 20
const MY_TASK_UNREAD_LIMIT = 50

// daemon address → ts when the CURRENT uninterrupted daemon connection began. Reset on
// every daemon-hello (i.e. every reconnect). Agent activity events arrive over the
// daemon WS, so if that WS flapped, an agent's activity wasn't delivered LIVE and its
// _lastActivityAt was briefly stale — making an active agent *look* idle. The daemon
// backfills the gap on reconnect (its cursor only advances on delivered bytes), so the
// staleness clears within seconds; getWouldHibernate just waits out the reconnect grace.
const _daemonConnectedSince = new Map()

const HIBERNATE_IDLE_MS = 20 * 60 * 1000
const LIVENESS_RECONNECT_GRACE_MS = 120_000

function touchActivity(agentId) {
  _lastActivityAt.set(agentId, Date.now())
}

// ---- Turn-end synthetic event ----
// An agent's "turn" ends when it transitions thinking → idle. The transient
// `agent-thinking` indicator is fire-and-forget (a disconnected subscriber
// misses the edge), so we ALSO persist a synthetic `turn_ended` row in the
// events DB. Because every share() is auto-broadcast as a fleet-event (see the
// fleetStore.onEvent wiring below), bots can SUBSCRIBE to turn boundaries live
// AND catch up after a disconnect by polling /api/store/events?type=turn_ended.
// This is the signal the disposition self-check bot (bin/bots/disposition.mjs)
// rides on. The true→false edge is deduped upstream by _thinkingState, so this
// fires exactly once per turn.
function emitTurnEnded(agentId, startedAtMs) {
  if (!fleetStore || !agentId) return
  // Only real agents have turns — skip humans/bots (Skip, todd, tlda, …).
  const a = fleetStore.getAgent?.(agentId)
  if (a?.human) return
  const endedAt = new Date()
  const durationMs = startedAtMs ? (endedAt.getTime() - startedAtMs) : null
  Promise.resolve(fleetStore.share({
    type: 'turn_ended',
    from: agentId,
    agentId,
    text: null,
    metadata: {
      kind: 'turn-end',
      startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
      endedAt: endedAt.toISOString(),
      durationMs,
    },
    unread: false,
  })).catch(e => console.error('[turn_ended] emit failed:', e.message))
}

function getWouldHibernate() {
  const now = Date.now()
  const result = {}
  for (const agentId of _aliveAgents) {
    // A dead/removed row can linger in this in-memory set until the next explicit
    // state update. Such a ghost
    // would otherwise be hibernated on its ancient _lastActivityAt — and since
    // lineage twins share a tmux_session, that kill-session would take down the
    // LIVE agent occupying the session. Skip anything not currently alive.
    const agent = fleetStore?.getAgent(agentId)
    if (!agent || agent.dead) continue
    if (_thinkingState.has(agentId)) continue
    if (_compactingState.has(agentId)) continue
    // An "idle for 20 minutes" reading is only meaningful after this specific
    // agent has been continuously observed alive for the same window. Without
    // this, a freshly rediscovered agent can inherit stale _lastActivityAt and
    // get killed almost immediately.
    const aliveSince = _aliveSince.get(agentId)
    if (!aliveSince || (now - aliveSince) < HIBERNATE_IDLE_MS) continue
    // Idle baseline = last REAL activity, or — if we've recorded none this
    // server-run (e.g. the agent was already idle before the last restart) —
    // the start of its current alive run. aliveSince is set once by
    // markAgentAlive and is not bumped by passive roster/status reads, so it's
    // a true floor for "has done nothing".
    // Without this, every deploy would leave pre-existing idle agents
    // permanently un-hibernatable (no lastActive → skipped forever).
    const lastActive = _lastActivityAt.get(agentId) || aliveSince
    const idleMs = now - lastActive
    if (idleMs < HIBERNATE_IDLE_MS) continue
    // Gap-aware idle: don't hibernate on a reading the activity feed couldn't
    // back up. But the daemon BACKFILLS on reconnect — its cursor is a
    // high-water mark of *delivered* bytes, so activity during a WS outage isn't
    // lost; on reconnect it drains everything written during the gap (see
    // readNewSessionLines in fleet-daemon.mjs). So _lastActivityAt self-corrects
    // within seconds of a reconnect. We therefore don't need a full idle window
    // of connection — just enough settle time for that drain to land. Require
    // the daemon to have been connected for the reconnect grace (~2min, well
    // over the actual drain) before trusting a "no recent activity" reading.
    const daemonKey = agent.machine_id && agent.env_name ? agentDaemonAddress(agent) : null
    if (daemonKey) {
      const connectedSince = _daemonConnectedSince.get(daemonKey)
      if (!connectedSince || (now - connectedSince) < LIVENESS_RECONNECT_GRACE_MS) continue
    }
    result[agentId] = Math.round(idleMs / 1000)
  }
  return result
}

// Pending targeted agent deltas for broadcastState(). A live-state tick must
// never rescan the full live roster; callers that know which agent changed pass
// that agent/id, and no-arg calls only publish bounded ephemeral maps.
const _pendingBroadcastAgentIds = new Set()
const _lastAgentJson = new Map()

function _queueBroadcastAgents(agentUpdates = null) {
  if (!agentUpdates) return
  const updates = Array.isArray(agentUpdates) ? agentUpdates : [agentUpdates]
  for (const item of updates) {
    const id = typeof item === 'string' ? item : item?.id
    if (id) _pendingBroadcastAgentIds.add(id)
  }
}

function _agentWithEphemeralState(agent) {
  if (!agent) return null
  if (_thinkingState.has(agent.id)) return { ...agent, status: 'thinking' }
  if (_compactingState.has(agent.id)) return { ...agent, status: 'compacting' }
  return agent
}

function _broadcastStateNow() {
  if (!fleetStore) return
  const pendingIds = [..._pendingBroadcastAgentIds]
  _pendingBroadcastAgentIds.clear()

  const changed = []
  const removed = []
  for (const id of pendingIds) {
    const a = _agentWithEphemeralState(fleetStore.getAgent(id))
    if (!a) {
      if (_lastAgentJson.has(id)) {
        _lastAgentJson.delete(id)
        removed.push(id)
      }
      continue
    }
    const json = JSON.stringify(a)
    if (_lastAgentJson.get(a.id) !== json) {
      changed.push(a)
      _lastAgentJson.set(a.id, json)
    }
  }

  broadcastFleet({
    event: 'agents-delta',
    data: {
      changed,
      removed,
      task_delta: fleetStore.consumeTaskChanges?.() || { changed: [], removed: [], overflow: false },
      thinking: Object.fromEntries(_thinkingState),
      compacting: Object.fromEntries(_compactingState),
      context: Object.fromEntries(_contextState),
    },
  })
}

// Debounced entry point for bounded fleet state. No-arg calls only push bounded
// ephemeral maps; pass an agent/id when the caller knows a concrete row changed.
let _broadcastTimer = null
function broadcastState(agentUpdates = null) {
  _queueBroadcastAgents(agentUpdates)
  if (_broadcastTimer) return
  _broadcastTimer = setTimeout(() => { _broadcastTimer = null; _broadcastStateNow() }, 50)
}

function mintFleetId() {
  return `fleet:${randomUUID().slice(0, 8)}`
}

function projectForCwd(cwd) {
  if (!cwd) return null
  for (const p of listProjects()) {
    if (p.sourceDir && cwd.startsWith(p.sourceDir)) return p.name
    const serverProjectDir = join(getProjectsDir(), p.name)
    if (cwd.startsWith(serverProjectDir)) return p.name
  }
  return null
}

function liveAgentsByName(name) {
  if (!name || !fleetStore) return []
  const rows = fleetStore.db.prepare('SELECT * FROM agents WHERE friendly_name = ? AND dead = 0').all(name)
  return rows.map(r => fleetStore._hydrateAgent(r))
}

function surfaceSpawnBounce(error) {
  const payload = {
    ...(error.payload || {}),
    message: error.message,
    ts: Date.now(),
  }
  // 2a: raise the collision as a notification card via the real notif spine
  // (collision detected + surfaced — the refactor's value). Action buttons
  // (pick-another / respawn behavior) are a tracked post-cutover follow-up (2b),
  // OMITTED here so we don't ship dead buttons. The notif Item type has actions
  // optional and the adapter handles no-actions safely.
  const agentId = payload.existing?.id || payload.name || 'unknown'
  const item = {
    id: `spawn-bounce:${agentId}`,
    kind: 'bounce',
    from: agentId,
    title: 'Spawn name collision',
    body: error.message,
    present: { chat: true, hud: true },
    priority: 'high',
  }
  payload.item = item
  raiseItem(SERVER_OWNER_ID, item)
  broadcastEvent('spawn-bounced', payload)
  throw error
}

// A fresh spawn is a new-agent intent. If its tentative name is occupied, the
// registering agent gets a deterministic variant from FleetStore's allocator.
// Non-fresh spawns keep the old convenience behavior: a live exact-name match
// wakes the existing agent by durable fleet id.
async function resolveSpawnTarget(name, respawn, { fresh = false, requested = {} } = {}) {
  if (respawn || !name || !fleetStore) return { name, respawn }
  let resolved
  try {
    resolved = resolveSpawnCollision({
      name,
      respawn,
      fresh,
      requested,
      liveMatches: liveAgentsByName(name),
      projectForCwd,
    })
  } catch (e) {
    if (e instanceof SpawnBounceError) return surfaceSpawnBounce(e)
    throw e
  }
  const existing = resolved.existing
  if (!existing) return { name: resolved.name, respawn: resolved.respawn }
  try {
    await fleetStore.share({
      type: 'activity', from: existing.id, to: existing.id,
      text: 'spawn', metadata: { tool: 'spawn', synthetic: true }, unread: false,
    })
    fleetStore._bustAgentsCache?.()
    broadcastState(existing)
  } catch (e) {
    console.error(`[spawn] synthetic activity failed for ${existing.id}: ${e.message}`)
  }
  // Carry the resolved fleet-id, NOT the friendly name, into the wake. The name
  // is re-resolvable to the wrong (dead/corrupted) namesake downstream; the id is
  // the permanent anchor. fleet-spawn's `fleet:`-prefix branch resumes that exact
  // identity's session. This is the S2 half of the wake fix (identity, not
  // name-grep) — see scratch/registration-rules.md.
  return { name: resolved.name, respawn: resolved.respawn }
}

function assignSpawnPhase(agentQuery, phase) {
  if (!agentQuery || !phase) return null
  if (!PHASES.includes(phase)) throw new Error(`phase must be one of: ${PHASES.join(', ')}`)
  const agent = fleetStore.findAgent(agentQuery)
  if (!agent) throw new Error(`agent not found for lineage assignment: ${agentQuery}`)
  const lineageName = agent.friendly_name || agentQuery
  const lineage = fleetStore.getOrCreateLineage(lineageName)
  fleetStore.makeRoomForPhase(lineage.id, phase)
  fleetStore.assignPhase(agent.id, lineage.id, phase)
  broadcastState(agent)
  return { agent: agent.id, lineage: lineage.id, lineage_name: lineage.friendly_name, phase }
}

function spawnMailboxCompletionText(entry, status, detail) {
  const label = detail.label || detail.agentId || entry.meta?.name || 'spawn'
  if (status === 'completed') {
    const agentPart = detail.agentId ? ` (${detail.agentId})` : ''
    const policyPart = detail.grantedPermission ? ` Permission: \`${detail.grantedPermission}\`.` : ''
    return `**Spawn mailbox ${entry.id} complete**: \`${label}\`${agentPart} has logged in and is ready for inbox pickup.${policyPart}`
  }
  return `**Spawn mailbox ${entry.id} failed**: \`${label}\` — ${detail.error || detail.reason || 'spawn failed'}.`
}

function deliverSpawnMailboxCompletion(entry, status, detail) {
  deliverTldaFeedbackChat({
    from: 'fleet:tlda',
    to: entry.ownerId,
    text: spawnMailboxCompletionText(entry, status, detail),
    metadata: {
      type: 'mailbox_complete',
      mailbox_id: entry.id,
      mailbox_kind: entry.kind,
      status,
      ...detail,
    },
  })
}

async function performSpawnRelay(caller, msg) {
  if (!caller?.id) throw new Error('spawn caller identity is required')
  const {
    name, agent, model, doc, cwd, respawn, fresh, refresh, effort, mode,
    permission, spawnPermission, permissions, requestedPermissions, policy, session, sessionId, session_id, enroll, routeAgent,
    iLikeToLiveDangerously, phase, mailboxTarget,
  } = msg || {}
  const requestedSession = session || sessionId || session_id || null
  const spawnReservedKeys = new Set([
    'type', 'name', 'agent', 'model', 'doc', 'cwd', 'respawn', 'fresh', 'refresh',
    'effort', 'mode', 'permission', 'spawnPermission', 'permissions',
    'requestedPermissions', 'policy', 'session', 'sessionId', 'session_id',
    'enroll', 'routeAgent', 'iLikeToLiveDangerously', 'phase', 'mailboxTarget',
    'modelOptions',
  ])
  const modelOptions = {
    ...(msg?.modelOptions && typeof msg.modelOptions === 'object' && !Array.isArray(msg.modelOptions) ? msg.modelOptions : {}),
    ...(effort ? { effort } : {}),
  }
  for (const [key, value] of Object.entries(msg || {})) {
    if (!spawnReservedKeys.has(key) && value != null && value !== '') modelOptions[key] = value
  }
  const sessionMode = !!requestedSession
  if (refresh) {
    throw new Error('refresh is disabled through MCP spawn; recover the original resume handle before respawning')
  }
  const shouldRespawn = !!respawn || (!fresh && !refresh && !!agent)
  let spawnName = sessionMode ? (name || null) : (fresh ? name : (agent || name))
  let refreshTarget = null
  let routeTarget = null
  if (!sessionMode && (shouldRespawn || refresh) && agent) {
    const existing = fleetStore?.findAgent(agent)
    routeTarget = existing || null
    // Carry the fleet-id (not the friendly name) so the wake targets that exact
    // identity's session — fleet-spawn re-resolves a name to the wrong namesake,
    // but resumes a `fleet:` id directly. findAgent is now liveness-aware, so it
    // already picked the live holder; pass that choice through, don't re-grep.
    spawnName = existing?.id || agent
    if (refresh) refreshTarget = existing
  }
  if (!sessionMode && fresh && routeAgent) {
    routeTarget = fleetStore?.findAgent(routeAgent) || null
    if (!routeTarget) throw new Error(`spawn route anchor not found: ${routeAgent}`)
  }
  if (!sessionMode && !spawnName) throw new Error(fresh ? 'fresh spawn requires name' : 'agent name required')
  if (refresh && !refreshTarget) refreshTarget = fleetStore?.findAgent(spawnName)
  if (!sessionMode && (shouldRespawn || refresh) && !routeTarget) routeTarget = fleetStore?.findAgent(spawnName) || null
  if (!sessionMode && (shouldRespawn || refresh) && !routeTarget) throw new Error(`spawn target not found: ${spawnName}`)
  const requestedSpec = { model, project: doc }
  const requestedPermission = permission || spawnPermission || null
  const storedRespawnPermissions = (!sessionMode && !fresh && routeTarget?.metadata)
    ? (routeTarget.metadata.requestedPermissions || routeTarget.metadata.permissionProfile || routeTarget.metadata.spawnPolicy || null)
    : null
  const permissionRequest = permissions || requestedPermissions || storedRespawnPermissions || null
  const route = resolveSpawnMachine({
    caller,
    targetAgent: routeTarget,
    fresh: !!fresh || sessionMode,
    respawn: !sessionMode && shouldRespawn && !refresh,
    refresh: !!refresh,
    fleetStore,
    daemonConnections,
    onDaemonMissing: (machineId, context, detail) => logSpawnDaemonMiss(machineId, context, detail),
  })
  const machineId = route.machine_id
  const resolved = sessionMode
    ? { name: spawnName, respawn: false }
    : (resolveSpawnTarget
    ? await resolveSpawnTarget(spawnName, shouldRespawn && !refresh, {
        fresh: !!fresh,
        requested: requestedSpec,
      })
    : { name: spawnName, respawn: shouldRespawn && !refresh })
  const pendingAgentId = (!sessionMode && !resolved.respawn && !refresh) ? mintFleetId() : null
  const targetAgentId = pendingAgentId || routeTarget?.id || (resolved.name?.startsWith?.('fleet:') ? resolved.name : null)
  const mailbox = mailboxLibrarian.start({
    kind: 'spawn',
    ownerId: caller.id,
    timeoutMs: Number(process.env.TLDA_SPAWN_MAILBOX_DEADLINE_MS || 5 * 60_000),
    meta: {
      name: spawnName,
      agentId: targetAgentId,
      machineId,
      fresh: !!fresh || sessionMode,
      respawn: sessionMode ? false : (refresh ? false : resolved.respawn),
      refresh: !!refresh,
      phase: phase || null,
    },
  })
  const mailboxDeadlineAt = mailbox.deadlineAt || (Date.now() + 5 * 60_000)
  const readiness = pendingAgentId
    ? spawnLibrarian.awaitLogin({ id: pendingAgentId, name: spawnName, spec: requestedSpec })
    : null
  const spawnRequest = {
    agent_id: targetAgentId,
    friendly_name: pendingAgentId ? spawnName : undefined,
    pretty_name: pendingAgentId ? prettyNameForFriendlyName(spawnName) : undefined,
    name: resolved.name || undefined,
    model: model || undefined,
    modelOptions,
    doc: doc || undefined,
    cwd: cwd || undefined,
    session_id: requestedSession || undefined,
    enroll: !!enroll || undefined,
    effort: effort || undefined,
    mode: mode || undefined,
    requestedPermission: requestedPermission || undefined,
    requestedPermissions: permissionRequest || undefined,
    policy: policy || undefined,
    acknowledgeNoSecurity: !!iLikeToLiveDangerously,
    requester: {
      id: caller.id,
      name: caller.friendly_name || caller.name || undefined,
      human: !!caller.human,
      spawnPolicy: caller.metadata?.spawnPolicy || undefined,
    },
    spawnRoute: route.source,
    daemon_env_name: route.env_name,
    respawn: sessionMode ? false : (refresh ? false : resolved.respawn),
    refresh: !!refresh,
  }
  void (async () => {
    try {
      let result
      try {
        for (;;) {
          result = await sendRpc(machineId, 'spawn', spawnRequest)
          const pendingIdentity = result?.ok === false &&
            (result.reason === 'identity-ingestion-pending' || result.code === 'identity-ingestion-pending')
          if (!pendingIdentity) break
          const remaining = mailboxDeadlineAt - Date.now()
          if (remaining <= 0) break
          const waitMs = Math.min(Math.max(Number(result.retry_after_ms || 1000), 250), 5000, remaining)
          await new Promise(r => setTimeout(r, waitMs))
        }
        if (pendingAgentId && result?.ok === false) {
          spawnLibrarian.failPending(pendingAgentId, result.code || result.reason || 'launch-failed')
        }
      } catch (e) {
        if (pendingAgentId && /RPC timeout .*op=spawn/.test(e.message || '')) {
          result = { ok: false, reason: 'spawning' }
        } else {
          if (pendingAgentId) spawnLibrarian.failPending(pendingAgentId, 'launch-failed')
          const settled = mailboxLibrarian.fail(mailbox.id, e.message || 'launch-failed', {
            reason: e.code || 'launch-failed',
            error: e.message || String(e),
          })
          if (settled) deliverSpawnMailboxCompletion(settled, 'failed', { error: e.message || String(e), reason: e.code || 'launch-failed' })
          return
        }
      }
      if (pendingAgentId && mailboxTarget && result?.reason === 'spawning') {
        const shell = fleetStore?.getAgent?.(pendingAgentId)
        if (shell?.metadata?.shell) {
          result = { ok: true, pending: true, agent: shell }
        } else {
          spawnLibrarian.failPending(pendingAgentId, 'login-timeout')
          const failed = {
            ok: false,
            reason: 'login-timeout',
            error: `spawn started for ${spawnName}, but no reserved shell row exists for ${pendingAgentId}`,
          }
          const settled = mailboxLibrarian.fail(mailbox.id, failed.error, failed)
          if (settled) deliverSpawnMailboxCompletion(settled, 'failed', failed)
          return
        }
      }
      if (result?.ok === false && result.reason !== 'spawning') {
        if (pendingAgentId) spawnLibrarian.failPending(pendingAgentId, result.reason || result.error || 'launch-failed')
        const settled = mailboxLibrarian.fail(mailbox.id, result.error || result.reason || 'launch-failed', result)
        if (settled) deliverSpawnMailboxCompletion(settled, 'failed', { ...result, error: result.error || result.reason || 'launch-failed' })
        return
      }
      let ready = null
      if (readiness) {
        ready = await readiness
        if (!ready.ok) {
          const settled = mailboxLibrarian.fail(mailbox.id, ready.reason, ready)
          if (settled) deliverSpawnMailboxCompletion(settled, 'failed', { ...ready, error: ready.reason })
          return
        }
      }
      let agentRecord = ready?.agent || result?.agent || (result?.agent_id ? fleetStore.findAgent(result.agent_id) : null) || (targetAgentId ? fleetStore.findAgent(targetAgentId) : null)
      if (agentRecord?.id && (result?.resume_id || result?.tmux_session || route.env_name)) {
        const patchedAgent = {
          ...agentRecord,
          tmux_session: result?.tmux_session || agentRecord.tmux_session,
          resume_id: result?.resume_id || agentRecord.resume_id,
          machine_id: route.machine_id,
          env_name: route.env_name,
          daemon_key: daemonAddress(route.machine_id, route.env_name),
        }
        fleetStore.upsertAgent(patchedAgent)
        agentRecord = fleetStore.getAgent?.(agentRecord.id) || patchedAgent
        if (ready?.agent?.id === agentRecord.id) ready.agent = agentRecord
      }
      let lineage = null
      if (phase && agentRecord?.id) {
        try {
          lineage = assignSpawnPhase(agentRecord.id, phase)
        } catch (e) {
          const settled = mailboxLibrarian.fail(mailbox.id, e.message || 'lineage assignment failed', { ...result, phase, error: e.message })
          if (settled) deliverSpawnMailboxCompletion(settled, 'failed', { ...result, error: `lineage assignment failed: ${e.message}` })
          return
        }
      }
      const registeredPolicy = agentRecord?.metadata?.spawnPolicy
      const spawnPolicy = result?.spawnPolicy || registeredPolicy
      const assignedName = agentRecord?.friendly_name || result?.assigned_name || result?.name || spawnName
      const requestedName = result?.requested_name || spawnName
      const completion = {
        ...result,
        agentId: agentRecord?.id || result?.agent_id || targetAgentId || null,
        label: assignedName,
        assigned_name: assignedName,
        requested_name: requestedName,
        name_changed: result?.name_changed ?? (assignedName !== requestedName),
        spawnPolicy,
        grantedPermission: result?.grantedPermission || spawnPolicy?.permission,
        spawnerPermission: result?.spawnerPermission,
        projectPermission: result?.projectPermission,
        modelPermission: result?.modelPermission,
        lineage,
      }
      const settled = mailboxLibrarian.complete(mailbox.id, completion)
      if (settled) deliverSpawnMailboxCompletion(settled, 'completed', completion)
      broadcastState()
    } catch (e) {
      if (pendingAgentId) spawnLibrarian.failPending(pendingAgentId, 'launch-failed')
      const settled = mailboxLibrarian.fail(mailbox.id, e.message || 'launch-failed', {
        reason: e.code || 'launch-failed',
        error: e.message || String(e),
      })
      if (settled) deliverSpawnMailboxCompletion(settled, 'failed', { error: e.message || String(e), reason: e.code || 'launch-failed' })
    }
  })()
  return {
    ok: true,
    async: true,
    status: 'pending',
    mailbox_id: mailbox.id,
    agent_id: targetAgentId,
    name: spawnName,
    machine_id: machineId,
    env_name: route.env_name,
  }
}

// Wire fleet store events → WS broadcast
if (fleetStore) {
  fleetStore.onEvent?.((event) => broadcastEvent('fleet-event', event))
}

// Backfill session_entries from JSONL files as delayed background work.
function scheduleSessionEntryBackfill() {
  if (!fleetStore || SESSION_BACKFILL_STARTUP_DELAY_MS < 0) return
  const CLAUDE_PROJECTS = join(os.homedir(), '.claude', 'projects')
  setTimeout(() => {
    fleetStore.backfillSessionEntries(CLAUDE_PROJECTS).then(({ indexed, skipped }) => {
      if (indexed > 0) console.log(`[fleet-store] search backfill: indexed ${indexed} sessions (${skipped} already indexed)`)
    }).catch(e => console.error('[fleet-store] search backfill failed:', e.message))
  }, SESSION_BACKFILL_STARTUP_DELAY_MS).unref?.()
}
scheduleSessionEntryBackfill()

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
  const configuredSpawnMachine = process.env.TLDA_SPAWN_MACHINE_ID || loadConfig()?.spawnMachineId
  if (configuredSpawnMachine && !fleetStore.getFleetPref(SERVER_OWNER_ID, SPAWN_MACHINE_PREF_KEY)) {
    fleetStore.setFleetPref(SERVER_OWNER_ID, SPAWN_MACHINE_PREF_KEY, configuredSpawnMachine)
    console.log(`[spawn-route] configured ${SERVER_OWNER_ID} ${SPAWN_MACHINE_PREF_KEY}=${configuredSpawnMachine}`)
  }
}

// Full chat delivery pipeline used by tlda-feedback (push-channel
// notifications for doc annotations). Mirrors the WS 'chat' handler:
// share → addUnread → broadcast. Calling only fleetStore.share leaves
// the message invisible to getUnread, so the recipient's MCP never
// surfaces it as a <channel> system-reminder.
function deliverTldaFeedbackChat({ from, to, text, metadata }) {
  if (!fleetStore) return
  Promise.resolve(fleetStore.share?.({ type: 'chat', from, to, text, metadata }))
    .then(event => {
      if (!event) return
      fleetStore.addUnread?.(event.id, to)
      broadcastEvent('fleet-event', { type: 'chat', from, to, id: event.id, text, event_id: event.id })
    })
    .catch(e => console.error(`[fleet-feedback] delivery failed: ${e.message}`))
}

async function reportFleetIncident({ severity = 'warning', component, operation, actors, impact, evidence, error }) {
  const text = [
    `**Fleet incident: ${component || 'unknown'}/${operation || 'unknown'}**`,
    '',
    `Severity: \`${severity}\``,
    `Impact: ${impact || 'unknown'}`,
    '',
    '```json',
    JSON.stringify(compactObject({ actors, evidence, error }), null, 2).slice(0, 3000),
    '```',
  ].join('\n')
  const event = await fleetStore.chat('fleet:tlda', SERVER_OWNER_ID, text, {
    type: 'fleet_incident',
    severity,
    component,
    operation,
    actors,
    impact,
    evidence,
    error,
  })
  if (event) {
    broadcastEvent('fleet-event', {
      type: 'chat',
      from: 'fleet:tlda',
      to: SERVER_OWNER_ID,
      id: event.id,
      text,
      event_id: event.id,
      metadata: event.metadata || null,
    })
  }
  return event
}

async function reportSyncSignalFailure(failure) {
  syncSignalLog.warn(failure, 'sync signal delivery failed')
  try {
    await reportFleetIncident({
      severity: 'warning',
      component: 'sync-signals',
      operation: failure.operation,
      actors: {
        docName: failure.docName,
        sessionId: failure.sessionId || null,
      },
      impact: `Transient sync signal ${failure.key || 'unknown'} failed during ${failure.operation || 'unknown operation'}.`,
      evidence: {
        key: failure.key || null,
        docName: failure.docName || null,
        sessionId: failure.sessionId || null,
        timestamp: failure.timestamp || null,
      },
      error: failure.error || null,
    })
  } catch (err) {
    syncSignalLog.error({
      failure,
      reportingError: err?.stack || err?.message || String(err),
    }, 'sync signal incident reporting failed')
  }
}

async function reportDaemonEventFailure(msg, operation, error) {
  const incident = daemonEventFailureIncident(msg, operation, error)
  daemonEventLog.warn({ incident }, 'daemon event delivery failed')
  try {
    await reportFleetIncident(incident)
  } catch (err) {
    daemonEventLog.error({
      incident,
      reportingError: err?.stack || err?.message || String(err),
    }, 'daemon event incident reporting failed')
  }
}

const notificationAttempts = createNotificationAttemptRecorder({
  fleetStore,
  logger: notificationAttemptLog,
  reportIncident: reportFleetIncident,
})

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
    // Auto-spawn a QA watcher agent when new content is committed to the shadow repo.
    // version-committed is the semantic trigger (new prose exists); build-card is UI-level.
    // The spawn library reserves an agent shell before starting tmux, so findAgent() works
    // immediately after the spawn RPC resolves — no login hook or name-pattern needed.
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
    const { name: docName, hash, summary, lintFindings = [], mirrorFailed, buildFailed, errors = [], warnings = [], lastMirrorSuccess, lastBuildSuccess, buildFiles, editedBy } = event
    const text = buildFailed
      ? `❌ Build failed — ${docName}: ${buildFailed}`
      : mirrorFailed
      ? `⚠️ Mirror failed — ${docName} (${hash}): ${mirrorFailed}`
      : `Build ${hash} — ${docName}`
    const metadata = {
      type: 'build_result',
      name: docName,
      hash: hash || null,
      summary: summary || null,
      lintFindings,
      mirrorFailed: mirrorFailed || null,
      buildFailed: buildFailed || null,
      errors,
      warnings,
      lastMirrorSuccess: lastMirrorSuccess || null,
      lastBuildSuccess: lastBuildSuccess || null,
      buildFiles: buildFiles || null,
    }

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
  if (!agent || !agent.machine_id || !agent.env_name) {
    return { via: 'none', code: 503, error: `agent has no daemon address (op=${op})` }
  }
  const dws = daemonConnections.get(daemonAddress(agent.machine_id, agent.env_name))
  if (!dws || dws.readyState !== 1) {
    return { via: 'none', code: 503, error: `no fleet-daemon connected for ${describeAgentAddress(agent.machine_id, agent.env_name)} (op=${op})` }
  }
  return { via: 'daemon', machine_id: daemonAddress(agent.machine_id, agent.env_name), daemon_address: daemonAddress(agent.machine_id, agent.env_name), env_name: agent.env_name, daemon: dws }
}

function agentDaemonAddress(agent) {
  return daemonAddress(agent?.machine_id, agent?.env_name)
}

function patchEventMetadata(eventId, updater) {
  const event = fleetStore.getEventById?.(eventId)
  if (!event) return null
  const current = event.metadata || {}
  const next = updater(current)
  fleetStore.db.prepare('UPDATE events SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(next), eventId)
  broadcastEvent('event-update', { id: eventId, metadata_patch: next })
  return next
}

function patchRecipientAttachmentState(eventId, recipientId, attachmentId, record) {
  return patchEventMetadata(eventId, metadata => (
    setRecipientAttachmentState(metadata, recipientId, attachmentId, record)
  ))
}

function notifyRecipientMaterialization({ eventId, recipientId, attachment, record }) {
  const state = record?.state
  if (!recipientId || !eventId || !state) return
  const title = attachment?.name || record?.title || `attachment ${attachment?.id ?? ''}`.trim()
  const location = record.localPath || record.projectPath || record.projectArtifactId || null
  const text = state === 'available'
    ? `Attachment materialized for message ${eventId}: ${title}${location ? `\n${location}` : ''}`
    : `Attachment materialization failed for message ${eventId}: ${title}${record.error ? `\n${record.error}` : ''}`
  deliverTldaFeedbackChat({
    from: 'tlda-materializer',
    to: recipientId,
    text,
    metadata: {
      source: 'materialization',
      source_event_id: eventId,
      attachment_id: attachment?.id != null ? String(attachment.id) : null,
      state,
      priority: state === 'failed' ? 'important' : 'normal',
    },
  })
}

function isMarkdownAttachment(attachment = {}, result = {}) {
  const mime = String(attachment.mimeType || attachment.contentType || result.contentType || '').toLowerCase()
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return true
  const name = String(attachment.name || result.name || result.localPath || result.path || '').toLowerCase()
  return name.endsWith('.md') || name.endsWith('.markdown')
}

async function fetchAttachmentTextForProjectArtifact(attachment) {
  if (!attachment?.url) throw new Error('attachment url required')
  const target = new URL(attachment.url, getFleetServerUrl()).toString()
  const res = await fetch(target, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`attachment fetch failed: HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MATERIALIZATION_MAX_BYTES) {
    throw new Error(`attachment exceeds max size (${len} > ${MATERIALIZATION_MAX_BYTES})`)
  }
  const ab = await res.arrayBuffer()
  if (ab.byteLength > MATERIALIZATION_MAX_BYTES) {
    throw new Error(`attachment exceeds max size (${ab.byteLength} > ${MATERIALIZATION_MAX_BYTES})`)
  }
  return Buffer.from(ab).toString('utf8')
}

async function materializeProjectMarkdownAttachment({ eventId, recipient, sourceAgent, attachment }) {
  if (!isMarkdownAttachment(attachment)) return null
  const markdown = await fetchAttachmentTextForProjectArtifact(attachment)
  const sourceAgentRow = sourceAgent ? fleetStore.getAgent?.(sourceAgent) : null
  return realizeProjectMarkdownArtifact({
    cwd: recipient.cwd,
    markdown,
    title: attachment.name || null,
    actor: sourceAgentRow ? {
      friendlyName: sourceAgentRow.friendly_name || sourceAgent,
      fleetId: sourceAgent,
    } : sourceAgent,
    provenance: {
      sourceAgent: sourceAgent || 'unknown',
      recipient: recipient.id,
      eventId,
      attachmentId: String(attachment.id),
      url: attachment.url || null,
    },
  })
}

async function materializeRecipientAttachment({ eventId, recipientId, sourceAgent, attachment }) {
  const recipient = fleetStore.getAgent?.(recipientId)
  if (!recipient || recipient.human) return
  const fail = (error) => {
    const record = {
      kind: 'attachment',
      state: 'failed',
      status: 'failed',
      title: attachment.name || null,
      contentType: attachment.mimeType || null,
      hash: attachment.sha256 || null,
      sourceAgent: sourceAgent || 'unknown',
      provenance: {
        eventId,
        attachmentId: String(attachment.id),
        url: attachment.url || null,
      },
      error,
      updated_at: new Date().toISOString(),
    }
    patchRecipientAttachmentState(eventId, recipientId, attachment.id, record)
    notifyRecipientMaterialization({ eventId, recipientId, attachment, record })
  }
  const route = resolveRpc('materialize-attachment', recipient)
  if (route.via === 'none') {
    fail(route.error)
    return
  }
  try {
    const result = await sendRpc(route.machine_id, 'materialize-attachment', {
      event_id: eventId,
      attachment_id: attachment.id,
      source_agent: sourceAgent || 'unknown',
      server_url: getFleetServerUrl(),
      url: attachment.url,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      sha256: attachment.sha256,
    })
    let projectArtifact = null
    try {
      projectArtifact = await materializeProjectMarkdownAttachment({ eventId, recipient, sourceAgent, attachment })
    } catch (e) {
      projectArtifact = {
        state: 'failed',
        status: 'failed',
        projectArtifactId: null,
        error: e.message || String(e),
      }
    }
    const record = {
      kind: 'attachment',
      state: 'available',
      status: 'ready',
      title: attachment.name || null,
      localPath: result.localPath || result.path,
      projectPath: projectArtifact?.projectPath || null,
      projectArtifactId: projectArtifact?.projectArtifactId || null,
      ...(projectArtifact ? {
        projectArtifactStatus: projectArtifact.status || projectArtifact.state || null,
        ...(projectArtifact.project ? { project: projectArtifact.project } : {}),
        ...(projectArtifact.render ? { render: projectArtifact.render } : {}),
        ...(projectArtifact.error ? { projectArtifactError: projectArtifact.error } : {}),
      } : {}),
      contentType: attachment.mimeType || null,
      hash: result.hash || result.sha256,
      sourceAgent: sourceAgent || 'unknown',
      provenance: {
        eventId,
        attachmentId: String(attachment.id),
        url: attachment.url || null,
      },
      size: result.size,
      sha256: result.sha256,
      materialized_at: new Date().toISOString(),
    }
    patchRecipientAttachmentState(eventId, recipientId, attachment.id, record)
    notifyRecipientMaterialization({ eventId, recipientId, attachment, record })
  } catch (e) {
    fail(e.message || String(e))
  }
}

function queueRecipientMaterialization({ eventId, recipientId, sourceAgent, attachments }) {
  for (const attachment of attachments || []) {
    if (!isMaterializableAttachment(attachment)) continue
    setImmediate(() => {
      materializeRecipientAttachment({ eventId, recipientId, sourceAgent, attachment })
        .catch(e => {
          const record = {
            kind: 'attachment',
            state: 'failed',
            status: 'failed',
            title: attachment.name || null,
            contentType: attachment.mimeType || null,
            hash: attachment.sha256 || null,
            sourceAgent: sourceAgent || 'unknown',
            provenance: {
              eventId,
              attachmentId: String(attachment.id),
              url: attachment.url || null,
            },
            error: e.message || String(e),
            updated_at: new Date().toISOString(),
          }
          patchRecipientAttachmentState(eventId, recipientId, attachment.id, record)
          notifyRecipientMaterialization({ eventId, recipientId, attachment, record })
        })
    })
  }
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

app.use((req, res, next) => {
  const start = performance.now()
  res.on('finish', () => {
    const durationMs = performance.now() - start
    if (res.statusCode >= 500 || durationMs >= 1000) {
      recordServerPerfEvent(res.statusCode >= 500 ? 'http-error' : 'http-slow', {
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: res.statusCode,
        durationMs,
      })
    }
  })
  next()
})

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), pid: process.pid })
})

app.get('/api/build-info', (_req, res) => {
  res.set('Cache-Control', 'no-store')
  const result = readBuildInfo(join(__dirname, 'build-info.json'))
  if (!result.ok) {
    res.status(result.status).json({
      ok: false,
      error: result.error,
    })
    return
  }
  res.json({
    ok: true,
    ...result.buildInfo,
  })
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
// Deepgram is SDK-only (one implementation, Skip 6/19) — bin/deepgram-sdk-bridge.mjs.
// The bridge listens on TLS (wss) only when the mkcert localhost certs exist — the
// SAME condition the bridge uses to choose its server. On Fly there are no mkcert
// certs, so the bridge runs on plain ws; matching the scheme here is what lets the
// proxy actually reach it off Skip's local machine.
const _dgCert = path.join(homedir(), '.config/tlda/localhost+2.pem')
const _dgKey = path.join(homedir(), '.config/tlda/localhost+2-key.pem')
const _dgWsScheme = existsSync(_dgCert) && existsSync(_dgKey) ? 'wss' : 'ws'
const DEEPGRAM_SDK_BRIDGE_URL = `${_dgWsScheme}://127.0.0.1:8180`
const WHISPER_BRIDGE_URL = 'ws://127.0.0.1:8179'

async function isBridgeUp(bridgeUrl) {
  const WS = (await import('ws')).default
  return new Promise(resolve => {
    let done = false
    let ws
    const finish = (v) => { if (!done) { done = true; try { ws?.close() } catch {}; resolve(v) } }
    try {
      ws = new WS(bridgeUrl, { rejectUnauthorized: false })
      ws.on('open', () => finish(true))
      ws.on('error', () => finish(false))
      setTimeout(() => finish(false), 800)
    } catch { resolve(false) }
  })
}

function hasDeepgramKey() {
  if (process.env.DEEPGRAM_API_KEY) return true
  try { return !!loadConfig()?.deepgramApiKey } catch { return false }
}

app.get('/api/voice/backends', async (req, res) => {
  try {
    const backends = [
      { value: '', label: 'Off', available: true },
      { value: 'chrome', label: 'Browser', available: true },
    ]
    if (hasDeepgramKey()) backends.push({ value: 'deepgram-sdk', label: 'Deepgram', available: true })
    if (await isBridgeUp(WHISPER_BRIDGE_URL)) backends.push({ value: 'whisper', label: 'Whisper', available: true })
    res.json({ backends })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

async function spawnVoiceBridge({ bridgeUrl, scriptName, logName, label }) {
  if (await isBridgeUp(bridgeUrl)) return { ok: true, started: false }

  const { spawn } = await import('child_process')
  const { openSync } = await import('fs')
  const { dirname, join } = await import('path')
  const { fileURLToPath } = await import('url')
  const here = dirname(fileURLToPath(import.meta.url))
  const tldaRoot = dirname(here)
  const bridgeScript = join(tldaRoot, 'bin', scriptName)
  const logPath = join(process.env.HOME || '', '.config', 'tlda', logName)
  const fd = openSync(logPath, 'a')
  const child = spawn('node', [bridgeScript], {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: tldaRoot,
  })
  child.unref()
  console.log(`[voice] ${label} bridge spawned (pid ${child.pid})`)
  return { ok: true, started: true, pid: child.pid }
}

app.post('/api/voice/deepgram-sdk/start', async (req, res) => {
  try {
    res.json(await spawnVoiceBridge({
      bridgeUrl: DEEPGRAM_SDK_BRIDGE_URL,
      scriptName: 'deepgram-sdk-bridge.mjs',
      logName: 'deepgram-sdk-bridge.log',
      label: 'deepgram sdk',
    }))
  } catch (err) {
    console.error('[voice] deepgram-sdk/start failed:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/voice/deepgram-sdk/stop', async (req, res) => {
  try {
    const { execSync } = await import('child_process')
    try { execSync('pkill -f "deepgram-sdk-bridge.mjs" 2>/dev/null', { timeout: 3000 }) } catch {}
    console.log('[voice] deepgram sdk bridge stopped')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Ensure the (SDK) deepgram bridge is running, spawning it if needed. Used by the
// /voice/deepgram-sdk WS proxy so a device that can't reach 127.0.0.1:8180 (the
// iPad) still gets a live bridge. Concurrent callers share one spawn.
let _deepgramSdkBridgeStarting = null
async function ensureDeepgramSdkBridge() {
  if (await isBridgeUp(DEEPGRAM_SDK_BRIDGE_URL)) return true
  if (!_deepgramSdkBridgeStarting) {
    _deepgramSdkBridgeStarting = (async () => {
      await spawnVoiceBridge({
        bridgeUrl: DEEPGRAM_SDK_BRIDGE_URL,
        scriptName: 'deepgram-sdk-bridge.mjs',
        logName: 'deepgram-sdk-bridge.log',
        label: 'deepgram sdk',
      })
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 250))
        if (await isBridgeUp(DEEPGRAM_SDK_BRIDGE_URL)) return
      }
    })().finally(() => { _deepgramSdkBridgeStarting = null })
  }
  await _deepgramSdkBridgeStarting
  return isBridgeUp(DEEPGRAM_SDK_BRIDGE_URL)
}

// Services health — checks tlda server (self), fleet server, Yjs sync
app.get('/health/services', async (req, res) => {
  const FLEET_URL = process.env.FLEET_SERVER || 'http://localhost:5199'
  const services = {
    tlda: { ok: true, uptime: process.uptime() },
    fleet: { ok: false, error: null },
    sync: { ok: true },
  }

  // Check fleet server without loading the full roster.
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2000)
    const r = await fetch(`${FLEET_URL}/api/agents/summary`, { signal: ctrl.signal })
    clearTimeout(timer)
    if (r.ok) {
      const data = await r.json()
      services.fleet = { ok: true, agents: data.live ?? data.total ?? 0 }
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
// gets forwarded here automatically. See project guidance on client logging.
const CLIENT_LOG_FILE = join(homedir(), '.config', 'tlda', 'client.log')
const CLIENT_PROFILE_FILE = join(homedir(), '.config', 'tlda', 'client-profile.jsonl')
const LIVE_PERF_MAX_SAMPLES = 250
const livePerfSamples = []
const livePerfByDoc = new Map()

function recordLivePerfEntry(entry) {
  const data = entry?.data && typeof entry.data === 'object' ? entry.data : {}
  const docName = data.document?.name || data.doc || null
  const sample = {
    ts: entry.ts || new Date().toISOString(),
    sessionId: data.sessionId || null,
    doc: docName,
    reason: data.reason || null,
    data,
  }
  livePerfSamples.push(sample)
  if (livePerfSamples.length > LIVE_PERF_MAX_SAMPLES) {
    livePerfSamples.splice(0, livePerfSamples.length - LIVE_PERF_MAX_SAMPLES)
  }
  if (docName) {
    const docSamples = livePerfByDoc.get(docName) || []
    docSamples.push(sample)
    if (docSamples.length > LIVE_PERF_MAX_SAMPLES) {
      docSamples.splice(0, docSamples.length - LIVE_PERF_MAX_SAMPLES)
    }
    livePerfByDoc.set(docName, docSamples)
  }
}

function appendClientLogEntry(entry) {
  const obj = {
    ts: entry.ts || new Date().toISOString(),
    level: entry.level || 'info',
    ns: entry.ns || 'unknown',
    msg: entry.msg ?? '',
    ...(entry.data !== undefined ? { data: entry.data } : {}),
    ...(entry.session ? { session: entry.session } : {}),
  }
  fs.appendFile(CLIENT_LOG_FILE, JSON.stringify(obj) + '\n', (err) => {
    if (err) console.log(`[client-log] append failed: ${err.message}`)
  })
}

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
    if (obj.ns === 'live-perf') recordLivePerfEntry(obj)
    lines.push(JSON.stringify(obj))
  }
  if (lines.length) {
    fs.appendFile(CLIENT_LOG_FILE, lines.join('\n') + '\n', (err) => {
      if (err) console.log(`[client-log] append failed: ${err.message}`)
    })
  }
  res.json({ ok: true, n: lines.length })
})

app.get('/api/diagnostics/live-perf', requireRead, (req, res) => {
  const doc = typeof req.query.doc === 'string' && req.query.doc ? req.query.doc : null
  const limitRaw = Number(req.query.limit || 50)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(250, Math.trunc(limitRaw))) : 50
  const sinceMs = typeof req.query.since === 'string' && req.query.since
    ? Date.parse(req.query.since)
    : NaN
  const source = doc ? (livePerfByDoc.get(doc) || []) : livePerfSamples
  const filteredSamples = Number.isFinite(sinceMs)
    ? source.filter(sample => Date.parse(sample.ts) >= sinceMs)
    : source
  const samples = filteredSamples.slice(-limit)
  const serverEvents = (Number.isFinite(sinceMs)
    ? serverPerfEvents.filter(event => Date.parse(event.ts) >= sinceMs)
    : serverPerfEvents
  ).slice(-limit)
  const docs = {}
  for (const sample of livePerfSamples) {
    const key = sample.doc || 'unknown'
    docs[key] = (docs[key] || 0) + 1
  }
  res.json({
    ok: true,
    count: samples.length,
    retained: livePerfSamples.length,
    docs,
    samples,
    server: {
      count: serverEvents.length,
      retained: serverPerfEvents.length,
      eventLoopLag: lastEventLoopLag,
      ws: wsSummary(),
      events: serverEvents,
    },
  })
})

function telemetryStatusSnapshotFromLiveBuffers() {
  return buildTelemetryStatusSnapshot({
    livePerfSamples,
    livePerfRetained: livePerfSamples.length,
    serverPerfEvents,
    serverPerfRetained: serverPerfEvents.length,
    eventLoopLag: lastEventLoopLag,
    ws: wsSummary(),
  })
}

app.get('/api/diagnostics/telemetry-status', requireRead, (req, res) => {
  res.json(telemetryStatusSnapshotFromLiveBuffers())
})

app.get('/api/diagnostics/telemetry-status.md', requireRead, (req, res) => {
  res.type('text/markdown').send(renderTelemetryStatusMarkdown(telemetryStatusSnapshotFromLiveBuffers()))
})

app.get('/api/diagnostics/control-plane-traces', requireRead, (req, res) => {
  const traceId = typeof req.query.trace_id === 'string' && req.query.trace_id ? req.query.trace_id : null
  const limitRaw = Number(req.query.limit || 50)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(250, Math.trunc(limitRaw))) : 50
  res.json(controlPlaneTraces.snapshot({ traceId, limit }))
})

app.get('/api/diagnostics/control-plane-traces.md', requireRead, (req, res) => {
  const traceId = typeof req.query.trace_id === 'string' && req.query.trace_id ? req.query.trace_id : null
  const limitRaw = Number(req.query.limit || 50)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(250, Math.trunc(limitRaw))) : 50
  res.type('text/markdown').send(renderControlPlaneTraceMarkdown(controlPlaneTraces.snapshot({ traceId, limit })))
})

app.post('/api/client-profile', (req, res) => {
  const body = req.body
  const entries = Array.isArray(body) ? body : [body]
  const lines = []
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    lines.push(JSON.stringify({
      ts: e.ts || new Date().toISOString(),
      kind: e.kind || 'client-profile',
      ...(e.doc ? { doc: e.doc } : {}),
      ...(e.href ? { href: e.href } : {}),
      ...(e.summary !== undefined ? { summary: e.summary } : {}),
      ...(e.readableStacks !== undefined ? { readableStacks: e.readableStacks } : {}),
      ...(e.trace !== undefined ? { trace: e.trace } : {}),
    }))
  }
  if (lines.length) {
    fs.appendFile(CLIENT_PROFILE_FILE, lines.join('\n') + '\n', (err) => {
      if (err) console.log(`[client-profile] append failed: ${err.message}`)
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

app.get('/api/reaper/report.md', requireRead, (req, res) => {
  const report = _lastReaperStatus?.markdownReport || '## Dev Reaper\n\nNo reaper status is available yet.'
  res.type('text/markdown').send(report)
})

// Sanitized provider/account usage status for the usage-meter shape. Same data
// as the `usage_status` MCP tool — manual/static config only, no scraping, no
// tokens. The shape polls this; missing config returns an empty accounts list.
app.get('/api/usage-status', requireRead, (req, res) => {
  try {
    res.json(normalizeUsageStatus(loadConfig()))
  } catch (e) {
    res.status(500).json({ error: `usage-status failed: ${e.message}` })
  }
})

app.post('/api/reaper/kill', requireRead, async (req, res) => {
  const { pid } = req.body
  if (!pid) return res.status(400).json({ error: 'missing pid' })
  const machineId = _lastReaperStatus?.daemon_key || LOCAL_DAEMON_ADDRESS
  try {
    const result = await sendRpc(machineId, 'reaper-kill', { pid })
    res.json(result || { ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/reaper/sweep', requireRead, async (req, res) => {
  const machineId = _lastReaperStatus?.daemon_key || LOCAL_DAEMON_ADDRESS
  try {
    const result = await sendRpc(machineId, 'reaper-sweep', {})
    res.json(result || { ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/playback/stream', requireRead, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('data: {"type":"connected"}\n\n')
  const keepalive = setInterval(() => res.write(':\n\n'), 15000)
  req.on('close', () => clearInterval(keepalive))
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

// Spawn model list for the spawn UI's autocomplete + validation. Single source
// of truth is agent-launch/models.mjs, so the UI never drifts from what spawn
// actually accepts. Shape: { default, models:[{alias,id,verified,kind}], verified:[id…] }.
function queryString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function resolveSpawnModelContext({ doc, cwd } = {}) {
  const directCwd = queryString(cwd)
  if (directCwd) return { doc: queryString(doc), cwd: directCwd, error: null }
  const docName = queryString(doc)
  if (!docName) return { doc: null, cwd: null, error: null }
  const project = readProject(docName)
  if (!project) return { doc: docName, cwd: null, error: `no project '${docName}'` }
  return { doc: docName, cwd: project.sourceDir || null, error: null }
}

app.get('/api/fleet/models', requireRead, (req, res) => {
  const context = resolveSpawnModelContext({ doc: req.query.doc, cwd: req.query.cwd })
  if (context.error) {
    res.status(404).json({ error: context.error })
    return
  }
  const daemonConfig = context.cwd ? readDaemonConfigForCwd(context.cwd) : readDaemonConfig()
  res.json(listSpawnModels(withDaemonModelAliases(loadConfig(), daemonConfig)))
})

app.get('/api/fleet/spawn-availability', requireRead, async (req, res) => {
  const context = resolveSpawnModelContext({ doc: req.query.doc, cwd: req.query.cwd })
  if (context.error) {
    res.status(404).json({ schema: 1, ok: false, error: context.error, aliases: [], defaultAlias: '' })
    return
  }
  if (req.query.target === 'fresh-spawn-current') {
    const result = await resolveFreshSpawnAvailabilityModels({
      userId: req.query.user,
      doc: context.doc,
      cwd: context.cwd,
      fleetStore,
      daemonConnections,
      // Resilient: a mint models query shouldn't fail because the daemon WS is mid-reconnect.
      sendRpc: (machineId, op, params) => sendRpcResilient(machineId, op, params),
      resolveSpawnMachine,
      onDaemonMissing: (machineId, context, detail) => logSpawnDaemonMiss(machineId, context, detail),
    })
    res.json({ schema: 1, target: 'fresh-spawn-current', ...result })
    return
  }
  const machine = req.query.machine ? String(req.query.machine) : null
  const machines = machine ? [machine] : [...daemonConnections.keys()].sort()
  const results = {}
  await Promise.all(machines.map(async (machineId) => {
    try {
      results[machineId] = await sendRpc(machineId, 'spawn-availability', {
        ...(context.cwd ? { cwd: context.cwd } : {}),
      })
    } catch (e) {
      results[machineId] = { ok: false, error: e.message || String(e) }
    }
  }))
  res.json({ schema: 1, machines: results })
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

app.get('/api/runtime-status', requireRead, (_req, res) => {
  res.json(buildRuntimeStatus({
    env: process.env,
    serverScriptPath: fileURLToPath(import.meta.url),
    fleetDbPath: process.env.TLDA_FLEET_DB || null,
    fleetStore,
    daemonConnections,
    fleetSummary: fleetStore.getAgentSummary?.(),
    localHostname: hostname(),
  }))
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
  const source = req.query.source || ''
  const name = req.query.name || ''
  const command = req.query.command || ''
  if (tool && _qualRules.length > 0) {
    const input = {}
    if (file) input.file_path = file
    if (skill) input.skill = skill
    if (content) input.content = content
    if (source) input.source = source
    if (name) input.name = name
    if (command) input.command = command
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
  const partial = partialSkillReadSummaries(_qualAgentPartialSkillReads, agentId)
    .filter(p => !readsSet.has(p.skillKey))
  res.json({ id: agentId, read, partial, owed, dismissed, cards })
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
// is a generic fleet permission, not tied to any one agent: a Claude session
// uses the `suggest` MCP tool; a bot (e.g. the Todd example) hits this route
// directly. Replace-semantics PER agent — posting overwrites that agent's set,
// an empty array clears it — so agents never clobber each other. The broadcast
// carries the flattened set across all agents.
const _suggestions = new Map() // agentId → Suggestion[]
const _items = new Map() // humanId → Item[]

function defaultPresentForKind(kind) {
  if (kind === 'bounce' || kind === 'mic-death') return { chat: true, hud: true }
  if (kind === 'modal' || kind === 'suggest' || kind === 'task') return { chat: true, list: true }
  return { chat: true }
}

function normalizeItem(raw = {}, fallback = {}) {
  const kind = String(raw.kind || fallback.kind || 'info')
  const present = { ...defaultPresentForKind(kind), ...(fallback.present || {}), ...(raw.present || {}), chat: true }
  return {
    id: String(raw.id || fallback.id || `${kind}:${Date.now()}`),
    kind,
    from: raw.from || fallback.from || undefined,
    title: String(raw.title || raw.label || fallback.title || ''),
    body: raw.body != null ? String(raw.body) : (raw.text != null ? String(raw.text) : fallback.body),
    actions: Array.isArray(raw.actions) ? raw.actions : (Array.isArray(fallback.actions) ? fallback.actions : []),
    payload: raw.payload ?? fallback.payload,
    present,
    dropTarget: raw.dropTarget || fallback.dropTarget,
    ttl: Number.isFinite(raw.ttl) ? raw.ttl : fallback.ttl,
    priority: raw.priority || fallback.priority || 'normal',
    ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
    targetId: raw.targetId || fallback.targetId,
    label: raw.label || fallback.label,
    text: raw.text || fallback.text,
    command: raw.command ?? fallback.command,
    group: raw.group || fallback.group,
    messageId: raw.messageId ?? fallback.messageId ?? null,
  }
}

function unexpiredItemsFor(userId) {
  const now = Date.now()
  const list = _items.get(userId) || []
  const kept = list.filter(item => !item.ttl || item.ts + item.ttl > now)
  if (kept.length !== list.length) _items.set(userId, kept)
  return kept
}

function broadcastItems(userId) {
  broadcastEvent('items', { userId, items: unexpiredItemsFor(userId) })
}

function raiseItem(userId, item) {
  const target = userId || SERVER_OWNER_ID
  const normalized = normalizeItem(item)
  if (!normalized.title && !normalized.label) throw new Error('Item title is required')
  const existing = unexpiredItemsFor(target)
  const next = existing.filter(i => i.id !== normalized.id)
  next.push(normalized)
  next.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  _items.set(target, next)
  broadcastItems(target)
  return normalized
}

function dismissItem(userId, itemId) {
  const target = userId || SERVER_OWNER_ID
  const next = unexpiredItemsFor(target).filter(i => i.id !== itemId)
  _items.set(target, next)
  broadcastItems(target)
}

function suggestionToItem(agentId, s) {
  return normalizeItem({
    ...s,
    id: `suggest:${agentId}:${s.messageId || ''}:${s.group || s.id}`,
    kind: 'suggest',
    from: agentId,
    targetId: s.targetId || agentId,
    title: s.label,
    body: s.text || '',
    present: { chat: true, list: true },
    actions: [{
      label: s.label,
      command: s.command || undefined,
      target: s.targetId || agentId,
    }],
  })
}

function refreshSuggestionItems(agentId, suggestions) {
  const userId = SERVER_OWNER_ID
  const prefix = `suggest:${agentId}:`
  const retained = unexpiredItemsFor(userId).filter(i => !String(i.id).startsWith(prefix))
  for (const s of suggestions) retained.push(suggestionToItem(agentId, s))
  _items.set(userId, retained)
  broadcastItems(userId)
}

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
  refreshSuggestionItems(agentId, _suggestions.get(agentId) || [])
  broadcastEvent('suggestions', { suggestions: flattenSuggestions() })
  res.json({ ok: true })
})

app.get('/api/suggestions', (_req, res) => {
  res.json({ suggestions: flattenSuggestions() })
})

app.get('/api/items', (req, res) => {
  const userId = req.query.userId || SERVER_OWNER_ID
  res.json({ userId, items: unexpiredItemsFor(userId) })
})

app.post('/api/items', (req, res) => {
  const { userId = SERVER_OWNER_ID, action = 'raise', item, id, ...rest } = req.body || {}
  try {
    if (action === 'dismiss') {
      const itemId = id || item?.id
      if (!itemId) return res.status(400).json({ error: 'Missing item id' })
      dismissItem(userId, String(itemId))
      return res.json({ ok: true })
    }
    const raised = raiseItem(userId, item || rest)
    res.json({ ok: true, item: raised })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
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
// Maps project-local backing names to their owning daemon route. The server
// never expands these into machine-local absolute paths; the owner daemon does.

const DEFAULT_BACKING_OWNER_MACHINE_ID = process.env.TLDA_BACKING_DEFAULT_OWNER_MACHINE_ID || 'mini'

/** @type {Map<string, {project: string, backingName: string, ownerMachineId: string | null, docNames: Set<string>}>} */
const backingFileRegistry = new Map()
function backingRegistryPath() { return join(getProjectsDir(), '..', 'data', 'backing-registry.json') }
// The registry is derived from live room shapes (self-healing): rebuild clears any
// stale entries and repopulates from the notes currently in active rooms, so a
// deleted/gone note can't keep its file-watch alive across a restart. Backed notes
// also re-register on mount, so rooms that load later repopulate themselves.
rebuildBackingFileRegistry().catch(e => console.error('[CRITICAL] backing registry rebuild failed:', e.message))

function backingRegistryKey(project, backingName) {
  return `${project}\0${backingName}`
}

function normalizeDocName(docName) {
  return docName?.startsWith('doc-') ? docName : `doc-${docName}`
}

function projectFromDocName(docName) {
  const roomName = normalizeDocName(docName)
  return roomName.replace(/^doc-/, '')
}

function resolveBackingRecord({ docName, backingName, filePath, ownerMachineId, legacyBackfill }) {
  const roomName = normalizeDocName(docName)
  const project = projectFromDocName(docName)
  const p = readProject(project)
  let name = backingName || null
  let legacyProjectLocalBackfill = false
  if (!name && filePath) {
    const sourceDir = p?.sourceDir ? resolve(p.sourceDir) : null
    const absolute = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : filePath
    if (!path.isAbsolute(absolute)) {
      name = absolute
    } else if (sourceDir) {
      const rel = path.relative(sourceDir, resolve(absolute))
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        name = rel
        legacyProjectLocalBackfill = true
      }
    }
  }
  if (!name || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
    return { error: 'backing file is not project-local', status: 'owner-missing', project, roomName }
  }
  const resolvedOwnerMachineId = ownerMachineId || (legacyBackfill && legacyProjectLocalBackfill ? DEFAULT_BACKING_OWNER_MACHINE_ID : null)
  if (!resolvedOwnerMachineId) {
    return { error: 'backing owner is missing', status: 'owner-missing', project, roomName, backingName: name.replace(/\\/g, '/') }
  }
  return {
    project,
    roomName,
    backingName: name.replace(/\\/g, '/'),
    ownerMachineId: resolvedOwnerMachineId,
  }
}

function backingFileRegister(record) {
  const key = backingRegistryKey(record.project, record.backingName)
  if (!backingFileRegistry.has(key)) {
    backingFileRegistry.set(key, {
      project: record.project,
      backingName: record.backingName,
      ownerMachineId: record.ownerMachineId || null,
      docNames: new Set(),
    })
  }
  const entry = backingFileRegistry.get(key)
  if (!entry.ownerMachineId && record.ownerMachineId) entry.ownerMachineId = record.ownerMachineId
  entry.docNames.add(record.roomName)
  sendWatchBackingFiles()
  persistBackingRegistry()
}

function backingFileUnregister(record) {
  const key = backingRegistryKey(record.project, record.backingName)
  const entry = backingFileRegistry.get(key)
  if (!entry) return
  entry.docNames.delete(record.roomName)
  if (entry.docNames.size > 0) { persistBackingRegistry(); return }
  backingFileRegistry.delete(key)
  sendWatchBackingFiles()
  persistBackingRegistry()
}

function sendWatchBackingFiles() {
  const byOwner = new Map()
  for (const entry of backingFileRegistry.values()) {
    if (!entry.ownerMachineId) continue
    if (!byOwner.has(entry.ownerMachineId)) byOwner.set(entry.ownerMachineId, [])
    byOwner.get(entry.ownerMachineId).push({
      project: entry.project,
      backingName: entry.backingName,
      docNames: [...entry.docNames],
    })
  }
  for (const [machineId, files] of byOwner) {
    enqueueDaemonMessage(machineId, { type: 'watch-backing-files', files }, { dedupeKey: 'watch-backing-files' })
  }
}

function persistBackingRegistry() {
  try {
    const data = [...backingFileRegistry.values()].map(entry => ({
      project: entry.project,
      backingName: entry.backingName,
      ownerMachineId: entry.ownerMachineId,
      docNames: [...entry.docNames],
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
        if (shape.props?.backingName || shape.props?.backingFile) {
          const record = resolveBackingRecord({
            docName,
            backingName: shape.props.backingName,
            filePath: shape.props.backingFile,
            ownerMachineId: shape.props.backingOwnerMachineId,
            legacyBackfill: !shape.props.backingName && !shape.props.backingOwnerMachineId && !shape.props.backingSyncStatus,
          })
          if (!record.error) backingFileRegister(record)
        }
      }
    } catch (e) { console.warn(`[server] failed to scan backing files for ${docName}: ${e.message}`) }
  }
  sendWatchBackingFiles()
  persistBackingRegistry()
}

// POST /api/backing-file-register — client registers a backing file watch
app.post('/api/backing-file-register', requireRead, (req, res) => {
  const { backingName, filePath, docName, ownerMachineId, legacyBackfill } = req.body || {}
  if ((!backingName && !filePath) || !docName) return res.status(400).json({ error: 'Missing backingName/filePath or docName' })
  const record = resolveBackingRecord({ docName, backingName, filePath, ownerMachineId, legacyBackfill })
  if (record.error) return res.status(409).json({ ok: false, error: record.error, status: record.status })
  backingFileRegister(record)
  res.json({ ok: true, status: 'pending', project: record.project, backingName: record.backingName, ownerMachineId: record.ownerMachineId })
})

// POST /api/backing-file-unregister — client drops a backing file watch when its
// note is deleted, so the daemon stops watching a file no note is backed by.
app.post('/api/backing-file-unregister', requireRead, (req, res) => {
  const { backingName, filePath, docName, ownerMachineId, legacyBackfill } = req.body || {}
  if (!backingName && !filePath) return res.status(400).json({ error: 'Missing backingName/filePath' })
  if (!docName) return res.status(400).json({ error: 'Missing docName' })
  const record = resolveBackingRecord({ docName, backingName, filePath, ownerMachineId, legacyBackfill })
  if (!record.error) backingFileUnregister(record)
  res.json({ ok: true })
})

// POST /api/backing-file-write — write content to a file via daemon RPC
app.post('/api/backing-file-write', requireRead, async (req, res) => {
  const { backingName, filePath, docName, ownerMachineId, legacyBackfill, content, restore } = req.body || {}
  if ((!backingName && !filePath) || !docName) return res.status(400).json({ error: 'Missing backingName/filePath or docName' })
  const record = resolveBackingRecord({ docName, backingName, filePath, ownerMachineId, legacyBackfill })
  if (record.error) return res.status(409).json({ ok: false, error: record.error, status: record.status })
  backingFileRegister(record)
  try {
    const result = await sendRpc(record.ownerMachineId, 'write-backing-file', { project: record.project, backingName: record.backingName, content: content ?? '', restore: !!restore })
    res.json({ ok: true, status: result?.status || 'synced', project: record.project, backingName: record.backingName, ownerMachineId: record.ownerMachineId })
  } catch (e) {
    const status = e?.message?.includes('deleted externally') ? 'deleted' : e?.code === 'NO_DAEMON' ? 'owner-unavailable' : 'failed'
    res.status(status === 'deleted' ? 409 : 503).json({ ok: false, error: e.message, status })
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
    broadcastState(agent)
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
    markAgentNotAlive(agent.id)
    const killEvent = { type: 'kill-session', from: SERVER_OWNER_ID, to: agent.id, text: `Killed ${agent.friendly_name || agent.id}` }
    await fleetStore.share(killEvent)
    broadcastState(agent.id)
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
  if (!isPlanModeResponse(response)) return res.status(400).json({ error: 'response must be approve, supervised, or reject' })
  const route = resolveRpc('send-text', agent)
  if (route.via === 'none') return res.status(503).json({ error: route.error })
  try {
    const result = await sendRpc(route.machine_id, 'send-text', { tmux_session: agent.tmux_session, text: planModeResponseKey(response), enter: false })
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
    broadcastState(agent.id)
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
    const project = readProject(name)
    const targets = Array.isArray(project?.targets) && project.targets.length > 0
      ? project.targets
      : [{ texBase: basename(project?.mainFile || 'main.tex', '.tex'), pages: project?.pages || 0 }]
    const target = targets.find(t => t?.texBase === texBase)
    const pageLimit = Number(target?.pages || 0)
    if (!target || pageNum < 1 || (pageLimit > 0 && pageNum > pageLimit)) {
      return res.status(404).json({ error: 'Page out of range' })
    }
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

  if (filePath.endsWith('.html')) {
    try {
      const project = readProject(name)
      if (project) {
        const { listDocumentColumns, listProjectPartColumns } = await import('./lib/document-columns.mjs')
        const { renderMarkdownColumnHtml } = await import('./lib/build-markdown.mjs')
        // Markdown-format projects: main file + parts (existing behavior).
        // Any other format: its markdown PARTS still render through this same
        // markdown renderer — the parent project's own format only owns its
        // own main document, not its parts.
        const columns = project.format === 'markdown'
          ? listDocumentColumns(name, { project, srcDir: join(PROJECTS_DIR, name, 'source') })
          : listProjectPartColumns(name, { srcDir: join(PROJECTS_DIR, name, 'source') })
        const column = columns.find(c => c.file === filePath)
        if (column) {
          const source = readFileSync(join(PROJECTS_DIR, name, 'source', column.sourceFile), 'utf8')
          const isTaskDoc = /(^|\n)tlda-kind:\s*task-doc\s*(\n|$)/.test(source)
          const html = renderMarkdownColumnHtml({ source, title: column.title, isTaskDoc })
          const bridged = injectBridge(html, `/docs/${name}/`, '', true, {})

          function memberTitle(memberName) {
            const tp = join(PROJECTS_DIR, memberName, 'output', 'toc.json')
            if (!existsSync(tp)) return memberName
            try {
              const toc = JSON.parse(readFileSync(tp, 'utf8'))
              return (toc.length > 0 && toc[0].level === 'section') ? toc[0].title : memberName
            } catch { return memberName }
          }

          const chapterTitle = column.title || memberTitle(name)
          let prev = null, next = null
          for (const p of listProjects()) {
            if (p.format !== 'book') continue
            const members = p.members || []
            const idx = members.indexOf(name)
            if (idx === -1) continue
            if (idx > 0) prev = { name: members[idx - 1], title: memberTitle(members[idx - 1]) }
            if (idx < members.length - 1) next = { name: members[idx + 1], title: memberTitle(members[idx + 1]) }
            break
          }

          res.set('Cache-Control', 'no-cache')
          res.type('html').send(injectChapterTitle(bridged, chapterTitle, prev, next))
          return
        }
      }
    } catch (e) {
      console.error(`[docs] lazy column render failed for ${name}/${filePath}: ${e.message}`)
      return res.status(500).json({ error: 'Column render failed', detail: e.message })
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

app.locals.fleetStore = fleetStore
app.use('/api/projects', projectRoutes)

// Handwriting recognition (MyScript proxy)
import recognizeRoutes from './routes/recognize.mjs'
app.use('/api/recognize', recognizeRoutes)

// Live voice/video room (LiveKit). Inert without LIVEKIT_URL/API_KEY/API_SECRET:
// /api/livekit/config reports configured:false and /api/livekit/token returns 503.
import livekitRoutes from './routes/livekit.mjs'
app.use('/api/livekit', livekitRoutes)

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
  broadcastDaemonAgentsUpdated,
  hasOpenFleetSocketForAgent,
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
  app.use((req, res, next) => {
    try {
      const wantsTouchDiag = req.query?.fleetGestures != null || req.query?.touchDiag != null
      const isIndex = req.method === 'GET' && (req.path === '/' || req.path === '/index.html')
      const isBundle = req.method === 'GET' && /^\/assets\/index-[^/]+\.js$/.test(req.path)
      if (wantsTouchDiag && (isIndex || isBundle)) {
        appendClientLogEntry({
          level: 'warn',
          ns: 'fleet-gesture-server',
          msg: isIndex ? 'viewer request' : 'bundle request',
          data: {
            path: req.path,
            query: req.query,
            ip: req.ip,
            remoteAddress: req.socket?.remoteAddress,
            userAgent: req.get('user-agent') || null,
            referer: req.get('referer') || null,
          },
        })
      }
    } catch (e) {
      console.log(`[fleet-gesture-server] access diagnostic failed: ${e.message}`)
    }
    next()
  })

  app.use(express.static(distDir, {
    // Never auto-serve index.html (for "/" or directly): it MUST go through the
    // SPA catch-all below so the active config gets injected. Hashed assets are
    // still served here.
    index: false,
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
    res.set('Document-Policy', 'js-profiling')
    // Inject the resolved active config so the SPA reads database/store/licenseKey
    // synchronously at startup — no build-time baking, no async race, no guessing.
    // resolveConfig() is validated at boot (server won't start on a bad config),
    // so this can't throw here; if config.json were edited to something invalid
    // while running, the page erroring loud is the correct, predictable behavior.
    const cfg = resolveConfig()
    const cfgScript = `<script>window.__TLDA_CONFIG__=${JSON.stringify(cfg)}</script>`
    const rawHtml = readFileSync(indexPath, 'utf8')
      .replace(/\s*<script>window\.__TLDA_CONFIG__=.*?<\/script>\s*/gs, '\n')
    const html = rawHtml.includes('<script type="module"')
      ? rawHtml.replace('<script type="module"', `${cfgScript}\n    <script type="module"`)
      : rawHtml.replace('</head>', `${cfgScript}\n</head>`)
    res.set('Content-Type', 'text/html; charset=utf-8')
    return res.send(html)
  }

  res.status(404).send('Viewer not built. Run: npm run build')
})

// ---------- HTTP(S) + WebSocket server ----------

const TLS_CERT = process.env.TLDA_TLS_CERT || join(homedir(), '.config/tlda/localhost+2.pem')
const TLS_KEY  = process.env.TLDA_TLS_KEY  || join(homedir(), '.config/tlda/localhost+2-key.pem')
const useTls = existsSync(TLS_CERT) && existsSync(TLS_KEY)

// Optional second cert pair for off-laptop access. The mkcert cert above is only
// trusted on machines holding the mkcert root CA (this laptop), so iPad/phone get
// cert errors. A Tailscale-issued cert (publicly trusted, tailnet-hostname SANs)
// fixes that. When present, SNI serves it for any non-localhost hostname while
// localhost keeps the mkcert cert — so one server/port answers both links.
const TLS_CERT_TAILNET = process.env.TLDA_TLS_CERT_TAILNET || join(homedir(), '.config/tlda/tailnet.pem')
const TLS_KEY_TAILNET  = process.env.TLDA_TLS_KEY_TAILNET  || join(homedir(), '.config/tlda/tailnet-key.pem')
const hasTailnetCert = existsSync(TLS_CERT_TAILNET) && existsSync(TLS_KEY_TAILNET)

let server
if (useTls) {
  const tlsOptions = { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }
  if (hasTailnetCert) {
    const localCtx = createSecureContext({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) })
    const tailnetCtx = createSecureContext({ cert: readFileSync(TLS_CERT_TAILNET), key: readFileSync(TLS_KEY_TAILNET) })
    tlsOptions.SNICallback = (servername, cb) => {
      const isLocal = servername === 'localhost' || servername === '127.0.0.1' || servername === '::1'
      cb(null, isLocal ? localCtx : tailnetCtx)
    }
    console.log(`[tls] SNI enabled — localhost→mkcert, others→tailnet cert (${TLS_CERT_TAILNET})`)
  }
  server = createHttpsServer(tlsOptions, app)
} else {
  server = createServer(app)
}

const syncWss = new WebSocketServer({ noServer: true })
// Fleet traffic crosses the Wi-Fi/tailnet path as well as local links. Keep
// small RPC replies cheap and compress larger incremental events when the
// client negotiates permessage-deflate.
const fleetWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: { threshold: 1024 },
})
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

function terminalAgentContext(agent) {
  return compactObject({
    agentId: agent?.id,
    label: agent?.friendly_name || agent?.id,
    tmuxSession: agent?.tmux_session,
    machineId: agent?.machine_id,
    envName: agent?.env_name,
  })
}

function sendTerminalFrame(ws, frame, { agentId, operation }) {
  if (ws?.readyState !== 1) return false
  try {
    ws.send(JSON.stringify(frame))
    return true
  } catch (err) {
    terminalBridgeLog.warn({
      agentId,
      operation,
      error: err?.stack || err?.message || String(err),
    }, 'terminal browser frame send failed')
    return false
  }
}

async function reportTerminalBridgeIncident({ operation, agent, error, browserNotified = false, evidence = {} }) {
  const context = terminalAgentContext(agent)
  const errText = error?.stack || error?.message || String(error)
  terminalBridgeLog.warn({
    operation,
    ...context,
    browserNotified,
    error: errText,
    evidence,
  }, 'terminal bridge operation failed')
  try {
    await reportFleetIncident({
      severity: 'warning',
      component: 'terminal-bridge',
      operation,
      actors: context,
      impact: `Terminal ${operation} failed for ${context.label || context.agentId || 'unknown agent'}.`,
      evidence: {
        ...evidence,
        browserNotified,
      },
      error: errText,
    })
  } catch (reportErr) {
    terminalBridgeLog.error({
      operation,
      ...context,
      originalError: errText,
      reportingError: reportErr?.stack || reportErr?.message || String(reportErr),
    }, 'terminal bridge incident reporting failed')
  }
}

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
    if (!agent || !agent.machine_id || !agent.env_name) {
      // Decline cleanly with a JSON message before close so the UI shows
      // a useful error instead of "WebSocket error".
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        try { ws.send(JSON.stringify({ type: 'error', message: 'agent has no daemon address; daemon not registered' })) } catch {
          // Socket may already be gone; close below is the remaining cleanup.
        }
        try { ws.close() } catch {
          // Socket already closed by peer; no server-side recovery remains.
        }
      })
      return
    }
    if (!agent.tmux_session) {
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        try { ws.send(JSON.stringify({ type: 'error', message: 'agent has no tmux session' })) } catch {
          // Socket may already be gone; close below is the remaining cleanup.
        }
        try { ws.close() } catch {
          // Socket already closed by peer; no server-side recovery remains.
        }
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
          const res = await sendRpc(agentDaemonAddress(agent), 'start-terminal-watch', {
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
        const { pane } = await sendRpc(agentDaemonAddress(agent), 'capture-pane', {
          tmux_session: agent.tmux_session, visible: true,
        })
        if (pane && ws.readyState === 1) {
          // capture-pane emits bare `\n` line endings; xterm has no convertEol,
          // so `\n` is a line-feed WITHOUT carriage-return → every line renders
          // one column further right (a staircase). The daemon's own PTY seed
          // already converts (fleet-daemon.mjs), but this server-side seed did
          // not — invisible for Claude (its TUI streams continuous full-screen
          // repaints that overwrite the garble) but permanent for an idle goose
          // agent that never repaints. Convert here too so the seed is readable.
          const seed = trimTerminalSeedBlankRows(pane).replace(/\r?\n/g, '\r\n')
          ws.send(JSON.stringify({ type: 'output', data: Buffer.from(seed).toString('base64'), encoding: 'base64' }))
        }
      } catch (e) {
        console.warn(`[terminal] seed capture failed for ${agent.id} (${agent.tmux_session}): ${e.message}`)
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'not-live', reason: 'terminal session not live' }), (sendError) => {
            if (sendError) console.warn(`[terminal] failed to send not-live frame for ${agent.id}: ${sendError.message}`)
          })
        }
      }

      ws.on('message', async (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg.type === 'input' && typeof msg.data === 'string') {
          try {
            await sendRpc(agentDaemonAddress(agent), 'terminal-input', {
              tmux_session: agent.tmux_session, data: msg.data,
            })
          } catch (e) {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'error', message: e.message }))
            }
          }
        } else if (msg.type === 'submit' && typeof msg.text === 'string') {
          try {
            await sendRpc(agentDaemonAddress(agent), 'send-text', {
              tmux_session: agent.tmux_session, text: msg.text, enter: true,
            })
          } catch (e) {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'error', message: e.message }))
            }
          }
        } else if (msg.type === 'resize' && msg.cols && msg.rows) {
          try {
            await sendRpc(agentDaemonAddress(agent), 'terminal-resize', {
              tmux_session: agent.tmux_session, cols: msg.cols, rows: msg.rows,
            })
          } catch (e) {
            const browserNotified = sendTerminalFrame(ws, {
              type: 'error',
              message: `terminal resize failed: ${e.message}`,
            }, { agentId: agent.id, operation: 'terminal-resize' })
            await reportTerminalBridgeIncident({
              operation: 'terminal-resize',
              agent,
              error: e,
              browserNotified,
              evidence: { cols: msg.cols, rows: msg.rows },
            })
          }
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
            await sendRpc(agentDaemonAddress(agent), 'stop-terminal-watch', {
              tmux_session: agent.tmux_session,
            })
          } catch (e) {
            await reportTerminalBridgeIncident({
              operation: 'stop-terminal-watch',
              agent,
              error: e,
              evidence: { remainingWatchers: 0 },
            })
          }
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
        await handleDaemonOutboxEnvelope(ws, msg, handleDaemonWsMessage, {
          onHandlerError: e => console.error('[daemon-ws] handler error:', e?.message),
        })
      })
      ws.on('close', (code, reason) => {
        logWsClose('daemon', ws, code, reason?.toString?.() || '')
        if (ws._daemonKey && daemonConnections.get(ws._daemonKey) === ws) {
          daemonConnections.delete(ws._daemonKey)
          fleetStore?.markDaemonDisconnected?.(ws._daemonKey)
          // The daemon is gone; process-level visibility is unknown, not false.
          // Preserve prior liveness so a server/Fly redeploy or daemon restart
          // cannot make every working agent on that machine vanish.
          failPendingRpcsForDaemon(ws._machineId, ws._envName, 'daemon disconnected')
          clearServerDaemonOutboxInflightForDaemon(ws._daemonKey)
          broadcastState()
          console.log(`[fleet-daemon] disconnected: daemon=${ws._daemonKey}`)
        }
      })
      ws.on('error', () => {
        if (ws._daemonKey && daemonConnections.get(ws._daemonKey) === ws) {
          daemonConnections.delete(ws._daemonKey)
          fleetStore?.markDaemonDisconnected?.(ws._daemonKey)
          failPendingRpcsForDaemon(ws._machineId, ws._envName, 'daemon ws error')
          clearServerDaemonOutboxInflightForDaemon(ws._daemonKey)
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
    // Behind `tailscale serve` (Fly) the socket peer is 127.0.0.1; the client's
    // real tailnet IP is the first hop of X-Forwarded-For. Capture it so a chat
    // message can be stamped with the sender's machine (resolveMachine).
    const fwdFor = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null
    fleetWss.handleUpgrade(req, socket, head, (ws) => {
      ws._fwdFor = fwdFor
      ws._remoteAddr = remoteAddr
      const agentFilter = url.searchParams.get('agent') || null
      ws._agentFilter = agentFilter
      wsFleetClients.add(ws)
      trackWs(ws, {
        kind: 'fleet',
        sessionId: `fleet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        remoteAddr,
        remotePort,
      })

      // Never send roster/task lists on connect.  A browser may immediately
      // send login; putting a multi-megabyte snapshot ahead of its reply made
      // identity establishment timeout on slow links.  List views fetch their
      // own bounded pages over HTTP, while this socket carries RPC replies and
      // incremental deltas for every client type.

      ws.on('message', (raw) => {
        handleFleetWsFrame(ws, raw)
      })
      ws.on('close', (code, reason) => {
        logWsClose('fleet', ws, code, reason?.toString?.() || '')
        wsFleetClients.delete(ws)
        // Unsubscribe the agent from all tlda-feedback watches so stale
        // subscriptions don't accumulate across MCP respawns.
        if (ws._tldaAgentId) {
          if (agentFleetConnections.get(ws._tldaAgentId) === ws) {
            agentFleetConnections.delete(ws._tldaAgentId)
          }
          if (!hasOpenFleetSocketForAgent(ws._tldaAgentId, ws)) {
            tldaFeedback.unsubscribeAll(ws._tldaAgentId)
          }
        }
      })
      ws.on('error', () => {
        wsFleetClients.delete(ws)
        if (ws._tldaAgentId && agentFleetConnections.get(ws._tldaAgentId) === ws) {
          agentFleetConnections.delete(ws._tldaAgentId)
        }
      })
    })
    return
  }

  // /voice/deepgram-sdk — same-origin relay to the local (SDK) Deepgram bridge.
  // A device that can't reach 127.0.0.1 (the iPad, where localhost is the iPad
  // itself) connects here over the TLS the page is already authenticated on; we
  // preserve binary PCM + text control framing both ways.
  if (url.pathname === '/voice/deepgram-sdk') {
    const bridgeUrl = DEEPGRAM_SDK_BRIDGE_URL
    const ensureBridge = ensureDeepgramSdkBridge
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

      const ready = await ensureBridge()
      if (closed) return
      if (!ready) {
        try { browserWs.send(JSON.stringify({ type: 'status', status: 'error', error: 'bridge unavailable' })) } catch {}
        closeBoth()
        return
      }

      upstream = new WS(bridgeUrl, { rejectUnauthorized: false })
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
        console.warn('[voice-proxy:sdk] upstream error:', err.message)
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
    if (id) {
      ws.send(JSON.stringify({ id, result }))
      msg._fleetReplied = true
    }
  }
  const error = (err) => {
    if (!id) return
    if (err && typeof err === 'object') {
      ws.send(JSON.stringify({
        id,
        error: {
          message: err.message || String(err),
          code: err.code,
          reason: err.reason,
          ...(err.payload ? { payload: err.payload } : {}),
        },
      }))
      msg._fleetReplied = true
    } else {
      ws.send(JSON.stringify({ id, error: err }))
      msg._fleetReplied = true
    }
  }

  if (!fleetStore) { error('fleet store unavailable'); return }

  if (type === 'notification-attempt') {
    const actor = ws._tldaAgentId || ws._tldaHumanId || msg.agentId || null
    const result = await notificationAttempts.record({
      ...msg.attempt,
      agentId: msg.attempt?.agentId || actor,
      evidence: {
        ...(msg.attempt?.evidence || {}),
        reportingPeer: describeFleetWsPeer(ws),
      },
    })
    reply(result)
    return
  }

  if (type === 'notify') {
    try {
      if (msg.action === 'dismiss') {
        if (!msg.id) throw new Error('notify dismiss requires id')
        dismissItem(msg.userId, msg.id)
        reply({ ok: true, action: 'dismiss', id: msg.id })
      } else {
        const item = raiseItem(msg.userId, msg.item)
        reply({ ok: true, action: 'raise', item })
      }
    } catch (e) {
      error(e)
    }
    return
  }

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

  if (type === 'register' || type === 'reserve-shell') {
    // Prefer agent_id over id: the MCP's sendWS() stamps a correlation `id`
    // onto every message, so the real fleet id arrives as agent_id. Falling
    // back to id keeps direct WS callers that send id=fleet_id working. Reading
    // the bare `id` first here was the root cause of phantom UUID-keyed rows.
    const { agent_id, id: msgId, name, pretty_name, tmux_session, cwd, labels, manager, session_id, resume_id, metadata, machine_id, env_name, kind } = msg
    const isShellReservation = type === 'reserve-shell'
    if (type === 'register' && !msg.human) {
      error('register is only for human browser sessions; agents must use reserve-shell before startup and login after startup')
      return
    }
    if (isShellReservation && msg.human) {
      error('reserve-shell is only for agent spawn shells')
      return
    }
    const agentId = agent_id || msgId
    if (!agentId) { error('missing id'); return }
    // Duplicate clients are allowed to coexist. Closing an existing socket here
    // is unsafe because fleet clients such as Todd auto-reconnect on close; two
    // same-identity clients then repeatedly kick each other off the server.
    agentFleetConnections.set(agentId, ws)
    // Remember which agent owns this WS so we can clean up their tlda-feedback
    // subscriptions on close.
    ws._tldaAgentId = agentId
    const now = new Date().toISOString()
    const existing = fleetStore.getAgent?.(agentId)
    // The friendly name is set once (first identity creation) and is thereafter owned
    // by rename/rotation. Re-login must NOT clobber it with the spawn name
    // — that would undo a lineage rotation. The terminal/window name lives in
    // tmux_session, independent of the friendly name. So only the *first* name
    // is taken from `name`; once set, it's preserved.
    const requestedName = name || null
    let assignedName = (existing && !existing.dead) ? (existing.friendly_name || requestedName) : requestedName
    const willSetName = (!existing?.friendly_name || existing?.dead) && requestedName
    if (willSetName) {
      const incomingLabels = Array.isArray(labels) ? labels : []
      if (incomingLabels.includes('bot') && incomingLabels.includes(requestedName)) {
        for (const holder of fleetStore.getLiveAgentsByFriendlyName?.(requestedName) || []) {
          if (holder.id === agentId || holder.dead || holder.friendly_name !== requestedName || holder.tmux_session) continue
          const holderLabels = Array.isArray(holder.labels) ? holder.labels : []
          if (!holderLabels.includes('bot') || !holderLabels.includes(requestedName)) continue
          console.log(`[register] retiring legacy bot row ${holder.id} so ${agentId} can claim ${requestedName}`)
          fleetStore.markDead(holder.id)
        }
      }
      try {
        assignedName = fleetStore.allocateFreshFriendlyName(requestedName, { excludeId: agentId })
      } catch (e) {
        error(e.message)
        return
      }
    }
    const agent = {
      id: agentId,
      friendly_name: assignedName || null,
      pretty_name: pretty_name ?? existing?.pretty_name ?? null,
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
      metadata: (metadata || existing?.metadata || kind)
        ? { ...(existing?.metadata || {}), ...(metadata || {}), ...(kind ? { kind } : {}) }
        : null,
      machine_id: machine_id || existing?.machine_id || null,
      env_name: env_name || existing?.env_name || null,
      daemon_key: (machine_id && env_name) ? daemonAddress(machine_id, env_name) : existing?.daemon_key || null,
      resume_id: resume_id || existing?.resume_id || null,
    }
    // Persist spawnPolicy ATOMICALLY as a coherent region blob. The shallow metadata
    // merge above is what let partial spawnPolicy writes corrupt the blob across
    // repeated identity updates; coercing to a coherent { name, policy } region here means no new
    // corruption can form. Representation-only — it reads the region off the stored blob
    // (new or legacy), never re-grants.
    if (agent.metadata?.spawnPolicy) {
      agent.metadata = { ...agent.metadata, spawnPolicy: normalizeRegionPolicy(agent.metadata.spawnPolicy) }
    }
    // Shell reservation vs claim. The spawn flow reserves the identity as a
    // "shell" (msg.shell) before the agent process exists — addressable
    // (dead=0, in the not-dead registry) but NOT awake. The agent's login/claim
    // is a separate login message, handled below.
    if (isShellReservation) {
      agent.metadata = { ...(agent.metadata || {}), shell: true }
    } else if (agent.metadata?.shell) {
      // Human registration can replace a stale shell row. Clear the shell flag
      // explicitly because upsertAgent merges metadata via SQLite
      // json_patch, which DELETES a key only when the patch sets it to null —
      // omitting it would leave the old shell:true intact through the merge.
      agent.metadata = { ...agent.metadata, shell: null }
    }
    if (session_id && !agent.session_ids.includes(session_id)) {
      agent.session_ids = [...(agent.session_ids || []), session_id].slice(-10)
    }
    try {
      fleetStore.upsertAgent(agent)
      if (isShellReservation && !agent.human) {
        fleetStore.ensureDefaultSubscription?.(agent.id)
      }
      for (const row of fleetStore.getSubscriptionsByOwner?.(agent.id) || []) {
        const docMatch = String(row.query || '').match(/^doc:([^\s]+)$/i)
        if (row.adapter === 'document_monitor' && docMatch) {
          tldaFeedback.subscribe(row.owner, docMatch[1], deliverTldaFeedbackChat)
        }
      }
    } catch (e) {
      if (e.message?.includes('already taken')) {
        error(e.message)
        return
      }
      throw e
    }
    const lifecycleLabel = agent.friendly_name || requestedName || agentId
    const eventType = isShellReservation ? 'lifecycle' : 'register'
    const eventText = isShellReservation
      ? `${lifecycleLabel} shell reserved`
      : `${lifecycleLabel} registered`
    fleetStore.share?.({ type: eventType, agent_id: agentId, from: agentId, to: agentId, text: eventText })
    // Every non-human agent belongs to a lineage from birth, as its own `dawn`
    // (the worker). This guarantees a handoff always has a chain to rotate within
    // — a direct handoff promotes that dawn → day (manager). The lineage is an
    // overlay, so a failure here must never block identity creation.
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
    const storedAgent = fleetStore.getAgent?.(agentId) || agent
    broadcastState(storedAgent)
    // If the agent has a machine_id, push the updated agent list to that
    // machine's daemon so it can start watching the new JSONL.
    if (agent.machine_id) broadcastDaemonAgentsUpdated(agent)
    reply({
      ok: true,
      agent: storedAgent,
      assigned_name: storedAgent.friendly_name || null,
      requested_name: requestedName,
      name_changed: !!(requestedName && storedAgent.friendly_name && requestedName !== storedAgent.friendly_name),
    })
    return
  }

  // Login has two forms:
  // - agents claim a server-created shell by `agent_id`
  // - humans attach by `name`
  // Neither form creates a new identity.
  if (type === 'login') {
    const { agent_id, name, tmux_session, cwd, labels, manager, session_id, resume_id, metadata, machine_id, env_name, kind } = msg
    if (agent_id) {
      const existing = fleetStore.getAgent?.(agent_id)
      if (!existing || existing.dead) { error(`No live shell for agent "${agent_id}". Spawn must create the shell before login.`); return }
      agentFleetConnections.set(agent_id, ws)
      ws._tldaAgentId = agent_id
      const now = new Date().toISOString()
      const agent = {
        ...existing,
        tmux_session: tmux_session || existing.tmux_session || null,
        session_id: session_id || existing.session_id || null,
        session_ids: existing.session_ids || [],
        cwd: cwd || existing.cwd || null,
        labels: labels || existing.labels || [],
        last_seen: now,
        dead: false,
        human: false,
        is_manager: !!manager,
        metadata: (metadata || existing.metadata || kind)
          ? { ...(existing.metadata || {}), ...(metadata || {}), ...(kind ? { kind } : {}) }
          : null,
        machine_id: machine_id || existing.machine_id || null,
        env_name: env_name || existing.env_name || null,
        daemon_key: (machine_id && env_name) ? daemonAddress(machine_id, env_name) : existing.daemon_key || null,
        resume_id: resume_id || existing.resume_id || null,
      }
      if (agent.metadata?.spawnPolicy) {
        agent.metadata = { ...agent.metadata, spawnPolicy: normalizeRegionPolicy(agent.metadata.spawnPolicy) }
      }
      if (agent.metadata?.shell) {
        agent.metadata = { ...agent.metadata, shell: null }
      }
      if (session_id && !agent.session_ids.includes(session_id)) {
        agent.session_ids = [...(agent.session_ids || []), session_id].slice(-10)
      }
      fleetStore.upsertAgent(agent)
      const storedAgent = fleetStore.getAgent?.(agent_id) || agent
      reply({ ok: true, agent: storedAgent, assigned_name: storedAgent.friendly_name || null })
      fleetStore.share?.({ type: 'login', agent_id, from: agent_id, to: agent_id, text: `${agent.friendly_name || agent_id} logged in` })
      markAgentAlive(agent_id)
      touchActivity(agent_id)
      spawnLibrarian.observeLiveness({
        type: 'agent-liveness',
        agent_id,
        tmux_session: agent.tmux_session,
        state: 'alive',
        ts: now,
      })
      spawnLibrarian.observeLogin(fleetStore.getAgent?.(agent_id) || agent)
      broadcastState(storedAgent)
      if (agent.machine_id) broadcastDaemonAgentsUpdated(storedAgent)
      return
    }

    if (!name || typeof name !== 'string') { error('missing name'); return }
    const sanitized = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!sanitized) { error('invalid name'); return }
    // Find existing agent by friendly_name
    const nameRows = fleetStore.db.prepare('SELECT * FROM agents WHERE friendly_name = ? AND dead = 0 AND human = 1').all(sanitized)
    if (nameRows.length === 0) {
      error(`No agent named "${sanitized}". Register first.`)
      return
    }
    const agent = fleetStore._hydrateAgent(nameRows[0])
    fleetStore.upsertAgent({ ...agent, last_seen: new Date().toISOString() })
    ws._tldaHumanId = agent.id
    broadcastState(agent.id)
    reply({ id: agent.id, name: agent.friendly_name, human: !!agent.human })
    return
  }

  if (type === 'spawn') {
    const callerId = ws._tldaAgentId || ws._tldaHumanId
    if (!callerId) { error('spawn requires an authenticated fleet WS identity; call login() first'); return }
    const caller = fleetStore.getAgent?.(callerId)
    if (!caller) { error(`spawn caller ${callerId} is not registered`); return }
    try {
      reply(await performSpawnRelay(caller, msg))
    } catch (e) {
      error(e)
    }
    return
  }

  if (type === 'store-agents') {
    reply(fleetStore.getAliveAgents())
    return
  }

  // Full roster INCLUDING dead agents — history tooling (get_thread,
  // search_logs) must keep dead agents addressable by name.
  if (type === 'store-agents-all') {
    error('Full agent store dumps are disabled; use resolve-agent, paged agents, or search.')
    return
  }

  if (type === 'resolve-agent') {
    reply({ agent: fleetStore.findAgent(msg.agent) || null })
    return
  }

  if (type === 'store-tasks') {
    if (msg.active === false) {
      error('Full task store dumps are disabled; use paged tasks or search.')
      return
    }
    reply(fleetStore.getActiveTasksPage?.({ limit: 100 })?.tasks || [])
    return
  }

  // ---- jsonl-index: daemon pushes JSONL text entries for unified search ----
  if (type === 'jsonl-index') {
    const entries = msg.entries || []
    try {
      await measureHotOp('fleet-ws jsonl-index', `entries=${entries.length}`, () => fleetStore.insertSessionEntries(entries))
    } catch (e) {
      console.error(`[jsonl-index] Failed to index ${entries.length} entries — search gaps possible:`, e.message); error(e.message); return
    }
    reply({ ok: true })
    return
  }

  // ---- fleet-search: unified search across fleet events + session JSONL text ----
  if (type === 'fleet-search') {
    try {
      const noMatch = '__fleet_search_no_match__'
      const currentSearchActor = () => {
        const me = String(msg.me || '').trim()
        if (!me) throw new Error('fleet-search requires caller identity for `me`')
        return me
      }
      const resolveAgentNode = (node) => {
        if (!node) return new Set()
        switch (node.t) {
          case 'lit': {
            if (node.v?.startsWith?.('fleet:')) return new Set([node.v])
            const ids = node.selector
              ? fleetStore.resolveAgentSelector(node.selector)
              : fleetStore.resolveAgentQuery(node.v)
            return new Set(ids)
          }
          case 'me': return new Set([currentSearchActor()])
          case 'and': {
            const left = resolveAgentNode(node.l)
            const right = resolveAgentNode(node.r)
            return new Set([...left].filter(id => right.has(id)))
          }
          case 'or': return new Set([...resolveAgentNode(node.l), ...resolveAgentNode(node.r)])
          case 'not':
            // Search-side negated agent sets are enforced by the post-filter.
            // Do not broaden the SQL prefilter to "all agents" here.
            return new Set()
          default: return new Set()
        }
      }
      const collectPrefilterIds = (node, out = new Set()) => {
        if (!node) return out
        switch (node.t) {
          case 'from':
          case 'to':
            for (const id of resolveAgentNode(node.x)) out.add(id)
            break
          case 'lit':
          case 'me':
            for (const id of resolveAgentNode(node)) out.add(id)
            break
          case 'and':
          case 'or':
            collectPrefilterIds(node.l, out); collectPrefilterIds(node.r, out)
            break
          case 'not':
            break
        }
        return out
      }
      const matchesAgentNode = (node, id) => {
        if (!node) return true
        switch (node.t) {
          case 'lit':
          case 'me': return resolveAgentNode(node).has(id)
          case 'and': return matchesAgentNode(node.l, id) && matchesAgentNode(node.r, id)
          case 'or': return matchesAgentNode(node.l, id) || matchesAgentNode(node.r, id)
          case 'not': return !matchesAgentNode(node.x, id)
          default: return false
        }
      }
      const rowId = (row, key) => row[key] || (key === 'from' ? row.agentId : null)
      const matchesMessageNode = (node, row) => {
        if (!node) return true
        switch (node.t) {
          case 'from': return matchesAgentNode(node.x, rowId(row, 'from'))
          case 'to': return matchesAgentNode(node.x, rowId(row, 'to'))
          case 'lit':
          case 'me': return matchesAgentNode(node, rowId(row, 'from')) || matchesAgentNode(node, rowId(row, 'to')) || matchesAgentNode(node, row.agentId)
          case 'since': return !row.timestamp || row.timestamp >= node.v
          case 'before': return !row.timestamp || row.timestamp < node.v
          case 'type': return row.type === node.v || row.role === node.v
          case 'and': return matchesMessageNode(node.l, row) && matchesMessageNode(node.r, row)
          case 'or': return matchesMessageNode(node.l, row) || matchesMessageNode(node.r, row)
          case 'not': return !matchesMessageNode(node.x, row)
          default: return false
        }
      }

      // Support lineage search: agents[] (array of fleet IDs to union)
      let searchAgent = msg.agents?.length ? msg.agents : msg.agent;
      const messageFilter = msg.filterExpression ? parseMessageFilter(msg.filterExpression) : null
      if (messageFilter) {
        const ids = [...collectPrefilterIds(messageFilter)]
        if (ids.length) searchAgent = ids
      }
      // A typed name fragment (agent:/from:) resolves on the SERVER to the set of
      // fleet ids it refers to — substring over current + historical names,
      // dawn-aware. An empty match yields an impossible id (an empty result set),
      // NOT an unfiltered search.
      if (msg.agentQuery) {
        const ids = fleetStore.resolveAgentQuery(msg.agentQuery);
        searchAgent = ids.length ? ids : [noMatch];
      }
      const hasText = (msg.query || '').trim().length > 0;
      let results = fleetStore.searchAll(msg.query || '', {
        limit: msg.limit, agent: searchAgent, role: msg.role, since: msg.since, before: msg.before,
        // No keyword + an agent filter → return that agent's whole history
        // instead of FTS-matching the literal query text.
        agentOnly: msg.agentOnly ?? (!hasText && !!searchAgent),
        historyOnly: msg.historyOnly,
        eventOnly: msg.eventOnly,
        fromOnly: msg.fromOnly,
      })
      if (hasText && (msg.naturalAgentQuery || msg.naturalAgentQueries?.length) && !searchAgent && !msg.filterExpression) {
        const naturalQueries = msg.naturalAgentQueries?.length ? msg.naturalAgentQueries : [msg.naturalAgentQuery]
        const ids = [...new Set(naturalQueries.flatMap(query => (
          String(query || '').trim() === 'me'
            ? [currentSearchActor()]
            : fleetStore.resolveAgentSelector(parseUnifiedAgentSelector(query) || { fragment: query })
        )))]
        if (ids.length) {
          const naturalTextQuery = (msg.naturalTextQuery || '').trim()
          const agentResults = fleetStore.searchAll(naturalTextQuery, {
            limit: msg.limit, agent: ids, role: msg.role, since: msg.since, before: msg.before,
            agentOnly: !naturalTextQuery,
            historyOnly: msg.historyOnly,
            eventOnly: msg.eventOnly,
          })
          const seen = new Set(results.map(r => `${r.source}:${r.id}`))
          for (const row of agentResults) {
            const key = `${row.source}:${row.id}`
            if (!seen.has(key)) {
              seen.add(key)
              results.push(row)
            }
          }
          results = results.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')).slice(0, msg.limit || 50)
        }
      }
      if (msg.eventType) results = results.filter(r => r.type === msg.eventType || r.role === msg.eventType)
      if (messageFilter) results = results.filter(r => matchesMessageNode(messageFilter, r))
      results = stampNames(results)
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

  // Interacting with a hibernating (non-dead, no live process) agent wakes.
  // Live non-Claude TUI agents also need a terminal nudge: their MCP channel can
  // record the event without submitting a new turn.
  // Idempotent waker: chat/delegate adds agent IDs to a Map.
  // A serial loop drains it — one spawn at a time, naturally deduped.
  const _wakeQueue = new Map()
  let _wakeDraining = false
  // Per-agent throttle so a repeatedly-failing wake doesn't spam Skip's chat.
  const _wakeFailWarned = new Map() // agentId → last-warned ms
  const WAKE_FAIL_WARN_MS = 5 * 60 * 1000
  function requestWake(agentId, nudgeText = null, asker = null, traceId = null) {
    const agent = fleetStore.getAgent?.(agentId)
    if (!agent || agent.dead || agent.human) return
    if (isReservedShellAgent(agent)) {
      spawnLibrarian.observeLiveness({
        type: 'agent-liveness',
        agent_id: agentId,
        tmux_session: agent.tmux_session,
        state: 'spawning',
        reason: 'reserved shell has not logged in yet',
        ts: new Date().toISOString(),
      })
      if (traceId) {
        controlPlaneTraces.append({
          trace_id: traceId,
          component: 'server',
          operation: 'wake.request',
          status: 'pending-shell',
          detail: { agent: agentId },
        })
      }
      return
    }
    if (isWakeBreakerOpen(_wakeBreaker, agentId, Date.now())) {
      if (traceId) {
        controlPlaneTraces.append({
          trace_id: traceId,
          component: 'server',
          operation: 'wake.request',
          status: 'breaker-open',
          detail: { agent: agentId },
        })
      }
      return
    }
    const prev = _wakeQueue.get(agentId)
    _wakeQueue.set(agentId, {
      nudgeText: nudgeText || prev?.nudgeText || null,
      asker: asker || prev?.asker || null,
      traceId: traceId || prev?.traceId || null,
    })
    if (traceId) {
      controlPlaneTraces.append({
        trace_id: traceId,
        component: 'server',
        operation: 'wake.request',
        status: 'queued',
        detail: { agent: agentId, asker },
      })
    }
    if (!_wakeDraining) drainWakeQueue()
  }

  async function drainWakeQueue() {
    _wakeDraining = true
    while (_wakeQueue.size > 0) {
      const [agentId, wakeEntry] = _wakeQueue.entries().next().value
      _wakeQueue.delete(agentId)
      const nudgeText = wakeEntry?.nudgeText || null
      const asker = wakeEntry?.asker || null
      const traceId = wakeEntry?.traceId || null
      const agent = fleetStore.getAgent?.(agentId)
      if (!agent || agent.dead || agent.human) {
        if (traceId) {
          controlPlaneTraces.append({
            trace_id: traceId,
            component: 'server',
            operation: 'wake.skip',
            status: 'ignored',
            detail: { agent: agentId, reason: !agent ? 'missing-agent' : agent.dead ? 'dead' : 'human' },
          })
        }
        continue
      }
      const daemonKeys = [...daemonConnections.keys()]
      if (daemonKeys.length === 0) {
        if (traceId) {
          controlPlaneTraces.append({
            trace_id: traceId,
            component: 'server',
            operation: 'wake.defer',
            status: 'no-daemon',
            detail: { agent: agentId },
          })
        }
        continue
      }
      const daemonKey = agent.machine_id && agent.env_name ? agentDaemonAddress(agent) : daemonKeys[0]
      try {
        if (traceId) {
          controlPlaneTraces.append({
            trace_id: traceId,
            component: 'server',
            operation: 'wake.route',
            status: 'started',
            detail: { agent: agentId, daemon: daemonKey },
          })
        }
        const machineId = agent.machine_id
        if (!machineId) throw new Error(`agent ${agent.friendly_name || agentId} has no machine_id; cannot route wake/respawn`)
        const ownerDaemon = daemonConnections.get(daemonKey)
        if (!ownerDaemon || ownerDaemon.readyState !== 1) throw new Error(`No fleet-daemon connected for ${daemonKey}`)
        const serverAlive = isAgentAlive(agentId)
        const liveness = serverAlive
          ? await sendRpcResilient(daemonKey, 'check-alive', { tmux_session: agent.tmux_session })
            .then(result => livenessFromCheckAliveResult(agentId, agent.tmux_session, result))
            .catch(e => ({
              type: 'agent-liveness',
              agent_id: agentId,
              tmux_session: agent.tmux_session,
              state: 'unknown',
              reason: e.message,
              ts: new Date().toISOString(),
            }))
          : {
              type: 'agent-liveness',
              agent_id: agentId,
              tmux_session: agent.tmux_session,
              state: 'unknown',
              reason: 'server liveness says hibernating',
              ts: new Date().toISOString(),
            }
        spawnLibrarian.observeLiveness({ ...liveness, agent_id: liveness.agent_id || agentId })
        const decision = spawnLibrarian.decideWake(agent, { ...liveness, agent_id: liveness.agent_id || agentId }, { serverAlive })
        if (traceId) {
          controlPlaneTraces.append({
            trace_id: traceId,
            component: 'server',
            operation: 'wake.decision',
            status: decision.action,
            detail: { agent: agentId, liveness: liveness.state },
          })
        }
        if (decision.action === 'deliver') {
          await sendWakeNudge(daemonKey, agent, agent.tmux_session, nudgeText, 'deliver')
          if (traceId) {
            controlPlaneTraces.append({
              trace_id: traceId,
              component: 'server',
              operation: 'wake.nudge',
              status: 'sent',
              detail: { agent: agentId, mode: 'deliver' },
            })
          }
          continue
        }
        if (decision.action === 'queue') {
          setTimeout(() => requestWake(agentId, nudgeText, asker, traceId), 2000).unref?.()
          continue
        }
        if (decision.action === 'hold') continue
        if (decision.action === 'surface') {
          // Convergent state via the event (per-agent status line), not a chat message. (Skip 6/27)
          broadcastEvent('agent-wedged', { agentId, reason: decision.message, ts: new Date().toISOString() })
          continue
        }
        console.log(`[respawn] waking ${agent.friendly_name || agentId} (${agentId})`)
        // Wake by IDENTITY, not name. requestWake already resolved the exact
        // fleet-id we mean (the Map is keyed by id, getAgent fetched that row);
        // passing agent.friendly_name here would throw that away and force a
        // name re-grep in fleet-spawn that could land on a different namesake.
        // agentId is a `fleet:` id, which fleet-spawn resumes directly. This is
        // the chat-wake entry point — the one that fires when Skip chats a
        // hibernating agent — so identity must be carried here above all.
        // Wake carries NO privilege check (hibernation is transparent) — pass no
      // requester; the daemon resumes the agent with its own privileges. agent_id
      // lets the daemon find that agent's own grant.
      const spawnResult = await sendRpc(daemonKey, 'spawn', { name: agentId, agent_id: agentId, respawn: true })
        if (!spawnResult?.ok) {
          // A returned {ok:false} used to be dropped on the floor: no wake, no
          // signal, and (worse) a false "agent woken" event below. Convert it to
          // the surfaced path (catch → chat the asker + agent-wedged). Never silent.
          throw new Error(spawnResult?.error || spawnResult?.reason || 'daemon returned ok:false with no reason')
        }
        await sendWakeNudge(daemonKey, agent, spawnResult?.tmux_session || agent.tmux_session, nudgeText, 'post-respawn')
        if (traceId) {
          controlPlaneTraces.append({
            trace_id: traceId,
            component: 'server',
            operation: 'wake.respawn',
            status: 'sent',
            detail: { agent: agentId, daemon: daemonKey },
          })
        }
        const wakeTs = new Date().toISOString()
        await measureHotOp('fleet-ws lifecycle wake insert', `agent=${agentId}`, () => fleetStore._insertEventRecord({
          type: 'lifecycle',
          timestamp: wakeTs,
          from: agentId,
          to: agentId,
          text: 'agent woken',
          unread: false,
        }, { notify: false }))
      } catch (e) {
        const b = _wakeBreaker.get(agentId) || { fails: 0 }
        b.fails += 1
        b.lastError = e.message
        b.nextTs = Date.now() + wakeBreakerBackoffMs(b.fails, WAKE_BREAKER_BASE_MS, WAKE_BREAKER_CAP_MS)
        _wakeBreaker.set(agentId, b)
        if (traceId) {
          controlPlaneTraces.append({
            trace_id: traceId,
            component: 'server',
            operation: 'wake.error',
            status: 'failed',
            detail: { agent: agentId },
            error: e.message,
          })
        }
        console.warn(`[respawn] failed for ${agentId} (fails=${b.fails}, backoff until ${new Date(b.nextTs).toISOString()}): ${e.message}`)
        // Convergent, visible signal on the roster (not just a chat) so a failed
        // wake shows up in the UI, not invisibly.
        broadcastEvent('agent-wedged', { agentId, reason: `wake failed: ${e.message}`, ts: new Date().toISOString() })
        // Surface the failure to WHOEVER ASKED (Skip's rule) — the agent/human who
        // chatted or delegated — falling back to the server owner for wakes with no
        // identifiable asker (internal retries). Throttled per-agent so a stuck wake
        // doesn't spam chat.
        const _now = Date.now()
        if (!_wakeFailWarned.has(agentId) || _now - _wakeFailWarned.get(agentId) > WAKE_FAIL_WARN_MS) {
          _wakeFailWarned.set(agentId, _now)
          const notify = asker && asker !== agentId ? asker : SERVER_OWNER_ID
          try {
            deliverTldaFeedbackChat({
              from: 'fleet:tlda',
              to: notify,
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

  const previewForWake = (raw, max = 120) => {
    const s = String(raw || '')
    return s.length > max ? `${s.slice(0, max)}…` : s
  }
  const inboxStatusFor = (agentId) => {
    const status = fleetStore.getAgent?.(agentId)?.metadata?.inboxStatus
    return normalizeInboxStatus(status)
  }
  const unreadPendingFor = (eventId, agentId) => {
    const row = fleetStore.db.prepare('SELECT read FROM unread WHERE event_id = ? AND to_id = ?').get(eventId, agentId)
    return !!row && !row.read
  }
  const inboxCall = (action) => `Call inbox() to ${action}.`
  const wakeText = ({ status, event, preview, action }) => {
    const label = normalizeInboxStatus(status)
    const prefix = label[0].toUpperCase() + label.slice(1)
    return `📬 ${prefix} ${event}: ${preview}\n${inboxCall(action)}`
  }
  const chatWakeText = (text, agentId) => wakeText({ status: inboxStatusFor(agentId), event: 'message arrived', preview: previewForWake(text), action: 'read and respond' })
  const delegateWakeText = (description, agentId) => wakeText({ status: inboxStatusFor(agentId), event: 'new task assigned', preview: previewForWake(description), action: 'see it' })

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
    const inserted = await measureHotOp('fleet-ws amend event insert', `from=${from} to=${orig.to}`, () => fleetStore._insertEventRecord({
      type: 'amend',
      timestamp: ts,
      from,
      to: orig.to,
      text,
      metadata: meta,
      unread: false,
    }, { notify: false }))
    const amendId = Number(inserted.id)
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
    const traceId = metadata?.trace_id || msg.trace_id || (msg._tempId ? `chat:${msg._tempId}` : createTraceId('chat'))
    controlPlaneTraces.append({
      trace_id: traceId,
      component: 'server',
      operation: 'chat.ingress',
      status: 'received',
      detail: { from: rawFrom, to: rawTo, temp_id: msg._tempId },
    })
    // Idempotency: if the client retries with the same _tempId, return the
    // previously inserted event IDs instead of creating duplicates.
    if (msg._tempId && _chatTempIds.has(msg._tempId)) {
      const prev = _chatTempIds.get(msg._tempId)
      controlPlaneTraces.append({
        trace_id: traceId,
        component: 'server',
        operation: 'chat.idempotency',
        status: 'memory-hit',
        detail: { temp_id: msg._tempId, event_ids: prev.eventIds },
      })
      reply({ ok: true, event_ids: prev.eventIds, recipients: prev.recipients, receipts: prev.receipts || [], _tempId: msg._tempId, trace_id: traceId })
      return
    }
    if (msg._tempId) {
      const prev = fleetStore.getChatTempIdResult?.(msg._tempId)
      if (prev) {
        _chatTempIds.set(msg._tempId, { ...prev, ts: Date.now() })
        controlPlaneTraces.append({
          trace_id: traceId,
          component: 'server',
          operation: 'chat.idempotency',
          status: 'db-hit',
          detail: { temp_id: msg._tempId, event_ids: prev.eventIds },
        })
        reply({ ok: true, event_ids: prev.eventIds, recipients: prev.recipients, receipts: prev.receipts || [], _tempId: msg._tempId, trace_id: traceId })
        return
      }
    }
    const resolveSingle = (id) => {
      if (id === SERVER_OWNER_NAME) return SERVER_OWNER_ID
      const a = fleetStore?.findAgent(id); return a ? a.id : null
    }
    const from = rawFrom ? (resolveSingle(rawFrom) || rawFrom) : null
    // `to` is a filter expression (e.g. "fleet:skip", "awake & reviewers",
    // "mathy & !goose"). Parse once, then test each agent's label set.
    let filterAst
    try { filterAst = parseFilter(rawTo) } catch (e) { error(`bad filter "${rawTo}": ${e.message}`); return }
    // Resolve over agents, NEVER delivering to dead ones. A dead agent
    // isn't running and can't act on a message; delivering to it also
    // double-fans a filter when a dead twin shares a live agent's name (e.g.
    // an old `preread` row + the live `preread`) → the sender sees their
    // message twice. To reach a dead agent, resurrect it first (it goes live,
    // then matches here). No "prefer the live one" — dead is simply excluded.
    const recipients = fleetStore.resolveChatRecipients(filterAst, { from, filter: rawTo })
    // Server-owner pseudo-recipient: not in the roster, so evaluate the filter
    // against its literal id/name label set. An empty filter (null) does NOT
    // fan out to the owner.
    if (filterAst && evalExpr(filterAst, [SERVER_OWNER_ID, SERVER_OWNER_NAME])) {
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
    // Stamp the human sender's physical machine onto the message context so any
    // agent can see what machine Skip is on without inferring from Tailscale.
    // Resolved server-side from the connection's tailnet IP; fail-visible (omit
    // when unknown — never a wrong machine). Folded into context so it renders
    // next to the doc/page chip.
    let outContext = context
    if (senderAgent?.human) {
      const machine = resolveMachine(ws?._fwdFor || ws?._remoteAddr)
      if (machine) outContext = { ...(context || {}), machine }
    }
    const ts = new Date().toISOString()
    const eventIds = []
    const insertedEvents = []
    const receipts = []
    const wakeRequests = []
    const basePriority = normalizeMessagePriority(metadata?.priority || parsePriorityPhrase(text) || (from === SERVER_OWNER_ID ? 'urgent' : 'normal'))
    controlPlaneTraces.append({
      trace_id: traceId,
      component: 'server',
      operation: 'chat.resolve',
      status: 'matched',
      detail: { from, to: rawTo, recipients },
    })
    for (const to of recipients) {
      // Resolve wiretaps per recipient — tap labels are matched against this `to`.
      const wiretapRecipients = fleetStore.resolveWiretaps(from, to, 'chat')
      const recipientAgent = fleetStore.getAgent?.(to)
      const inboxStatus = normalizeInboxStatus(recipientAgent?.metadata?.inboxStatus)
      const inboxStatusTag = recipientAgent?.metadata?.inboxStatusTag || null
      const deliveryChannel = normalizeDeliveryChannel(recipientAgent?.metadata?.deliveryChannel)
      const deliveryDecision = decideInboxDelivery({ status: inboxStatus, priority: basePriority, now: Date.parse(ts) || Date.now() })
      const materializableAttachments = (inline_attachments || []).filter(isMaterializableAttachment)
      let combinedMetadata = {
        ...(metadata || {}),
        priority: basePriority,
        trace_id: traceId,
        inbox_delivery: deliveryDecision.delivery,
        inbox_status: inboxStatus,
        delivery_channel: deliveryChannel,
        ...(inboxStatusTag ? { inbox_status_tag: inboxStatusTag } : {}),
        ...(deliveryDecision.notifyBy ? { notify_by: deliveryDecision.notifyBy } : {}),
        ...(ccResolved ? { cc: ccResolved } : {}),
        ...(processedAttachments ? { attachments: processedAttachments } : {}),
        ...(inline_attachments ? { inline_attachments } : {}),
        ...(msg._tempId ? { client_temp_id: msg._tempId } : {}),
        ...(wiretapRecipients.length ? { wiretap_cc: wiretapRecipients } : {}),
        ...(outContext ? { context: outContext } : {}),
        ...(preambleRef ? { preambleRef } : {}),
        ...(chatReminder ? { chatReminder } : {}),
        ...(source ? { source } : {}),
      }
      if (recipientAgent && !recipientAgent.human && materializableAttachments.length) {
        combinedMetadata = initializeRecipientRefs(combinedMetadata, to, materializableAttachments, { sourceAgent: from })
      }
      const inserted = await measureHotOp('fleet-ws chat event insert', `from=${from} to=${to} bytes=${text.length}`, () => fleetStore._insertEventRecord({
        type: 'chat',
        timestamp: ts,
        from,
        to,
        text,
        metadata: Object.keys(combinedMetadata).length ? combinedMetadata : null,
        unread: true,
      }, { notify: false }))
      const eventId = Number(inserted.id)
      controlPlaneTraces.append({
        trace_id: traceId,
        component: 'fleet-store',
        operation: 'chat.insert',
        status: 'stored',
        detail: { event_id: eventId, from, to },
      })
      eventIds.push(eventId)
      receipts.push({
        recipient: to,
        status: inboxStatus,
        tag: inboxStatusTag,
        priority: basePriority,
        delivery: deliveryDecision.delivery,
        deliveryChannel,
        wokeRecipient: deliveryDecision.wokeRecipient,
        notifyBy: deliveryDecision.notifyBy,
      })
      if (recipientAgent && !recipientAgent.human && deliveryChannel === 'channel' && !hasOpenFleetSocketForAgent(to)) {
        await notificationAttempts.record({
          agentId: to,
          reason: 'chat',
          sourceEventId: eventId,
          priority: basePriority,
          intendedSurface: 'channel',
          policy: deliveryDecision.delivery === 'batched' ? 'batched' : inboxStatus,
          outcome: 'deferred',
          evidence: {
            inboxStatus,
            delivery: deliveryDecision.delivery,
            activeChannelSocket: false,
          },
          nextAction: deliveryDecision.notifyBy ? 'retry-at' : 'retry-on-reconnect',
          nextAttemptAt: deliveryDecision.notifyBy || null,
        })
      }
      // Echo _tempId on the broadcast so a client whose WS reply was lost during
      // a hiccup can still bind this echo to its orphaned optimistic entry
      // (the reply, not the DB row, is what normally carries _tempId).
      insertedEvents.push({ id: eventId, type: 'chat', timestamp: ts, from_id: from, to_id: to, text, metadata: Object.keys(combinedMetadata).length ? combinedMetadata : null, materializableAttachments, ...(msg._tempId ? { _tempId: msg._tempId } : {}) })
      if (deliveryDecision.delivery === 'notified') {
        wakeRequests.push({ to, text: chatWakeText(text, to), asker: from, traceId })
      } else if (deliveryDecision.delivery === 'batched' && deliveryDecision.notifyBy) {
        const delay = Math.max(0, Date.parse(deliveryDecision.notifyBy) - Date.now())
        setTimeout(() => {
          const latestStatus = inboxStatusFor(to)
          const unreadPending = unreadPendingFor(eventId, to)
          if (shouldWakeBatchedMessage({ status: latestStatus, unreadPending })) {
            requestWake(to, wakeText({
              status: latestStatus,
              event: 'batched message ready',
              preview: previewForWake(text),
              action: 'read and respond',
            }), from, traceId)
          }
        }, delay)
      }
    }
    // Cache _tempId for idempotent retries
    if (msg._tempId) _chatTempIds.set(msg._tempId, { eventIds, recipients, receipts, ts: Date.now() })
    // Reply FIRST so the client can reconcile optimistic events before broadcasts arrive.
    reply({ ok: true, event_ids: eventIds, recipients, receipts, _tempId: msg._tempId || null, trace_id: traceId })
    for (const ev of insertedEvents) {
      const { materializableAttachments: _materializableAttachments, ...broadcastEv } = ev
      broadcastEvent('fleet-event', broadcastEv)
      if (_materializableAttachments?.length) {
        queueRecipientMaterialization({
          eventId: ev.id,
          recipientId: ev.to_id,
          sourceAgent: ev.from_id,
          attachments: _materializableAttachments,
        })
      }
    }
    const deliveredAt = Date.parse(ts) || Date.now()
    for (const to of recipients) {
      const recipient = fleetStore.getAgent?.(to)
      if (recipient && !recipient.human) spawnLibrarian.observeDelivery(to, deliveredAt)
    }
    for (const wake of wakeRequests) requestWake(wake.to, wake.text, wake.asker, wake.traceId)

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
        if (approval?.tmux_session && approval?.machine_id && approval?.env_name) {
          sendRpc(daemonAddress(approval.machine_id, approval.env_name), 'send-text', {
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
        if (!agent?.tmux_session || !agent.machine_id || !agent.env_name) continue
        sendRpc(agentDaemonAddress(agent), 'send-text', {
          tmux_session: agent.tmux_session,
          text: '/plan',
          enter: true,
        }).catch(e => console.error(`[outline-keyword] plan mode failed for ${r}: ${e.message}`))
        if (keyword === 'outline') {
          setTimeout(() => {
            sendRpc(agentDaemonAddress(agent), 'send-text', {
              tmux_session: agent.tmux_session,
              text: 'Invoke the outline-before-writing skill now. Write your outline in the plan file, then share the plan file path in chat so it appears as a tappable note.',
              enter: true,
            }).catch(e => console.error(`[outline-keyword] skill nudge failed for ${r}: ${e.message}`))
          }, 2000)
        }
        fleetStore.updateAgentMeta?.(agent.id, { inPlanMode: true, planModeType: keyword })
        console.log(`[outline-keyword] forced plan mode on ${agent.friendly_name || r} (keyword: ${keyword})`)
      }
      broadcastState(recipients)
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
      const { events: resolved, hasMore } = fleetStore.buildChatHistoryResponse({
        before,
        agents,
        limit,
        serverOwnerId: SERVER_OWNER_ID,
        serverOwnerName: SERVER_OWNER_NAME,
      })
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
    const { agent: agentQuery, description, message: taskMsg, success_criteria, blocked_by, from, requires_approval, allow_pending_agent, operation_id } = msg
    if (!agentQuery || !description) { error('missing agent or description'); return }
    const previous = operation_id ? fleetStore.getDelegateOperationResult?.(operation_id) : null
    if (previous?.delegateEventId) {
      reply({
        ok: true,
        task_id: previous.taskId,
        delegate_event_id: previous.delegateEventId,
        event_id: previous.delegateEventId,
        event_ids: previous.eventIds,
        operation_id,
        idempotent: true,
      })
      return
    }
    const traceId = msg.trace_id || (operation_id ? `delegate:${operation_id}` : createTraceId('delegate'))
    controlPlaneTraces.append({
      trace_id: traceId,
      component: 'server',
      operation: 'delegate.ingress',
      status: 'received',
      detail: { from, agent: agentQuery, operation_id: operation_id || null },
    })
    const resolved = fleetStore.findAgent(agentQuery) || (
      allow_pending_agent && typeof agentQuery === 'string' && agentQuery.startsWith('fleet:')
        ? { id: agentQuery, friendly_name: null }
        : null
    )
    if (!resolved) { error(`agent not found: ${agentQuery}`); return }
    const taskId = previous?.taskId || `${resolved.id.slice(0, 10)}-${Date.now().toString(36)}`
    const now = new Date().toISOString()
    const metadata = {
      trace_id: traceId,
      ...(operation_id ? { client_operation_id: operation_id } : {}),
      ...(requires_approval ? { requires_approval: true } : {}),
      ...(allow_pending_agent && !fleetStore.findAgent(agentQuery) ? { pending_spawn_delegate: true } : {}),
    }
    const task = {
      id: taskId, agent: resolved.id, description,
      message: taskMsg || description,
      delegated_by: from || null, delegated_at: now,
      status: blocked_by?.length ? 'blocked' : 'pending',
      acknowledged: false,
      blockedBy: blocked_by || undefined,
      success_criteria: success_criteria || undefined,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    }
    fleetStore.upsertTask(task)
    const fromAgent = from ? fleetStore.findAgent(from) : null
    const delegateEvent = await fleetStore.delegate?.(from, resolved.id, taskId, description, {
      trace_id: traceId,
      ...(operation_id ? { client_operation_id: operation_id } : {}),
      fromLabel: fromAgent?.friendly_name || from || '',
      toLabel: resolved.friendly_name || resolved.id,
      criteria: success_criteria || [],
      message: taskMsg || '',
    })
    controlPlaneTraces.append({
      trace_id: traceId,
      component: 'fleet-store',
      operation: 'delegate.insert',
      status: 'stored',
      detail: { task_id: taskId, event_id: delegateEvent?.id, from, to: resolved.id },
    })
    const targetAgent = fleetStore.getAgent?.(resolved.id)
    const deliveryChannel = normalizeDeliveryChannel(targetAgent?.metadata?.deliveryChannel)
    if (targetAgent && !targetAgent.human && deliveryChannel === 'channel' && !hasOpenFleetSocketForAgent(resolved.id)) {
      const inboxStatus = normalizeInboxStatus(targetAgent?.metadata?.inboxStatus)
      await notificationAttempts.record({
        agentId: resolved.id,
        reason: 'delegate',
        sourceEventId: delegateEvent?.id || null,
        sourceTaskId: taskId,
        priority: 'urgent',
        intendedSurface: 'channel',
        policy: inboxStatus,
        outcome: 'deferred',
        evidence: {
          inboxStatus,
          activeChannelSocket: false,
        },
        nextAction: 'retry-on-reconnect',
      })
    }
    broadcastState(resolved.id)
    reply({
      ok: true,
      task_id: taskId,
      delegate_event_id: delegateEvent?.id || null,
      event_id: delegateEvent?.id || null,
      event_ids: [delegateEvent?.id].filter(id => id != null),
      operation_id: operation_id || null,
      trace_id: traceId,
    })
    requestWake(resolved.id, delegateWakeText(description, resolved.id), from, traceId)
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
    const { eventId } = await completeTaskLifecycle({ fleetStore, agentId: agent, task })
    broadcastState()
    reply({ ok: true, task_id: task.id, event_id: eventId })
    return
  }

  if (type === 'report-close') {
    const { agent: rawAgent, task_id, summary, close, reason, approval_id, operation_id } = msg
    if (!rawAgent) { error('missing agent'); return }
    if (!summary) { error('missing summary'); return }
    if (!operation_id) { error('missing operation_id'); return }
    const traceId = msg.trace_id || `report:${operation_id}`
    controlPlaneTraces.append({
      trace_id: traceId,
      component: 'server',
      operation: 'report.ingress',
      status: 'received',
      detail: { agent: rawAgent, task_id, operation_id, close: !!close },
    })
    const agent = fleetStore.findAgent?.(rawAgent)?.id || rawAgent
    const task = task_id
      ? fleetStore.getTask?.(task_id)
      : fleetStore.getTaskByAgent?.(agent)
    if (!task) { error('no active task'); return }
    const closeDecision = close ? decideReportClose(summary) : { allowClose: true }
    if (close && task.metadata?.requires_approval) {
      if (!approval_id) { error('This task requires approval. Pass approval_id (event ID of a human approval message).'); return }
      const evt = fleetStore.getEventById(approval_id)
      if (!evt) { error(`approval_id ${approval_id} not found`); return }
      const fromAgent = (evt.from_id || evt.from) ? fleetStore.getAgent(evt.from_id || evt.from) : null
      if (!fromAgent?.human) { error(`approval_id ${approval_id} is not from a human`); return }
    }

    const previous = fleetStore.getReportCloseOperationResult?.(operation_id)
    let reportEventId = previous?.reportEventId || null
    let chatEventId = previous?.chatEventId || null
    let closeEventId = previous?.closeEventId || null

    if (!reportEventId) {
      const insertedReport = await fleetStore.report?.(agent, task.id, summary, {
        trace_id: traceId,
        client_operation_id: operation_id,
        close_requested: !!close,
      })
      reportEventId = insertedReport?.id || null
      controlPlaneTraces.append({
        trace_id: traceId,
        component: 'fleet-store',
        operation: 'report.insert',
        status: 'stored',
        detail: { event_id: reportEventId, task_id: task.id, agent },
      })
    } else {
      controlPlaneTraces.append({
        trace_id: traceId,
        component: 'server',
        operation: 'report.idempotency',
        status: 'hit',
        detail: { event_id: reportEventId, operation_id },
      })
    }

    if (!chatEventId && task.delegated_by) {
      const sender = fleetStore.getAgent?.(agent)
      const senderName = sender?.friendly_name || agent
      const insertedChat = await fleetStore.chat?.(
        agent,
        task.delegated_by,
        `**${senderName} report: ${task.description}**\n\n${summary}`,
        {
          trace_id: traceId,
          client_operation_id: operation_id,
          type: 'report',
          report_event_id: reportEventId,
          priority: 'normal',
        },
      )
      chatEventId = insertedChat?.id || null
      controlPlaneTraces.append({
        trace_id: traceId,
        component: 'fleet-store',
        operation: 'report.chat.insert',
        status: 'stored',
        detail: { event_id: chatEventId, from: agent, to: task.delegated_by },
      })
    }

    if (close && closeDecision.allowClose && !closeEventId) {
      const closeReason = reason || 'done'
      task.status = 'done'
      task.completed_at = new Date().toISOString()
      task.metadata = { ...(task.metadata || {}), close_reason: closeReason }
      fleetStore.upsertTask(task)
      const insertedClose = await fleetStore.taskDone?.(agent, task.id, task.description, {
        trace_id: traceId,
        client_operation_id: operation_id,
        report_event_id: reportEventId,
        close_reason: closeReason,
      })
      closeEventId = insertedClose?.id || null
      controlPlaneTraces.append({
        trace_id: traceId,
        component: 'fleet-store',
        operation: 'report.close.insert',
        status: 'stored',
        detail: { event_id: closeEventId, task_id: task.id, reason: closeReason },
      })
    }

    broadcastState()
    reply({
      ok: true,
      task_id: task.id,
      report_event_id: reportEventId,
      chat_event_id: chatEventId,
      close_event_id: closeEventId,
      close_rejected: !!close && !closeDecision.allowClose,
      close_guard_reason: closeDecision.reason,
      close_guard_message: closeDecision.message || null,
      event_id: closeEventId || reportEventId,
      event_ids: [reportEventId, chatEventId, closeEventId].filter(id => id != null),
      operation_id,
      trace_id: traceId,
    })
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
    const tasks = fleetStore.getActiveTasksByAgentLimited?.(agentId, MY_TASK_TASK_LIMIT) || fleetStore.getActiveTasksByAgent?.(agentId)?.slice(0, MY_TASK_TASK_LIMIT) || []
    const taskCount = fleetStore.getActiveTaskCountByAgent?.(agentId) ?? tasks.length
    const task = tasks[0] || fleetStore.getTaskByAgent?.(agentId) || null
    const unread = fleetStore.getUnreadLimited?.(agentId, MY_TASK_UNREAD_LIMIT) || fleetStore.getUnread?.(agentId)?.slice(0, MY_TASK_UNREAD_LIMIT) || []
    const unreadCount = fleetStore.getUnreadCount?.(agentId) ?? unread.length
    // peek=true: caller just wants to see unread (e.g., the channel-WS
    // flush-on-reconnect path that displays a count). Don't mark read in
    // that case — the actual inbox() call from the agent will do the
    // marking. Without this, peek silently consumes the unread queue and
    // the subsequent inbox() returns nothing.
    if (unread.length && !msg.peek) {
      const readIds = fleetStore.markEventsRead?.(agentId, unread.map(m => m.id)) || []
      if (readIds.length) broadcastEvent('read-receipt', { event_ids: readIds, agent: agentId })
    }
    broadcastState()
    reply({
      task,
      tasks: tasks.length ? tasks : (task ? [task] : []),
      messages: unread,
      counts: {
        tasks: taskCount,
        messages: unreadCount,
        task_limit: MY_TASK_TASK_LIMIT,
        message_limit: MY_TASK_UNREAD_LIMIT,
        tasks_truncated: taskCount > tasks.length,
        messages_truncated: unreadCount > unread.length,
      },
    })
    return
  }

  if (type === 'inbox-status') {
    const { agent, status, tag } = msg
    if (!agent) { error('missing agent'); return }
    if (!INBOX_STATUSES.includes(status)) { error(`bad inbox status: ${status}`); return }
    fleetStore.updateAgentMeta?.(agent, { inboxStatus: status, inboxStatusTag: tag || null })
    broadcastState()
    reply({ ok: true, agent, status, tag: tag || null })
    return
  }

  if (type === 'delivery-channel') {
    const { caller: callerQuery, agent: agentQuery, channel: rawChannel } = msg
    if (!callerQuery) { error('missing caller'); return }
    const channel = validateDeliveryChannel(rawChannel)
    if (!channel) { error(`bad delivery channel: ${rawChannel}; use ${DELIVERY_CHANNELS.join(', ')}`); return }
    const caller = fleetStore.findAgent?.(callerQuery)
    if (!caller) { error(`caller not found: ${callerQuery}`); return }
    const row = fleetStore.findAgent?.(agentQuery || caller.id)
    if (!row) { error(`agent not found: ${agentQuery || caller.id}`); return }
    const targetLabel = row.friendly_name || row.id
    const self = caller.id === row.id
    if (!self && !fleetStore.isDelegatorForAgent?.(caller.id, row.id)) {
      error(`Cannot set delivery channel for ${targetLabel}: you are not that agent's manager. Delegate them a task first if you mean to take responsibility for their delivery channel, then retry.`)
      return
    }
    if (channel === 'tmux') {
      if (!row.tmux_session) { error('agent has no tmux session'); return }
      const route = resolveRpc('send-text', row)
      if (route.via === 'none') { error(route.error); return }
    }
    fleetStore.updateAgentMeta?.(row.id, { deliveryChannel: channel })
    broadcastState()
    reply({ ok: true, agent: row.id, target_label: targetLabel, caller: caller.id, channel, self })
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
      broadcastState(agentData.id)
    }
    reply({ ok: true })
    return
  }

  if (type === 'agent-thinking') {
    if (msg.thinking) {
      _thinkingState.set(msg.agentId, Date.now())
      touchActivity(msg.agentId)
    } else {
      // thinking → idle edge is a turn end. _thinkingState holds the start ts
      // and dedupes: only the first false after a true reaches emitTurnEnded.
      const startedAt = _thinkingState.get(msg.agentId)
      _thinkingState.delete(msg.agentId)
      if (startedAt !== undefined) emitTurnEnded(msg.agentId, startedAt)
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
    try {
      await fleetStore.renameAgentFriendlyName(agent.id, newName, { actorId: agent.id, reason: 'ws-rename' })
      broadcastState()
      reply({ ok: true, agent: agent.id, name: newName || null })
    } catch (e) {
      error(e.message)
    }
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
      markAgentNotAlive(agent.id)
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
      markAgentNotAlive(agent.id)
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

  // (The authoritative `spawn` handler is above — it runs through
  // performAuthorizedSpawn / authorizeSpawn and returns for every spawn message.
  // A second, older `if (type === 'spawn')` block used to live here that sent the
  // daemon RPC WITHOUT permission authorization or a spawnPolicy; it was dead
  // (unreachable after the first handler's return) and a latent self-escalation
  // bypass, so it was removed. Do not reintroduce an unauthorized spawn path.)

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

  // ---- check-alive ----
  if (type === 'check-alive') {
    const { agent: agentQuery } = msg
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.tmux_session) { reply(livenessFromCheckAliveResult(agent.id, null, { alive: false })); return }
    const route = resolveRpc('check-alive', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendRpc(route.machine_id, 'check-alive', { tmux_session: agent.tmux_session })
      reply(livenessFromCheckAliveResult(agent.id, agent.tmux_session, result))
    } catch (e) { error(e.message) }
    return
  }

  // ---- plan-mode-respond ----
  if (type === 'plan-mode-respond') {
    const { agent: agentQuery, response } = msg
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!agent.tmux_session) { error('no tmux session'); return }
    if (!isPlanModeResponse(response)) { error('response must be approve, supervised, or reject'); return }
    const route = resolveRpc('send-text', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      let result = await sendRpc(route.machine_id, 'send-text', { tmux_session: agent.tmux_session, text: planModeResponseKey(response), enter: false })
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
    if (!agent.machine_id || !agent.env_name) { error('agent has no daemon address'); return }
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

  // ---- subscription rows ----
  if (type === 'subscribe') {
    const { caller: callerQuery, target: targetQuery, query, notification_policy: policy } = msg
    if (!callerQuery || !query || !policy) { error('missing caller, query, or notification_policy'); return }
    const caller = fleetStore.findAgent?.(callerQuery)
    const target = fleetStore.findAgent?.(targetQuery || callerQuery)
    if (!caller || !target) { error('caller or target not found'); return }
    if (caller.id !== target.id && !fleetStore.isDelegatorForAgent?.(caller.id, target.id)) {
      error('not authorized to configure subscriptions for that target'); return
    }
    if (policy !== 'immediate' && policy !== 'hold' && !/^batch\(.+\)$/.test(policy)) {
      error('notification_policy must be immediate, hold, or batch(spec)'); return
    }
    const docMatch = query.match(/^doc:([^\s]+)$/i)
    if (!docMatch && (/\b(doc|event|type|since|after|before|agent):/i.test(query) || /\bto:me\b/i.test(query))) {
      error('unsupported subscription query term: stage-1 supports directional fleet labels or a single doc:<name> query'); return
    }
    if (!docMatch) {
      try { parseFilter(query) } catch (e) { error(`bad subscription query: ${e.message}`); return }
    }
    // Stage 1 persists every requested policy, but the existing fanout path is
    // immediate-only. Until batch/hold schedulers exist, supported matches
    // still enter the same server notification path.
    let adapter = 'wiretap'
    let adapterId = null
    try {
      if (docMatch) {
        adapter = 'document_monitor'
        tldaFeedback.subscribe(target.id, docMatch[1], deliverTldaFeedbackChat)
      } else {
        const tap = fleetStore.addWiretap(target.id, query, null)
        adapterId = tap.id
      }
    } catch (e) { error(`subscription adapter failed: ${e.message}`); return }
    const subscription = fleetStore.addSubscription({ owner: target.id, query, notificationPolicy: policy, createdBy: caller.id, adapter, adapterId })
    reply(subscription)
    return
  }

  if (type === 'subscriptions') {
    const { caller: callerQuery, target: targetQuery } = msg
    if (!callerQuery) { error('missing caller'); return }
    const caller = fleetStore.findAgent?.(callerQuery)
    const target = fleetStore.findAgent?.(targetQuery || callerQuery)
    if (!caller || !target) { error('caller or target not found'); return }
    if (caller.id !== target.id && !fleetStore.isDelegatorForAgent?.(caller.id, target.id)) {
      error('not authorized to inspect subscriptions for that target'); return
    }
    const rows = fleetStore.getSubscriptionsByOwner(target.id)
    for (const row of rows) {
      if (row.adapter === 'document_monitor') {
        const docMatch = String(row.query || '').match(/^doc:([^\s]+)$/i)
        if (docMatch) tldaFeedback.subscribe(row.owner, docMatch[1], deliverTldaFeedbackChat)
      }
    }
    reply(rows)
    return
  }

  if (type === 'unsubscribe') {
    const { caller: callerQuery, subscription_id: subscriptionId } = msg
    if (!callerQuery || !subscriptionId) { error('missing caller or subscription_id'); return }
    const caller = fleetStore.findAgent?.(callerQuery)
    const subscription = fleetStore.getSubscription(subscriptionId)
    if (!caller || !subscription) { error('caller or subscription not found'); return }
    if (caller.id !== subscription.owner && !fleetStore.isDelegatorForAgent?.(caller.id, subscription.owner)) {
      error('not authorized to remove that subscription'); return
    }
    if (subscription.adapter === 'wiretap' && subscription.adapter_id) fleetStore.removeWiretap(subscription.adapter_id)
    if (subscription.adapter === 'document_monitor') {
      const docMatch = String(subscription.query || '').match(/^doc:([^\s]+)$/i)
      if (docMatch) tldaFeedback.unsubscribe(subscription.owner, docMatch[1])
    }
    fleetStore.removeSubscription(subscription.subscription_id)
    reply({ ok: true, subscription_id: subscription.subscription_id })
    return
  }

  // ---- wiretap-add (internal adapter) ----
  if (type === 'wiretap-add') {
    const { agent, filter, types } = msg
    if (!agent || !filter) { error('missing agent or filter'); return }
    // Filter is a string expression (same grammar as chat/fleet_table) with
    // directional to:/from: leaf prefixes. addWiretap validates via parseFilter.
    let tap
    try { tap = fleetStore.addWiretap(agent, filter, types) }
    catch (e) { error(`bad filter: ${e.message}`); return }
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
    const result = fleetStore.retractTask?.(task, {
      recipientExposed: hasOpenFleetSocketForAgent(task.agent, ws),
      retractedBy: msg.from || null,
    }) || { task_id: task.id, mode: 'removed_task_only' }
    broadcastState()
    reply({ ok: true, ...result })
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
      const { events: resolved, hasMore, nextCursor } = fleetStore.buildChatHistoryResponse({
        before,
        agents: Array.isArray(agents) ? agents : [],
        limit,
        serverOwnerId: SERVER_OWNER_ID,
        serverOwnerName: SERVER_OWNER_NAME,
      })
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
const DEFAULT_QUALIFICATIONS_FILE = path.join(__dirname, 'qualifications-default.json')
let _qualRules = []
const _qualAgentReads = new Map()     // agentId → Set of skill keys + file paths
const _qualAgentPartialSkillReads = new Map()
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
    const qualPath = fs.existsSync(QUALIFICATIONS_FILE) ? QUALIFICATIONS_FILE : DEFAULT_QUALIFICATIONS_FILE
    if (!fs.existsSync(qualPath)) return
    const data = JSON.parse(fs.readFileSync(qualPath, 'utf8'))
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

function qualTrackPartialSkillReads(agentId, command) {
  recordPartialSkillReads(_qualAgentPartialSkillReads, agentId, command, (id, skillKey, filePath) => {
    qualTrackRead(id, filePath)
    qualTrackRead(id, skillKey)
  })
}

function qualLoadReadsFromDb() {
  if (!fleetStore) return
  try {
    const readsByAgent = fleetStore.getAllSkillReadsByAgent?.() || new Map()
    for (const [agentId, reads] of readsByAgent) {
      if (reads.size > 0) _qualAgentReads.set(agentId, reads)
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

  // Normalize the tool name to its base so every form is recognized: Read,
  // read_file, mcp__tlda__read_file, tlda/read_file, summon/load, load.
  const toolReadNorm = String(tool || '').replace(/^mcp__/, '').replace(/__/g, '/')
  const toolBase = toolReadNorm.split('/').pop()
  const isFileRead = tool === 'Read' || toolBase === 'read_file'
  const summonSource = input?.source || input?.skill || input?.name || ''
  const isSummonLoad = (toolReadNorm.includes('summon') || toolBase === 'load') && toolBase !== 'read_file' && summonSource
  if (tool === 'Bash' && input?.command) qualTrackPartialSkillReads(agentId, input.command)
  if ((isFileRead || tool === 'Skill') && input) {
    if (isFileRead) {
      const fp = input.file_path || input.path || arg || ''
      if (fp) {
        qualTrackRead(agentId, fp)
        // A read whose path is …/skills/<name>/SKILL.md credits skill:<name> —
        // this is what lets native (Claude/codex) and MCP-read_file (goose)
        // reads register with the education gate in place of skill().
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
  if (isSummonLoad) {
    qualTrackRead(agentId, 'skill:' + String(summonSource))
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
    const partial = partialSkillReadSummaries(_qualAgentPartialSkillReads, agentId)
      .filter(p => skills.includes(p.skill) && !reads.has(p.skillKey))
    pendingEducation.set(agentId, { skill: skills[0], skills, partial, ts: Date.now() })
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
if (fleetStore?.db) {
  fleetStore.db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_outbox_processed (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      processed_at TEXT NOT NULL
    )
  `)
}
const _daemonOutboxProcessedGetStmt = fleetStore?.db.prepare(
  'SELECT 1 FROM daemon_outbox_processed WHERE id = ? LIMIT 1'
)
const _daemonOutboxProcessedInsertStmt = fleetStore?.db.prepare(
  'INSERT OR IGNORE INTO daemon_outbox_processed (id, type, processed_at) VALUES (?, ?, ?)'
)
const DAEMON_AGENT_REPLAY_BATCH = Number(process.env.TLDA_DAEMON_AGENT_REPLAY_BATCH || 200)

const {
  handleDaemonOutboxEnvelope,
  enqueueDaemonMessage,
  flushServerDaemonOutbox,
  clearServerDaemonOutboxInflightForDaemon,
} = createDaemonWsControlPlane({
  daemonConnections,
  serverDaemonOutbox,
  serverDaemonOutboxInflight,
  daemonOutboxProcessedGetStmt: _daemonOutboxProcessedGetStmt,
  daemonOutboxProcessedInsertStmt: _daemonOutboxProcessedInsertStmt,
  socketCanAcceptMore,
})

function knownDaemonKeys() {
  const keys = new Set([...daemonConnections.keys()])
  for (const row of fleetStore?.listDaemonRegistrations?.() || []) {
    if (row.daemon_key) keys.add(row.daemon_key)
  }
  return [...keys].sort()
}

function projectsForDaemon() {
  // Returns the project list a daemon needs to watch source dirs for,
  // including each project's relevant-files set (from the last build's
  // .fls). The daemon uses this to watch ONLY the files the build
  // actually reads — not the entire sourceDir.
  return listProjects()
    .filter(p => !p.archived)
    .map(p => {
      let watchFiles = null
      try {
        const rfPath = join(PROJECTS_DIR, p.name, 'output', 'relevant-files.json')
        if (p.sourceDir && existsSync(rfPath)) {
          const rf = JSON.parse(readFileSync(rfPath, 'utf8'))
          // Filter to only author-dir paths (not the server mirror paths)
          watchFiles = daemonWatchFilesFromAbsolutePaths(p, rf.files || [])
        }
      } catch (e) {
        // Keep daemon welcome/project updates flowing; null watchFiles makes the
        // daemon watch the main file until the next build regenerates paper scope.
        console.warn(`[daemon] relevant-files.json unavailable for ${p.name}; using main-file watch only: ${e.message}`)
      }
      if (p.sourceDir) {
        const partSourceWatchFiles = daemonProjectPartSourceWatchFiles(p)
        if (partSourceWatchFiles.length > 0) {
          watchFiles = [...new Set([...(watchFiles || []), ...partSourceWatchFiles])]
        }
      }
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

function daemonWatchFilesFromAbsolutePaths(project, files) {
  return (files || [])
    .filter(f => typeof f === 'string' && f.startsWith(project.sourceDir))
    .map(f => f.slice(project.sourceDir.length + 1))
}

function daemonProjectPartSourceWatchFiles(project) {
  try {
    const manifest = readProjectPartsManifest(project.name)
    return daemonWatchFilesFromAbsolutePaths(
      project,
      (manifest.parts || []).map(part => part?.metadata?.sourcePath),
    )
  } catch {
    return []
  }
}

function broadcastDaemonAgentsUpdated(agentUpdates = null) {
  const updates = agentUpdates
    ? (Array.isArray(agentUpdates) ? agentUpdates : [agentUpdates]).filter(Boolean)
    : null
  const daemonKeys = updates
    ? [...new Set(updates.map(a => a.daemon_key || (a.machine_id && a.env_name ? daemonAddress(a.machine_id, a.env_name) : null)).filter(Boolean))]
    : knownDaemonKeys()
  if (!fleetStore || daemonKeys.length === 0) {
    if (!fleetStore) console.warn('[fleet-daemon] broadcastDaemonAgentsUpdated: no fleetStore')
    return
  }
  for (const daemonKey of daemonKeys) {
    try {
      let agents = updates
        ? updates.filter(a => (a.daemon_key || (a.machine_id && a.env_name ? daemonAddress(a.machine_id, a.env_name) : null)) === daemonKey)
        : fleetStore.getAgentsByDaemonKey(daemonKey)
      for (const agent of agents) daemonAgentEvents.append(daemonKey, agent)
      // Connected daemons receive only the mutations recorded since their
      // cursor; the durable replay stream preserves ordering across a flap.
      const cursor = daemonConnections.get(daemonKey)?._agentStatusSeq ?? 0
      const replay = daemonAgentEvents.replay(daemonKey, cursor, { snapshotOverLimit: !updates })
      if (replay.snapshot) {
        agents = fleetStore.getAgentsByDaemonKey(daemonKey)
        enqueueDaemonMessage(daemonKey, { type: 'agents-updated', agents, agent_status_seq: replay.lastSeq }, { dedupeKey: 'agents-snapshot' })
      }
      else {
        for (const event of replay.events) enqueueDaemonMessage(daemonKey, { ...event, type: 'agent-status-event', event_type: event.type })
        const ws = daemonConnections.get(daemonKey)
        if (ws) ws._agentStatusSeq = replay.lastSeq
      }
    } catch (e) {
      console.error(`[fleet-daemon] broadcastDaemonAgentsUpdated failed for ${daemonKey}: ${e.message}`)
    }
  }
}

function broadcastDaemonProjectsUpdated() {
  const daemonKeys = knownDaemonKeys()
  if (daemonKeys.length === 0) return
  const projects = projectsForDaemon()
  for (const daemonKey of daemonKeys) {
    enqueueDaemonMessage(daemonKey, { type: 'projects-updated', projects }, { dedupeKey: 'projects-updated' })
  }
}

function broadcastDaemonActiveViewers() {
  const daemonKeys = knownDaemonKeys()
  if (daemonKeys.length === 0) return
  const viewers = [...getActiveViewerProjects()]
  for (const daemonKey of daemonKeys) {
    enqueueDaemonMessage(daemonKey, { type: 'active-viewers', projects: viewers }, { dedupeKey: 'active-viewers' })
  }
}

function daemonAgentReplayForWelcome(daemonKey, lastSeq) {
  const cursor = Number.isInteger(lastSeq) ? lastSeq : 0
  if (cursor <= 0) {
    const agents = fleetStore?.getAgentsByDaemonKey(daemonKey) || []
    for (const agent of agents) daemonAgentEvents.append(daemonKey, agent)
    const replay = daemonAgentEvents.replay(daemonKey, 0, { limit: DAEMON_AGENT_REPLAY_BATCH })
    return { ...replay, agents, reset: true }
  }
  const replay = daemonAgentEvents.replay(daemonKey, cursor, {
    limit: DAEMON_AGENT_REPLAY_BATCH,
    snapshotOverLimit: false,
  })
  return { ...replay, agents: [], reset: false }
}

function sendDaemonAgentReplayContinuation(daemonKey, afterSeq) {
  const ws = daemonConnections.get(daemonKey)
  if (!ws || ws.readyState !== 1) return
  const replay = daemonAgentEvents.replay(daemonKey, afterSeq, {
    limit: DAEMON_AGENT_REPLAY_BATCH,
    snapshotOverLimit: false,
  })
  if (replay.events.length === 0) return
  try {
    ws.send(JSON.stringify({
      type: 'agent-status-events',
      agent_status_seq: replay.lastSeq,
      agent_status_events: replay.events,
      agent_status_has_more: replay.hasMore,
    }))
    ws._agentStatusSeq = replay.lastSeq
  } catch (e) {
    console.warn(`[fleet-daemon] agent replay continuation failed for ${daemonKey}: ${e.message}`)
    return
  }
  if (replay.hasMore) {
    setImmediate(() => sendDaemonAgentReplayContinuation(daemonKey, replay.lastSeq))
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
    dispatchBuild(projectName).catch(e => console.warn(`[shadow-ahead] build failed for ${projectName}: ${e.message}`))
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
    const result = await writeSentinel(docName, {
      commitHash: latestBuildHash,
      timestamp: Date.now(),
      buildReadyAt: latestBuildAt,
    })

    if (!result.skipped) {
      console.log(`[sentinel-sync] ${projectName}: synced ${latestBuildHash.slice(0, 7)}`)
    }
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

async function handleDaemonWsMessage(ws, msg) {
  const { type } = msg

  if (type === 'daemon-hello') {
    const { machine_id, env_name, user, hostname, version, boot_id, install_path, last_agent_status_seq } = msg
    if (!machine_id || !env_name) return
    const daemonKey = daemonAddress(machine_id, env_name)
    // §4b backstop: a daemon address is owned by ONE daemon install. If another
    // daemon already holds it live, only the SAME install restarting may take
    // over (newer boot wins); a DIFFERENT install (e.g. a worktree/dev-rig
    // daemon) is refused — it can never evict the real live daemon. This is the
    // hard stop for the "two daemons fighting over `air`" leak, independent of
    // how the rogue daemon was misconfigured.
    const existing = daemonConnections.get(daemonKey)
    if (existing && existing !== ws) {
      const decision = daemonHelloDecision({
        existing: { open: existing.readyState === 1, bootId: existing._bootId || 0, installPath: existing._installPath },
        incoming: { bootId: boot_id || 0, installPath: install_path },
      })
      if (decision === 'refuse') {
        const sameInstall = existing._installPath && install_path && existing._installPath === install_path
        const reason = sameInstall
          ? 'a newer daemon already holds this daemon address'
          : `daemon address ${daemonKey} is already held live by a different daemon install (${existing._installPath || 'unknown'}); refusing this one (${install_path || 'unknown'})`
        console.warn(`[fleet-daemon] REFUSED daemon-hello: ${reason}`)
        try {
          ws.send(JSON.stringify({ type: 'daemon-evict', reason, held_by_boot_id: existing._bootId || 0 }))
        } catch {}
        try { ws.close() } catch {}
        return
      }
      // decision === 'evict-existing': same install restarting with a newer boot.
      try {
        existing.send(JSON.stringify({
          type: 'daemon-evict',
          reason: 'same install restarted with a newer boot_id',
          replaced_by_boot_id: boot_id || 0,
        }))
      } catch {}
      try { existing.close() } catch {}
      daemonConnections.delete(daemonKey)
    }
    ws._machineId = machine_id
    ws._envName = env_name
    ws._daemonKey = daemonKey
    ws._bootId = boot_id
    ws._installPath = install_path
    ws._user = user
    ws._hostname = hostname
    ws._version = version
    ws._agentStatusSeq = Number.isInteger(last_agent_status_seq) ? last_agent_status_seq : 0
    daemonConnections.set(daemonKey, ws)
    notifyDaemonReady(daemonKey) // wake any control-op RPCs waiting to retry across this reconnect
    clearServerDaemonOutboxInflightForDaemon(daemonKey)
    daemonWelcomeSeenAt.set(daemonKey, Date.now())
    fleetStore?.upsertDaemonRegistration?.({
      daemon_key: daemonKey,
      machine_id,
      env_name,
      install_path,
      user,
      hostname,
      version,
      boot_id: boot_id || 0,
      status: 'connected',
      connected_at: new Date().toISOString(),
      metadata: { scope: 'machine-env' },
    })
    if (daemonConnections.get(daemonKey) !== ws) {
      console.error(`[fleet-daemon] routability invariant failed after welcome setup: daemon=${daemonKey}`)
    }
    // Reset the activity-feed uptime clock: this (re)connect starts a fresh
    // continuous window. getWouldHibernate won't hibernate agents on this machine
    // until the feed has been up a full idle window, so a flap can't cause a
    // stale-_lastActivityAt false hibernate.
    _daemonConnectedSince.set(daemonKey, Date.now())
    if (daemonKey === LOCAL_DAEMON_ADDRESS) noteDaemonHealthyConnect()
    console.log(`[fleet-daemon] connected: daemon=${daemonKey} user=${user}@${hostname} v=${version} boot_id=${boot_id}`)

    // Resume any active terminal watches for agents on this machine.
    // The browser-side watcher set is server-held; the daemon comes back
    // empty after a restart so we re-fire start-terminal-watch.
    if (fleetStore) {
      const watchedAgentIds = [...terminalWatchers.keys()]
      const watchedAgents = watchedAgentIds.length > 0 ? fleetStore.getAgentsByIds(watchedAgentIds) : []
      for (const a of watchedAgents) {
        if ((a.daemon_key || (a.machine_id && a.env_name ? daemonAddress(a.machine_id, a.env_name) : null)) !== daemonKey) continue
        if (a.tmux_session && terminalWatchers.has(a.id)) {
          sendRpc(daemonKey, 'start-terminal-watch', {
            agent_id: a.id, tmux_session: a.tmux_session, poll_ms: 500,
          }).catch(e => console.warn(`[server] terminal-watch resume failed for ${a.id}: ${e.message}`))
        }
      }
    }

    // Send daemon-welcome with agents + projects this machine should
    // watch. Agents are filtered by machine_id; legacy NULL agents will
    // be invisible to daemons until the MCP starts sending machine_id.
    const agentReplay = daemonAgentReplayForWelcome(daemonKey, ws._agentStatusSeq)
    try {
      ws.send(JSON.stringify({
        type: 'daemon-welcome',
        server_boot_id: SERVER_BOOT_ID,
        agents: agentReplay.snapshot ? agentReplay.agents : [],
        agent_status_reset: agentReplay.reset,
        agent_status_seq: agentReplay.lastSeq,
        agent_status_events: agentReplay.events,
        agent_status_has_more: agentReplay.hasMore,
        projects: projectsForDaemon(),
        activeViewers: [...getActiveViewerProjects()],
      }))
      if (agentReplay.hasMore) {
        setImmediate(() => sendDaemonAgentReplayContinuation(daemonKey, agentReplay.lastSeq))
      }
    } catch (e) {
      console.error(`[fleet-daemon] welcome send failed: ${e.message}`)
    }
    // Send persisted backing file watch list to daemon.
    sendWatchBackingFiles()
    flushServerDaemonOutbox(daemonKey)

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
    const { agent_id, state, tmux_session, pid, reason, ts } = msg
    if (Array.isArray(msg.agent_ids) || Array.isArray(msg.checked_agent_ids)) {
      const aliveIds = new Set((msg.agent_ids || []).filter(id => typeof id === 'string' && id))
      const checkedIds = new Set([
        ...(msg.checked_agent_ids || []).filter(id => typeof id === 'string' && id),
        ...aliveIds,
      ])
      const batchTs = ts || new Date().toISOString()
      for (const id of checkedIds) {
        const agent = fleetStore?.getAgent?.(id)
        const batchState = aliveIds.has(id) ? 'alive' : 'dead'
        spawnLibrarian.observeLiveness({
          type,
          agent_id: id,
          tmux_session: agent?.tmux_session || null,
          state: batchState,
          reason: batchState === 'dead' ? 'daemon liveness batch: not alive' : undefined,
          ts: batchTs,
        })
        if (batchState === 'alive') {
          // Liveness = "the tmux process still exists", NOT "the agent did work".
          // markAgentAlive is idempotent for _aliveSince; real activity is recorded
          // by agent-activity / agent-thinking / chat, not by this liveness ping.
          markAgentAlive(id)
        } else {
          markAgentNotAlive(id)
        }
      }
      broadcastState()
      return
    }
    if (!agent_id || !state) return
    spawnLibrarian.observeLiveness({ type, agent_id, state, tmux_session, pid, reason, ts })
    if (state === 'alive') {
      // Liveness ≠ activity (see the batch handler above): this is a 30s "process
      // exists" ping, not real work, so it must not reset the idle clock. Real
      // activity is recorded by agent-activity / agent-thinking / chat.
      markAgentAlive(agent_id)
    } else if (state === 'dead' || state === 'wedged') {
      markAgentNotAlive(agent_id)
    }
    broadcastState()
    return
  }

  if (type === 'agent-activity') {
    const { agent_id, jsonl_offset, ts } = msg
    if (!agent_id || typeof jsonl_offset !== 'number') return
    spawnLibrarian.observeActivity({ type, agent_id, jsonl_offset, ts })
    markAgentAlive(agent_id)
    touchActivity(agent_id)
    if (fleetStore?.updateHeartbeat) {
      fleetStore.updateHeartbeat(agent_id)
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
    broadcastDaemonAgentsUpdated(agent)
    return
  }

  if (type === 'activity-event') {
    if (!fleetStore) return
    const serverReceivedAtMs = Date.now()
    const { agent_id, tool, arg, input } = msg
    if (!agent_id) return
    touchActivity(agent_id)
    if (tool === '_usage') return // usage stats don't need DB storage
    try {
      const serverBroadcastQueuedAtMs = Date.now()
      const activity = buildDaemonActivityRecord(msg, { serverReceivedAtMs, serverBroadcastQueuedAtMs })
      await measureHotOp('daemon-ws activity event insert', `agent=${agent_id} tool=${tool || ''}`, () => fleetStore.share(activity))
    } catch (e) {
      await reportDaemonEventFailure(msg, 'activity-write', e)
      throw e
    }
    checkQualifications(agent_id, tool, arg, input)
    return
  }

  if (type === 'native-task-event') {
    const { changed } = applyNativeTaskEvents(fleetStore, msg)
    if (changed) broadcastState()
    return
  }

  if (type === 'jsonl-index') {
    if (!fleetStore) return
    const entries = msg.entries || []
    try {
      await measureHotOp('daemon-ws jsonl-index', `entries=${entries.length}`, () => fleetStore.insertSessionEntries(entries))
      if (msg.id) ws.send(JSON.stringify({ id: msg.id, result: { ok: true } }))
    } catch (e) {
      console.error(`[jsonl-index] Failed to index ${entries.length} entries — search gaps possible:`, e.message)
      if (msg.id) ws.send(JSON.stringify({ id: msg.id, error: e.message }))
    }
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
      await reportDaemonEventFailure(msg, 'terminal-chat-write', e)
      throw e
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
    if (msg.agent_id) {
      fanOutTerminalDead(msg.agent_id)
      markAgentNotAlive(msg.agent_id)
      broadcastState()
    }
    return
  }

  if (type === 'spawn-startup-failed') {
    if (!fleetStore) return
    const { agent_id, agent_name, tmux_session, harness, model, respawn, code, reason, snippet } = msg
    if (!agent_id) return
    const agent = fleetStore.getAgent?.(agent_id)
    const label = agent?.friendly_name || agent_name || agent_id.slice(0, 12)
    const text = `Spawn startup failed for ${label}: ${reason || code || 'startup error'}`
    const metadata = {
      type: 'spawn_startup_failed',
      agentId: agent_id,
      agentLabel: label,
      tmux_session: tmux_session || null,
      harness: harness || agent?.metadata?.kind || null,
      model: model || agent?.metadata?.model || null,
      respawn: !!respawn,
      code: code || null,
      reason: reason || null,
      snippet: snippet || null,
    }
    try {
      markAgentNotAlive(agent_id)
      // A shell that never booted (never claimed) must be marked dead so it
      // leaves the not-dead registry — otherwise the reserved identity
      // lingers as a phantom addressable agent that will never inhabit.
      if (agent?.metadata?.shell) fleetStore.markDead?.(agent_id)
      fleetStore.updateAgentMeta?.(agent_id, {
        startupFailure: {
          ts: new Date().toISOString(),
          code: metadata.code,
          reason: metadata.reason,
          tmux_session: metadata.tmux_session,
          harness: metadata.harness,
          model: metadata.model,
        },
      })
      const task = fleetStore.getTaskByAgent?.(agent_id)
      if (task) {
        task.status = 'failed'
        task.last_checked = new Date().toISOString()
        task.metadata = { ...(task.metadata || {}), startupFailure: metadata }
        fleetStore.upsertTask(task)
        await fleetStore.taskUpdate?.(agent_id, task.id, 'failed', metadata)
      } else {
        await fleetStore.share?.({
          type: 'lifecycle',
          from: agent_id,
          to: SERVER_OWNER_ID,
          agentId: agent_id,
          text,
          metadata,
          unread: false,
        })
      }
      const recipients = new Set([SERVER_OWNER_ID])
      if (task?.delegated_by) recipients.add(task.delegated_by)
      for (const to of recipients) {
        await fleetStore.share?.({
          type: 'chat',
          from: 'fleet:tlda',
          to,
          text: `**Spawn startup failed** for \`${label}\`\n\n${reason || 'The harness printed a fatal startup error before the agent logged in.'}`,
          metadata,
          unread: true,
        })
      }
      broadcastEvent('spawn-startup-failed', metadata)
      broadcastState()
    } catch (e) {
      console.error(`[fleet-daemon] spawn startup failure write: ${e.message}`)
    }
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
    _lastReaperStatus = {
      ...(msg.data || msg),
      daemon_key: ws._daemonKey || msg.daemon_key || msg.data?.daemon_key || null,
    }
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
      const env_name = agent?.env_name
      const event = await fleetStore.share({
        type: 'plan_approval',
        from: agent_id,
        to: SERVER_OWNER_ID,
        text: plan_text,
        metadata: { tmux_session: tmux_session || null, machine_id, env_name },
        unread: true,
        timestamp: new Date().toISOString(),
      })
      pendingPlanApprovals.set(agent_id, {
        tmux_session: tmux_session || agent?.tmux_session,
        machine_id,
        env_name,
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
    if (msg.error) entry.reject(new Error(rpcErrorMessage(msg.error)))
    else entry.resolve(msg.result)
    return
  }

  if (type === 'agent-thinking') {
    if (msg.agentId) {
      if (msg.thinking) {
        _thinkingState.set(msg.agentId, Date.now())
        touchActivity(msg.agentId)
      } else {
        // thinking → idle edge = turn end (see emitTurnEnded; deduped by _thinkingState).
        const startedAt = _thinkingState.get(msg.agentId)
        _thinkingState.delete(msg.agentId)
        if (startedAt !== undefined) emitTurnEnded(msg.agentId, startedAt)
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
    if (readProject(project)) {
      updateProject(project, { lastSourceMachineId: ws._machineId, lastSourceEnvName: ws._envName, lastSourceMachineAt: Date.now() })
    }
    // Hand off to the same pipeline used by HTTP /api/projects/:name/push.
    try {
      const result = await processProjectPush(project, { files, deletedFiles, editedBy })
      if (!result.ok) {
        console.error(`[fleet-daemon] source-change ${project}: ${result.error || 'unknown'}`)
        const err = new Error(result.error || 'source-change failed')
        err.status = result.status || 500
        err.permanent = err.status >= 400 && err.status < 500 && err.status !== 409
        throw err
      }
    } catch (e) {
      console.error(`[fleet-daemon] source-change ${project} crashed: ${e.message}`)
      throw e
    }
    return
  }

  if (type === 'backing-file-status') {
    const { project, backingName, docNames: msgDocNames, content, status, message } = msg
    if (!project || !backingName) return
    const entry = backingFileRegistry.get(backingRegistryKey(project, backingName))
    const docNames = entry?.docNames || new Set(Array.isArray(msgDocNames) ? msgDocNames : [])
    console.log(`[backing] backing-file-status: ${project}:${backingName} status=${status || 'synced'}, registry size=${backingFileRegistry.size}, docNames=${docNames ? [...docNames].join(',') : 'NONE'}`)
    if (!docNames || docNames.size === 0) return
    for (const docName of docNames) {
      broadcastSignal(docName, 'signal:file-updated', {
        project,
        backingName,
        filePath: backingName,
        content: content ?? '',
        status: status || 'synced',
        ...(message && { message }),
      })
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
  killAllDispatchedBuilds() // builds now run in forked workers — kill those too

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

// Fail loud on a bad config rather than booting into unpredictable behavior:
// resolve the active config once at startup. A missing config or field throws
// here and the server refuses to start, with a clear message.
{
  const cfg = resolveConfig()
  console.log(`[config] active="${cfg.name}" database=${cfg.database.http} store=${cfg.store.http} license=${cfg.licenseKey ? 'set' : 'none'}`)
}

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
  // supervisor or the hibernate loop — it exists only to load schemas + serve
  // a throwaway doc, and must not touch the live fleet.
  if (process.env.TLDA_DEV_SERVER === '1') {
    console.log('[dev-server] isolated mode — daemon supervisor and hibernate loop disabled')
  } else {
  // Start the local-daemon supervisor. Run an immediate check (so the daemon
  // is up shortly after server start) and then poll on an interval. The
  // daemon's own pidfile + connection-state checks gate actual respawn so
  // we don't burst-spawn while a daemon is starting.
  console.log(`[daemon-supervisor] watching for local daemon (machine_id=${LOCAL_MACHINE_ID})`)
  ensureLocalDaemon()

  // Resume Overleaf git-sync pollers for any project linked to a remote.
  resumeOverleafPollers(listProjects)

  setInterval(ensureLocalDaemon, DAEMON_SUPERVISOR_INTERVAL_MS).unref()

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
        markAgentNotAlive(agent.id)
      } catch (e) {
        console.error(`[hibernate] failed to hibernate ${agent.friendly_name || agent.id}: ${e.message}`)
      }
    }
    broadcastState()
  }, HIBERNATE_CHECK_MS).unref()
  }
})
