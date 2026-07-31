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

import { createFilterSubscriptions } from './lib/filter-subscriptions.mjs'
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
import { AsyncLocalStorage } from 'node:async_hooks'
import { lookup as mimeLookup } from 'mime-types'
import { CONFIG_DIR, DEFAULT_PORT, getFleetServerUrl, hasTls, resolveConfig } from '../shared/config.mjs'
import { createLagProfiler } from './lib/lag-profiler.mjs'
import { BARE_METADATA, resolveAssetAsync } from '../shared/doc-assets.mjs'
import { formatDisplayTimestamp } from '../shared/display-time.mjs'
import { listModels as listSpawnModels } from '../agent-launch/models.mjs'
import { readDaemonConfig, readDaemonConfigForCwd, withDaemonModelAliases } from '../agent-launch/permission-ledger.mjs'
import { labelsForAgent, parseFilter, parseMessageFilter, evalExpr } from '../shared/fleet-labels.mjs'
import { parseAgentSelector as parseUnifiedAgentSelector } from '../shared/unified-filter-grammar.mjs'
import { daemonHelloDecision } from '../shared/daemon-identity.mjs'
import { resolveServerIsolation } from '../shared/server-identity.mjs'
import { initProjectStore, listProjects, readProject, updateProject, getProjectsDir, readProjectPartsManifest, readClientSourceManifest, searchProjectContent, sourceLifecycleStore } from './lib/project-store.mjs'
import { createSourceChangeResultCache } from './lib/source-change-correlation.mjs'
import { resumeOverleafPollers } from './lib/overleaf-sync.mjs'
import { resetStaleBuildStates, killAllBuilds, setShadowMirrorHandler } from './lib/build-runner.mjs'
import { createShadowMirrorRpcHandler } from './lib/shadow-mirror-rpc.mjs'
import { killAllDispatchedBuilds } from './lib/build-dispatch.mjs'
import projectRoutes, { processProjectPush, setAcceptedSourceMutationHandler } from './routes/projects.mjs'
import { initAuth, isAuthEnabled, validateToken, extractToken, requireRead, requireRw, loginRoute } from './lib/auth.mjs'
import { initSyncRooms, getOrCreateRoom, flushAllRooms, closeAllRooms, replayCachedSignals, onGlobalEvent, broadcastSignal, getRoomRecords, listActiveRooms, updateShape, putShape } from './lib/sync-rooms.mjs'
import * as tldaFeedback from './lib/tlda-feedback.mjs'
import { injectBridge, injectSlidesBridge, injectChapterTitle } from './lib/html-injector.mjs'
import { isChatHistoryEventType, resolveNameAt } from './lib/fleet-history.mjs'
import { FleetStoreClient } from './lib/fleet-store-client.mjs'
import { agentsForTerminalWatchResume } from './lib/terminal-watch-resume.mjs'
import { applyNativeTaskEvents } from './lib/native-task-wrapper.mjs'
import { resolveMachine } from './lib/tailscale-peers.mjs'
import { createFleetRouter, RESOLVED_UPLOAD_DIR } from './routes/fleet.mjs'
import { copyAttachmentsToUploadDir } from './lib/chat-attachment-store.mjs'
import { buildRuntimeStatus } from './lib/runtime-status.mjs'
import { createAgentRuntimeStatusStore, RUNTIME_KIND, RUNTIME_STATUS } from './lib/agent-runtime-status.mjs'
import { createHumanPresenceTracker } from './lib/human-presence.mjs'
import { resolveSpawnMachine, SPAWN_MACHINE_PREF_KEY } from './lib/spawn-routing.mjs'
import { normalizeSpawnRelayInput } from './lib/spawn-relay-input.mjs'
import { resolveFreshSpawnAvailabilityModels } from './lib/spawn-availability-models.mjs'
import { decideTaskRenudges, isWakeBreakerOpen, wakeBreakerBackoffMs } from './lib/task-renudge.mjs'
import { canReportTask, completeTaskLifecycle, transferTaskLifecycle } from './lib/task-lifecycle.mjs'
import { livenessFromCheckAliveResult, runWakeRouteLifecycle, shouldSendWakeNudge } from './lib/wake-route-lifecycle.mjs'
import { unroutedNativeDescendantIds } from './lib/native-subagent-lifecycle.mjs'
import { rejectMatchingWsRequests, startWsRequest } from '../shared/fleet-transport.mjs'
import { createFleetOperationTransport } from '../shared/fleet-operation-transport.mjs'
import { isPlanModeResponse, planModeResponseKey } from './lib/plan-mode-response.mjs'
import { SpawnBounceError, SpawnLibrarian, resolveSpawnCollision } from '../shared/spawn-librarian.ts'
import { MailboxLibrarian } from '../shared/mailbox-librarian.ts'
import { trimTerminalSeedBlankRows } from '../shared/terminal-seed.mjs'
import { partialSkillReadSummaries, recordPartialSkillReads } from '../shared/partial-skill-reads.mjs'
import { reloadHumanFleetClients } from './lib/targeted-client-control.mjs'
import { daemonAddress, describeAgentAddress } from '../shared/agent-move-target.mjs'
import { readBuildInfo } from './lib/build-info.mjs'
import { resolveTimerParticipants, timerDeliveryFailureResult, timerTerminalInputFailureResult } from './lib/timer-routing.mjs'
import { ServerTimerScheduler } from './lib/timer-scheduler.mjs'
import { createDaemonWsControlPlane } from './lib/daemon-ws-control-plane.mjs'
import { clearTrustedHeartbeatProbes, shouldSkipHeartbeatSweepForLag, shouldTerminateForMissedPong, socketCanAcceptMore } from '../shared/fleet-ws-flow.mjs'
import {
  DELIVERY_CHANNELS,
  INBOX_STATUSES,
  decideSubscriptionDelivery,
  normalizeDeliveryChannel,
  normalizeInboxStatus,
  normalizeMessagePriority,
  parsePriorityPhrase,
  validateDeliveryChannel,
} from '../shared/inbox-attention.mjs'
import {
  buildInboxRefPath,
  initializeRecipientRefs,
  isMaterializableAttachment,
  pendingAttachmentPlaceholder,
  setRecipientAttachmentState,
} from '../shared/inbox-reference-materialization.mjs'
import { formatMaterializationFailureNotification } from './lib/materialization-notifications.mjs'
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
import { buildVoicePipelineSnapshot } from './lib/observability/voice-pipeline.mjs'
import { daemonEventFailureIncident } from './lib/daemon-event-failures.mjs'
import { buildDaemonActivityRecord, shouldStoreDaemonActivity } from './lib/daemon-activity-ingest.mjs'
import { appendAgentActionFromActivity } from './lib/edit-events.mjs'
import {
  agentLivenessTraceResponse,
  createAgentLivenessTraceStore,
  recordLivenessProjection,
} from './lib/agent-liveness-trace.mjs'
import { createActivityDeliveryCounters, ACTIVITY_DELIVERY_STAGES } from '../shared/activity-delivery-counters.mjs'
import {
  ACTIVITY_HEALTH_BOUNDARIES,
  ACTIVITY_HEALTH_OK,
  ACTIVITY_HEALTH_UNAVAILABLE,
  activityHealthIncidentPayload,
  activityHealthKey,
  activityHealthIncidentDecision,
  isActivityHealthOk,
  normalizeActivityHealth,
} from '../shared/activity-health.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fleetWsLog = createBackendLogger('fleet-ws')
const agentLivenessTrace = createAgentLivenessTraceStore()

const terminalBridgeLog = createBackendLogger('terminal-bridge')
const syncSignalLog = createBackendLogger('sync-signals')
const daemonEventLog = createBackendLogger('daemon-events')
const controlPlaneTraces = createControlPlaneTraceStore()
const serverActivityDeliveryCounters = createActivityDeliveryCounters({ origin: 'server' })
// Agents seen emitting activity with no seat row. Warn-once keys, so a seat
// binding that never lands doesn't reprint every few seconds — the daemon's own
// "pending daemon route rejected locally" loop wrote 431,202 lines that way on
// 2026-07-25 and buried the signal it was trying to give.
const daemonActivityDeliverySnapshots = new Map()
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

// Running total of background jsonl-index failures. Because the jsonl-index
// handlers now ack immediately and index in the background (search-backfill is
// best-effort, decoupled from daemon request health — see the handlers), a
// failed index would otherwise be a SILENT search gap. This makes it loud +
// counted: distinctive log tag, a perf event, and a running total surfaced in
// activityDeliverySnapshot() so a gap is detectable and re-indexable.
const jsonlIndexBgFailures = { count: 0, entriesDropped: 0, lastError: null, lastAt: null, sessions: [] }
function recordJsonlIndexBgFailure(source, entries, e) {
  const sessions = [...new Set((entries || []).map(x => x?.session_id).filter(Boolean))]
  jsonlIndexBgFailures.count += 1
  jsonlIndexBgFailures.entriesDropped += (entries || []).length
  jsonlIndexBgFailures.lastError = e?.message || String(e)
  jsonlIndexBgFailures.lastAt = new Date().toISOString()
  jsonlIndexBgFailures.sessions = sessions
  console.error(`[jsonl-index-bg-fail] ${source}: background index of ${(entries || []).length} entries failed — SEARCH GAP (re-indexable), sessions=${sessions.join(',')}:`, e?.message || e)
  recordServerPerfEvent('jsonl-index-bg-fail', { source, entries: (entries || []).length, sessions, error: e?.message || String(e) })
}

function activityDeliverySnapshot() {
  return {
    jsonlIndexBgFailures,
    server: serverActivityDeliveryCounters.snapshot(),
    daemons: [...daemonActivityDeliverySnapshots.entries()].map(([daemonKey, snapshot]) => ({
      daemonKey,
      ...snapshot,
    })),
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
await initProjectStore(PROJECTS_DIR)
initSyncRooms(PROJECTS_DIR, { onSignalFailure: reportSyncSignalFailure })
await resetStaleBuildStates()

// Fleet store (SQLite-backed agent registry + chat).
// TLDA_FLEET_DB overrides the default path — used by integration tests
// to isolate from the live /tmp/fleet.db.
const fleetStore = new FleetStoreClient(process.env.TLDA_FLEET_DB, {
  taskDoc: true,
  taskDocOptions: { projectsDir: PROJECTS_DIR },
})
await fleetStore.ready()
const fleetOperationContext = new AsyncLocalStorage()
const serverDaemonOutboxInflight = new Map()
let serverTimerScheduler = null

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

// The lag numbers above say WHEN the loop stalled but never WHAT stalled it, and
// the per-query `[slowquery]` logger cannot close that gap: it thresholds each
// query at 25ms, so 190 x 4ms is invisible, and it wraps only `.all()`/`.get()`,
// so synchronous `.run()` writes are never measured at all. The sampler sees the
// thread itself, so a stall names its own cause without anyone being attached.
const lagProfiler = createLagProfiler({ dir: join(CONFIG_DIR, 'lag-profiles') })
lagProfiler.start().catch(e => {
  // A diagnostic failing to start must not take the server down with it, but it
  // must not go quiet either — a sampler everyone believes is running and isn't
  // is worse than none. Loud on the log AND in the perf ring that
  // /api/diagnostics/live-perf serves, so its absence is discoverable.
  console.error('[lag-profiler] FAILED TO START — stalls will not be captured:', e)
  recordServerPerfEvent('lag-profiler-start-failed', { error: e?.message || String(e) })
})

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
// A thread is a few dozen agents talking across thousands of rows, so the same
// ids repeat constantly and the work should be proportional to the agents, not
// to the rows. One call fetches every participant's name spans and current
// name; everything after that is in memory. Nothing outlives the request, so a
// rename has nothing to invalidate.
//
// This replaced a per-row lookup that ran `nameAt` + `getAgent` for each of
// from/to/agentId on every row, against a limit of 5,000 — up to 30,000
// synchronous point queries to render one events reply, each `getAgent`
// hydrating an entire agent to read one column.
//
// The historical name is time-dependent and must NOT be memoized on id alone:
// that would collapse an agent's distinct historical names into whichever
// resolved first and silently rewrite history in every thread view. Resolving
// against the spans keeps every instant distinct.
async function stampNames(rows) {
  if (!Array.isArray(rows)) return rows
  const names = await fleetStore.nameSpansFor(
    rows.flatMap(r => [r.from, r.to, r.agentId]),
  )
  const stamp = (r, id, nameKey, nowKey) => {
    if (!id) return
    const entry = names.get(id)
    const at = resolveNameAt(entry, r.timestamp)
    r[nameKey] = at
    const current = entry?.current ?? null
    if (current !== at) r[nowKey] = current
  }
  for (const r of rows) {
    stamp(r, r.from, 'fromName', 'fromNameNow')
    stamp(r, r.to, 'toName', 'toNameNow')
    stamp(r, r.agentId, 'agentName', 'agentNameNow')
  }
  return rows
}

// Fleet state: in-memory
const wsFleetClients = new Set()            // active /ws/fleet connections
const agentFleetConnections = new Map()     // agent_id -> latest /ws/fleet connection

// Daemon connections — keyed by machine_id:env_name. Each value is the live WS
// for that daemon config lane. Used for RPC routing and agent updates.
const daemonConnections = new Map()         // machine_id:env_name -> ws
const daemonWelcomeSeenAt = new Map()       // machine_id:env_name -> last successful hello setup

function daemonTerminalInputAllowed(daemonKey) {
  const ws = daemonConnections.get(daemonKey)
  return ws?._capabilities?.terminalInputAllowed === true
}

function agentWithDaemonCapabilities(agent) {
  if (!agent) return agent
  const daemonKey = agent.daemon_key || agent.route_daemon_key
  return {
    ...agent,
    terminalInputAllowed: daemonKey ? daemonTerminalInputAllowed(daemonKey) : false,
  }
}

// Gate 1 observability: correlates one daemon WS connection attempt across
// server and client logs, keyed by client-minted `connection_attempt_id`
// (echoed back in daemon-welcome alongside ws._wsSessionId). Observability
// only — no new liveness authority, no self-poll, no delivery-policy change.
// Content-free: no token, URL query, session/resume/terminal capability.
function traceGate1(stage, detail) {
  console.log(`[gate1-trace] ${stage} ${JSON.stringify({ ts: new Date().toISOString(), ...detail })}`)
}

// Runtime status truth. Positive process evidence remains true until the daemon
// explicitly reports absence/death. A missing heartbeat, a daemon disconnect,
// or copied route state does not fabricate hibernation.
const _aliveAgents = new Set()              // Set<agent_id>
const _aliveSince = new Map()               // agent_id -> first ms in current alive run

const runtimeStatusStore = createAgentRuntimeStatusStore({
  onChange: agentId => {
    // Not awaited, and these three are the only refreshes treated this way.
    // refreshAgentLiveness returns nothing — it re-syncs the agent registry so
    // the roster view and footer count see the change. Nothing downstream reads
    // a result, and every caller that follows it with broadcastState hits a
    // 50ms debounce, which is far longer than a worker round trip, so the
    // refresh lands before the broadcast it feeds.
    //
    // .catch rather than bare `void`: a dropped rejection here would be an
    // unhandled rejection, and a registry that stopped re-syncing is worth
    // seeing in the log rather than discovering as a roster that quietly stops
    // updating.
    //
    // The alternative was making markAgentAlive/markAgentNotAlive async, which
    // cascades through the whole liveness path for a call whose value nobody
    // uses.
    fleetStore.refreshAgentLiveness(agentId).catch(e => console.error(`[runtime-status] liveness refresh failed for ${agentId}: ${e?.message || e}`))
    if (typeof broadcastState === 'function') broadcastState(agentId)
  },
})
fleetStore.setRuntimeProjector(agent => runtimeStatusStore.project(agent))

const humanPresence = createHumanPresenceTracker({
  onEdge: ({ humanId, status, atMs }) => {
    const source = status === RUNTIME_STATUS.HERE
      ? 'browser-connections-0-to-1'
      : 'browser-connections-1-to-0'
    runtimeStatusStore.markHumanPresence(humanId, status, source, { atMs })
    fleetStore.recordRuntimeState(
      humanId,
      { kind: RUNTIME_KIND.HUMAN, status },
      new Date(atMs).toISOString(),
    ).catch(e => console.error(`[human-presence] durable state write failed for ${humanId}: ${e?.message || e}`))
  },
})

// Awake, projected from the agent ROW. It used to take an id and call back
// into the store for a seat — per check — while both of its callers already
// held the agent and its seat a couple of lines above. The seat facts now ride
// the row, so this looks nothing up.
// The two facts the store needs to count the roster, and the reason they are
// assembled at the call site rather than kept anywhere: they are inputs to one
// computation. `liveEvidenceIds` is the agents for which the daemon/process has
// supplied positive evidence without a later explicit negative observation.
function rosterCountInputs() {
  const liveEvidenceIds = []
  for (const agentId of _aliveAgents) {
    const evidence = runtimeStatusStore.evidenceFor(agentId)
    if (evidence?.liveness !== 'alive') continue
    liveEvidenceIds.push(agentId)
  }
  return { liveEvidenceIds, humanHereIds: humanPresence.hereIds() }
}

function isReservedShellAgent(agent) {
  return !!agent?.metadata?.shell
}

function markAgentAlive(agentId, now = Date.now(), detail = {}) {
  const wasAlive = _aliveAgents.has(agentId)
  const evidence = runtimeStatusStore.markAlive(agentId, detail.source || 'server-positive-evidence', { ...detail, atMs: now })
  if (evidence?.liveness !== 'alive') return
  fleetStore.recordRuntimeState(agentId, { kind: RUNTIME_KIND.AI, status: RUNTIME_STATUS.AWAKE }, evidence.liveness_at)
    .catch(e => console.error(`[liveness] runtime status write failed for ${agentId}: ${e?.message || e}`))
  if (!wasAlive || !_aliveSince.has(agentId)) _aliveSince.set(agentId, now)
  _aliveAgents.add(agentId)
  if (!wasAlive) {
    // Fire-and-forget for the reason given where onChange does the same.
    fleetStore.refreshAgentLiveness(agentId).catch(e => console.error(`[liveness] refresh failed for ${agentId}: ${e?.message || e}`))
    // Recovery: an agent transitioning to alive (login/reconnect) clears its
    // wake breaker so a restored session is nudged again immediately (§4.2).
    _wakeBreaker.delete(agentId)
  }
}

function markAgentNotAlive(agentId, detail = {}) {
  const wasAlive = _aliveAgents.has(agentId)
  const evidence = detail.unknown
    ? runtimeStatusStore.markUnknown(agentId, detail.source || 'runtime-unknown', detail)
    : runtimeStatusStore.markNotAlive(agentId, detail.source || 'runtime-negative-evidence', detail)
  if (evidence?.liveness === 'alive') return
  if (!detail.unknown) {
    fleetStore.recordRuntimeState(agentId, { kind: RUNTIME_KIND.AI, status: RUNTIME_STATUS.HIBERNATING }, evidence.liveness_at)
      .catch(e => console.error(`[liveness] runtime status write failed for ${agentId}: ${e?.message || e}`))
  }
  _aliveAgents.delete(agentId)
  _aliveSince.delete(agentId)
  clearEphemeralState(agentId)
  // Fire-and-forget for the reason given where onChange does the same.
  if (wasAlive) fleetStore.refreshAgentLiveness(agentId).catch(e => console.error(`[liveness] refresh failed for ${agentId}: ${e?.message || e}`))
}

function markUnroutedNativeDescendantsNotAlive(parentAgentId, detail = {}) {
  const descendantIds = unroutedNativeDescendantIds(fleetStore.getAliveAgents(), parentAgentId)
  for (const descendantId of descendantIds) {
    markAgentNotAlive(descendantId, {
      ...detail,
      source: detail.source || 'native-parent-not-alive',
      reason: detail.reason || `native parent ${parentAgentId} is not alive`,
    })
  }
}

function recordExplicitCheckAliveLiveness(liveness) {
  const agentId = liveness?.agent_id
  if (!agentId) return
  const atMs = Date.parse(liveness.ts) || Date.now()
  const detail = {
    source: 'daemon-check-alive',
    state: liveness.state,
    reason: liveness.reason,
    pid: liveness.pid,
    atMs,
  }
  if (liveness.state === 'alive') markAgentAlive(agentId, atMs, detail)
  else if (liveness.state === 'dead' || liveness.state === 'wedged') markAgentNotAlive(agentId, detail)
  else markAgentNotAlive(agentId, { ...detail, unknown: true })
}

// Which agents this daemon connecting or dropping changes the route state of.
//
// The route projection is indexed by daemon, so this does not scan the roster.
async function refreshRuntimeRoutesForDaemon(daemonKey) {
  if (!daemonKey) return
  const seated = await fleetStore.getAgentsByDaemonKey(daemonKey)
  const affected = seated.filter(agent => agent && !agent.human).map(agent => agent.id)
  for (const id of affected) await fleetStore.refreshAgentLiveness(id)
  if (affected.length) broadcastState(affected)
}


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
    ws.on('message', () => {
      const now = Date.now()
      ws._wsLastInputAt = now
      if (ws._wsKind === 'fleet') ws._wsLastPongAt = now
    })
  }
  const cleanup = () => {
    recordServerPerfEvent('ws-cleanup', {
      kind: ws._wsKind,
      doc: ws._wsDocName,
      sessionId: ws._wsSessionId,
      connectedForMs: Date.now() - ws._wsConnectedAt,
    })
    _trackedWs.delete(ws)
  }
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
      const r = await sendDaemonDurable(machineId, 'kill-orphan-chromium', {
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
    // Stopgap (transport-unification): give EVERY socket kind the same 2× grace
    // fleet already had, so a live-but-jittery daemon/terminal/sync socket isn't
    // reaped at 30s. Observed: a healthy Mini daemon was terminated at 45s of
    // no-pong under event-loop/Tailscale jitter, tearing down cards + watcher
    // push. The client watchdogs (ResilientWS 90s, browser heartbeat) still
    // reconnect if a socket is genuinely dead; this only stops false kills.
    const heartbeatIntervalMs = WS_HEARTBEAT_INTERVAL_MS * 2
    if (shouldTerminateForMissedPong(ws._wsLastPongAt, ws._wsLastPingAt, now, heartbeatIntervalMs)) {
      console.log(`[heartbeat] terminating unresponsive ${ws._wsKind} ws=${ws._wsSessionId} doc=${ws._wsDocName || '-'}`)
      recordServerPerfEvent('heartbeat-terminate', {
        kind: ws._wsKind,
        doc: ws._wsDocName,
        sessionId: ws._wsSessionId,
        lastPongAgoMs: ws._wsLastPongAt ? now - ws._wsLastPongAt : null,
        lastPingAgoMs: ws._wsLastPingAt ? now - ws._wsLastPingAt : null,
      })
      if (ws._wsKind === 'daemon' && ws._daemonKey) {
        traceGate1('heartbeat-terminate', {
          daemon_key: ws._daemonKey,
          boot_id: ws._bootId,
          connection_attempt_id: ws._connectionAttemptId,
          ws_session_id: ws._wsSessionId,
          lastPongAgoMs: ws._wsLastPongAt ? now - ws._wsLastPongAt : null,
        })
      }
      ws.terminate()
      continue
    }
    ws._wsLastPingAt = now
    ws.ping()
  }
}, WS_HEARTBEAT_INTERVAL_MS).unref()

// Server owner — the human running this server process. Used as fallback
// identity for MCP agents and CLI operations. Browser users identify
// themselves via WS 'login' (returning) or 'register' (new human) messages.
const SERVER_OWNER_NAME = process.env.TLDA_USER || (() => { try { return os.userInfo()?.username } catch { return 'user' } })()
const SERVER_OWNER_ID = `fleet:${SERVER_OWNER_NAME}`
const SERVER_BOOT_ID = Date.now()   // unique per server start; daemon uses this to detect restarts
// Pending RPCs awaiting a daemon `rpc-reply`. Keyed by RPC id.
// Each entry is the shared ws-request-policy shape plus { machine_id, env_name }.
const pendingRpcs = new Map()
let _rpcSeq = 0
const DAEMON_RPC_RECONNECT_GRACE_MS = Number(process.env.TLDA_DAEMON_RPC_RECONNECT_GRACE_MS || 15_000)
const pendingRpcFailureTimers = new Map()

// ---------- Plan mode approval tracking ----------
//
// When a terminal frame shows the Claude Code plan mode approval prompt
// ("Would you like to proceed?"), we fire a plan_approval fleet event and
// track the pending approval so Skip's voice response can be routed back
// as a keystroke to the correct agent's tmux pane.
//
// keyed by agent_id -> { agent_id, eventId }
const pendingPlanApprovals = new Map()

// Chat idempotency cache: _tempId → { eventIds, recipients, receipts, ts }
// Prevents duplicate DB rows when the browser retries a timed-out send.
const _chatTempIds = new Map()
const CHAT_TEMPID_TTL_MS = 60_000
setInterval(() => {
  const cutoff = Date.now() - CHAT_TEMPID_TTL_MS
  for (const [k, v] of _chatTempIds) { if (v.ts < cutoff) _chatTempIds.delete(k) }
}, 30_000).unref?.()

const _subscriptionBatchWakes = new Map()

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

async function sendWakeNudge(daemonKey, agent, nudgeText, phase, logTag = 'wake-nudge') {
  if (!shouldSendWakeNudge(agent, nudgeText)) return
  await sendDaemonDurable(daemonKey, 'notify-agent', {
    agent_id: agent.id,
    text: nudgeText,
    enter_delay_ms: agent?.metadata?.kind === 'codex' ? 400 : 0,
  })
}

function timestampMs(value) {
  if (!value) return null
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

function agentAwaySinceMs(agent) {
  return timestampMs(agent?.last_seen)
    || timestampMs(agent?.registered_at)
}

function formatAwayDuration(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return 'less than a minute'
  const units = [
    ['day', 24 * 60 * 60_000],
    ['hour', 60 * 60_000],
    ['minute', 60_000],
  ]
  for (const [name, size] of units) {
    const n = Math.floor(ms / size)
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'}`
  }
  return 'less than a minute'
}

function agentReturnNotice(agent, status = 'hibernating', { reanimated = false } = {}) {
  const sinceMs = agentAwaySinceMs(agent)
  const duration = sinceMs ? formatAwayDuration(Date.now() - sinceMs) : 'an unknown amount of time'
  const lines = [`You were away as ${status} for ${duration}.`]
  if (reanimated) {
    lines.push('You were killed and reanimated.')
    lines.push('Your open tasks were retired when you were killed.')
  }
  return lines.join('\n')
}

function withAgentReturnNotice(agent, nudgeText, status = 'hibernating', opts = {}) {
  const notice = agentReturnNotice(agent, status, opts)
  return nudgeText ? `${notice}\n\n${nudgeText}` : notice
}

async function waitForAgentDaemonRoute(agentId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const seat = await fleetStore.getAgentDaemonRoute?.(agentId)
    if (seat) return seat
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return await fleetStore.getAgentDaemonRoute?.(agentId) || null
}

async function sendReanimateNoticeWithRetry(agentId, agent, seat, noticeText) {
  let currentRoute = seat
  let lastErr = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await sendWakeNudge(currentRoute.daemon_key, agent, noticeText, 'post-reanimate', 'reanimate')
      return currentRoute
    } catch (e) {
      lastErr = e
      if (attempt >= 2) break
      await new Promise(resolve => setTimeout(resolve, 500))
      currentRoute = await fleetStore.getAgentDaemonRoute?.(agentId) || currentRoute
    }
  }
  throw lastErr || new Error('reanimate notice failed')
}

async function reanimateAgent(agentQuery) {
  if (!agentQuery) throw new Error('reanimate requires agent')
  const before = await fleetStore.findAgentStored?.(agentQuery) || await fleetStore.findAgent(agentQuery)
  if (!before) {
    const err = new Error('agent not found')
    err.status = 404
    throw err
  }
  if (before.human) {
    const err = new Error('cannot reanimate a human')
    err.status = 400
    throw err
  }
  if (!before.dead) {
    const err = new Error(`${before.friendly_name || before.id} is not dead`)
    err.status = 409
    throw err
  }
  const daemonKey = before.daemon_key || (before.machine_id && before.env_name ? daemonAddress(before.machine_id, before.env_name) : null)
  if (!daemonKey) {
    const err = new Error(`${before.friendly_name || before.id} has no daemon address`)
    err.status = 409
    throw err
  }
  const ownerDaemon = daemonConnections.get(daemonKey)
  if (!ownerDaemon || ownerDaemon.readyState !== 1) {
    const err = new Error(`No fleet-daemon connected for ${daemonKey}`)
    err.status = 503
    throw err
  }

  const revived = await fleetStore.markAlive(before.id)
  markAgentNotAlive(before.id, { source: 'reanimate', reason: 'dead bit cleared; waking agent' })
  broadcastState(before.id)
  let spawnResult
  try {
    spawnResult = await sendDaemonDurable(daemonKey, 'wake', { fleet_id: before.id })
    if (!spawnResult?.ok) {
      throw new Error(spawnResult?.error || spawnResult?.reason || 'daemon returned ok:false with no reason')
    }
  } catch (e) {
    const currentRoute = await fleetStore.getAgentDaemonRoute?.(before.id)
    if (!currentRoute) {
      await fleetStore.markDead(before.id)
      markAgentNotAlive(before.id, { source: 'reanimate', reason: `wake failed: ${e.message}` })
      broadcastState(before.id)
    }
    throw e
  }
  const nextSeat = await waitForAgentDaemonRoute(before.id)
  if (!nextSeat?.daemon_key) throw new Error(`reanimate for ${before.id} did not establish a daemon route`)
  const noticeText = agentReturnNotice(before, 'dead', { reanimated: true })
  try {
    await sendReanimateNoticeWithRetry(before.id, revived, nextSeat, noticeText)
  } catch (e) {
    let killError = null
    try {
      await sendDaemonDurable(nextSeat.daemon_key, 'kill-session', terminalRpcPayload(revived, nextSeat))
    } catch (killErr) {
      killError = killErr
    }
    await fleetStore.markDead(before.id)
    markAgentNotAlive(before.id, { source: 'reanimate', reason: `notice failed: ${e.message}` })
    broadcastState(before.id)
    const suffix = killError ? `; also failed to kill resumed session: ${killError.message}` : ''
    throw new Error(`reanimate notice failed after wake; agent left dead${suffix}: ${e.message}`)
  }
  await measureHotOp('fleet-ws lifecycle reanimate insert', `agent=${before.id}`, () => fleetStore.insertEventRecord({
    type: 'lifecycle',
    timestamp: new Date().toISOString(),
    from: before.id,
    to: before.id,
    text: 'agent reanimated',
    unread: false,
  }, { notify: false }))
  broadcastState(before.id)
  return {
    ok: true,
    agent_id: before.id,
    agent: revived.friendly_name || before.id,
    notice: noticeText,
    wake: spawnResult,
  }
}

async function requestTaskWake(agentId, nudgeText = null, keys = []) {
  const agent = await fleetStore.getAgent(agentId)
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
    const agent = await fleetStore?.getAgent?.(agentId)
    if (!agent || agent.dead || agent.human) continue
    const seat = await fleetStore?.getAgentDaemonRoute?.(agentId)
    if (!seat) continue
    const daemonKeys = [...daemonConnections.keys()]
    if (daemonKeys.length === 0) continue
    const daemonKey = seat.daemon_key
    try {
      const ownerDaemon = daemonConnections.get(daemonKey)
      if (!ownerDaemon || ownerDaemon.readyState !== 1) throw new Error(`No fleet-daemon connected for ${daemonKey}`)
      const spawnResult = await sendDaemonDurable(daemonKey, 'wake', { fleet_id: agentId })
      if (!spawnResult?.ok) {
        // Don't drop a failed re-nudge silently — surface via the catch (agent-wedged).
        throw new Error(spawnResult?.error || spawnResult?.reason || 'daemon returned ok:false with no reason')
      }
      const nextSeat = await fleetStore?.getAgentDaemonRoute?.(agentId)
      if (!nextSeat) throw new Error(`respawn for ${agentId} did not create a daemon route`)
      const deliveredNudge = spawnResult.already ? nudgeText : withAgentReturnNotice(agent, nudgeText)
      await sendWakeNudge(nextSeat.daemon_key, agent, deliveredNudge, spawnResult.already ? 'already-awake' : 'post-respawn', 'task-renudge')
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

async function taskInboxStatusFor(agentId) {
  const status = (await fleetStore?.getAgent?.(agentId))?.metadata?.inboxStatus
  return normalizeInboxStatus(status)
}

function taskWakePreview(raw, max = 120) {
  const s = String(raw || '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

async function taskDelegateWakeText(description, agentId) {
  const status = await taskInboxStatusFor(agentId)
  const prefix = status[0].toUpperCase() + status.slice(1)
  return `📬 ${prefix} new task assigned: ${taskWakePreview(description)}\nCall inbox() to see it.`
}

async function runTaskRenudgeSweep() {
  if (!fleetStore) return
  const page = await fleetStore.getActiveTasksPage?.({ limit: TASK_RENUDGE_SWEEP_LIMIT, cursor: _taskRenudgeCursor }) || { tasks: [], nextCursor: null }
  const tasks = page.tasks || []
  _taskRenudgeCursor = page.nextCursor || null
  const taskStates = tasks.map(task => fleetStore.getTaskDeliveryState?.(task)).filter(Boolean)
  const agentIds = taskStates.map(state => state?.task?.agent).filter(Boolean)
  const nudges = decideTaskRenudges({
    taskStates,
    agents: await fleetStore.getAgentsByIds?.(agentIds) || [],
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
    await requestTaskWake(nudge.task.agent, await taskDelegateWakeText(nudge.task.description || nudge.event.text || nudge.task.id, nudge.task.agent), [nudge.key])
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
 * Resilient callers reuse one request id across reconnect attempts. The daemon
 * binds that id to the operation and canonical payload, then replays the result
 * without repeating the side effect. The caller's deadline remains authoritative.
 */
class NoDaemonError extends Error {
  constructor(machineId, envName) {
    super(`No fleet-daemon connected for ${describeAgentAddress(machineId, envName)}`)
    this.code = 'NO_DAEMON'
    this.machineId = machineId
    this.envName = envName
  }
}

async function sendDaemonRpcAttempt(machineId, op, params = {}, opts = {}) {
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
    if (op === 'spawn') logSpawnDaemonMiss(key, 'sendDaemonRpcAttempt(spawn)', { hasWs: !!dws, readyState: dws?.readyState ?? 'missing', route: params.spawnRoute || 'unknown' })
    return Promise.reject(new NoDaemonError(targetMachine, envName))
  }
  const id = opts.requestId || `rpc-${++_rpcSeq}-${Date.now().toString(36)}`
  // Per-attempt deadline is a caller-passed param (event-based default): control ops
  // wrapped in sendDaemonDurable pass a short per-attempt timeout so a stale-but-"open"
  // WS is abandoned quickly and retried on the fresh reconnect, rather than blocking
  // the full 10s each time.
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : null
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

function rpcReplyError(msg) {
  const error = new Error(rpcErrorMessage(msg.error))
  if (msg.reason) error.reason = msg.reason
  if (msg.code) error.code = msg.code
  return error
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
// Base sendDaemonEphemeral() is deliberately "10s timeout, no retry" — the caller decides. But
// durable *control* ops (send-text / wake-nudge, check-alive, spawn-availability)
// should NOT hard-fail while the daemon WS is mid-reconnect (Fly deploy flap, 1006
// churn, off-launchd restart). Per Skip: the deadline is a caller-passed param with an
// event-based default — the op queues and completes on the reconnect event. This
// wrapper waits (event-driven, not a busy-poll) for the daemon to (re)register and
// retries, bounded by a total deadline. Every attempt uses the same request id;
// the daemon rejects mismatched reuse and replays an exact match.
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
function waitForDaemonReady(daemonKey, deadlineMs = null) {
  const dws = daemonConnections.get(daemonKey)
  if (dws && dws.readyState === 1) return Promise.resolve()
  if (deadlineMs !== null && !(deadlineMs > 0)) return Promise.reject(new Error(`daemon ${daemonKey} not connected`))
  return new Promise((resolve, reject) => {
    let set = daemonReadyWaiters.get(daemonKey)
    if (!set) { set = new Set(); daemonReadyWaiters.set(daemonKey, set) }
    const w = { resolve, timer: null }
    if (deadlineMs !== null) {
      w.timer = setTimeout(() => {
        set.delete(w)
        if (set.size === 0) daemonReadyWaiters.delete(daemonKey)
        reject(new Error(`daemon ${daemonKey} did not reconnect within ${deadlineMs}ms`))
      }, deadlineMs)
    }
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
  if (err?.code === 'RPC_DEADLINE') return true
  const m = rpcErrorMessage(err)
  return /RPC timeout after|daemon disconnected|not connected|did not reconnect/i.test(m)
}

// Event-based retry across reconnect for idempotent control ops. Retries only on
// transient (reconnect-class) failures; op-level errors propagate immediately.
async function sendDaemonRpcDurableAttempt(machineId, op, params = {}, {
  totalDeadlineMs = null,
  attemptTimeoutMs = null,
  requestId = null,
} = {}) {
  const key = rpcDaemonKey(machineId, params)
  const stableRequestId = requestId || `rpc-${++_rpcSeq}-${Date.now().toString(36)}`
  const start = Date.now()
  let lastErr = null
  while (true) {
    const remaining = Number.isFinite(totalDeadlineMs) ? totalDeadlineMs - (Date.now() - start) : null
    if (remaining !== null && remaining <= 0) break
    const dws = daemonConnections.get(key)
    if (!dws || dws.readyState !== 1) {
      try { await waitForDaemonReady(key, remaining) } catch (e) { lastErr = e; break }
    }
    try {
      return await sendDaemonRpcAttempt(machineId, op, params, {
        requestId: stableRequestId,
        timeoutMs: Number.isFinite(attemptTimeoutMs)
          ? (remaining === null ? attemptTimeoutMs : Math.min(attemptTimeoutMs, Math.max(1, remaining)))
          : null,
      })
    } catch (e) {
      lastErr = e
      if (!isTransientRpcError(e)) throw e
      // A stale-but-"open" WS would re-hit the same dead socket; wait for a fresh
      // ready daemon (the close handler evicts the dead WS, the new hello notifies).
      const left = Number.isFinite(totalDeadlineMs) ? totalDeadlineMs - (Date.now() - start) : null
      if (left !== null && left <= 0) break
      try { await waitForDaemonReady(key, left) } catch (we) { lastErr = we; break }
    }
  }
  // Exhausting the retry budget is not a verdict either -- nothing refused the
  // op, we stopped waiting. Carry a code so callers can tell that apart from a
  // daemon-reported failure, the same way NoDaemonError does.
  const exhausted = new Error(`RPC ${op} to ${key} gave no response within ${totalDeadlineMs}ms`)
  exhausted.code = 'RPC_DEADLINE'
  throw lastErr || exhausted
}

const serverDaemonTransport = createFleetOperationTransport({
  name: 'server-daemon',
  sendEphemeral: (operation, payload, options) =>
    sendDaemonRpcAttempt(payload.machineId, operation, {
      ...payload.params,
      operation_id: payload.params?.operation_id || options.envelope.operation_id,
      fleet_operation: options.envelope,
    }, options.rpcOptions),
  sendDurable: (operation, payload, options) =>
    sendDaemonRpcDurableAttempt(payload.machineId, operation, {
      ...payload.params,
      operation_id: payload.params?.operation_id || options.envelope.operation_id,
      fleet_operation: options.envelope,
    }, { ...options.rpcOptions, requestId: options.envelope.operation_id }),
  observe: event => {
    if (event.stage === 'started') {
      fleetStore.beginTransportOperation(event.envelope)
        .catch(e => console.error(`[server-daemon] begin transport operation failed for ${event.envelope?.operation_id}: ${e?.message || e}`))
      return
    }
    fleetStore.recordTransportOperationResult(
      event.operation_id,
      event.operation,
      event.ok ? 'result' : 'error',
      event.ok ? { ok: true, queued: event.queued === true } : { message: event.error },
      event.envelope,
    ).catch(e => console.error(`[server-daemon] record transport result failed for ${event.operation_id}: ${e?.message || e}`))
  },
})

function sendDaemonEphemeral(machineId, operation, params = {}, rpcOptions = {}) {
  const parent = fleetOperationContext.getStore()
  return serverDaemonTransport.ephemeral(operation, { machineId, params }, {
    rpcOptions,
    sender: 'server',
    destination: machineId,
    parentOperationId: parent?.operation_id || null,
  })
}

function sendDaemonDurable(machineId, operation, params = {}, rpcOptions = {}) {
  const parent = fleetOperationContext.getStore()
  return serverDaemonTransport.durable(operation, { machineId, params }, {
    rpcOptions,
    sender: 'server',
    destination: machineId,
    parentOperationId: parent?.operation_id || null,
  })
}

// Mirror-back is event-based and idempotent (same hash → same ref): use the
// resilient sender so a daemon WS reconnect flap retries instead of throwing a
// 10s timeout that masquerades as a failure. (Skip 7/22)
setShadowMirrorHandler(createShadowMirrorRpcHandler({
  readProject,
  sendDaemonEphemeral: sendDaemonDurable,
  // Every connected daemon, not just the one that pushed last — a machine that
  // does not hold the project declines for itself.
  listDaemonKeys: () => [...daemonConnections.keys()],
}))

setAcceptedSourceMutationHandler(async ({ sourceDaemonKey, ...message }) => {
  const keys = [...daemonConnections.keys()].filter(key => key !== sourceDaemonKey)
  if (keys.length === 0) return
  const settled = await Promise.allSettled(keys.map(key =>
    sendDaemonDurable(key, 'apply-source-update', message, { totalDeadlineMs: 5000, timeoutMs: 2000 })
      .then(result => ({ key, result })),
  ))
  const failed = []
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]
    if (outcome.status === 'rejected') {
      failed.push(`${keys[i]} (${outcome.reason?.message || outcome.reason})`)
    } else if (outcome.value.result?.ok === false && outcome.value.result?.reason !== 'project-not-watched') {
      failed.push(`${keys[i]} (${outcome.value.result?.reason || 'declined'})`)
    }
  }
  if (failed.length > 0) {
    console.error(`[source-sync] accepted source update for ${message.project} did not reach all linked checkouts: ${failed.join(', ')}`)
  }
})

// No server-side echo suppression. Dedup is client-side: the WS reply
// includes the event ID, which the client maps to its optimistic event
// before the echo arrives (WS message ordering guarantees this).

// Filter subscriptions — a chat is a filter, and the server answers it.
//
const filterSubscriptions = createFilterSubscriptions({
  getAgentsByIds: async (agentIds) => {
    const ids = [...new Set((agentIds || []).filter(Boolean))]
    if (!ids.length) return []
    const agents = await fleetStore?.getAgentsByIds?.(ids) || []
    const seen = new Set(agents.map(agent => agent.id))
    let frontier = [...new Set(agents.map(agent => agent?.parent_agent_id).filter(Boolean))]
    while (frontier.length) {
      const parents = await fleetStore?.getAgentsByIds?.(frontier) || []
      frontier = []
      for (const parent of parents) {
        if (seen.has(parent.id)) continue
        seen.add(parent.id)
        agents.push(parent)
        if (parent.parent_agent_id && !seen.has(parent.parent_agent_id)) {
          frontier.push(parent.parent_agent_id)
        }
      }
    }
    return agents
  },
  loadMembershipSpans: async (labels, bounds) =>
    await fleetStore?.filterMembershipSpans?.(labels, bounds) || [],
})

// Liveness counters for the filter push.
//
// The deletion of the client spool is gated on a comparator staying quiet — and
// a quiet comparator is indistinguishable from one that never ran. These make
// the difference checkable: subscriptions 0 or eventsSeen 0 on a live server
// with panels open means the path is not running, not that it agrees.
// startedAt/uptimeMs are NOT optional. These are process-lifetime counters, so a
// zero after a restart is indistinguishable from a zero that never moved — and on
// 2026-07-25 that ambiguity misled a teammate within minutes of shipping: a
// sample taken between a 12:53:02Z restart and the 12:56:09Z resumption read
// eventsMatched: 0 and was reported as "the rebuild matches nothing", when it had
// matched at 12:52:29Z and matched again three minutes later.
//
// Invariant 5 in scratch/server-side-filter-handoff.md, closed here: a counter
// that can reset must say when it started.
const filterPushCounters = {
  eventsSeen: 0,
  eventsMatched: 0,
  deliveries: 0,
  evaluations: 0,
  matchFaults: 0,
  lastEventAt: null,
  lastDeliveryAt: null,
}
const filterPushStartedAt = new Date().toISOString()

async function pushFilteredEvent(data) {
  if (!data) return
  filterPushCounters.eventsSeen++
  filterPushCounters.lastEventAt = new Date().toISOString()
  let matched
  try {
    matched = await filterSubscriptions.match(data)
  } catch (e) {
    // A filter fault must never take down the broadcast everyone still relies on.
    filterPushCounters.matchFaults++
    console.warn('[filter-subs] match failed:', e.message)
    return
  }
  filterPushCounters.evaluations += matched.evaluations || 0
  if (matched.length) {
    filterPushCounters.eventsMatched++
    filterPushCounters.deliveries += matched.length
    filterPushCounters.lastDeliveryAt = filterPushCounters.lastEventAt
  }
  const publicData = { ...data }
  delete publicData._filter_agents
  for (const { conn, subId } of matched) {
    try {
      if (conn.readyState === 1) conn.send(JSON.stringify({ event: 'filter-event', data: { subId, event: publicData } }))
    } catch { /* the socket's own close path cleans up */ }
  }
}

function broadcastFleet(msg) {
  const operation = fleetOperationContext.getStore()
  const data = JSON.stringify(operation && !msg.fleet_operation
    ? { ...msg, fleet_operation: operation }
    : msg)
  for (const ws of wsFleetClients) {
    try { if (ws.readyState === 1) ws.send(data) } catch { wsFleetClients.delete(ws) }
  }
}
function broadcastEvent(type, data) {
  if (type === 'fleet-event' && data?.type === 'activity') {
    serverActivityDeliveryCounters.record(ACTIVITY_DELIVERY_STAGES.SERVER_BROADCAST, data, 1, {
      type: 'activity',
      agent: data.from_id || data.from || data.agent || null,
      tool: data.metadata?.tool || data.text || null,
    })
  }
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
  if (type === 'fleet-event') {
    if (isChatHistoryEventType(data?.type)) void pushFilteredEvent(data)
    return
  }
  broadcastFleet({ event: type, data })
}

serverTimerScheduler = new ServerTimerScheduler({
  store: fleetStore,
  broadcast: broadcastEvent,
  notify: (to, text, source) => requestWake(to, text, null, null, source || {}),
})
// Not awaited: this is module top level, where there is no async context to
// await into. A failing first refresh is reported rather than becoming an
// unhandled rejection at startup.
serverTimerScheduler.start().catch(e => console.error(`[timer-scheduler] initial refresh failed: ${e?.message || e}`))

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
        sendFleetResponseFrame(ws, { id: requestId, error: { message } })
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
    await fleetStore.chat('fleet:tlda', SERVER_OWNER_ID, text, {
      type: 'fleet_runtime_error',
      wsPeer: peer,
      messageType: type,
      requestId,
    })
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
    await fleetOperationContext.run(msg.fleet_operation || null, () => handleFleetWsMessage(ws, msg))
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
  onWedged: async ({ agent_id, liveness }) => {
    const agent = await fleetStore?.getAgent?.(agent_id)
    const label = agent?.friendly_name || agent_id
    const metadata = {
      type: 'agent_wedged',
      agentId: agent_id,
      agentLabel: label,
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
    // Silence on success: a late-arriving spawn is still just a success. Surface it
    // as state (event + roster), not a "it's now available" chat line. (Skip 7/22)
    broadcastEvent('spawn-late-login', metadata)
    broadcastState(agent)
  },
})
const mailboxLibrarian = new MailboxLibrarian({
  onExpire: (entry) => {
    if (entry.kind !== 'spawn') return
    // A timeout is not a failure. A spawn that hasn't logged in within the mailbox
    // deadline is event-based and still in flight — it either logs in later (the
    // agent shows up in the roster; onLateLogin handled that) or the launch itself
    // threw a REAL error, which surfaces separately with a real reason. Firing a
    // "deadline exceeded → failed" chat at the requesting agent manufactures a
    // failure out of a timeout and disrupts that agent for nothing. Whether a
    // spawn is genuinely stuck belongs on a live status surface, not a chat push.
    // (Skip 7/22)
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
const MY_TASK_DELIVERY_LIMIT = 50

function touchActivity(agentId) {
  _lastActivityAt.set(agentId, Date.now())
}

// ---- Turn-end synthetic event ----
// An agent's "turn" ends when it transitions thinking → idle. The transient
// `agent-thinking` indicator is fire-and-forget (a disconnected subscriber
// misses the edge), so we ALSO persist a synthetic `turn_ended` row in the
// events DB for subscribers.
// The true→false edge is deduped upstream by _thinkingState, so this fires
// exactly once per turn.
async function emitTurnEnded(agentId, startedAtMs) {
  if (!fleetStore || !agentId) return
  // Only real agents have turns — skip humans/bots (Skip, todd, tlda, …).
  const a = await fleetStore.getAgent?.(agentId)
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

// Read-only authoritative idle fact for lifecycle-policy consumers such as Todd.
// This function never changes agent state and never applies a policy threshold.
// The returned duration is capped by continuous observed liveness, so a newly
// rediscovered seat cannot inherit an older idle clock and immediately qualify.
// Iterates the agents this server currently believes are alive, not the whole
// roster. That is not a shortcut — it is the same set, arrived at cheaply.
//
// The loop's fourth filter requires a finite alive_since_ms, and that field is
// written only by runtimeStatusStore.markAlive and cleared only by
// markNotAlive/markUnknown. Those are called from exactly two places,
// markAgentAlive and markAgentNotAlive, each immediately after the matching
// _aliveAgents.add / .delete. So _aliveAgents is a superset of the candidate
// set: nothing outside it can survive filter four. Agents inside it whose
// evidence has since aged past the TTL are still filtered by the awake check
// below, exactly as before.
//
// The roster scan cost a full getAllAgents() plus a projection per row to
// discover a handful of agents the main thread already had in a Set. One
// bounded getAgentsByIds instead — the same inversion as the roster count.
async function getTrustedIdleSeconds() {
  const now = Date.now()
  const result = {}
  const candidates = [..._aliveAgents]
  if (!candidates.length) return result
  for (const agent of await fleetStore.getAgentsByIds(candidates)) {
    if (!agent || agent.dead || agent.human || agent.metadata?.shell) continue
    const agentId = agent.id
    const runtime = runtimeStatusStore.project(agent)
    if (runtime.status !== 'awake') continue
    if (_thinkingState.has(agentId)) continue
    if (_compactingState.has(agentId)) continue
    const aliveSince = Number(runtimeStatusStore.evidenceFor(agentId)?.alive_since_ms)
    if (!Number.isFinite(aliveSince)) continue
    // Idle baseline = last REAL activity, or — if we've recorded none this
    // server-run (e.g. the agent was already idle before the last restart) —
    // the start of its current alive run. aliveSince comes from the canonical
    // runtime evidence and is not bumped by passive roster/status reads, so it
    // is a true floor for "has done nothing".
    // Without this, every deploy would leave pre-existing idle agents
    // permanently un-hibernatable (no lastActive → skipped forever).
    const lastActive = _lastActivityAt.get(agentId) || aliveSince
    const idleMs = Math.min(now - lastActive, now - aliveSince)
    result[agentId] = Math.floor(idleMs / 1000)
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
  const withCapabilities = agentWithDaemonCapabilities(agent)
  if (_thinkingState.has(agent.id)) return { ...withCapabilities, status: 'thinking' }
  if (_compactingState.has(agent.id)) return { ...withCapabilities, status: 'compacting' }
  return withCapabilities
}

// async because building the delta reads each changed agent through the store.
// The debounce below keeps one run in flight at a time — see the note there.
async function _broadcastStateNow() {
  if (!fleetStore) return
  const pendingIds = [..._pendingBroadcastAgentIds]
  _pendingBroadcastAgentIds.clear()

  const changed = []
  const removed = []
  for (const id of pendingIds) {
    const a = _agentWithEphemeralState(await fleetStore.getAgent(id))
    if (!a) {
      if (_lastAgentJson.has(id)) {
        _lastAgentJson.delete(id)
        removed.push(id)
      }
      continue
    }
    const runtime = a.runtime_status || null
    const generation = runtime?.evidence?.liveness_generation || null
    const json = JSON.stringify(a)
    const changedRowBuilt = _lastAgentJson.get(a.id) !== json
    if (changedRowBuilt) {
      changed.push(a)
      _lastAgentJson.set(a.id, json)
    }
    if (generation) recordLivenessProjection(agentLivenessTrace, {
      agentId: id,
      generation,
      runtime,
      changedRowBuilt,
    })
  }

  broadcastFleet({
    event: 'agents-delta',
    data: {
      changed,
      removed,
      // Footer totals cover the full non-dead roster, not only the bounded
      // client page receiving this delta.
      ...(pendingIds.length ? { agentTotals: await fleetStore.getAliveAgentCounts(rosterCountInputs()) } : {}),
      task_delta: await fleetStore.consumeTaskChanges?.() || { changed: [], removed: [], overflow: false },
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
  // The timer handle is cleared only AFTER the run settles, not before it
  // starts. _broadcastStateNow is async now, and it drains the pending set at
  // the top but writes _lastAgentJson after its awaits — so two overlapping
  // runs would compare against a half-updated map and re-broadcast rows that
  // had not changed. Same interleaving the outbox flush had to be chained
  // against; here holding the handle is enough, because the handle IS the
  // "one in flight" flag.
  //
  // Anything queued while a run was in flight would otherwise sit there until
  // the next unrelated call, so the drain re-arms itself if the set refilled.
  _broadcastTimer = setTimeout(() => {
    _broadcastStateNow()
      .catch(e => console.error(`[broadcast] state broadcast failed: ${e?.message || e}`))
      .finally(() => {
        _broadcastTimer = null
        if (_pendingBroadcastAgentIds.size) broadcastState()
      })
  }, 50)
}

function mintFleetId() {
  return `fleet:${randomUUID().slice(0, 8)}`
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
      liveMatches: await fleetStore.getLiveAgentsByFriendlyName(name),
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

function deliverSpawnMailboxCompletion(entry, status, detail) {
  if (entry.kind !== 'spawn') return
  const label = detail.label || entry.meta?.name || detail.agentId || entry.meta?.agentId || 'mint'
  Promise.resolve(fleetStore?.share?.({
    type: 'spawn_mailbox',
    from: 'fleet:tlda',
    text: `spawn mailbox ${status}: ${label}`,
    unread: false,
    agentId: detail.agentId || entry.meta?.agentId || null,
    metadata: {
      type: 'mailbox_complete',
      mailbox_id: entry.id,
      mailbox_kind: entry.kind,
      owner_id: entry.ownerId,
      label,
      status,
      ...detail,
    },
  })).catch(e => console.error(`[spawn-mailbox] failed to record ${entry.id}: ${e.message}`))
}

function isIndeterminateSpawnOutcome(value) {
  const reason = value?.reason || value?.code
  const message = value?.error || value?.message || String(value || '')
  return reason === 'indeterminate-after-restart'
    || /outcome is indeterminate after process restart/i.test(message)
}

function settleSpawnMailboxIndeterminate(mailbox, detail) {
  const error = detail.error || 'spawn outcome is indeterminate after daemon restart'
  const settled = mailboxLibrarian.indeterminate(mailbox.id, error, {
    reason: 'indeterminate-after-restart',
    ...detail,
    error,
  })
  if (settled) deliverSpawnMailboxCompletion(settled, 'indeterminate', {
    reason: 'indeterminate-after-restart',
    ...detail,
    error,
  })
}

async function performSpawnRelay(caller, msg) {
  if (!caller?.id) throw new Error('spawn caller identity is required')
  const {
    name, agent, model, doc, cwd, respawn, fresh, refresh, effort, mode,
    permissionRequest, enroll, routeAgent,
    iLikeToLiveDangerously, mailboxTarget, modelOptions,
    pretty_name: requestedPrettyName,
  } = normalizeSpawnRelayInput(msg)
  if (refresh) {
    throw new Error('refresh is disabled through MCP spawn; recover the original resume handle before respawning')
  }
  const shouldRespawn = !!respawn || (!fresh && !refresh && !!agent)
  let spawnName = fresh ? name : (agent || name)
  let refreshTarget = null
  let routeTarget = null
  if ((shouldRespawn || refresh) && agent) {
    const existing = await fleetStore?.findAgent(agent)
    routeTarget = existing || null
    // Carry the fleet-id (not the friendly name) so the wake targets that exact
    // identity's session — fleet-spawn re-resolves a name to the wrong namesake,
    // but resumes a `fleet:` id directly. findAgent is now liveness-aware, so it
    // already picked the live holder; pass that choice through, don't re-grep.
    spawnName = existing?.id || agent
    if (refresh) refreshTarget = existing
  }
  if (fresh && routeAgent) {
    routeTarget = await fleetStore?.findAgent(routeAgent) || null
    if (!routeTarget) throw new Error(`spawn route anchor not found: ${routeAgent}`)
  }
  if (!spawnName) throw new Error(fresh ? 'fresh spawn requires name' : 'agent name required')
  if (refresh && !refreshTarget) refreshTarget = await fleetStore?.findAgent(spawnName)
  if ((shouldRespawn || refresh) && !routeTarget) routeTarget = await fleetStore?.findAgent(spawnName) || null
  if ((shouldRespawn || refresh) && !routeTarget) throw new Error(`spawn target not found: ${spawnName}`)
  const requestedSpec = { model, project: doc }
  const route = await resolveSpawnMachine({
    caller,
    targetAgent: routeTarget,
    fresh: !!fresh,
    respawn: shouldRespawn && !refresh,
    refresh: !!refresh,
    fleetStore,
    daemonConnections,
    onDaemonMissing: (machineId, context, detail) => logSpawnDaemonMiss(machineId, context, detail),
  })
  const machineId = route.machine_id
  const resolved = resolveSpawnTarget
    ? await resolveSpawnTarget(spawnName, shouldRespawn && !refresh, {
        fresh: !!fresh,
        requested: requestedSpec,
      })
    : { name: spawnName, respawn: shouldRespawn && !refresh }
  const pendingAgentId = (!resolved.respawn && !refresh) ? mintFleetId() : null
  const targetAgentId = pendingAgentId || routeTarget?.id || (resolved.name?.startsWith?.('fleet:') ? resolved.name : null)
  const mailbox = mailboxLibrarian.start({
    kind: 'spawn',
    ownerId: caller.id,
    timeoutMs: Number(process.env.TLDA_SPAWN_MAILBOX_DEADLINE_MS || 5 * 60_000),
    meta: {
      name: spawnName,
      agentId: targetAgentId,
      machineId,
      fresh: !!fresh,
      respawn: refresh ? false : resolved.respawn,
      refresh: !!refresh,
    },
  })
  const readiness = pendingAgentId
    ? spawnLibrarian.awaitLogin({ id: pendingAgentId, name: spawnName, spec: requestedSpec })
    : null
  let reservedFriendlyName = null
  if (pendingAgentId) {
    const now = new Date().toISOString()
    const assignedName = await fleetStore.allocateFreshFriendlyName(spawnName, { excludeId: pendingAgentId })
    reservedFriendlyName = assignedName
    await fleetStore.upsertAgent({
      id: pendingAgentId,
      friendly_name: assignedName,
      pretty_name: requestedPrettyName ?? null,
      labels: [],
      registered_at: now,
      last_seen: now,
      dead: false,
      human: false,
      metadata: { shell: true },
    })
    await fleetStore.setAgentDaemonRoute(pendingAgentId, daemonAddress(route.machine_id, route.env_name))
  }
  const spawnRequest = {
    agent_id: targetAgentId,
    friendly_name: reservedFriendlyName || undefined,
    pretty_name: pendingAgentId ? (requestedPrettyName ?? undefined) : undefined,
    name: resolved.name || undefined,
    model: model || undefined,
    modelOptions,
    doc: doc || undefined,
    cwd: cwd || undefined,
    enroll: !!enroll || undefined,
    effort: effort || undefined,
    mode: mode || undefined,
    permissionRequest: permissionRequest || undefined,
    acknowledgeNoSecurity: !!iLikeToLiveDangerously,
    requester: {
      id: caller.id,
      name: caller.friendly_name || caller.name || undefined,
      human: !!caller.human,
      permissionGrant: caller.metadata?.permissionGrant || undefined,
      daemonId: caller.daemon_key || caller.metadata?.daemon_key || undefined,
    },
    spawnRoute: route.source,
    daemon_env_name: route.env_name,
    respawn: refresh ? false : resolved.respawn,
    refresh: !!refresh,
  }
  void (async () => {
    try {
      let result
      try {
        const operation = pendingAgentId ? 'mint' : (resolved.respawn ? 'wake' : 'spawn')
        result = await sendDaemonDurable(machineId, operation, spawnRequest)
        if (isIndeterminateSpawnOutcome(result)) {
          result = {
            ok: false,
            reason: 'indeterminate-after-restart',
            error: result.error || 'previous daemon RPC execution outcome is indeterminate after process restart; operation was not replayed',
          }
        }
        if (pendingAgentId && result?.ok === false) {
          if (!isIndeterminateSpawnOutcome(result)) {
            spawnLibrarian.failPending(pendingAgentId, result.code || result.reason || 'launch-failed')
          }
        }
      } catch (e) {
        // A transport error is not a launch failure. The daemon may still be
        // running rpcMint; nothing rejected this spawn, we just stopped hearing
        // about it. Treat it as still-in-flight and let the late-login path
        // settle it.
        //
        // This tested `/RPC timeout .*op=spawn/`, which could never match: the
        // op above is 'mint' whenever pendingAgentId is set, and 'spawn' only
        // when it is not -- so the two halves of the condition were mutually
        // exclusive and this branch never ran once. Every RPC timeout on the
        // spawn path therefore reported `spawn mailbox failed` while the agent
        // was still coming up, which is the false-failure run recorded in
        // AGENTS.md ("seven times in one evening for agents that were alive and
        // working"). Matching the op name by prose is what made it silently
        // dead; isTransientRpcError is the predicate this file already uses for
        // "no verdict came back".
        if (pendingAgentId && isTransientRpcError(e)) {
          result = { ok: false, reason: 'spawning' }
        } else if (isIndeterminateSpawnOutcome(e)) {
          result = {
            ok: false,
            reason: 'indeterminate-after-restart',
            error: e.message || 'previous daemon RPC execution outcome is indeterminate after process restart; operation was not replayed',
          }
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
        const shell = await fleetStore?.getAgent?.(pendingAgentId)
        if (shell?.metadata?.shell) {
          result = { ok: true, pending: true, agent: shell }
        }
      }
      if (isIndeterminateSpawnOutcome(result)) {
        if (pendingAgentId && readiness) {
          result = { ok: true, pending: true, reason: 'indeterminate-after-restart' }
        } else {
          settleSpawnMailboxIndeterminate(mailbox, {
            label: spawnName,
            agentId: targetAgentId,
            machineId,
            error: result.error || 'previous daemon RPC execution outcome is indeterminate after process restart; operation was not replayed',
          })
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
      let agentRecord = ready?.agent || result?.agent || (result?.agent_id ? await fleetStore.findAgent(result.agent_id) : null) || (targetAgentId ? await fleetStore.findAgent(targetAgentId) : null)
      // Runtime route authority is the durable agent-daemon route path. Do not
      // patch legacy route columns from the spawn result; doing so lets generic
      // spawn completion bypass the daemon-route binding.
      const registeredPolicy = agentRecord?.metadata?.permissionGrant
      const permissionGrant = result?.permissionGrant || registeredPolicy
      const assignedName = agentRecord?.friendly_name || result?.assigned_name || result?.name || spawnName
      const requestedName = result?.requested_name || spawnName
      const completion = {
        ...result,
        agentId: agentRecord?.id || result?.agent_id || targetAgentId || null,
        label: assignedName,
        assigned_name: assignedName,
        requested_name: requestedName,
        name_changed: result?.name_changed ?? (assignedName !== requestedName),
        permissionGrant,
        spawnerPermission: result?.spawnerPermission,
        projectPermission: result?.projectPermission,
        modelPermission: result?.modelPermission,
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
  await fleetStore.upsertAgent({
    id: SERVER_OWNER_ID,
    friendly_name: SERVER_OWNER_NAME,
    human: true,
    dead: false,
    labels: [],
    registered_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  })
  await fleetStore.recordRuntimeState(
    SERVER_OWNER_ID,
    { kind: RUNTIME_KIND.HUMAN, status: RUNTIME_STATUS.AWAY },
  )
  const configuredSpawnMachine = process.env.TLDA_SPAWN_MACHINE_ID || readDaemonConfig().spawnMachineId
  if (configuredSpawnMachine && !await fleetStore.getFleetPref(SERVER_OWNER_ID, SPAWN_MACHINE_PREF_KEY)) {
    await fleetStore.setFleetPref(SERVER_OWNER_ID, SPAWN_MACHINE_PREF_KEY, configuredSpawnMachine)
    console.log(`[spawn-route] configured ${SERVER_OWNER_ID} ${SPAWN_MACHINE_PREF_KEY}=${configuredSpawnMachine}`)
  }
}

// Full chat delivery pipeline used by tlda-feedback (push-channel
// notifications for doc annotations). The store write owns unread creation and
// live broadcast; hand-built echoes drift from the inserted row.
// The subscriptions table is the record of who monitors which doc; tlda-feedback
// reads it rather than keeping a second copy, and arms the room listeners for
// every persisted row at startup.
async function configureTldaFeedback() {
  tldaFeedback.configure({
    listDocSubscriptions: async () => (await fleetStore?.getSubscriptionsByAdapter?.('document_monitor') || [])
      .map(row => {
        const match = String(row.query || '').match(/^doc:([^\s]+)$/i)
        return match ? { owner: row.owner, doc: match[1] } : null
      })
      .filter(Boolean),
    deliverChat: deliverTldaFeedbackChat,
  })
  await tldaFeedback.armPersisted()
}

function deliverTldaFeedbackChat({ from, to, text, metadata }) {
  if (!fleetStore) return
  Promise.resolve(fleetStore.share?.({ type: 'chat', from, to, text, metadata }))
    .catch(e => console.error(`[fleet-feedback] delivery failed: ${e.message}`))
}

await configureTldaFeedback()

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
  return event
}

async function reportFleetIncidentClear({ key, agent, health, incident }) {
  if (!fleetStore || !key) return null
  const text = [
    `**Fleet incident cleared: activity-health/${incident?.boundary || health?.boundary || 'unknown'}**`,
    '',
    `Agent: \`${agent?.friendly_name || agent?.id || 'unknown'}\``,
    `Recovered at: \`${formatDisplayTimestamp(health?.ts || Date.now())}\``,
    '',
    '```json',
    JSON.stringify(compactObject({
      key,
      previous: incident || null,
      recovery: health || null,
    }), null, 2).slice(0, 3000),
    '```',
  ].join('\n')
  const event = await fleetStore.chat('fleet:tlda', SERVER_OWNER_ID, text, {
    type: 'fleet_incident_clear',
    component: 'activity-health',
    operation: incident?.boundary || health?.boundary || 'unknown',
    key,
    agent_id: agent?.id || null,
    cleared_at: health?.ts || new Date().toISOString(),
    previous_event_id: incident?.eventId || null,
  })
  return event
}

async function reconcileActivityHealthIncident(agent, health) {
  if (!fleetStore || !agent || !health) return agent
  const fresh = await fleetStore.getAgent?.(agent.id) || agent
  const metadata = fresh.metadata || {}
  const incidents = { ...(metadata.activityHealthIncidents || {}) }
  const now = new Date()
  const decision = activityHealthIncidentDecision(incidents, agent, health)

  if (isActivityHealthOk(health)) {
    let updatedAgent = fresh
    for (const key of decision.clearKeys) {
      const incident = incidents[key]
      incidents[key] = { ...incident, clearedAt: health.ts || now.toISOString(), clearBoundary: health.boundary || null }
      updatedAgent = await fleetStore.updateAgentActivityHealthIncidents?.(agent.id, incidents) || updatedAgent
      await reportFleetIncidentClear({ key, agent, health, incident })
    }
    return updatedAgent
  } else {
    const key = activityHealthKey(agent.id, health.boundary)
    if (decision.raise) {
      incidents[key] = {
        key,
        eventId: null,
        boundary: health.boundary || null,
        state: health.state || null,
        raisedAt: health.ts || now.toISOString(),
        clearedAt: null,
        pending: true,
      }
      let updatedAgent = await fleetStore.updateAgentActivityHealthIncidents?.(agent.id, incidents) || fresh
      const payload = activityHealthIncidentPayload(agent, health, now)
      const event = await reportFleetIncident(payload)
      const latest = await fleetStore.getAgent?.(agent.id) || updatedAgent
      const latestIncidents = { ...(latest.metadata?.activityHealthIncidents || {}) }
      if (latestIncidents[key] && !latestIncidents[key].clearedAt) {
        latestIncidents[key] = {
          ...latestIncidents[key],
          eventId: event?.id || null,
          pending: false,
        }
        updatedAgent = await fleetStore.updateAgentActivityHealthIncidents?.(agent.id, latestIncidents) || updatedAgent
      }
      return updatedAgent
    }
  }

  return fresh
}

async function updateAgentActivityHealth(agentId, patch) {
  if (!fleetStore || !agentId) return null
  const existing = await fleetStore.getAgent?.(agentId)
  if (!existing) return null
  const previousHealth = existing.metadata?.activityHealth || null
  const health = normalizeActivityHealth({
    state: patch.state,
    boundary: patch.boundary,
    reason: patch.reason,
    ts: patch.ts,
    lastKnownGoodAt: patch.lastKnownGoodAt || previousHealth?.lastKnownGoodAt || null,
    lastActivityAt: patch.lastActivityAt || previousHealth?.lastActivityAt || null,
  })
  const updated = (await fleetStore.updateAgentActivityHealth(agentId, health))?.agent || await fleetStore.getAgent(agentId)
  const withIncidentState = await reconcileActivityHealthIncident(updated, health)
  broadcastState(withIncidentState?.id || agentId)
  return withIncidentState
}

async function updateDaemonActivityTransportHealth(daemonKey, patch) {
  if (!fleetStore || !daemonKey) return
  const agents = await fleetStore.getAgentsByDaemonKey?.(daemonKey) || []
  for (const agent of agents) {
    await updateAgentActivityHealth(agent.id, patch)
  }
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

// Tell browsers to refresh their project list when project state changes.
onGlobalEvent(async (event) => {
  if (event?.type === 'project-changed') {
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
      const existing = await fleetStore.findAgent(qaName)
      if (!existing || existing.dead) {
        const machineIds = [...daemonConnections.keys()]
        if (machineIds.length > 0) {
          const taskDesc = `Watch the ${docName} writing project. Read the qa-writing-watch skill for your full spec.`
          sendDaemonDurable(machineIds[0], 'spawn', { name: qaName, fresh: !existing })
            .then(async () => {
              const agent = await fleetStore.findAgent(qaName)
              if (agent) {
                const taskId = `qa-task-${docName}-${Date.now()}`
                await fleetStore.delegate('fleet:tlda', agent.id, taskId, taskDesc, { type: 'qa_watch', project: docName })
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
    const subs = new Set(await tldaFeedback.subscribers(docName))
    if (editedBy) subs.add(editedBy)

    for (const agentId of subs) {
      await fleetStore.chat('fleet:tlda', agentId, text, metadata)
    }
  }
  if (event?.type === 'scratch-build-failed' && fleetStore && event.agentId) {
    const { doc, agentId, label, errors = [] } = event
    const errorList = errors.map(e => `  • ${e}`).join('\n')
    const text = `**Scratch build failed** — \`${label}\` in ${doc}\n\n${errorList}`
    await fleetStore.chat('fleet:tlda', agentId, text, { type: 'scratch_build_failed', doc, label })
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

async function agentRouteOrError(agent) {
  const seat = agent?.id ? await fleetStore?.getAgentDaemonRoute?.(agent.id) : null
  if (!seat) return { error: 'agent has no daemon route' }
  return { seat }
}

function terminalRpcPayload(agent, seat, extra = {}) {
  return {
    agent_id: agent?.id,
    ...extra,
  }
}

const PROTECTED_AGENT_EDIT_FIELDS = new Set([
  'agent_id',
  'kind',
  'model',
  'cwd',
  'machine_id',
  'env_name',
  'daemon_key',
])

function protectedAgentEditFields(agentData = {}) {
  return Object.keys(agentData).filter(key => PROTECTED_AGENT_EDIT_FIELDS.has(key))
}

async function patchEventMetadata(eventId, updater, { broadcast = true } = {}) {
  const event = await fleetStore.getEventById?.(eventId)
  if (!event) return null
  const current = event.metadata || {}
  const next = updater(current)
  // Replace, not patch: the updater was handed the current metadata and
  // returns what it wants stored, so a key it dropped must stay dropped.
  await fleetStore.replaceEventMetadata(eventId, next)
  if (broadcast) broadcastEvent('event-update', { id: eventId, metadata_patch: next })
  return next
}

async function patchRecipientAttachmentState(eventId, recipientId, attachmentId, record) {
  return patchEventMetadata(eventId, metadata => (
    setRecipientAttachmentState(metadata, recipientId, attachmentId, record)
  ))
}

function finalizeRecipientPlaceholderPaths(metadata = {}, { recipientId, eventId, sourceAgent, timestamp, attachments }) {
  let next = metadata
  for (const attachment of attachments || []) {
    const ref = next?.recipient_refs?.[recipientId]?.attachments?.[String(attachment.id)]
    if (ref?.state !== 'pending') continue
    next = setRecipientAttachmentState(next, recipientId, attachment.id, {
      ...ref,
      placeholderPath: buildInboxRefPath({
        sourceAgent: sourceAgent || 'unknown',
        date: timestamp,
        eventId,
        name: attachment.name,
      }),
      provenance: {
        ...(ref.provenance || {}),
        eventId,
      },
    })
  }
  return next
}

function placeholderSeenByRecipient(metadata = {}, recipientId, attachmentId) {
  const recipient = metadata?.recipient_refs?.[recipientId]
  const seen = new Set((recipient?.placeholder_seen_attachment_ids || []).map(String))
  return seen.has(String(attachmentId))
}

function placeholderSupersededForRecipient(metadata = {}, recipientId, attachmentId) {
  const recipient = metadata?.recipient_refs?.[recipientId]
  const superseded = new Set((recipient?.placeholder_superseded_attachment_ids || []).map(String))
  return superseded.has(String(attachmentId))
}

function markPlaceholderSuperseded(metadata = {}, recipientId, attachmentId, { now = new Date().toISOString() } = {}) {
  const next = { ...(metadata || {}) }
  const refs = next.recipient_refs && typeof next.recipient_refs === 'object' ? next.recipient_refs : {}
  const currentRecipient = refs[recipientId] || {}
  const superseded = new Set((currentRecipient.placeholder_superseded_attachment_ids || []).map(String))
  superseded.add(String(attachmentId))
  next.recipient_refs = {
    ...refs,
    [recipientId]: {
      ...currentRecipient,
      placeholder_superseded_at: now,
      placeholder_superseded_attachment_ids: Array.from(superseded),
    },
  }
  return next
}

async function insertMaterializationAmend({ eventId, metadata }) {
  const original = await fleetStore.getEventById?.(eventId)
  if (!original || original.type !== 'chat') return null
  const ts = new Date().toISOString()
  const meta = { ...(metadata || {}), amends: original.id }
  const inserted = await measureHotOp('materialization amend event insert', `event=${eventId} to=${original.to}`, () => fleetStore.insertEventRecord({
    type: 'amend',
    timestamp: ts,
    from: original.from,
    to: original.to,
    text: original.text,
    metadata: meta,
    unread: false,
  }, { notify: false }))
  const amendId = Number(inserted.id)
  broadcastEvent('fleet-event', {
    id: amendId,
    type: 'amend',
    timestamp: ts,
    from_id: original.from,
    to_id: original.to,
    text: original.text,
    metadata: meta,
  })
  return amendId
}

async function replaceMaterializedPlaceholder({ eventId, recipientId, attachment, metadata }) {
  if (placeholderSupersededForRecipient(metadata, recipientId, attachment.id)) return
  const finalMetadata = await patchEventMetadata(eventId, current => (
    markPlaceholderSuperseded(current, recipientId, attachment.id)
  ))
  await insertMaterializationAmend({ eventId, metadata: finalMetadata || metadata })
  if (!placeholderSeenByRecipient(metadata, recipientId, attachment.id)) return
  const ref = finalMetadata?.recipient_refs?.[recipientId]?.attachments?.[String(attachment.id)]
  const label = ref ? pendingAttachmentPlaceholder(ref, attachment).replace(/\*$/, '') : (attachment.name || `attachment ${attachment.id}`)
  deliverTldaFeedbackChat({
    from: 'tlda-materializer',
    to: recipientId,
    text: `Reference materialized for message ${eventId}: ${label}`,
    metadata: {
      source: 'materialization',
      source_event_id: eventId,
      attachment_id: String(attachment.id),
      state: 'available',
    },
  })
}

function notifyRecipientMaterializationFailures({ eventId, recipientId, failures }) {
  const text = formatMaterializationFailureNotification({ eventId, failures })
  if (!recipientId || !eventId || !text) return
  deliverTldaFeedbackChat({
    from: 'tlda-materializer',
    to: recipientId,
    text,
    metadata: {
      source: 'materialization',
      source_event_id: eventId,
      attachment_id: null,
      failed_attachment_ids: failures.map(({ attachment }) => String(attachment.id)),
      state: 'failed',
      priority: 'important',
    },
  })
}

async function materializeRecipientAttachment({ eventId, recipientId, sourceAgent, attachment }) {
  const recipient = await fleetStore.getAgent?.(recipientId)
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
      daemonMaterializationError: error,
      updated_at: new Date().toISOString(),
    }
    patchRecipientAttachmentState(eventId, recipientId, attachment.id, record)
    return { attachment, record }
  }
  const current = await agentRouteOrError(recipient, { requireTerminal: false })
  if (current.error) {
    return fail(`${current.error} (op=materialize-attachment)`)
  }
  try {
    const result = await sendDaemonDurable(current.seat.daemon_key, 'materialize-attachment', {
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
    const record = {
      kind: 'attachment',
      state: 'available',
      status: 'ready',
      title: attachment.name || null,
      localPath: result.localPath || result.path,
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
    const updatedMetadata = patchRecipientAttachmentState(eventId, recipientId, attachment.id, record)
    await replaceMaterializedPlaceholder({ eventId, recipientId, attachment, metadata: updatedMetadata })
    return null
  } catch (e) {
    return fail(e.message || String(e))
  }
}

function queueRecipientMaterialization({ eventId, recipientId, sourceAgent, attachments }) {
  const materializable = (attachments || []).filter(isMaterializableAttachment)
  if (materializable.length === 0) return
  setImmediate(() => {
    Promise.all(materializable.map(attachment => (
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
          return { attachment, record }
        })
    ))).then(results => {
      const failures = results.filter(Boolean)
      notifyRecipientMaterializationFailures({ eventId, recipientId, failures })
    }).catch(e => {
      console.error(`[materialization] batch notification failed for message ${eventId}: ${e.message}`)
    })
  })
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
app.get('/health', async (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), pid: process.pid })
})

app.get('/api/build-info', async (_req, res) => {
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

// The deepgram bridge. Browser hits this when voice=deepgram is selected.
// Deepgram is SDK-only (one implementation, Skip 6/19) — bin/deepgram-runtime/deepgram-sdk-bridge.mjs.
//
// TLDA_VOICE_BRIDGE_URL names a bridge running on its OWN machine — the tlda-voice
// Fly box, reached over Fly's private network at ws://tlda-voice.internal:8180.
// When it is set, the bridge is not ours to manage: we never spawn it and never
// kill it, because it belongs to a machine this process does not own. We reach it
// or we say we could not. That is the same rule the app already lives by for a
// daemon on another machine (AGENTS.md, "Multi-Machine Architecture").
//
// When it is unset the bridge is local to this machine and this process starts it
// on demand, which is correct where one machine runs the whole stack. The bridge
// listens on TLS (wss) only when the mkcert localhost certs exist — the SAME
// condition the bridge uses to choose its server — so the scheme is matched here.
// Two knobs, because two different processes reach the bridge by two routes:
//   TLDA_VOICE_BRIDGE_URL  — how THIS SERVER reaches it (Fly 6PN,
//                            ws://tlda-voice.internal:8180), used by the proxy.
//   TLDA_VOICE_DIRECT_URL  — how THE BROWSER reaches it (the tailnet name,
//                            wss://tlda-voice.<tailnet>.ts.net), handed to the
//                            client so its audio socket does not terminate on
//                            this machine and therefore does not die when this
//                            machine is deployed.
// Unset TLDA_VOICE_DIRECT_URL and the browser keeps using the same-origin proxy
// exactly as it does today, which is what makes a revert a config flip.
const REMOTE_VOICE_BRIDGE_URL = process.env.TLDA_VOICE_BRIDGE_URL || ''
const BROWSER_VOICE_BRIDGE_URL = process.env.TLDA_VOICE_DIRECT_URL || ''
const _dgCert = path.join(homedir(), '.config/tlda/localhost+2.pem')
const _dgKey = path.join(homedir(), '.config/tlda/localhost+2-key.pem')
const _dgWsScheme = existsSync(_dgCert) && existsSync(_dgKey) ? 'wss' : 'ws'
const DEEPGRAM_SDK_BRIDGE_URL = REMOTE_VOICE_BRIDGE_URL || `${_dgWsScheme}://127.0.0.1:8180`
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
  return !!process.env.DEEPGRAM_API_KEY
}

app.get('/api/voice/backends', async (req, res) => {
  try {
    const backends = [
      { value: '', label: 'Off', available: true },
      { value: 'chrome', label: 'Browser', available: true },
    ]
    // Offer Deepgram when the BRIDGE is actually reachable, the same way Whisper
    // is decided one line below. It used to be decided by DEEPGRAM_API_KEY on
    // this server — a key this server stops using once the bridge lives on its
    // own machine, so that check would have kept passing only by accident of a
    // stale secret, and tidying that secret away would have silently removed
    // Deepgram from Skip's picker with no other symptom.
    const deepgramReachable = REMOTE_VOICE_BRIDGE_URL
      ? await isBridgeUp(DEEPGRAM_SDK_BRIDGE_URL)
      : hasDeepgramKey()
    if (deepgramReachable) backends.push({ value: 'deepgram-sdk', label: 'Deepgram', available: true })
    if (await isBridgeUp(WHISPER_BRIDGE_URL)) backends.push({ value: 'whisper', label: 'Whisper', available: true })
    res.json({ backends })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

async function spawnVoiceBridge({ bridgeUrl, scriptName, logName, label, nice = null }) {
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
  if (Number.isFinite(nice)) {
    const { execFile } = await import('child_process')
    execFile('renice', ['-n', String(nice), '-p', String(child.pid)], { timeout: 3000 }, (err) => {
      if (err) console.warn(`[voice] ${label} bridge priority request failed: ${err.message}`)
    })
  }
  const priorityLabel = Number.isFinite(nice) ? ` nice=${nice}` : ''
  console.log(`[voice] ${label} bridge spawned (pid ${child.pid}${priorityLabel})`)
  return { ok: true, started: true, pid: child.pid, nice: Number.isFinite(nice) ? nice : undefined }
}

app.post('/api/voice/deepgram-sdk/start', async (req, res) => {
  try {
    // A remote bridge is always-on and not ours to start. Answer with whether it
    // is actually reachable rather than reporting a start we did not perform.
    if (REMOTE_VOICE_BRIDGE_URL) {
      const up = await isBridgeUp(DEEPGRAM_SDK_BRIDGE_URL)
      if (!up) console.error(`[voice] deepgram bridge unreachable at ${REMOTE_VOICE_BRIDGE_URL}`)
      return res.status(up ? 200 : 503).json({
        ok: up,
        started: false,
        remote: REMOTE_VOICE_BRIDGE_URL,
        directUrl: BROWSER_VOICE_BRIDGE_URL,
        ...(up ? {} : { error: 'deepgram bridge unreachable' }),
      })
    }
    res.json({
      ...(await spawnVoiceBridge({
        bridgeUrl: DEEPGRAM_SDK_BRIDGE_URL,
        scriptName: 'deepgram-runtime/deepgram-sdk-bridge.mjs',
        logName: 'deepgram-sdk-bridge.log',
        label: 'deepgram sdk',
        nice: -10,
      })),
      directUrl: BROWSER_VOICE_BRIDGE_URL,
    })
  } catch (err) {
    console.error('[voice] deepgram-sdk/start failed:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/voice/deepgram-sdk/stop', async (req, res) => {
  try {
    // Never kill a remote bridge. It is a shared always-on service on another
    // machine; one tab turning voice off must not take it away from everyone. The
    // client already ends its own upstream session by closing this socket, which
    // is what the bridge's `stop` handling acts on.
    if (REMOTE_VOICE_BRIDGE_URL) {
      return res.json({ ok: true, stopped: false, remote: REMOTE_VOICE_BRIDGE_URL })
    }
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
  // A remote bridge lives on a machine this process does not own, so there is
  // nothing here to spawn and nothing to substitute. Report the failure and let
  // the caller surface it — quietly switching Skip to another backend mid-sentence
  // is exactly what voice being explicitly opt-in exists to prevent.
  if (REMOTE_VOICE_BRIDGE_URL) {
    console.error(`[voice] deepgram bridge unreachable at ${REMOTE_VOICE_BRIDGE_URL}`)
    return false
  }
  if (!_deepgramSdkBridgeStarting) {
    _deepgramSdkBridgeStarting = (async () => {
      await spawnVoiceBridge({
        bridgeUrl: DEEPGRAM_SDK_BRIDGE_URL,
        scriptName: 'deepgram-runtime/deepgram-sdk-bridge.mjs',
        logName: 'deepgram-sdk-bridge.log',
        label: 'deepgram sdk',
        nice: -10,
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
  const services = {
    tlda: { ok: true, uptime: process.uptime() },
    fleet: { ok: true, agents: (await fleetStore.getAgentSummary())?.live ?? 0 },
    sync: { ok: true },
  }

  res.json(services)
})

// Cookie login — set token as cookie, redirect to viewer
app.get('/auth/login', loginRoute)

// Auth level — tells the client what its token allows
app.get('/api/auth/me', async (req, res) => {
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

app.post('/api/log', async (req, res) => {
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

// Is the filter path running at all? Answers the question a silent comparator
// cannot: subscriptions 0 means no client is asking; eventsSeen 0 means no
// event reached the push; deliveries 0 with subscriptions > 0 means nothing
// matched. Silence in the comparator is only evidence of agreement when these
// are non-zero.
app.get('/api/diagnostics/filter-subscriptions', requireRead, async (req, res) => {
  res.json({
    ...filterSubscriptions.stats(),
    ...filterPushCounters,
    // Read these before reading any zero above.
    startedAt: filterPushStartedAt,
    uptimeMs: Date.now() - Date.parse(filterPushStartedAt),
    rosterSize: (await fleetStore?.getAgentSummary?.() || {}).total || 0,
  })
})

app.get('/api/diagnostics/live-perf', requireRead, async (req, res) => {
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
      lagProfiler: lagProfiler.snapshot(),
    },
    activityDelivery: activityDeliverySnapshot(),
  })
})

app.get('/api/diagnostics/agent-liveness-trace', requireRead, async (req, res) => {
  const agent = typeof req.query.agent === 'string' && req.query.agent ? req.query.agent : null
  if (!agent) return res.status(400).json({ error: 'agent query parameter is required' })
  const limitRaw = Number(req.query.limit || 200)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.trunc(limitRaw))) : 200
  res.json(agentLivenessTraceResponse(agentLivenessTrace, { agent, limit }))
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

app.get('/api/diagnostics/telemetry-status', requireRead, async (req, res) => {
  res.json(telemetryStatusSnapshotFromLiveBuffers())
})

app.get('/api/diagnostics/telemetry-status.md', requireRead, async (req, res) => {
  res.type('text/markdown').send(renderTelemetryStatusMarkdown(telemetryStatusSnapshotFromLiveBuffers()))
})

app.get('/api/diagnostics/voice-pipeline', requireRead, async (req, res) => {
  res.json(buildVoicePipelineSnapshot({ livePerfSamples }))
})

app.get('/api/diagnostics/control-plane-traces', requireRead, async (req, res) => {
  const traceId = typeof req.query.trace_id === 'string' && req.query.trace_id ? req.query.trace_id : null
  const limitRaw = Number(req.query.limit || 50)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(250, Math.trunc(limitRaw))) : 50
  res.json(controlPlaneTraces.snapshot({ traceId, limit }))
})

app.get('/api/diagnostics/control-plane-traces.md', requireRead, async (req, res) => {
  const traceId = typeof req.query.trace_id === 'string' && req.query.trace_id ? req.query.trace_id : null
  const limitRaw = Number(req.query.limit || 50)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(250, Math.trunc(limitRaw))) : 50
  res.type('text/markdown').send(renderControlPlaneTraceMarkdown(controlPlaneTraces.snapshot({ traceId, limit })))
})

app.post('/api/client-profile', async (req, res) => {
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

app.get('/api/reaper/status', requireRead, async (req, res) => {
  res.json(_lastReaperStatus || { error: 'no data yet' })
})

app.get('/api/reaper/report.md', requireRead, async (req, res) => {
  const report = _lastReaperStatus?.markdownReport || '## Dev Reaper\n\nNo reaper status is available yet.'
  res.type('text/markdown').send(report)
})

// Sanitized provider/account usage status for the usage-meter shape. Same data
// as the `usage_status` MCP tool — manual/static config only, no scraping, no
// tokens. The shape polls this; missing config returns an empty accounts list.
app.get('/api/playback/stream', requireRead, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('data: {"type":"connected"}\n\n')
  const keepalive = setInterval(() => res.write(':\n\n'), 15000)
  req.on('close', () => clearInterval(keepalive))
})

app.get('/api/fleet/viewing', requireRead, async (req, res) => {
  const userId = req.query.user
  if (userId) {
    let ctx = _viewingContext.get(userId)
    if (!ctx && fleetStore) {
      const agent = await fleetStore.findAgent(userId)
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

async function resolveSpawnModelContext({ doc, cwd } = {}) {
  const directCwd = queryString(cwd)
  if (directCwd) return { doc: queryString(doc), cwd: directCwd, error: null }
  const docName = queryString(doc)
  if (!docName) return { doc: null, cwd: null, error: null }
  const project = await readProject(docName)
  if (!project) return { doc: docName, cwd: null, error: `no project '${docName}'` }
  return { doc: docName, cwd: project.sourceDir || null, error: null }
}

app.get('/api/fleet/models', requireRead, async (req, res) => {
  const context = await resolveSpawnModelContext({ doc: req.query.doc, cwd: req.query.cwd })
  if (context.error) {
    res.status(404).json({ error: context.error })
    return
  }
  const daemonConfig = context.cwd ? readDaemonConfigForCwd(context.cwd) : readDaemonConfig()
  res.json(listSpawnModels(withDaemonModelAliases({}, daemonConfig)))
})

app.get('/api/fleet/spawn-availability', requireRead, async (req, res) => {
  const context = await resolveSpawnModelContext({ doc: req.query.doc, cwd: req.query.cwd })
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
      sendDaemonEphemeral: (machineId, op, params) => sendDaemonDurable(machineId, op, params),
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
      results[machineId] = await sendDaemonEphemeral(machineId, 'spawn-availability', {
        ...(context.cwd ? { cwd: context.cwd } : {}),
      })
    } catch (e) {
      results[machineId] = { ok: false, error: e.message || String(e) }
    }
  }))
  res.json({ schema: 1, machines: results })
})

app.get('/api/fleet/prefs', requireRead, async (req, res) => {
  const userId = req.query.user
  if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Missing ?user= param' })
  if (!fleetStore) return res.status(503).json({ error: 'fleet store unavailable' })
  res.json(await fleetStore.getAllFleetPrefs(userId))
})

// Todd owns hibernation policy; the server owns only this read-only liveness
// fact. Keeping the boundary explicit prevents a bot from deriving idleness
// from roster labels or becoming a second status publisher.
app.get('/api/fleet/trusted-idle', requireRead, async (_req, res) => {
  res.json({ idleSecondsByAgent: await getTrustedIdleSeconds() })
})

app.get('/api/fleet/prefs/:key', requireRead, async (req, res) => {
  const userId = req.query.user
  if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Missing ?user= param' })
  if (!fleetStore) return res.status(503).json({ error: 'fleet store unavailable' })
  const value = await fleetStore.getFleetPref(userId, req.params.key)
  res.json({ key: req.params.key, value: value ?? null })
})

app.post('/api/fleet/prefs/:key', requireRead, async (req, res) => {
  const { user: userId, value } = req.body
  if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Missing user in body' })
  if (value === undefined) return res.status(400).json({ error: 'Missing value in body' })
  if (!fleetStore) return res.status(503).json({ error: 'fleet store unavailable' })
  await fleetStore.setFleetPref(userId, req.params.key, value)
  res.json({ ok: true })
})

app.get('/api/runtime-status', requireRead, async (_req, res) => {
  res.json(buildRuntimeStatus({
    env: process.env,
    serverScriptPath: fileURLToPath(import.meta.url),
    fleetDbPath: process.env.TLDA_FLEET_DB || null,
    fleetStore,
    daemonConnections,
    fleetSummary: await fleetStore.getAgentSummary?.(),
    localHostname: hostname(),
  }))
})

// ---------- Education enforcement ----------
// PreToolUse hooks call /check with tool+file info; server runs qualification
// check preventively and returns a pending skill (if any) in one round-trip.
const pendingEducation = new Map()

// Preventive check: hook sends tool+file, server runs qualifications inline
app.get('/api/education/check/:agentId', async (req, res) => {
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
    await checkQualifications(agentId, tool, file, input)
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
app.post('/api/education/dismiss/:agentId', async (req, res) => {
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
app.get('/api/education/skills/:agentId', async (req, res) => {
  const agentId = req.params.agentId
  const readsSet = (await fleetStore?.getSkillReads?.(agentId)) || _qualAgentReads.get(agentId) || new Set()
  const read = [...readsSet]
    .filter(k => typeof k === 'string' && k.startsWith('skill:'))
    .map(k => k.slice('skill:'.length))
    .sort()
  const owed = [...(_qualAgentOwed.get(agentId) || new Map()).entries()]
    .map(([skill, d]) => ({ skill, scope: d.scope, trigger: d.triggerShort || null }))
  const dismissed = [...(_qualAgentDismissed.get(agentId) || new Map()).values()]
    .map(d => ({ skill: d.skill, reason: d.reason, scope: d.scope, trigger: d.trigger || null }))
  const cards = (await fleetStore?.getDrillCards?.(agentId)) || []
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
  await fleetStore.addDrillCard(agentId, drill, { gradient, pass, card })
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
  const agent = await fleetStore.getAgent?.(agentId)
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

app.post('/api/suggestions', async (req, res) => {
  const { agentId, suggestions } = req.body || {}
  if (!agentId) return res.status(400).json({ error: 'Missing agentId' })
  if (!Array.isArray(suggestions)) return res.status(400).json({ error: 'Missing suggestions array' })
  if (suggestions.length === 0) _suggestions.delete(agentId)
  else _suggestions.set(agentId, suggestions.map(s => ({ ...s, from: agentId })))
  refreshSuggestionItems(agentId, _suggestions.get(agentId) || [])
  broadcastEvent('suggestions', { suggestions: flattenSuggestions() })
  res.json({ ok: true })
})

app.get('/api/suggestions', async (_req, res) => {
  res.json({ suggestions: flattenSuggestions() })
})

app.get('/api/items', async (req, res) => {
  const userId = req.query.userId || SERVER_OWNER_ID
  res.json({ userId, items: unexpiredItemsFor(userId) })
})

app.post('/api/items', async (req, res) => {
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
app.get('/api/local-image', requireRead, async (req, res) => {
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

// ---------- Fleet action HTTP routes ----------
// These mirror WS message handlers so UI buttons (fetch POST) can reach them.

async function agentRouteOrHttpError(res, agent) {
  const seat = agent?.id ? await fleetStore?.getAgentDaemonRoute?.(agent.id) : null
  if (!seat) {
    res.status(409).json({ error: 'agent has no daemon route' })
    return null
  }
  return seat
}

app.post('/api/send-text', requireRead, async (req, res) => {
  const { agent: agentQuery, text, enter } = req.body || {}
  if (!agentQuery) return res.status(400).json({ error: 'Missing agent' })
  if (!fleetStore) return res.status(503).json({ error: 'Fleet not initialized' })
  const agent = await fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  const route = resolveRpc('send-text', agent)
  if (route.via === 'none') return res.status(route.code).json({ error: route.error })
  try {
    const result = await sendDaemonDurable(route.machine_id, 'send-text', { agent_id: agent.id, text, enter: enter !== false })
    res.json(result || { ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/send-key', requireRead, async (req, res) => {
  const { agent: agentQuery, key } = req.body || {}
  if (!agentQuery || !key) return res.status(400).json({ error: 'Missing agent or key' })
  if (!fleetStore) return res.status(503).json({ error: 'Fleet not initialized' })
  const agent = await fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  const route = resolveRpc('send-key', agent)
  if (route.via === 'none') return res.status(route.code).json({ error: route.error })
  try {
    const result = await sendDaemonDurable(route.machine_id, 'send-key', { agent_id: agent.id, key })
    res.json(result || { ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/interrupt', requireRead, async (req, res) => {
  const { agent: agentQuery } = req.body || {}
  if (!agentQuery) return res.status(400).json({ error: 'Missing agent' })
  if (!fleetStore) return res.status(503).json({ error: 'Fleet not initialized' })
  const agent = await fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  const route = resolveRpc('interrupt', agent)
  if (route.via === 'none') return res.status(route.code).json({ error: route.error })
  try {
    const result = await sendDaemonDurable(route.machine_id, 'interrupt', { agent_id: agent.id })
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
  const agent = await fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  const seat = await agentRouteOrHttpError(res, agent)
  if (!seat) return
  try {
    const result = await sendDaemonDurable(seat.daemon_key, 'soft-interrupt', terminalRpcPayload(agent, seat))
    res.json({ ok: true, agent: agent.friendly_name || agent.id, ...result })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/kill-session', requireRead, async (req, res) => {
  const { agent: agentQuery } = req.body || {}
  if (!agentQuery) return res.status(400).json({ error: 'Missing agent' })
  if (!fleetStore) return res.status(503).json({ error: 'Fleet not initialized' })
  const agent = await fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  const seat = await agentRouteOrHttpError(res, agent)
  if (!seat) return
  try {
    const result = await sendDaemonDurable(seat.daemon_key, 'kill-session', terminalRpcPayload(agent, seat))
    markAgentNotAlive(agent.id, { source: 'http-kill-session', reason: 'operator killed session' })
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
  const agent = await fleetStore.findAgent(agentQuery)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  if (!isPlanModeResponse(response)) return res.status(400).json({ error: 'response must be approve, supervised, or reject' })
  const seat = await agentRouteOrHttpError(res, agent)
  if (!seat) return
  try {
    const result = await sendDaemonDurable(seat.daemon_key, 'send-text', terminalRpcPayload(agent, seat, { text: planModeResponseKey(response), enter: false }))
    await fleetStore.updateAgentMeta?.(agent.id, { permission_mode: null, inPlanMode: false, planModeType: null })
    const pending = pendingPlanApprovals.get(agent.id)
    if (pending?.eventId) {
      const now = new Date().toISOString()
      const patch = response === 'reject' ? { rejectedAt: now } : { approvedAt: now, mode: response }
      try {
        await fleetStore.updateEventMetadata(pending.eventId, patch)
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
    await fleetStore.updateEventMetadata(eventId, patch)
    broadcastEvent('event-update', { id: eventId, metadata_patch: patch })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---------- Doc asset serving ----------
// Serves from server/projects/{name}/output/ at /docs/{name}/*

async function docPathExists(path) {
  try {
    await fs.promises.access(path)
    return true
  } catch {
    return false
  }
}

app.get('/docs/manifest.json', requireRead, async (req, res) => {
  const manifest = generateManifest()
  res.json(manifest)
})

// Serve sub-resources of html-format projects without auth (CSS, JS, fonts from site_libs)
// These are Quarto framework files loaded by iframes that can't pass auth headers
app.use('/docs', async (req, res, next) => {
  const parts = req.path.slice(1).split('/')
  if (parts.length < 3) return next() // need at least /name/site_libs/...
  const name = parts[0]
  const filePath = parts.slice(1).join('/')
  // Skip auth for non-HTML sub-resources in html-format projects
  // (CSS, JS, fonts, figures — loaded by iframes that can't pass auth headers)
  if (!filePath.endsWith('.html')) {
    try {
      const project = await readProject(name)
      if (project?.format === 'html') {
        const assetPath = join(PROJECTS_DIR, name, 'output', filePath)
        if (await docPathExists(assetPath)) {
          res.set('Cache-Control', 'public, max-age=3600')
          return res.sendFile(resolve(assetPath), { dotfiles: 'allow' })
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

  // Serve derived shadow render cache:
  // /docs/{name}/history/shadow-{hash7}/<texBase>-page-N.svg
  if (filePath.startsWith('history/')) {
    if (!filePath.startsWith('history/shadow-')) {
      return res.status(404).json({ error: 'Not found' })
    }

    const histPath = join(PROJECTS_DIR, name, filePath)
    if (await docPathExists(histPath)) {
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
      const outputDir = join(PROJECTS_DIR, name, 'output')
      const pageInfoPath = join(outputDir, 'page-info.json')
      const project = await readProject(name)
      if (project && await docPathExists(pageInfoPath)) {
        if (project.format === 'html') {
          const pageInfo = JSON.parse(await fs.promises.readFile(pageInfoPath, 'utf8'))
          // Find chapter list: either from first entry's chapters field, or all entries
          const chapters = pageInfo[0]?.chapters || pageInfo.map(e => ({ file: e.file, title: e.title }))
          // Use head from first chapter
          const firstHtml = await fs.promises.readFile(join(outputDir, chapters[0].file), 'utf8')
          const headMatch = firstHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i)
          const headContent = headMatch ? headMatch[1] : ''
          // Extract body from each chapter
          const bodies = []
          for (const ch of chapters) {
            const chapterPath = join(outputDir, ch.file)
            if (!await docPathExists(chapterPath)) continue
            const chapterHtml = await fs.promises.readFile(chapterPath, 'utf8')
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
    const project = await readProject(name)
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
    const aliased = await resolveAssetAsync(PROJECTS_DIR, name, filePath)
    if (aliased) {
      res.set('Cache-Control', 'no-cache')
      return res.sendFile(resolve(aliased), { dotfiles: 'allow' })
    }
  }

  if (filePath.endsWith('.html')) {
    try {
      const project = await readProject(name)
      if (project) {
        const { listDocumentColumns, listProjectPartColumns } = await import('./lib/document-columns.mjs')
        const { renderMarkdownColumnHtml } = await import('./lib/build-markdown.mjs')
        // Markdown-format projects: main file + parts (existing behavior).
        // Any other format: its markdown PARTS still render through this same
        // markdown renderer — the parent project's own format only owns its
        // own main document, not its parts.
        const columns = project.format === 'markdown'
          ? await listDocumentColumns(name, { project, srcDir: join(PROJECTS_DIR, name, 'source') })
          : await listProjectPartColumns(name, { srcDir: join(PROJECTS_DIR, name, 'source') })
        const column = columns.find(c => c.file === filePath)
        if (column) {
          const source = await fs.promises.readFile(join(PROJECTS_DIR, name, 'source', column.sourceFile), 'utf8')
          const isTaskDoc = /(^|\n)tlda-kind:\s*task-doc\s*(\n|$)/.test(source)
          const agentNames = isTaskDoc ? await fleetStore.getAgentDisplayNames() : []
          const html = renderMarkdownColumnHtml({
            source,
            title: column.title,
            isTaskDoc,
            agentNames,
            projectName: name,
            sourceFile: column.sourceFile,
            mainFile: project.mainFile || 'index.md',
          })
          const bridged = injectBridge(html, `/docs/${name}/`, '', true, {})

          async function memberTitle(memberName) {
            const tp = join(PROJECTS_DIR, memberName, 'output', 'toc.json')
            if (!await docPathExists(tp)) return memberName
            try {
              const toc = JSON.parse(await fs.promises.readFile(tp, 'utf8'))
              return (toc.length > 0 && toc[0].level === 'section') ? toc[0].title : memberName
            } catch { return memberName }
          }

          const chapterTitle = column.title || await memberTitle(name)
          let prev = null, next = null
          for (const p of await listProjects()) {
            if (p.format !== 'book') continue
            const members = p.members || []
            const idx = members.indexOf(name)
            if (idx === -1) continue
            if (idx > 0) prev = { name: members[idx - 1], title: await memberTitle(members[idx - 1]) }
            if (idx < members.length - 1) next = { name: members[idx + 1], title: await memberTitle(members[idx + 1]) }
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
  if (await docPathExists(projectPath)) {
    res.set('Cache-Control', 'no-cache')
    // For HTML files in html-format projects, inject the tlda bridge script
    if (filePath.endsWith('.html')) {
      try {
        const project = await readProject(name)
        if (project) {
          if (project.format === 'slides') {
            // Slides format: inject the reveal.js bridge script
            const html = await fs.promises.readFile(projectPath, 'utf8')
            const injected = injectSlidesBridge(html)
            res.type('html').send(injected)
            return
          }
          if (project.format === 'markdown') {
            // Markdown: bridge already injected at build time; inject chapter title + prev/next at serve time.
            const html = await fs.promises.readFile(projectPath, 'utf8')

            // Resolve chapter title: promote h1 to chapter title if present (matches aggregateBookToc logic)
            async function memberTitle(memberName) {
              const tp = join(PROJECTS_DIR, memberName, 'output', 'toc.json')
              if (!await docPathExists(tp)) return memberName
              try {
                const toc = JSON.parse(await fs.promises.readFile(tp, 'utf8'))
                return (toc.length > 0 && toc[0].level === 'section') ? toc[0].title : memberName
              } catch { return memberName }
            }

            const chapterTitle = await memberTitle(name)

            // Find which book contains this member and compute prev/next
            let prev = null, next = null
            for (const p of await listProjects()) {
              if (p.format !== 'book') continue
              const members = p.members || []
              const idx = members.indexOf(name)
              if (idx === -1) continue
              if (idx > 0) prev = { name: members[idx - 1], title: await memberTitle(members[idx - 1]) }
              if (idx < members.length - 1) next = { name: members[idx + 1], title: await memberTitle(members[idx + 1]) }
              break  // use first book found
            }

            const injected = injectChapterTitle(html, chapterTitle, prev, next)
            res.type('html').send(injected)
            return
          }
          if (project.format === 'html') {
            const html = await fs.promises.readFile(projectPath, 'utf8')
            // Look up chapter title and compute "Chapter N" numbering within parts
            let chapterTitle = ''
            let isFirstPage = false
            let navPrev = null
            let navNext = null
            try {
              const pageInfoPath = join(PROJECTS_DIR, name, 'output', 'page-info.json')
              const pageInfo = JSON.parse(await fs.promises.readFile(pageInfoPath, 'utf8'))
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
app.locals.sendDaemonEphemeral = sendDaemonEphemeral
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
  sendDaemonEphemeral, sendDaemonDurable, resolveRpc, daemonConnections, resolveSpawnTarget,
  enqueueDaemonMessage: (...args) => enqueueDaemonMessage(...args),
  hasOpenFleetSocketForAgent,
  reanimateAgent,
  requireOperationRead: requireRw,
})
app.use(fleetRouter)

app.post('/api/fleet/reload-client', requireRw, async (req, res) => {
  const humanId = req.body?.humanId
  try {
    const result = reloadHumanFleetClients(fleetWss.clients, humanId, {
      reason: req.body?.reason || 'operator-request',
    })
    if (result.sent === 0) {
      return res.status(404).json({ ok: false, error: `No connected browser for ${humanId}`, ...result })
    }
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

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
app.get('/{*path}', async (req, res) => {
  // Don't catch API or doc routes
  if (req.path.startsWith('/api/') || req.path.startsWith('/docs/')) {
    return res.status(404).json({ error: 'Not found' })
  }
  // Nor built assets. A tab opened before a deploy still requests its own
  // content-hashed chunks; answering those with index.html means the browser
  // parses HTML as a module and throws uncaught, and the 200 hides it. A gone
  // asset must be gone.
  if (req.path.startsWith('/assets/')) {
    return res.status(404).json({ error: 'Not found' })
  }

  const indexPath = join(distDir, 'index.html')
  if (existsSync(indexPath)) {
    res.set('Cache-Control', 'no-cache')
    res.set('Document-Policy', 'js-profiling')
    // Inject the resolved active config so the SPA reads database/store/licenseKey
    // synchronously at startup — no build-time baking, no async race, no guessing.
    // resolveConfig() is validated at boot (server won't start on a bad config),
    // so this can't throw here; if server.yaml were edited to something invalid
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
    machineId: agent?.machine_id,
    envName: agent?.env_name,
  })
}

function sendTerminalFrame(ws, frame, { agentId, operation }, callback = undefined) {
  if (ws?.readyState !== 1) return false
  try {
    ws.send(JSON.stringify(frame), callback)
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
    const agent = await fleetStore.findAgent(agentId)
    const seat = agent ? await fleetStore.getAgentDaemonRoute?.(agent.id) : null
    if (!agent || !seat) {
      // Decline cleanly with a JSON message before close so the UI shows
      // a useful error instead of "WebSocket error".
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        sendTerminalFrame(ws, { type: 'error', message: 'agent has no daemon route; terminal routing unavailable' }, { agentId, operation: 'terminal-open' })
        try { ws.close() } catch {
          // Socket already closed by peer; no server-side recovery remains.
        }
      })
      return
    }
    terminalWss.handleUpgrade(req, socket, head, async (ws) => {
      ws._agentId = agent.id
      ws._machineId = seat.machine_id
      const terminalInputAllowed = daemonTerminalInputAllowed(seat.daemon_key)
      sendTerminalFrame(ws, {
        type: 'capabilities',
        terminalInputAllowed,
        capabilities: { terminalInputAllowed },
      }, { agentId: agent.id, operation: 'terminal-capabilities' })

      // Add to watcher set, then start the daemon poll. Always — this set only
      // records which browsers are attached, and says nothing about whether the
      // daemon's watch PTY is still alive. A daemon restart kills the watch while
      // leaving these sockets open, so gating on "first watcher" meant every later
      // viewer inherited a dead stream and its pane froze with the socket healthy.
      // rpcStartTerminalWatch is idempotent: an existing watch re-sends size and a
      // fresh snapshot and returns { already: true }.
      let set = terminalWatchers.get(agent.id)
      if (!set) { set = new Set(); terminalWatchers.set(agent.id, set) }
      set.add(ws)

      try {
        const res = await sendDaemonEphemeral(seat.daemon_key, 'start-terminal-watch', {
          agent_id: agent.id, poll_ms: 500,
        })
        if (res && res.cols && res.rows) terminalSizes.set(agent.id, { cols: res.cols, rows: res.rows })
      } catch (e) {
        sendTerminalFrame(ws, { type: 'error', message: e.message }, { agentId: agent.id, operation: 'start-terminal-watch' })
      }

      // Tell the viewer the agent's real tmux window size BEFORE seeding content,
      // so the peek grid is created at the right width and the seed doesn't wrap.
      const cachedSize = terminalSizes.get(agent.id)
      if (cachedSize && ws.readyState === 1) {
        sendTerminalFrame(ws, { type: 'size', cols: cachedSize.cols, rows: cachedSize.rows }, { agentId: agent.id, operation: 'terminal-size' })
      }

      // Seed with current terminal content so the card isn't blank on open.
      // The live attach stream only repaints on a fresh attach (and the daemon
      // skips the repaint if a watch already exists), so without this seed an
      // idle awake agent shows nothing. capture-pane takes `lines` and returns
      // the screen as `pane` (see rpcCapturePane in fleet-daemon.mjs).
      try {
        const { pane } = await sendDaemonEphemeral(seat.daemon_key, 'capture-pane', {
          agent_id: agent.id, visible: true,
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
          sendTerminalFrame(ws, { type: 'output', data: Buffer.from(seed).toString('base64'), encoding: 'base64' }, { agentId: agent.id, operation: 'terminal-seed' })
        }
      } catch (e) {
        console.warn(`[terminal] seed capture failed for ${agent.id}: ${e.message}`)
        if (ws.readyState === 1) {
          sendTerminalFrame(ws, { type: 'not-live', reason: 'terminal session not live' }, { agentId: agent.id, operation: 'terminal-seed' }, (sendError) => {
            if (sendError) console.warn(`[terminal] failed to send not-live frame for ${agent.id}: ${sendError.message}`)
          })
        }
      }

      ws.on('message', async (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        await fleetOperationContext.run(msg.fleet_operation || null, async () => {
          if (msg.type === 'input' && typeof msg.data === 'string') {
            try {
              await sendDaemonEphemeral(seat.daemon_key, 'terminal-input', {
                agent_id: agent.id, data: msg.data,
              })
            } catch (e) {
              if (ws.readyState === 1) {
                sendTerminalFrame(ws, { type: 'error', message: e.message }, { agentId: agent.id, operation: 'terminal-input' })
              }
            }
          } else if (msg.type === 'submit' && typeof msg.text === 'string') {
            try {
              await sendDaemonEphemeral(seat.daemon_key, 'send-text', {
                agent_id: agent.id, text: msg.text, enter: true,
              })
            } catch (e) {
              if (ws.readyState === 1) {
                sendTerminalFrame(ws, { type: 'error', message: e.message }, { agentId: agent.id, operation: 'terminal-submit' })
              }
            }
          } else if (msg.type === 'resize' && msg.cols && msg.rows) {
            try {
              await sendDaemonEphemeral(seat.daemon_key, 'terminal-resize', {
                agent_id: agent.id, cols: msg.cols, rows: msg.rows,
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
      })

      const cleanup = async () => {
        const set = terminalWatchers.get(agent.id)
        if (!set) return
        set.delete(ws)
        if (set.size === 0) {
          terminalWatchers.delete(agent.id)
          terminalSizes.delete(agent.id)
          try {
            await sendDaemonEphemeral(seat.daemon_key, 'stop-terminal-watch', {
              agent_id: agent.id,
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
    fleetWss.handleUpgrade(req, socket, head, (ws) => {
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
      ws.on('close', async (code, reason) => {
        logWsClose('daemon', ws, code, reason?.toString?.() || '')
        if (ws._daemonKey && daemonConnections.get(ws._daemonKey) === ws) {
          traceGate1('registry-removed', {
            daemon_key: ws._daemonKey,
            boot_id: ws._bootId,
            connection_attempt_id: ws._connectionAttemptId,
            ws_session_id: ws._wsSessionId,
            via: 'close',
            code,
          })
          daemonConnections.delete(ws._daemonKey)
          daemonActivityDeliverySnapshots.delete(ws._daemonKey)
          // A disconnect is transient. Preserve the daemon's last explicit
          // process observations; silence is not a hibernation report.
          // Not awaited: this runs in a socket close/error handler, which is
          // not async and must not become so. Rejections are reported rather
          // than dropped — a route refresh that fails leaves the roster
          // showing stale routes for that daemon's agents, which is worth
          // seeing in the log.
          refreshRuntimeRoutesForDaemon(ws._daemonKey)
            .catch(e => console.error(`[runtime-routes] refresh failed for ${ws._daemonKey}: ${e?.message || e}`))
          // The daemon is gone; process-level visibility is unknown, not false.
          // Preserve prior liveness so a server/Fly redeploy or daemon restart
          // cannot make every working agent on that machine vanish.
          failPendingRpcsForDaemon(ws._machineId, ws._envName, 'daemon disconnected')
          clearServerDaemonOutboxInflightForDaemon(ws._daemonKey)
          updateDaemonActivityTransportHealth(ws._daemonKey, {
            state: ACTIVITY_HEALTH_UNAVAILABLE,
            boundary: ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_DISCONNECTED,
            reason: 'daemon websocket closed',
            ts: new Date().toISOString(),
          }).catch(e => console.error(`[activity-health] daemon disconnect update failed: ${e.message}`))
          broadcastState()
          console.log(`[fleet-daemon] disconnected: daemon=${ws._daemonKey}`)
        }
      })
      ws.on('error', async () => {
        if (ws._daemonKey && daemonConnections.get(ws._daemonKey) === ws) {
          traceGate1('registry-removed', {
            daemon_key: ws._daemonKey,
            boot_id: ws._bootId,
            connection_attempt_id: ws._connectionAttemptId,
            ws_session_id: ws._wsSessionId,
            via: 'error',
          })
          daemonConnections.delete(ws._daemonKey)
          daemonActivityDeliverySnapshots.delete(ws._daemonKey)
          // A disconnect is transient. Preserve the daemon's last explicit
          // process observations; silence is not a hibernation report.
          // Not awaited: this runs in a socket close/error handler, which is
          // not async and must not become so. Rejections are reported rather
          // than dropped — a route refresh that fails leaves the roster
          // showing stale routes for that daemon's agents, which is worth
          // seeing in the log.
          refreshRuntimeRoutesForDaemon(ws._daemonKey)
            .catch(e => console.error(`[runtime-routes] refresh failed for ${ws._daemonKey}: ${e?.message || e}`))
          failPendingRpcsForDaemon(ws._machineId, ws._envName, 'daemon ws error')
          clearServerDaemonOutboxInflightForDaemon(ws._daemonKey)
          updateDaemonActivityTransportHealth(ws._daemonKey, {
            state: ACTIVITY_HEALTH_UNAVAILABLE,
            boundary: ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_DISCONNECTED,
            reason: 'daemon websocket error',
            ts: new Date().toISOString(),
          }).catch(e => console.error(`[activity-health] daemon error update failed: ${e.message}`))
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
        filterSubscriptions.dropConnection(ws)
        humanPresence.detach(ws)
        // A doc subscription is durable and outlives this socket. Closing it
        // used to tear down the agent's tlda-feedback watches, which silently
        // disarmed every subscription whose row was still in the table.
        if (ws._tldaAgentId && agentFleetConnections.get(ws._tldaAgentId) === ws) {
          agentFleetConnections.delete(ws._tldaAgentId)
        }
      })
      ws.on('error', () => {
        wsFleetClients.delete(ws)
        filterSubscriptions.dropConnection(ws)
        humanPresence.detach(ws)
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
      let pendingBytes = 0
      let droppedFrames = 0
      let flushedFrames = 0
      const maxPendingBytes = 16000 * 2 * 3
      const maxPendingAgeMs = 3000

      const proxySnapshot = () => ({
        pendingFrames: pending.length,
        pendingBytes,
        oldestAgeMs: pending.length ? Math.max(0, Date.now() - pending[0].queuedAt) : null,
        droppedFrames,
        flushedFrames,
        maxPendingBytes,
        maxPendingAgeMs,
        upstreamReadyState: upstream?.readyState ?? null,
      })

      const sendProxyStatus = () => {
        if (browserWs.readyState !== 1) return
        try {
          browserWs.send(JSON.stringify({ type: 'proxy_status', proxy: proxySnapshot(), timestamp: Date.now() }))
        } catch (err) {
          // Best-effort telemetry must not interrupt live audio proxying.
          console.warn('[voice-proxy:sdk] proxy telemetry send failed:', err.message)
        }
      }

      const dropPendingAt = (index) => {
        const [frame] = pending.splice(index, 1)
        if (!frame) return
        pendingBytes = Math.max(0, pendingBytes - frame.data.length)
        droppedFrames++
      }

      const prunePending = () => {
        const now = Date.now()
        for (let i = pending.length - 1; i >= 0; i--) {
          if (now - pending[i].queuedAt > maxPendingAgeMs) dropPendingAt(i)
        }
        while (pendingBytes > maxPendingBytes && pending.length) dropPendingAt(0)
      }

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
          const frame = Buffer.isBuffer(data) ? data : Buffer.from(data)
          pending.push({ data: frame, isBinary, queuedAt: Date.now() })
          pendingBytes += frame.length
          prunePending()
          sendProxyStatus()
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
        prunePending()
        for (const { data, isBinary } of pending) {
          try {
            upstream.send(data, { binary: isBinary })
            flushedFrames++
          } catch (err) {
            droppedFrames++
            console.warn('[voice-proxy:sdk] pending audio flush failed:', err.message)
          }
        }
        pending.length = 0
        pendingBytes = 0
        sendProxyStatus()
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
// Handles request/response messages from the fleet operation transport.

function sendFleetResponseFrame(ws, frame) {
  if (ws?.readyState !== 1) return false
  ws.send(JSON.stringify(frame))
  return true
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
const WAKE_ACK_DEADLINE_MS = Number(process.env.TLDA_WAKE_ACK_DEADLINE_MS || 60_000)
const _pendingWakeAcks = new Map()
function awaitWakeAcknowledgment({ agentId, traceId, source = {}, asker = null }) {
  if (!traceId || source.priority !== 'urgent' || _pendingWakeAcks.has(traceId)) return
  const timer = setTimeout(async () => {
    const pending = _pendingWakeAcks.get(traceId)
    if (!pending) return
    _pendingWakeAcks.delete(traceId)
    broadcastEvent('agent-wedged', { agentId, reason: 'urgent wake was delivered but not acknowledged before deadline', ts: new Date().toISOString() })
    if (asker) deliverTldaFeedbackChat({ from: 'fleet:tlda', to: asker, text: `⚠️ **Urgent wake timed out** for \`${agentId}\`; delivery was attempted but no inbox acknowledgment arrived.`, metadata: { type: 'wake_ack_timeout', trace_id: traceId, agentId } })
  }, WAKE_ACK_DEADLINE_MS)
  timer.unref?.()
  _pendingWakeAcks.set(traceId, { agentId, timer })
}
function acknowledgeWakeTrace(traceId, agentId) {
  const pending = _pendingWakeAcks.get(traceId)
  if (!pending || pending.agentId !== agentId) return false
  clearTimeout(pending.timer)
  _pendingWakeAcks.delete(traceId)
  return true
}
async function requestWake(agentId, nudgeText = null, asker = null, traceId = null, source = {}) {
  const agent = await fleetStore.getAgent(agentId)
  if (!agent || agent.dead || agent.human) return
  if (isReservedShellAgent(agent)) {
    spawnLibrarian.observeLiveness({
      type: 'agent-liveness',
      agent_id: agentId,
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
    source: Object.keys(source || {}).length ? source : (prev?.source || {}),
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
    const source = wakeEntry?.source || {}
    const agent = await fleetStore.getAgent?.(agentId)
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
    const seat = await fleetStore?.getAgentDaemonRoute?.(agentId)
    if (!seat) {
      continue
    }
    const daemonKey = seat.daemon_key
    try {
      const result = await runWakeRouteLifecycle({
        agentId,
        agent,
        daemonKey,
        ownerDaemon: daemonConnections.get(daemonKey),
        nudgeText,
        returnNoticeText: withAgentReturnNotice(agent, nudgeText),
        traceId,
        sendDaemonDurable,
        appendControlTrace: (event) => controlPlaneTraces.append(event),
        sendWakeNudge,
        getAgentDaemonRoute: (id) => fleetStore.getAgentDaemonRoute(id),
        insertWakeLifecycleEvent: async () => {
          const wakeTs = new Date().toISOString()
          await measureHotOp('fleet-ws lifecycle wake insert', `agent=${agentId}`, () => fleetStore.insertEventRecord({
            type: 'lifecycle',
            timestamp: wakeTs,
            from: agentId,
            to: agentId,
            text: 'agent woken',
            unread: false,
          }, { notify: false }))
        },
      })
      if (result.action === 'respawned') console.log(`[respawn] woke ${agent.friendly_name || agentId} (${agentId})`)
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

async function handleFleetWsMessage(ws, msg) {
  const { id, type } = msg
  const operationEnvelope = msg.fleet_operation || null
  if (operationEnvelope) {
    if (operationEnvelope.operation_type !== type) {
      throw new Error(`fleet operation envelope type ${operationEnvelope.operation_type} does not match message type ${type}`)
    }
    if (!['durable', 'ephemeral'].includes(operationEnvelope.delivery_class)) {
      throw new Error(`fleet operation ${type} has invalid delivery class ${operationEnvelope.delivery_class}`)
    }
  }
  const clientOperationId = msg.operation_id || operationEnvelope?.operation_id || null
  const reply = (result) => {
    if (clientOperationId && fleetStore) {
    fleetStore.recordTransportOperationResult(clientOperationId, type, 'result', result, operationEnvelope)
      .catch(e => console.error(`[fleet-ws] record transport result failed for ${clientOperationId}: ${e?.message || e}`))
    }
    if (id) {
      sendFleetResponseFrame(ws, { id, result })
      msg._fleetReplied = true
    }
  }
  const error = (err) => {
    if (!id) return
    const payload = err && typeof err === 'object'
      ? {
          message: err.message || String(err),
          code: err.code,
          reason: err.reason,
          ...(err.payload ? { payload: err.payload } : {}),
        }
      : err
    if (clientOperationId && fleetStore) {
      fleetStore.recordTransportOperationResult(clientOperationId, type, 'error', payload, operationEnvelope)
        .catch(e => console.error(`[fleet-ws] record transport error failed for ${clientOperationId}: ${e?.message || e}`))
    }
    if (err && typeof err === 'object') {
      sendFleetResponseFrame(ws, {
        id,
        error: payload,
      })
      msg._fleetReplied = true
    } else {
      sendFleetResponseFrame(ws, { id, error: err })
      msg._fleetReplied = true
    }
  }

  if (!fleetStore) { error('fleet store unavailable'); return }
  if (clientOperationId) {
    try {
      if (operationEnvelope) await fleetStore.beginTransportOperation(operationEnvelope)
      const previous = await fleetStore.getTransportOperationResult(clientOperationId, type)
      if (previous?.kind === 'error') {
        sendFleetResponseFrame(ws, { id, error: previous.payload })
        msg._fleetReplied = true
        return
      }
      if (previous?.kind === 'result') {
        sendFleetResponseFrame(ws, { id, result: previous.payload })
        msg._fleetReplied = true
        return
      }
    } catch (e) {
      error(e)
      return
    }
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

  if (type === 'items') {
    const userId = msg.userId || SERVER_OWNER_ID
    reply({ userId, items: unexpiredItemsFor(userId) })
    return
  }

  if (type === 'suggestions-get') {
    reply({ suggestions: flattenSuggestions() })
    return
  }

  if (type === 'suggestions-set') {
    const { agentId, suggestions } = msg
    if (!agentId) { error('Missing agentId'); return }
    if (!Array.isArray(suggestions)) { error('Missing suggestions array'); return }
    if (suggestions.length === 0) _suggestions.delete(agentId)
    else _suggestions.set(agentId, suggestions.map(s => ({ ...s, from: agentId })))
    refreshSuggestionItems(agentId, _suggestions.get(agentId) || [])
    broadcastEvent('suggestions', { suggestions: flattenSuggestions() })
    reply({ ok: true })
    return
  }

  if (type === 'prefs-get-all') {
    if (!msg.user || typeof msg.user !== 'string') { error('prefs-get-all requires user'); return }
    reply(await fleetStore.getAllFleetPrefs(msg.user))
    return
  }

  if (type === 'prefs-set') {
    if (!msg.user || typeof msg.user !== 'string') { error('prefs-set requires user'); return }
    if (!msg.key || typeof msg.key !== 'string') { error('prefs-set requires key'); return }
    if (msg.value === undefined) { error('prefs-set requires value'); return }
    await fleetStore.setFleetPref(msg.user, msg.key, msg.value)
    reply({ ok: true })
    return
  }

  if (type === 'reanimate') {
    if (!msg.agent) { error('reanimate requires agent'); return }
    try {
      const result = await reanimateAgent(msg.agent)
      reply(result)
    } catch (e) {
      error(e)
    }
    return
  }

  if (type === 'mark-dead') {
    const agentId = msg.agent_id || msg.agent
    if (!agentId) { error('mark-dead requires agent'); return }
    try {
      await fleetStore.markDead(agentId)
      clearEphemeralState(agentId)
      broadcastState()
      reply({ ok: true })
    } catch (e) {
      error(e)
    }
    return
  }

  if (type === 'fleet-roster-truth') {
    const agents = await fleetStore.getAliveAgents?.() || []
    const totals = await fleetStore.getAgentSummary?.() || { total: agents.length }
    reply({
      totals,
      agents: agents.slice(0, Math.max(1, Math.min(Number(msg.limit) || 50, 500))).map(agentWithDaemonCapabilities),
      shown: Math.min(agents.length, Math.max(1, Math.min(Number(msg.limit) || 50, 500))),
      matched: agents.length,
      wholeFleet: totals,
    })
    return
  }

  if (type === 'agents-page') {
    const page = await fleetStore.getAliveAgentsPage({
      limit: msg.limit,
      cursor: msg.cursor || null,
    })
    reply({ ...page, agents: (page.agents || []).map(agentWithDaemonCapabilities), totals: await fleetStore.getAliveAgentCounts(rosterCountInputs()) })
    return
  }

  if (type === 'tasks-page') {
    const page = await fleetStore.getActiveTasksPage({
      limit: msg.limit,
      cursor: msg.cursor || null,
    })
    reply({ ...page, total: await fleetStore.getActiveTaskCount() })
    return
  }

  // ---- Timer countdown widget (timer-set / timer-fire / timer-cancel) ----
  // Bridges the `timer` event the viewer renders as a live ticking bubble. Used
  // by both the MCP timer() tool and a bot's action countdowns — same wire
  // format, so bots speak the same language as real agents. timer-set stores +
  // broadcasts a pending timer; timer-fire/cancel patches it to a terminal state.
  if (type === 'timer-set') {
    const { agent, message, fire_at, to: toAgent, repeat_seconds, expires_at, task_id } = msg
    // Address the countdown to the conversation it belongs to (e.g. the agent
    // being handed off). A chat panel only renders events whose from/to matches
    // its target agent, so a countdown hardcoded to the server owner never
    // appears in the panel the requester triggered it from.
    const { from, to } = await resolveTimerParticipants({
      agent,
      toAgent,
      findAgent: fleetStore.findAgent?.bind(fleetStore),
      fallbackOwner: SERVER_OWNER_ID,
    })
    const metadata = {
      pending: true,
      fire_at,
      message,
      ...(repeat_seconds ? { repeat_seconds: Number(repeat_seconds) } : {}),
      ...(expires_at ? { expires_at } : {}),
      ...(task_id ? { task_id } : {}),
    }
    const event = await fleetStore.share({ type: 'timer', from, to, text: `⏱ ${message}`, metadata })
    await serverTimerScheduler?.refresh()
    reply({ ok: true, id: event.id })
    return
  }
  if (type === 'timer-fire' || type === 'timer-cancel') {
    const eventId = msg.event_id
    const state = type === 'timer-cancel' ? 'cancelled' : 'fired'
    if (eventId == null) {
      reply(timerTerminalInputFailureResult({ state, eventId }))
      return
    }
    const event = await fleetStore.getEventById(Number(eventId))
    if (!event) {
      reply(timerTerminalInputFailureResult({ state, eventId }))
      return
    }
    try {
      const result = state === 'cancelled'
        ? await serverTimerScheduler.cancel(Number(eventId))
        : await serverTimerScheduler.fire(Number(eventId), { message: msg.message })
      reply(result)
    } catch (e) {
      reply(timerDeliveryFailureResult({ state, eventId, error: e }))
    }
    return
  }

  if (type === 'subagent-observed') {
    const parentAgentId = msg.parent_agent_id || null
    if (!parentAgentId) { error('subagent-observed requires parent_agent_id'); return }
    const parent = await fleetStore.getAgent?.(parentAgentId)
    if (!parent || parent.dead) { error(`subagent parent "${parentAgentId}" is not live`); return }

    const childAgentId = mintFleetId()
    const childPart = String(msg.child_name || 'subagent').trim() || 'subagent'
    const requestedName = `${parent.friendly_name || parent.id}:${childPart}`
    let assignedName
    try {
      assignedName = await fleetStore.allocateFreshFriendlyName(requestedName, { excludeId: childAgentId })
    } catch (e) {
      error(e)
      return
    }
    const now = new Date().toISOString()
    const child = {
      id: childAgentId,
      parent_agent_id: parent.id,
      friendly_name: assignedName,
      cwd: parent.cwd || null,
      labels: [],
      registered_at: now,
      last_seen: now,
      dead: false,
      human: false,
      is_manager: false,
      metadata: null,
    }
    await fleetStore.upsertAgent(child)
    await fleetStore.ensureDefaultSubscription?.(child.id)
    const stored = await fleetStore.getAgent?.(child.id) || child
    broadcastState(stored)
    reply({ ok: true, agent: stored })
    return
  }

  if (type === 'native-subagent-notification-ack') {
    const parentAgentId = msg.parent_agent_id || null
    const childAgentId = msg.child_agent_id || null
    if (!parentAgentId || !childAgentId) {
      error('native-subagent-notification-ack requires parent_agent_id and child_agent_id')
      return
    }
    const result = await fleetStore.acknowledgeNativeSubagentNotifications?.(parentAgentId, childAgentId)
    reply({ ok: true, ...(result || { acknowledged: 0 }) })
    return
  }

  if (type === 'register' || type === 'reserve-shell' || type === 'mint-shell') {
    // Prefer agent_id over id: the transport adapter stamps a correlation `id`
    // onto every message, so the real fleet id arrives as agent_id. Falling
    // back to id keeps direct WS callers that send id=fleet_id working. Reading
    // the bare `id` first here was the root cause of phantom UUID-keyed rows.
    const { agent_id, id: msgId, local_agent_id, name, pretty_name, labels, manager, metadata, machine_id, env_name, kind } = msg
    const isShellReservation = type === 'reserve-shell' || type === 'mint-shell'
    if (type === 'register' && !msg.human) {
      error('register is only for human browser sessions; agents must use reserve-shell before startup and login after startup')
      return
    }
    if (isShellReservation && msg.human) {
      error('reserve-shell is only for agent spawn shells')
      return
    }
    let agentId = agent_id || msgId
    if (type === 'mint-shell') {
      agentId = agent_id || mintFleetId()
    }
    if (!agentId) { error('missing id'); return }
    // Duplicate clients are allowed to coexist. Closing an existing socket here
    // is unsafe because fleet clients such as Todd auto-reconnect on close; two
    // same-identity clients then repeatedly kick each other off the server.
    if (!msg.human) {
      agentFleetConnections.set(agentId, ws)
      // Remember which agent owns this WS so we can clean up their
      // tlda-feedback subscriptions on close.
      ws._tldaAgentId = agentId
    }
    const now = new Date().toISOString()
    const existing = await fleetStore.getAgent?.(agentId)
    // The friendly name is set once (first identity creation) and is thereafter owned
    // by rename/rotation. Re-login must NOT clobber it with the spawn name
    // — that would undo a lineage rotation. So only the *first* name is taken
    // from `name`; once set, it's preserved.
    const requestedName = name || null
    let assignedName = (existing && !existing.dead) ? (existing.friendly_name || requestedName) : requestedName
    const willSetName = (!existing?.friendly_name || existing?.dead) && requestedName
    if (willSetName) {
      const incomingLabels = Array.isArray(labels) ? labels : []
      if (incomingLabels.includes('bot') && incomingLabels.includes(requestedName)) {
        for (const holder of await fleetStore.getLiveAgentsByFriendlyName?.(requestedName) || []) {
          if (holder.id === agentId || holder.dead || holder.friendly_name !== requestedName) continue
          const holderLabels = Array.isArray(holder.labels) ? holder.labels : []
          if (!holderLabels.includes('bot') || !holderLabels.includes(requestedName)) continue
          // Rotate the previous holder off the name; do not kill it. Claiming a
          // name is a naming operation, and the row being displaced may be a
          // live bot. Skip: "the name rotation doesn't kill an agent — it wipes
          // their name, but it doesn't kill them."
          let rotated = null
          try { rotated = await fleetStore.allocateFreshFriendlyName(requestedName, { excludeId: holder.id }) } catch { rotated = null }
          console.log(`[register] rotating legacy bot row ${holder.id} off ${requestedName} → ${rotated || '(name cleared)'} so ${agentId} can claim it`)
          fleetStore.renameAgentFriendlyName(holder.id, rotated, { reason: 'name-claimed-by-new-holder' })
            .catch(e => console.warn(`[register] could not rotate ${holder.id} off ${requestedName}: ${e.message}`))
        }
      }
      try {
        assignedName = await fleetStore.allocateFreshFriendlyName(requestedName, { excludeId: agentId })
      } catch (e) {
        error(e.message)
        return
      }
    }
    const agent = {
      id: agentId,
      friendly_name: assignedName || null,
      pretty_name: pretty_name ?? existing?.pretty_name ?? null,
      labels: labels || existing?.labels || [],
      registered_at: existing?.registered_at || now,
      last_seen: now,
      dead: false,
      human: !!msg.human,
      is_manager: !!manager,
      metadata: (metadata || existing?.metadata || kind)
        ? { ...(existing?.metadata || {}), ...(metadata || {}), ...(kind ? { kind } : {}) }
        : null,
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
    try {
      await fleetStore.upsertAgent(agent)
      if (agent.human) {
        ws._tldaAgentId = null
        humanPresence.attach(ws, agent.id)
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
    void fleetStore.share?.({ type: eventType, agent_id: agentId, from: agentId, to: agentId, text: eventText })
    const storedAgent = await fleetStore.getAgent?.(agentId) || agent
    broadcastState(storedAgent)
    reply({
      ok: true,
      agent: storedAgent,
      ...(local_agent_id ? { local_agent_id } : {}),
      server_agent_id: storedAgent.id,
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
    const { agent_id, name, labels, manager, metadata, kind } = msg
    let loginAgentId = agent_id || null
    if (loginAgentId) {
      const existing = await fleetStore.getAgent?.(loginAgentId)
      if (!existing || existing.dead) { error(`No live shell for agent "${loginAgentId}". Spawn must create the shell before login.`); return }
      humanPresence.detach(ws)
      agentFleetConnections.set(loginAgentId, ws)
      ws._tldaAgentId = loginAgentId
      const now = new Date().toISOString()
      const agent = {
        ...existing,
        labels: labels || existing.labels || [],
        last_seen: now,
        dead: false,
        human: false,
        is_manager: !!manager,
        metadata: (metadata || existing.metadata || kind)
          ? { ...(existing.metadata || {}), ...(metadata || {}), ...(kind ? { kind } : {}) }
          : null,
      }
      if (agent.metadata?.shell) {
        agent.metadata = { ...agent.metadata, shell: null }
      }
      await fleetStore.upsertAgent(agent)
      const stored = await fleetStore.getAgent?.(loginAgentId) || agent
      const storedAgent = await fleetStore.projectAgentDaemonRoute?.(stored) || stored
      reply({ ok: true, agent: storedAgent, assigned_name: storedAgent.friendly_name || null })
      void fleetStore.share?.({ type: 'login', agent_id: loginAgentId, from: loginAgentId, to: loginAgentId, text: `${agent.friendly_name || loginAgentId} logged in` })
      markAgentAlive(loginAgentId, Date.now(), { source: 'agent-login' })
      touchActivity(loginAgentId)
      spawnLibrarian.observeLiveness({
        type: 'agent-liveness',
        agent_id: loginAgentId,
        state: 'alive',
        ts: now,
      })
      spawnLibrarian.observeLogin(await fleetStore.getAgent?.(loginAgentId) || agent)
      broadcastState(storedAgent)
      return
    }

    if (!name || typeof name !== 'string') { error('missing name'); return }
    const sanitized = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!sanitized) { error('invalid name'); return }
    // Find existing agent by friendly_name
    const agent = await fleetStore.getLiveHumanByFriendlyName(sanitized)
    if (!agent) {
      error(`No agent named "${sanitized}". Register first.`)
      return
    }
    await fleetStore.upsertAgent({ ...agent, last_seen: new Date().toISOString() })
    ws._tldaAgentId = null
    humanPresence.attach(ws, agent.id)
    broadcastState(agent.id)
    reply({ id: agent.id, name: agent.friendly_name, human: !!agent.human })
    return
  }

  if (type === 'spawn') {
    const callerId = ws._tldaAgentId || ws._tldaHumanId
    if (!callerId) { error('spawn requires an authenticated fleet WS identity; call login() first'); return }
    const caller = await fleetStore.getAgent?.(callerId)
    if (!caller) { error(`spawn caller ${callerId} is not registered`); return }
    try {
      reply(await performSpawnRelay(caller, msg))
    } catch (e) {
      error(e)
    }
    return
  }

  if (type === 'resolve-chat-recipients') {
    let filterAst
    try {
      filterAst = parseFilter(msg.to)
    } catch (e) {
      error(`bad filter "${msg.to}": ${e.message}`)
      return
    }
    reply({
      recipients: await fleetStore.resolveChatRecipients(filterAst, {
        from: msg.from || null,
        filter: msg.to || '',
      }),
    })
    return
  }

  if (type === 'store-agents-by-ids') {
    const ids = [...new Set((msg.ids || []).filter(id => typeof id === 'string' && id))]
    if (ids.length > 20) {
      error('store-agents-by-ids accepts at most 20 ids')
      return
    }
    reply(await fleetStore.getAgentsByIds(ids))
    return
  }

  if (type === 'resolve-agent') {
    reply({ agent: await fleetStore.findAgent(msg.agent) || null })
    return
  }

  if (type === 'task-by-id') {
    if (!msg.task_id) {
      error('task-by-id requires task_id')
      return
    }
    reply({ task: await fleetStore.getTask(msg.task_id) || null })
    return
  }

  if (type === 'active-task-by-agent') {
    if (!msg.agent) {
      error('active-task-by-agent requires agent')
      return
    }
    reply({ task: await fleetStore.getTaskByAgent(msg.agent) || null })
    return
  }

  // ---- jsonl-index: daemon pushes JSONL text entries for unified search ----
  if (type === 'jsonl-index') {
    const entries = msg.entries || []
    // Ack immediately (accept-on-queue), then index in the BACKGROUND. Historical
    // search-backfill is best-effort per sign-off (2026-07-22): the FTS insert must
    // not couple to the daemon's request health — a slow/large index batch delaying
    // this reply was timing out the daemon's `jsonl-index` request → WS flap. This
    // reply advances NO offset/liveness cursor on the daemon (that stays keyed to
    // `job-complete`), so the risk is bounded to SEARCH only. A background failure is
    // surfaced loudly (never silent) with its session_ids so the gap is detectable
    // and re-indexable.
    reply({ ok: true })
    measureHotOp('fleet-ws jsonl-index', `entries=${entries.length}`, () => fleetStore.insertSessionEntries(entries))
      .catch(e => recordJsonlIndexBgFailure('fleet-ws', entries, e))
    return
  }

  // ---- fleet-search-stats: small diagnostic surface for search corpus scale ----
  if (type === 'fleet-search-stats') {
    try {
      reply(await fleetStore.getSearchStats())
    } catch (e) { error(e.message) }
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
      const resolveAgentNode = async (node) => {
        if (!node) return new Set()
        switch (node.t) {
          case 'lit': {
            if (node.v?.startsWith?.('fleet:')) return new Set([node.v])
            const ids = node.selector
              ? await fleetStore.resolveAgentSelector(node.selector)
              : await fleetStore.resolveAgentQuery(node.v)
            return new Set(ids)
          }
          case 'me': return new Set([currentSearchActor()])
          case 'and': {
            const left = await resolveAgentNode(node.l)
            const right = await resolveAgentNode(node.r)
            return new Set([...left].filter(id => right.has(id)))
          }
          case 'or': return new Set([...await resolveAgentNode(node.l), ...await resolveAgentNode(node.r)])
          case 'not':
            // Search-side negated agent sets are enforced by the post-filter.
            // Do not broaden the SQL prefilter to "all agents" here.
            return new Set()
          default: return new Set()
        }
      }
      const collectPrefilterIds = async (node, out = new Set()) => {
        if (!node) return out
        switch (node.t) {
          case 'from':
          case 'to':
            for (const id of await resolveAgentNode(node.x)) out.add(id)
            break
          case 'lit':
          case 'me':
            for (const id of await resolveAgentNode(node)) out.add(id)
            break
          case 'and':
          case 'or':
            await collectPrefilterIds(node.l, out); await collectPrefilterIds(node.r, out)
            break
          case 'not':
            break
        }
        return out
      }
      const matchesAgentNode = async (node, id) => {
        if (!node) return true
        switch (node.t) {
          case 'lit':
          case 'me': return (await resolveAgentNode(node)).has(id)
          case 'and': return await matchesAgentNode(node.l, id) && await matchesAgentNode(node.r, id)
          case 'or': return await matchesAgentNode(node.l, id) || await matchesAgentNode(node.r, id)
          case 'not': return !await matchesAgentNode(node.x, id)
          default: return false
        }
      }
      const rowId = (row, key) => row[key] || (key === 'from' ? row.agentId : null)
      const matchesMessageNode = async (node, row) => {
        if (!node) return true
        switch (node.t) {
          case 'from': return await matchesAgentNode(node.x, rowId(row, 'from'))
          case 'to': return await matchesAgentNode(node.x, rowId(row, 'to'))
          case 'lit':
          case 'me': return await matchesAgentNode(node, rowId(row, 'from')) || await matchesAgentNode(node, rowId(row, 'to')) || await matchesAgentNode(node, row.agentId)
          case 'since': return !row.timestamp || row.timestamp >= node.v
          case 'before': return !row.timestamp || row.timestamp < node.v
          case 'type': return row.type === node.v || row.role === node.v
          case 'and': return await matchesMessageNode(node.l, row) && await matchesMessageNode(node.r, row)
          case 'or': return await matchesMessageNode(node.l, row) || await matchesMessageNode(node.r, row)
          case 'not': return !await matchesMessageNode(node.x, row)
          default: return false
        }
      }

      // Support lineage search: agents[] (array of fleet IDs to union)
      let searchAgent = msg.agents?.length ? msg.agents : msg.agent;
      const messageFilter = msg.filterExpression ? parseMessageFilter(msg.filterExpression) : null
      if (messageFilter) {
        const ids = [...await collectPrefilterIds(messageFilter)]
        if (ids.length) searchAgent = ids
      }
      // A typed name fragment (agent:/from:) resolves on the SERVER to the set of
      // fleet ids it refers to — substring over current + historical names,
      // dawn-aware. An empty match yields an impossible id (an empty result set),
      // NOT an unfiltered search.
      if (msg.agentQuery) {
        const ids = await fleetStore.resolveAgentQuery(msg.agentQuery);
        searchAgent = ids.length ? ids : [noMatch];
      }
      const hasText = (msg.query || '').trim().length > 0;
      let results = await fleetStore.searchAll(msg.query || '', {
        limit: msg.limit, agent: searchAgent, role: msg.role, type: msg.eventType, types: msg.eventTypes, since: msg.since, before: msg.before,
        // No keyword + an agent filter → return that agent's whole history
        // instead of FTS-matching the literal query text.
        agentOnly: msg.agentOnly ?? (!hasText && !!searchAgent),
        historyOnly: msg.historyOnly,
        eventOnly: msg.eventOnly,
        fromOnly: msg.fromOnly,
      })
      if (hasText && (msg.naturalAgentQuery || msg.naturalAgentQueries?.length) && !searchAgent && !msg.filterExpression) {
        const naturalQueries = msg.naturalAgentQueries?.length ? msg.naturalAgentQueries : [msg.naturalAgentQuery]
        const ids = [...new Set((await Promise.all(naturalQueries.map(async query => (
          String(query || '').trim() === 'me'
            ? [currentSearchActor()]
            : await fleetStore.resolveAgentSelector(parseUnifiedAgentSelector(query) || { fragment: query })
        )))).flat())]
        if (ids.length) {
          const naturalTextQuery = (msg.naturalTextQuery || '').trim()
          const agentResults = await fleetStore.searchAll(naturalTextQuery, {
            limit: msg.limit, agent: ids, role: msg.role, type: msg.eventType, types: msg.eventTypes, since: msg.since, before: msg.before,
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
      if (messageFilter) {
        const filtered = []
        for (const row of results) {
          if (await matchesMessageNode(messageFilter, row)) filtered.push(row)
        }
        results = filtered
      }
      if (hasText && !msg.historyOnly && !msg.eventOnly) {
        const documentRows = await searchProjectContent(msg.query || '', {
          limit: msg.limit || 50,
          currentProject: msg.currentProject || null,
        })
        if (documentRows.length) {
          const seen = new Set(results.map(r => `${r.source}:${r.id}`))
          for (const row of documentRows) {
            const key = `${row.source}:${row.id}`
            if (!seen.has(key)) {
              seen.add(key)
              results.push(row)
            }
          }
          results = results
            .sort((a, b) => {
              const scoreDelta = (b.score || 0) - (a.score || 0)
              if (scoreDelta) return scoreDelta
              return (b.timestamp ?? '').localeCompare(a.timestamp ?? '')
            })
            .slice(0, msg.limit || 50)
        }
      }
      results = await stampNames(results)
      const context = {}
      if (msg.context_timestamps?.length) {
        for (const ts of msg.context_timestamps) {
          const ctx = await fleetStore.getChatContext(ts, msg.context_window || 3)
          await stampNames(ctx.before); await stampNames(ctx.after)
          context[ts] = ctx
        }
      }
      reply({ results, context })
    } catch (e) { error(e.message) }
    return
  }


  const previewForWake = (raw, max = 120) => {
    const s = String(raw || '')
    return s.length > max ? `${s.slice(0, max)}…` : s
  }
  // Reads the agent, so async — and the read is immediately property-accessed,
  // which is the `(await …)?.x` shape that must not be written as
  // `await …?.x`: that reads .metadata off a Promise and normalises undefined.
  const inboxStatusFor = async (agentId) => {
    const status = (await fleetStore.getAgent(agentId))?.metadata?.inboxStatus
    return normalizeInboxStatus(status)
  }
  const unreadPendingFor = (eventId, agentId) => fleetStore.isUnreadPending(eventId, agentId)
  const inboxCall = (action) => `Call inbox() to ${action}.`
  const wakeText = ({ status, event, preview, action }) => {
    const label = normalizeInboxStatus(status)
    const prefix = label[0].toUpperCase() + label.slice(1)
    return `📬 ${prefix} ${event}: ${preview}\n${inboxCall(action)}`
  }
  const chatWakeText = async (text, agentId) => wakeText({ status: await inboxStatusFor(agentId), event: 'message arrived', preview: previewForWake(text), action: 'read and respond' })
  const delegateWakeText = async (description, agentId) => wakeText({ status: await inboxStatusFor(agentId), event: 'new task assigned', preview: previewForWake(description), action: 'see it' })
  const subscriptionBatchKey = (delivery) => `${delivery.recipient}\u0000${delivery.subscription_id}\u0000${delivery.notification_policy}`
  const reserveSubscriptionBatch = (delivery) => {
    if (delivery.delivery !== 'batched' || !delivery.notifyBy) return delivery
    const key = subscriptionBatchKey(delivery)
    const now = Date.now()
    let state = _subscriptionBatchWakes.get(key)
    if (!state || (Date.parse(state.notifyBy) || 0) <= now) {
      state = {
        key,
        recipient: delivery.recipient,
        subscriptionId: delivery.subscription_id,
        notifyBy: delivery.notifyBy,
        eventIds: new Set(),
        timer: null,
        preview: null,
        from: null,
        traceId: null,
        priority: null,
      }
      _subscriptionBatchWakes.set(key, state)
    }
    return { ...delivery, notifyBy: state.notifyBy, batch_key: key }
  }
  const queueSubscriptionBatchWake = ({ delivery, eventId, text, from, traceId, priority }) => {
    if (delivery.delivery !== 'batched' || !delivery.batch_key) return
    const state = _subscriptionBatchWakes.get(delivery.batch_key)
    if (!state) return
    state.eventIds.add(eventId)
    state.preview ||= text
    state.from ||= from
    state.traceId ||= traceId
    state.priority ||= priority
    if (state.timer) return
    const delay = Math.max(0, Date.parse(state.notifyBy) - Date.now())
    state.timer = setTimeout(() => { (async () => {
      _subscriptionBatchWakes.delete(state.key)
      let pending = false
      for (const id of state.eventIds) {
        if (await unreadPendingFor(id, state.recipient)) { pending = true; break }
      }
      if (!pending) return
      const latestStatus = await inboxStatusFor(state.recipient)
      await requestWake(state.recipient, wakeText({
        status: latestStatus,
        event: 'batched subscription matches ready',
        preview: previewForWake(state.preview),
        action: 'read and respond',
      }), state.from, state.traceId, { sourceEventIds: [...state.eventIds], priority: state.priority, subscriptionId: state.subscriptionId })
    })().catch(e => console.error(`[wake] subscription batch wake failed for ${state.recipient}: ${e?.message || e}`))
    }, delay)
    state.timer.unref?.()
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
    const resolveSingle = async (id) => {
      if (id === SERVER_OWNER_NAME) return SERVER_OWNER_ID
      const a = await fleetStore?.findAgent(id); return a ? a.id : null
    }
    const from = rawFrom ? (await resolveSingle(rawFrom) || rawFrom) : null
    if (!from) { reply({ ok: false, error: 'missing from' }); return }
    let target
    if (event_id != null) {
      target = await fleetStore.getEventById(Number(event_id))
      if (!target) { reply({ ok: false, error: `no message with id ${event_id}` }); return }
      // getEventById aliases the sender column to `from` (not `from_id`).
      if (target.from !== from) { reply({ ok: false, error: `message ${event_id} was not sent by you` }); return }
    } else {
      target = await fleetStore.getLatestChatFrom?.(from)
      if (!target) { reply({ ok: false, error: 'you have no message to amend' }); return }
    }
    // All amends chain off the ORIGINAL chat event. If the target is itself an
    // amend (agent passed an amend id), follow its reference to the original.
    const origId = (target.type === 'amend' && target.metadata?.amends) ? target.metadata.amends : target.id
    const orig = origId === target.id ? target : await fleetStore.getEventById(Number(origId))
    if (!orig || orig.type !== 'chat') { reply({ ok: false, error: `cannot resolve original message for ${target.id}` }); return }

    const ts = new Date().toISOString()
    const meta = {
      amends: orig.id,
      ...(source ? { source } : {}),
      ...(inline_attachments ? { inline_attachments } : {}),
    }
    const inserted = await measureHotOp('fleet-ws amend event insert', `from=${from} to=${orig.to}`, () => fleetStore.insertEventRecord({
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
      const prev = await fleetStore.getChatTempIdResult?.(msg._tempId)
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
    const resolveSingle = async (id) => {
      if (id === SERVER_OWNER_NAME) return SERVER_OWNER_ID
      const a = await fleetStore?.findAgent(id); return a ? a.id : null
    }
    const from = rawFrom ? (await resolveSingle(rawFrom) || rawFrom) : null
    // `to` is a filter expression (e.g. "fleet:skip", "awake & reviewers",
    // "mathy & !goose"). Parse once, then test each agent's label set.
    let filterAst
    try { filterAst = parseFilter(rawTo) } catch (e) { error(`bad filter "${rawTo}": ${e.message}`); return }
    // Resolve over agents, NEVER delivering to dead ones. A dead agent
    // isn't running and can't act on a message; delivering to it also
    // double-fans a filter when a dead twin shares a live agent's name (e.g.
    // an old `preread` row + the live `preread`) → the sender sees their
    // message twice. To reach a dead agent, reanimate it first (it goes live,
    // then matches here). No "prefer the live one" — dead is simply excluded.
    const recipients = await fleetStore.resolveChatRecipients(filterAst, { from, filter: rawTo })
    // Server-owner pseudo-recipient: not in the roster, so evaluate the filter
    // against its literal id/name label set. An empty filter (null) does NOT
    // fan out to the owner.
    if (filterAst && evalExpr(filterAst, [SERVER_OWNER_ID, SERVER_OWNER_NAME])) {
      if (!recipients.includes(SERVER_OWNER_ID)) recipients.push(SERVER_OWNER_ID)
    }
    if (recipients.length === 0) { error(`No recipients matched: ${JSON.stringify(rawTo)}`); return }
    // Update sender heartbeat + activity tracking
    if (from) {
      await fleetStore.updateHeartbeat?.(from)
      touchActivity(from)
    }
    // Resolve CC (still single-string list)
    let ccResolved = cc && cc.length ? cc.map(resolveSingle).filter(Boolean) : null
    if (ccResolved && ccResolved.length === 0) ccResolved = null
    // Copy attachments into the persistent upload dir (once for all recipients),
    // the SAME dir /api/upload uses (RESOLVED_UPLOAD_DIR honors TLDA_UPLOAD_DIR).
    // Previously this wrote to an ephemeral container path that Fly wiped on every
    // redeploy, 404-ing the materialized attachment URLs afterward.
    const processedAttachments = copyAttachmentsToUploadDir(attachments, RESOLVED_UPLOAD_DIR)
    const senderAgent = await fleetStore.getAgent?.(from)
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
      // Resolve subscriptions per recipient — tap labels are matched against this `to`.
      const subscriptionMatches = await fleetStore.resolveSubscriptionDeliveries?.(from, to, 'chat') || []
      const wiretapRecipients = await fleetStore.resolveWiretaps(from, to, 'chat')
      const recipientAgent = await fleetStore.getAgent?.(to)
      const nativeParentId = recipientAgent?.parent_agent_id || null
      const nativeChildHasDirectChannel = nativeParentId
        ? hasOpenFleetSocketForAgent(to) || !!(await fleetStore.getAgentDaemonRoute?.(to))
        : false
      const nativeNeedsParent = !!nativeParentId && !nativeChildHasDirectChannel
      const inboxStatus = normalizeInboxStatus(recipientAgent?.metadata?.inboxStatus)
      const inboxStatusTag = recipientAgent?.metadata?.inboxStatusTag || null
      const deliveryChannel = normalizeDeliveryChannel(recipientAgent?.metadata?.deliveryChannel)
      const nowMs = Date.parse(ts) || Date.now()
      const deliveryDecision = decideSubscriptionDelivery({ policy: 'immediate', priority: basePriority, now: nowMs })
      const subscriptionDeliveries = []
      for (const match of subscriptionMatches) {
        const decision = decideSubscriptionDelivery({ policy: match.notification_policy, priority: basePriority, now: nowMs })
        if (!decision) continue
        subscriptionDeliveries.push({
          recipient: match.recipient,
          subscription_id: match.subscription_id,
          query: match.query,
          notification_policy: match.notification_policy,
          ...decision,
        })
      }
      for (let i = 0; i < subscriptionDeliveries.length; i++) {
        subscriptionDeliveries[i] = reserveSubscriptionBatch(subscriptionDeliveries[i])
      }
      const subscriptionRecipients = [...new Set(subscriptionDeliveries.map(d => d.recipient))]
      const watchRecipients = [...new Set([...(wiretapRecipients || []), ...subscriptionRecipients])]
      const materializableAttachments = (inline_attachments || []).filter(isMaterializableAttachment)
      let combinedMetadata = {
        ...(metadata || {}),
        priority: basePriority,
        trace_id: traceId,
        inbox_delivery: nativeNeedsParent ? 'queued' : deliveryDecision.delivery,
        inbox_status: inboxStatus,
        delivery_channel: deliveryChannel,
        ...(inboxStatusTag ? { inbox_status_tag: inboxStatusTag } : {}),
        ...(deliveryDecision.notifyBy ? { notify_by: deliveryDecision.notifyBy } : {}),
        ...(ccResolved ? { cc: ccResolved } : {}),
        ...(processedAttachments ? { attachments: processedAttachments } : {}),
        ...(inline_attachments ? { inline_attachments } : {}),
        ...(msg._tempId ? { client_temp_id: msg._tempId } : {}),
        ...(watchRecipients.length ? { wiretap_cc: watchRecipients } : {}),
        ...(subscriptionDeliveries.length ? { subscription_deliveries: subscriptionDeliveries } : {}),
        ...(outContext ? { context: outContext } : {}),
        ...(preambleRef ? { preambleRef } : {}),
        ...(chatReminder ? { chatReminder } : {}),
        ...(source ? { source } : {}),
      }
      if (recipientAgent && !recipientAgent.human && materializableAttachments.length) {
        combinedMetadata = initializeRecipientRefs(combinedMetadata, to, materializableAttachments, { sourceAgent: from })
      }
      const inserted = await measureHotOp('fleet-ws chat event insert', `from=${from} to=${to} bytes=${text.length}`, () => fleetStore.insertEventRecord({
        type: 'chat',
        timestamp: ts,
        from,
        to,
        text,
        metadata: Object.keys(combinedMetadata).length ? combinedMetadata : null,
        unread: true,
      }, { notify: false }))
      const eventId = Number(inserted.id)
      if (nativeNeedsParent) {
        await fleetStore.createNativeSubagentNotification?.({
          eventId,
          parentAgentId: nativeParentId,
          childAgentId: to,
          senderAgentId: from,
          createdAt: ts,
        })
      }
      if (recipientAgent && !recipientAgent.human && materializableAttachments.length) {
        combinedMetadata = finalizeRecipientPlaceholderPaths(combinedMetadata, {
          recipientId: to,
          eventId,
          sourceAgent: from,
          timestamp: ts,
          attachments: materializableAttachments,
        })
        await patchEventMetadata(eventId, () => combinedMetadata, { broadcast: false })
      }
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
        delivery: nativeNeedsParent ? 'queued' : deliveryDecision.delivery,
        deliveryChannel,
        wokeRecipient: nativeNeedsParent ? false : deliveryDecision.wokeRecipient,
        notifyBy: deliveryDecision.notifyBy,
      })
      // Echo _tempId on the broadcast so a client whose WS reply was lost during
      // a hiccup can still bind this echo to its orphaned optimistic entry
      // (the reply, not the DB row, is what normally carries _tempId).
      insertedEvents.push({ id: eventId, type: 'chat', timestamp: ts, from_id: from, to_id: to, text, metadata: Object.keys(combinedMetadata).length ? combinedMetadata : null, materializableAttachments, ...(msg._tempId ? { _tempId: msg._tempId } : {}) })
      if (deliveryDecision.delivery === 'notified') {
        if (nativeNeedsParent) {
          wakeRequests.push({
            to: nativeParentId,
            text: `📬 Message queued for native subagent ${recipientAgent.friendly_name || to}.`,
            asker: from,
            traceId,
            source: { sourceEventId: eventId, priority: basePriority },
          })
        } else {
          wakeRequests.push({ to, text: await chatWakeText(text, to), asker: from, traceId, source: { sourceEventId: eventId, priority: basePriority } })
        }
      }
      for (const subDelivery of subscriptionDeliveries) {
        if (subDelivery.delivery === 'notified') {
          const subscriptionStatus = await inboxStatusFor(subDelivery.recipient)
          wakeRequests.push({
            to: subDelivery.recipient,
            text: wakeText({ status: subscriptionStatus, event: 'subscription match', preview: previewForWake(text), action: 'read and respond' }),
            asker: from,
            traceId,
            source: { sourceEventId: eventId, priority: basePriority, subscriptionId: subDelivery.subscription_id },
          })
        } else if (subDelivery.delivery === 'batched' && subDelivery.notifyBy) {
          queueSubscriptionBatchWake({ delivery: subDelivery, eventId, text, from, traceId, priority: basePriority })
        }
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
      const recipient = await fleetStore.getAgent?.(to)
      if (recipient && !recipient.human) spawnLibrarian.observeDelivery(to, deliveredAt)
    }
    // Awaited in sequence, which is exactly what the synchronous version did:
    // each wake ran to completion before the next began.
    for (const wake of wakeRequests) await requestWake(wake.to, wake.text, wake.asker, wake.traceId, wake.source)

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
        if (approval?.agent_id) {
          const agent = await fleetStore.findAgent?.(approval.agent_id)
          const { seat } = await agentRouteOrError(agent)
          if (seat) sendDaemonDurable(seat.daemon_key, 'send-text', terminalRpcPayload(agent, seat, {
            text: key,
            enter: false,
          })).catch(e => console.error(`[plan-approval] keystroke failed: ${e.message}`))
        }
      }
    }
    // "let's outline/plan" keyword: force plan mode on recipient agents
    const planKeywordMatch = from === SERVER_OWNER_ID && text.match(/\blet'?s\s+(\w+\s+){0,2}(outline|plan)\b/i)
    if (planKeywordMatch) {
      const keyword = planKeywordMatch[2].toLowerCase()
      for (const r of recipients) {
        const agent = await fleetStore.findAgent(r)
        const { seat } = await agentRouteOrError(agent)
        if (!seat) continue
        sendDaemonDurable(seat.daemon_key, 'send-text', terminalRpcPayload(agent, seat, {
          text: '/plan',
          enter: true,
        })).catch(e => console.error(`[outline-keyword] plan mode failed for ${r}: ${e.message}`))
        if (keyword === 'outline') {
          setTimeout(() => {
            sendDaemonDurable(seat.daemon_key, 'send-text', terminalRpcPayload(agent, seat, {
              text: 'Invoke the outline-before-writing skill now. Write your outline in the plan file, then share the plan file path in chat so it appears as a tappable note.',
              enter: true,
            })).catch(e => console.error(`[outline-keyword] skill nudge failed for ${r}: ${e.message}`))
          }, 2000)
        }
        await fleetStore.updateAgentMeta?.(agent.id, { inPlanMode: true, planModeType: keyword })
        console.log(`[outline-keyword] forced plan mode on ${agent.friendly_name || r} (keyword: ${keyword})`)
      }
      broadcastState(recipients)
    }
    return
  }

  if (type === 'heartbeat') {
    const { agent } = msg
    if (agent) await fleetStore.updateHeartbeat?.(agent)
    reply({ ok: true })
    return
  }

  if (type === 'viewing') {
    const { agent, context } = msg
    if (agent && context) _viewingContext.set(agent, { ...context, updatedAt: Date.now() })
    reply({ ok: true })
    return
  }

  if (type === 'delegate') {
    const {
      agent: agentQuery,
      description,
      message: taskMsg,
      success_criteria,
      blocked_by,
      from,
      requires_approval,
      notify_at,
      notify_every,
      expires_at,
      allow_pending_agent,
      operation_id,
      task_id,
    } = msg
    if (!agentQuery || (!description && !task_id)) { error('missing agent or description'); return }
    if (task_id && !taskMsg) { error('missing message for existing task delegation'); return }
    const previous = operation_id ? await fleetStore.getDelegateOperationResult?.(operation_id) : null
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
    const resolved = await fleetStore.findAgent(agentQuery) || (
      allow_pending_agent && typeof agentQuery === 'string' && agentQuery.startsWith('fleet:')
        ? { id: agentQuery, friendly_name: null }
        : null
    )
    if (!resolved) { error(`agent not found: ${agentQuery}`); return }
    const existingTask = task_id ? await fleetStore.getTask?.(task_id) : null
    if (task_id && !existingTask) { error(`task not found: ${task_id}`); return }
    if (existingTask && (existingTask.status === 'done' || existingTask.status === 'retracted')) { error(`cannot delegate closed task: ${task_id}`); return }
    const fromAgent = from ? await fleetStore.findAgent(from) : null
    const caller = fromAgent || (from ? { id: from } : null)
    if (existingTask && !await canReportTask({ caller, task: existingTask, fleetStore })) {
      error('not authorized to delegate this task; only its assignee, delegator, their management chains, or a human may do so'); return
    }
    const taskId = previous?.taskId || task_id || `${resolved.id.slice(0, 10)}-${Date.now().toString(36)}`
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    const notifyAtMs = notify_at ? Date.parse(notify_at) : nowMs
    const expiresAtMs = expires_at ? Date.parse(expires_at) : Infinity
    if (notify_at && !Number.isFinite(notifyAtMs)) { error('notify_at must be an ISO timestamp'); return }
    if (notify_every != null && (!Number.isFinite(Number(notify_every)) || Number(notify_every) <= 0)) { error('notify_every must be a positive number of seconds'); return }
    if (expires_at && !Number.isFinite(expiresAtMs)) { error('expires_at must be an ISO timestamp'); return }
    if (Number.isFinite(expiresAtMs) && Number.isFinite(notifyAtMs) && expiresAtMs <= notifyAtMs) { error('expires_at must be later than notify_at'); return }
    const metadata = {
      trace_id: traceId,
      ...(operation_id ? { client_operation_id: operation_id } : {}),
      ...(requires_approval ? { requires_approval: true } : {}),
      ...(allow_pending_agent && !await fleetStore.findAgent(agentQuery) ? { pending_spawn_delegate: true } : {}),
      ...(task_id ? { transfer: true, previous_agent: existingTask.agent } : {}),
      notify_at: new Date(notifyAtMs).toISOString(),
      ...(notify_every != null ? { notify_every: Number(notify_every) } : {}),
      ...(expires_at ? { expires_at: new Date(expiresAtMs).toISOString() } : {}),
    }
    const delegateMetadata = {
      trace_id: traceId,
      ...(operation_id ? { client_operation_id: operation_id } : {}),
      fromLabel: fromAgent?.friendly_name || from || '',
      toLabel: resolved.friendly_name || resolved.id,
      criteria: success_criteria || [],
      message: taskMsg || '',
      ...(task_id ? { transfer: true, previous_agent: existingTask.agent } : {}),
    }
    let delegateEvent
    if (existingTask) {
      const transfer = await transferTaskLifecycle({
        fleetStore,
        task: existingTask,
        fromAgentId: from || null,
        toAgentId: resolved.id,
        message: taskMsg,
        delegatedAt: now,
        eventMetadata: delegateMetadata,
        eventOptions: { unread: notifyAtMs <= nowMs },
        taskMetadataPatch: {
          notify_at: new Date(notifyAtMs).toISOString(),
          notify_every: notify_every != null ? Number(notify_every) : undefined,
          expires_at: expires_at ? new Date(expiresAtMs).toISOString() : undefined,
        },
      })
      delegateEvent = transfer.event
    } else {
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
      await fleetStore.upsertTask(task)
      delegateEvent = await fleetStore.delegate?.(from, resolved.id, taskId, description, delegateMetadata, {
        unread: !Number.isFinite(notifyAtMs) || notifyAtMs <= Date.now(),
      })
    }
    if (existingTask) {
      const pendingTimers = await fleetStore.listPendingTimerEvents?.() || []
      for (const timer of pendingTimers) {
        if (timer.metadata?.task_id === taskId) await serverTimerScheduler?.cancel(Number(timer.id))
      }
    }
    const notifyEverySeconds = notify_every != null ? Number(notify_every) : null
    const reminderAtMs = notifyAtMs > nowMs
      ? notifyAtMs
      : notifyEverySeconds
        ? nowMs + notifyEverySeconds * 1000
        : NaN
    if (Number.isFinite(reminderAtMs) && reminderAtMs < expiresAtMs) {
      await fleetStore.share({
        type: 'timer',
        from: from || resolved.id,
        to: resolved.id,
        text: `⏱ ${description}`,
        metadata: {
          pending: true,
          fire_at: new Date(reminderAtMs).toISOString(),
          message: `Task reminder: ${description}`,
          task_id: taskId,
          ...(notifyEverySeconds ? { repeat_seconds: notifyEverySeconds } : {}),
          ...(expires_at ? { expires_at: new Date(expiresAtMs).toISOString() } : {}),
        },
        unread: false,
      })
      await serverTimerScheduler?.refresh()
    }
    if (Number.isFinite(expiresAtMs)) {
      await fleetStore.share({
        type: 'timer',
        from: from || resolved.id,
        to: resolved.id,
        text: `Task expired: ${description}`,
        metadata: {
          pending: true,
          fire_at: new Date(expiresAtMs).toISOString(),
          task_id: taskId,
          task_expiry: true,
        },
        unread: false,
      })
      await serverTimerScheduler?.refresh()
    }
    controlPlaneTraces.append({
      trace_id: traceId,
      component: 'fleet-store',
      operation: existingTask ? 'delegate.transfer' : 'delegate.insert',
      status: 'stored',
      detail: { task_id: taskId, event_id: delegateEvent?.id, from, to: resolved.id },
    })
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
    if (!Number.isFinite(notifyAtMs) || notifyAtMs <= Date.now()) {
      await requestWake(resolved.id, await delegateWakeText(description, resolved.id), from, traceId, { sourceEventId: delegateEvent?.id || null, sourceTaskId: taskId, priority: 'urgent' })
    }
    return
  }

  if (type === 'task-done') {
    const { agent: rawAgent, task_id, skip_qa, approval_id } = msg
    if (!rawAgent) { error('missing agent'); return }
    const agent = (await fleetStore.findAgent(rawAgent))?.id || rawAgent
    const task = task_id
      ? await fleetStore.getTask?.(task_id)
      : await fleetStore.getTaskByAgent?.(agent)
    if (!task) { error('no active task'); return }
    if (task.metadata?.requires_approval) {
      if (!approval_id) { error('This task requires approval. Pass approval_id (event ID of a human approval message).'); return }
      const evt = await fleetStore.getEventById(approval_id)
      if (!evt) { error(`approval_id ${approval_id} not found`); return }
      const fromAgent = (evt.from_id || evt.from) ? await fleetStore.getAgent(evt.from_id || evt.from) : null
      if (!fromAgent?.human) { error(`approval_id ${approval_id} is not from a human`); return }
    }
    if (!skip_qa && fleetStore.getQaAgentIds) {
      const qaIds = await fleetStore.getQaAgentIds()
      if (qaIds.length > 0) {
        const qaStatus = await fleetStore.getQaStatus(task.id)
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
    const caller = await fleetStore.findAgent?.(rawAgent)
    const agent = caller?.id || rawAgent
    const task = task_id
      ? await fleetStore.getTask?.(task_id)
      : await fleetStore.getTaskByAgent?.(agent)
    if (!task) { error('no active task'); return }
    if (task_id && !await canReportTask({ caller: caller || { id: agent }, task, fleetStore })) {
      error('not authorized to report on this task; only its assignee, delegator, their management chains, or a human may do so'); return
    }
    if (close && task.metadata?.requires_approval) {
      if (!approval_id) { error('This task requires approval. Pass approval_id (event ID of a human approval message).'); return }
      const evt = await fleetStore.getEventById(approval_id)
      if (!evt) { error(`approval_id ${approval_id} not found`); return }
      const fromAgent = (evt.from_id || evt.from) ? await fleetStore.getAgent(evt.from_id || evt.from) : null
      if (!fromAgent?.human) { error(`approval_id ${approval_id} is not from a human`); return }
    }

    const previous = await fleetStore.getReportCloseOperationResult?.(operation_id)
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
      const sender = await fleetStore.getAgent?.(agent)
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

    if (close && !closeEventId) {
      const closeReason = reason || 'done'
      const { eventId } = await completeTaskLifecycle({
        fleetStore,
        agentId: agent,
        task,
        description: task.description,
        taskMetadataPatch: { close_reason: closeReason, closed_by: agent },
        eventMetadata: {
          trace_id: traceId,
          client_operation_id: operation_id,
          report_event_id: reportEventId,
          close_reason: closeReason,
          closed_by: agent,
        },
      })
      closeEventId = eventId || null
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
      task_description: task.description,
      report_event_id: reportEventId,
      chat_event_id: chatEventId,
      close_event_id: closeEventId,
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
    const task = await fleetStore.getTask?.(task_id)
    if (!task) { error('task not found'); return }
    await fleetStore.removeTask?.(task_id)
    broadcastState()
    reply({ ok: true, task_id })
    return
  }

  if (type === 'my-task') {
    const agentId = msg.agent
    if (!agentId) { error('missing agent'); return }
    const tasks = await fleetStore.getActiveTasksByAgentLimited?.(agentId, MY_TASK_TASK_LIMIT) || []
    const taskCount = await fleetStore.getActiveTaskCountByAgent?.(agentId) ?? tasks.length
    const task = tasks[0] || await fleetStore.getTaskByAgent?.(agentId) || null
    const messages = await fleetStore.getInboxDeliveriesLimited?.(agentId, MY_TASK_DELIVERY_LIMIT) || []
    const messageCount = await fleetStore.getInboxDeliveryCount?.(agentId) ?? messages.length
    reply({
      task,
      tasks: tasks.length ? tasks : (task ? [task] : []),
      messages,
      counts: {
        tasks: taskCount,
        messages: messageCount,
        task_limit: MY_TASK_TASK_LIMIT,
        message_limit: MY_TASK_DELIVERY_LIMIT,
        tasks_truncated: taskCount > tasks.length,
        messages_truncated: messageCount > messages.length,
      },
    })
    return
  }

  if (type === 'ack-inbox') {
    const agentId = msg.agent
    if (!agentId) { error('missing agent'); return }
    const eventIds = Array.isArray(msg.event_ids) ? msg.event_ids : []
    const readIds = await fleetStore.markEventsRead?.(agentId, eventIds) || []
    await fleetStore.updateHeartbeat?.(agentId)
    if (readIds.length) broadcastEvent('read-receipt', { event_ids: readIds, agent: agentId })
    reply({ ok: true, event_ids: readIds })
    return
  }

  if (type === 'inbox-status') {
    const { agent, status, tag } = msg
    if (!agent) { error('missing agent'); return }
    if (!INBOX_STATUSES.includes(status)) { error(`bad inbox status: ${status}`); return }
    await fleetStore.updateAgentMeta?.(agent, { inboxStatus: status, inboxStatusTag: tag || null })
    broadcastState()
    reply({ ok: true, agent, status, tag: tag || null })
    return
  }

  if (type === 'delivery-channel') {
    const { caller: callerQuery, agent: agentQuery, channel: rawChannel } = msg
    if (!callerQuery) { error('missing caller'); return }
    const channel = validateDeliveryChannel(rawChannel)
    if (!channel) { error(`bad delivery channel: ${rawChannel}; use ${DELIVERY_CHANNELS.join(', ')}`); return }
    const caller = await fleetStore.findAgent?.(callerQuery)
    if (!caller) { error(`caller not found: ${callerQuery}`); return }
    const row = await fleetStore.findAgent?.(agentQuery || caller.id)
    if (!row) { error(`agent not found: ${agentQuery || caller.id}`); return }
    const targetLabel = row.friendly_name || row.id
    const self = caller.id === row.id
    if (!self && !await fleetStore.isDelegatorForAgent?.(caller.id, row.id)) {
      error(`Cannot set delivery channel for ${targetLabel}: you are not that agent's manager. Delegate them a task first if you mean to take responsibility for their delivery channel, then retry.`)
      return
    }
    if (channel === 'tmux') {
      const route = resolveRpc('resolve-agent-route', row)
      if (route.via === 'none') { error(route.error); return }
      try {
        await sendDaemonEphemeral(route.machine_id, 'resolve-agent-route', { agent_id: row.id })
      } catch (e) {
        error(e.message)
        return
      }
    }
    await fleetStore.updateAgentMeta?.(row.id, { deliveryChannel: channel })
    broadcastState()
    reply({ ok: true, agent: row.id, target_label: targetLabel, caller: caller.id, channel, self })
    return
  }

  if (type === 'update-agent') {
    const { agent: agentData } = msg
    if (agentData?.id) {
      const forbidden = protectedAgentEditFields(agentData)
      if (forbidden.length) {
        error(`Cannot edit immutable identity/runtime route fields with update-agent: ${forbidden.join(', ')}`)
        return
      }
      if (agentData.friendly_name) {
        const cols = await fleetStore.checkNameAvailable([agentData.friendly_name], { excludeId: agentData.id, asFriendlyName: true })
        if (cols.length) {
          error(`Name "${agentData.friendly_name}" unavailable: ${cols.map(c => c.kind === 'pseudo_label' ? 'reserved routing label' : `collides with ${c.kind} on ${c.agent_id}`).join('; ')}`)
          return
        }
      }
      try {
        await fleetStore.upsertAgent(agentData)
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
      if (startedAt !== undefined) await emitTurnEnded(msg.agentId, startedAt)
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
      await fleetStore.updateAgentStatus?.(agentId, state, tool, ts)
      // Pane-status classification is a DISPLAY feed (thinking/idle/...), not a
      // liveness authority. It used to also publish alive/not-alive and fought
      // the daemon's process-observation liveness for the same fact — the
      // 7/17 classifier-vs-liveness flapping. Skip's order: delete the
      // duplicate publisher, don't referee it. Liveness truth comes from
      // agent-liveness (process observation) and login only.
      runtimeStatusStore.updateActivity(agentId, state, { tool, atMs: Date.parse(ts) || Date.now() })
      broadcastEvent('agent-status', { agent: agentId, state, tool, ts })
      broadcastState()
    }
    reply({ ok: true })
    return
  }

  // ---- rename ----
  if (type === 'rename') {
    const { agent: agentQuery, name: newName } = msg
    if (!agentQuery || newName == null) { error('agent and name required'); return }
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (newName) {
      const conflict = await fleetStore.nameTakenByOther(newName, agent.id)
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

  // ---- lineage-stack operations ----
  if (type === 'lineage-stack') {
    const lineage = await fleetStore.getLineage(msg.lineage)
    if (!lineage) { error('lineage not found'); return }
    reply({
      lineage,
      stack: await fleetStore.getStack(lineage.id),
      history: await fleetStore.getLineageHistory(lineage.id),
    })
    return
  }

  if (type === 'lineage-push' || type === 'lineage-pop' || type === 'lineage-swap') {
    const assignments = Array.isArray(msg.name_assignments) ? msg.name_assignments : []
    const normalized = assignments.map(item => ({
      fleetId: item?.fleet_id,
      friendlyName: item?.friendly_name ?? null,
      prettyName: item?.pretty_name,
      labels: Array.isArray(item?.labels) ? item.labels : undefined,
    }))
    if (normalized.some(item => !item.fleetId)) { error('every name assignment requires fleet_id'); return }
    if (new Set(normalized.map(item => item.fleetId)).size !== normalized.length) {
      error('duplicate fleet_id in name assignments')
      return
    }
    try {
      let result
      if (type === 'lineage-push') {
        const incoming = await fleetStore.findAgent(msg.agent)
        if (!incoming) { error('incoming agent not found'); return }
        const lineage = await fleetStore.getLineage(msg.lineage) || await fleetStore.getOrCreateLineage(msg.lineage)
        const allowed = new Set([...(await fleetStore.getStack(lineage.id)).map(item => item.id), incoming.id])
        if (normalized.some(item => !allowed.has(item.fleetId))) { error('name assignment is outside the affected lineage'); return }
        result = await fleetStore.pushExisting(lineage.id, incoming.id, normalized, {
          actorId: msg.caller || null,
          reason: msg.reason || 'push-existing',
        })
      } else if (type === 'lineage-pop') {
        const lineage = await fleetStore.getLineage(msg.lineage)
        if (!lineage) { error('lineage not found'); return }
        const allowed = new Set((await fleetStore.getStack(lineage.id)).map(item => item.id))
        if (normalized.some(item => !allowed.has(item.fleetId))) { error('name assignment is outside the affected lineage'); return }
        result = await fleetStore.pop(lineage.id, normalized, {
          actorId: msg.caller || null,
          reason: msg.reason || 'pop',
        })
      } else {
        const recipient = await fleetStore.findAgent(msg.recipient)
        const incoming = await fleetStore.findAgent(msg.agent)
        if (!recipient || !incoming) { error('swap recipient and incoming agent are required'); return }
        const active = await fleetStore.getActiveStackEntry(recipient.id)
        if (!active) { error('swap recipient is not on an active lineage stack'); return }
        const allowed = new Set([...(await fleetStore.getStack(active.lineage_id)).map(item => item.id), incoming.id])
        if (normalized.some(item => !allowed.has(item.fleetId))) { error('name assignment is outside the affected lineage'); return }
        result = await fleetStore.swap(recipient.id, incoming.id, normalized, {
          actorId: msg.caller || null,
          reason: msg.reason || 'swap',
        })
      }
      broadcastState(result.affected)
      reply({ ok: true, ...result })
    } catch (e) {
      error(e.message)
    }
    return
  }

  // ---- label ----
  if (type === 'label') {
    const { agent: agentQuery, operation, labels } = msg
    const validValue = operation === 'replace'
      ? Array.isArray(labels)
      : (operation === 'add' || operation === 'remove')
        && (typeof labels === 'string' || Array.isArray(labels))
    if (!agentQuery || !validValue) {
      error('agent, operation, and labels are required; replace requires a list')
      return
    }
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const result = await fleetStore.mutateAgentLabels(agent.id, operation, labels, { actorId: msg.caller || agent.id })
    broadcastState()
    reply({ ok: true, ...result })
    return
  }

  // ---- kick ----
  if (type === 'kick') {
    const { agent: agentQuery } = msg
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const route = resolveRpc('kick', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendDaemonDurable(route.machine_id, 'kick', { agent_id: agent.id })
      reply(result)
    } catch (e) { error(e.message) }
    return
  }

  // ---- kill-session ----
  if (type === 'kill-session') {
    const { agent: agentQuery } = msg
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const { seat, error: seatError } = await agentRouteOrError(agent)
    if (!seat) { error(seatError); return }
    try {
      const result = await sendDaemonDurable(seat.daemon_key, 'kill-session', terminalRpcPayload(agent, seat))
      markAgentNotAlive(agent.id, { source: 'ws-kill-session', reason: 'operator killed session' })
      markUnroutedNativeDescendantsNotAlive(agent.id, { source: 'ws-kill-session', reason: 'native parent session killed' })
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
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const { seat, error: seatError } = await agentRouteOrError(agent)
    if (!seat) { error(seatError); return }
    try {
      const result = await sendDaemonDurable(seat.daemon_key, 'kill-session', terminalRpcPayload(agent, seat))
      markAgentNotAlive(agent.id, { source: 'ws-hibernate-session', reason: 'operator hibernated session' })
      markUnroutedNativeDescendantsNotAlive(agent.id, { source: 'ws-hibernate-session', reason: 'native parent session hibernated' })
      broadcastState()
      reply({ ok: true, agent: agent.friendly_name || agent.id, ...result })
    } catch (e) { error(e.message) }
    return
  }

  // ---- interrupt ----
  if (type === 'interrupt') {
    const { agent: agentQuery } = msg
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const route = resolveRpc('interrupt', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendDaemonDurable(route.machine_id, 'interrupt', { agent_id: agent.id })
      reply({ ok: true, agent: agent.friendly_name || agent.id, ...result })
    } catch (e) { error(e.message) }
    return
  }

  // ---- soft-interrupt ----
  if (type === 'soft-interrupt') {
    const { agent: agentQuery } = msg
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const route = resolveRpc('soft-interrupt', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendDaemonDurable(route.machine_id, 'soft-interrupt', { agent_id: agent.id })
      reply({ ok: true, agent: agent.friendly_name || agent.id, ...result })
    } catch (e) { error(e.message) }
    return
  }

  // (The authoritative `spawn` handler is above — it runs through
  // performAuthorizedSpawn / authorizeSpawn and returns for every spawn message.
  // A second, older `if (type === 'spawn')` block used to live here that sent the
  // daemon RPC WITHOUT permission authorization or a permissionGrant; it was dead
  // (unreachable after the first handler's return) and a latent self-escalation
  // bypass, so it was removed. Do not reintroduce an unauthorized spawn path.)

  // ---- send-key ----
  if (type === 'send-key') {
    const { agent: agentQuery, key } = msg
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const route = resolveRpc('send-key', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendDaemonDurable(route.machine_id, 'send-key', { agent_id: agent.id, key })
      reply(result)
    } catch (e) { error(e.message) }
    return
  }

  // ---- send-text ----
  if (type === 'send-text') {
    const { agent: agentQuery, text, enter } = msg
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const route = resolveRpc('send-text', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendDaemonDurable(route.machine_id, 'send-text', { agent_id: agent.id, text, enter: enter !== false })
      reply(result)
    } catch (e) { error(e.message) }
    return
  }

  // ---- capture-pane ----
  if (type === 'capture-pane') {
    const { agent: agentQuery, lines } = msg
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const route = resolveRpc('capture-pane', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      const result = await sendDaemonEphemeral(route.machine_id, 'capture-pane', { agent_id: agent.id, lines: lines || 50 })
      reply(result)
    } catch (e) { error(e.message) }
    return
  }

  // ---- check-alive ----
  if (type === 'check-alive') {
    const { agent: agentQuery } = msg
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const { seat, error: seatError } = await agentRouteOrError(agent)
    if (!seat) { error(seatError); return }
    try {
      const result = await sendDaemonEphemeral(seat.daemon_key, 'check-alive', { agent_id: agent.id })
      const liveness = livenessFromCheckAliveResult(agent.id, result)
      recordExplicitCheckAliveLiveness(liveness)
      reply(liveness)
    } catch (e) { error(e.message) }
    return
  }

  // ---- plan-mode-respond ----
  if (type === 'plan-mode-respond') {
    const { agent: agentQuery, response } = msg
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    if (!isPlanModeResponse(response)) { error('response must be approve, supervised, or reject'); return }
    const { seat, error: seatError } = await agentRouteOrError(agent)
    if (!seat) { error(seatError); return }
    try {
      let result = await sendDaemonDurable(seat.daemon_key, 'send-text', terminalRpcPayload(agent, seat, { text: planModeResponseKey(response), enter: false }))
      await fleetStore.updateAgentMeta?.(agent.id, { permission_mode: null, inPlanMode: false, planModeType: null })
      // Persist response on the plan_approval event
      const pending = pendingPlanApprovals.get(agent.id)
      if (pending?.eventId) {
        const now = new Date().toISOString()
        const patch = response === 'reject' ? { rejectedAt: now } : { approvedAt: now, mode: response }
        try {
          await fleetStore.updateEventMetadata(pending.eventId, patch)
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
    const agent = await fleetStore.findAgent(agentQuery)
    if (!agent) { error('agent not found'); return }
    const { seat, error: seatError } = await agentRouteOrError(agent)
    if (!seat) { error(seatError); return }
    try {
      const parseCCMode = (pane) => {
        if (/plan mode on/i.test(pane)) return 'plan'
        if (/accept edits on/i.test(pane)) return 'acceptEdits'
        return 'default'
      }
      const cap1 = await sendDaemonEphemeral(seat.daemon_key, 'capture-pane', terminalRpcPayload(agent, seat, { lines: 5 }))
      const currentMode = parseCCMode(cap1?.content || '')
      const btabs = currentMode === 'plan' ? 1 : currentMode === 'acceptEdits' ? 1 : 2
      for (let i = 0; i < btabs; i++) {
        await sendDaemonEphemeral(seat.daemon_key, 'send-key', terminalRpcPayload(agent, seat, { key: 'BTab' }))
        if (i < btabs - 1) await new Promise(r => setTimeout(r, 150))
      }
      if (btabs > 0) await new Promise(r => setTimeout(r, 300))
      const cap2 = await sendDaemonEphemeral(seat.daemon_key, 'capture-pane', terminalRpcPayload(agent, seat, { lines: 5 }))
      const finalMode = parseCCMode(cap2?.content || '')
      await fleetStore.updateAgentMeta?.(agent.id, { permission_mode: finalMode === 'default' ? null : finalMode })
      broadcastState()
      reply({ ok: true, mode: finalMode, was: currentMode })
    } catch (e) { error(e.message) }
    return
  }

  // ---- mark-event-read ----
  if (type === 'mark-event-read') {
    const { event_id, agent: rawAgent } = msg
    if (!event_id || !rawAgent) { error('event_id and agent required'); return }
    const agent = await fleetStore.findAgent(rawAgent)
    const agentId = agent?.id || rawAgent
    const changed = await fleetStore.markEventRead?.(parseInt(event_id, 10), agentId)
    if (changed) broadcastEvent('read-receipt', { event_ids: [parseInt(event_id, 10)], agent: agentId })
    reply({ ok: true, changed: !!changed })
    return
  }

  // ---- prompt-respond ----
  if (type === 'prompt-respond') {
    const { eventId, response } = msg
    if (!eventId) { error('Missing eventId'); return }
    try {
      const patch = response === 'approved'
        ? { approvedAt: new Date().toISOString() }
        : { rejectedAt: new Date().toISOString() }
      await fleetStore.updateEventMetadata(eventId, patch)
      broadcastEvent('event-update', { id: eventId, metadata_patch: patch })
      reply({ ok: true })
    } catch (e) { error(e.message) }
    return
  }

  // ---- terminal-card ----
  if (type === 'terminal-card') {
    const { from: rawFrom, reason } = msg
    if (!rawFrom) { error('missing from'); return }
    const agent = await fleetStore.findAgent(rawFrom)
    if (!agent) { error(`Agent not found: "${rawFrom}"`); return }
    const route = resolveRpc('resolve-agent-route', agent)
    if (route.via === 'none') { error(route.error); return }
    try {
      await sendDaemonEphemeral(route.machine_id, 'resolve-agent-route', { agent_id: agent.id })
    } catch (e) {
      error(e.message)
      return
    }
    const label = agent.friendly_name || agent.id.slice(0, 12)
    const text = reason ? `${label}: ${reason}` : `${label}: terminal requested`
    const event = await fleetStore.share?.({
      type: 'terminal_card', from: agent.id, to: SERVER_OWNER_ID, text,
      metadata: JSON.stringify({ reason: reason || null, agentId: agent.id, agentLabel: label }),
    })
    reply({ ok: true, event_id: event?.id })
    return
  }

  // ---- subscription rows ----
  if (type === 'subscribe') {
    const { caller: callerQuery, target: targetQuery, query, notification_policy: policy } = msg
    if (!callerQuery || !query || !policy) { error('missing caller, query, or notification_policy'); return }
    const caller = await fleetStore.findAgent?.(callerQuery)
    const target = await fleetStore.findAgent?.(targetQuery || callerQuery)
    if (!caller || !target) { error('caller or target not found'); return }
    if (caller.id !== target.id && !await fleetStore.isDelegatorForAgent?.(caller.id, target.id)) {
      error('not authorized to configure subscriptions for that target'); return
    }
    if (policy !== 'immediate' && policy !== 'hold' && !/^batch\(.+\)$/.test(policy)) {
      error('notification_policy must be immediate, hold, or batch(spec)'); return
    }
    if (/^batch\(.+\)$/.test(policy) && !decideSubscriptionDelivery({ policy })) {
      error('unsupported batch notification_policy; use a duration like batch(5m), batch(30s), or batch(1h)'); return
    }
    const docMatch = query.match(/^doc:([^\s]+)$/i)
    if (!docMatch && (/\b(doc|event|type|since|after|before|agent):/i.test(query) || /\bto:me\b/i.test(query))) {
      error('unsupported subscription query term: stage-1 supports directional fleet labels or a single doc:<name> query'); return
    }
    if (!docMatch) {
      try { parseFilter(query) } catch (e) { error(`bad subscription query: ${e.message}`); return }
    }
    let adapter = 'wiretap'
    let adapterId = null
    try {
      if (docMatch) {
        adapter = 'document_monitor'
      } else {
        const tap = await fleetStore.addWiretap(target.id, query, null)
        adapterId = tap.id
      }
    } catch (e) { error(`subscription adapter failed: ${e.message}`); return }
    const subscription = await fleetStore.addSubscription({ owner: target.id, query, notificationPolicy: policy, createdBy: caller.id, adapter, adapterId })
    // Arm after the row exists — the subscriber set is read from the table.
    if (docMatch) tldaFeedback.arm(docMatch[1])
    reply(subscription)
    return
  }

  if (type === 'subscriptions') {
    const { caller: callerQuery, target: targetQuery } = msg
    if (!callerQuery) { error('missing caller'); return }
    const caller = await fleetStore.findAgent?.(callerQuery)
    const target = await fleetStore.findAgent?.(targetQuery || callerQuery)
    if (!caller || !target) { error('caller or target not found'); return }
    if (caller.id !== target.id && !await fleetStore.isDelegatorForAgent?.(caller.id, target.id)) {
      error('not authorized to inspect subscriptions for that target'); return
    }
    reply(await fleetStore.getSubscriptionsByOwner(target.id))
    return
  }

  if (type === 'unsubscribe') {
    const { caller: callerQuery, subscription_id: subscriptionId } = msg
    if (!callerQuery || !subscriptionId) { error('missing caller or subscription_id'); return }
    const caller = await fleetStore.findAgent?.(callerQuery)
    const subscription = await fleetStore.getSubscription(subscriptionId)
    if (!caller || !subscription) { error('caller or subscription not found'); return }
    if (caller.id !== subscription.owner && !await fleetStore.isDelegatorForAgent?.(caller.id, subscription.owner)) {
      error('not authorized to remove that subscription'); return
    }
    if (subscription.adapter === 'wiretap' && subscription.adapter_id) await fleetStore.removeWiretap(subscription.adapter_id)
    await fleetStore.removeSubscription(subscription.subscription_id)
    // Release after the row is gone — the remaining-subscriber check reads the table.
    if (subscription.adapter === 'document_monitor') {
      const docMatch = String(subscription.query || '').match(/^doc:([^\s]+)$/i)
      if (docMatch) await tldaFeedback.releaseIfUnsubscribed(docMatch[1])
    }
    reply({ ok: true, subscription_id: subscription.subscription_id })
    return
  }

  // ---- retract ----
  if (type === 'retract') {
    const { agent: rawAgent, task_id } = msg
    if (!rawAgent) { error('missing agent'); return }
    const agentId = (await fleetStore.findAgent(rawAgent))?.id || rawAgent
    const task = task_id ? await fleetStore.getTask?.(task_id) : await fleetStore.getTaskByAgent?.(agentId)
    if (!task) { error('no active task'); return }
    const result = await fleetStore.retractTask?.(task, {
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
    await fleetStore.upsertSharedDoc({ doc, path: docPath, title, agent, ephemeral })
    reply({ ok: true })
    return
  }

  // ---- shared-docs-get ----
  if (type === 'shared-docs-get') {
    reply(await fleetStore.getSharedDocs())
    return
  }

  // ---- mark-dead ----
  if (type === 'mark-dead') {
    const { agent: agentId } = msg
    if (!agentId) { error('missing agent'); return }
    await fleetStore.markDead(agentId)
    broadcastState()
    reply({ ok: true })
    return
  }

  // ---- filter subscriptions ----
  //
  // A panel says "here is my filter and how much I can show". Subscribing gets
  // it the live stream; `window` also gets it the matching history, decided by
  // the SAME predicate, so the panel needs no global client-side buffer to
  // replay. Without this the subscription only ever carried live events, so a
  // panel had to be fed from the browser's event store — which is the thing
  // being deleted, and which was the bug: it resolved names against a paged
  // roster the server does not have to guess at.
  if (type === 'subscribe-filter') {
    try {
      const { subId, filter } = msg
      if (!subId) return error('subscribe-filter requires subId')
      const humanId = msg.humanId || ws._tldaAgentId || null
      const humanName = msg.humanName || null
      filterSubscriptions.subscribe(ws, subId, filter || null, { humanId, humanName })
      reply({ ok: true, ...filterSubscriptions.stats() })

      const window = Math.min(Math.max(parseInt(msg.window) || 0, 0), 500)
      if (window > 0) {
        // Deliberately after reply(): the subscription is live from the moment
        // subscribe() returns, so an event arriving during this query is pushed
        // rather than lost, and the client dedupes by id. The reverse order
        // would open a window where an event is in neither stream.
        filterSubscriptions.history(filter || null, {
          humanId, humanName, limit: window, before: msg.before || null,
          // history() walks newest-first and cuts at `limit`, so it asks for
          // newest-first — from SQL, not by reversing an array afterwards.
          queryPage: ({ before, agentIds, limit }) =>
            fleetStore.queryChatHistory({ before, agents: agentIds, limit, order: 'desc' }),
        }).then(async page => {
          if (ws.readyState !== 1) return
          // Chronological for the panel, which renders oldest at the top. This
          // is the one place the page is turned around, and it is turning around
          // a list the walker built, not undoing a sort the database did.
          const events = await fleetStore.resolveChatRows(page.events.slice().reverse(), {
            serverOwnerId: SERVER_OWNER_ID, serverOwnerName: SERVER_OWNER_NAME,
          })
          ws.send(JSON.stringify({ event: 'filter-events', data: {
            subId, events, reason: 'history',
            requestBefore: msg.before || null,
            hasMore: page.hasMore, nextCursor: page.nextCursor, truncated: page.truncated,
          } }))
        }).catch(e => {
          // A panel that silently gets no history is the failure being removed,
          // so this is reported to the client rather than only logged here.
          console.warn('[filter-subs] history failed:', e.message)
          try {
            if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'filter-events', data: {
              subId, events: [], reason: 'history', requestBefore: msg.before || null, error: e.message,
            } }))
          } catch { /* socket already gone */ }
        })
      }
    } catch (e) { error(e.message) }
    return
  }

  if (type === 'unsubscribe-filter') {
    try {
      if (!msg.subId) return error('unsubscribe-filter requires subId')
      filterSubscriptions.unsubscribe(ws, msg.subId)
      reply({ ok: true, ...filterSubscriptions.stats() })
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

async function qualTrackRead(agentId, key) {
  if (!key) return
  if (!_qualAgentReads.has(agentId)) _qualAgentReads.set(agentId, new Set())
  _qualAgentReads.get(agentId).add(key)
  if (key.startsWith('skill:')) {
    // Reading the skill clears it from the owed set — the block lifts.
    const owed = _qualAgentOwed.get(agentId)
    if (owed) owed.delete(key.slice('skill:'.length))
    if (fleetStore) {
      try { await fleetStore.addSkillRead(agentId, key) } catch (e) {
        // Memory state already lifted this gate; persistence failure should be
        // visible without re-blocking the action that read the skill.
        console.warn(`[education] failed to persist skill read for ${agentId}: ${e?.message || e}`)
      }
    }
  }
}

async function qualTrackPartialSkillReads(agentId, command) {
  const completed = recordPartialSkillReads(_qualAgentPartialSkillReads, agentId, command)
  for (const rec of completed) {
    await qualTrackRead(rec.agentId, rec.filePath)
    await qualTrackRead(rec.agentId, rec.skillKey)
  }
}

async function qualLoadReadsFromDb() {
  if (!fleetStore) return
  try {
    const readsByAgent = (await fleetStore.getAllSkillReadsByAgent()) || new Map()
    for (const [agentId, reads] of readsByAgent) {
      if (reads.size > 0) _qualAgentReads.set(agentId, reads)
    }
  } catch {}
}

async function getLatexProjectDirs() {
  try {
    const projects = await listProjects()
    return projects
      .filter(p => p.format === 'svg' && p.sourceDir)
      .map(p => p.sourceDir.endsWith('/') ? p.sourceDir : p.sourceDir + '/')
  } catch {
    return []
  }
}

async function isInLatexProject(filePath) {
  const dirs = await getLatexProjectDirs()
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

async function checkQualifications(agentId, tool, arg, input) {
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
  if (tool === 'Bash' && input?.command) await qualTrackPartialSkillReads(agentId, input.command)
  if ((isFileRead || tool === 'Skill') && input) {
    if (isFileRead) {
      const fp = input.file_path || input.path || arg || ''
      if (fp) {
        await qualTrackRead(agentId, fp)
        // A read whose path is …/skills/<name>/SKILL.md credits skill:<name> —
        // this is what lets native (Claude/codex) and MCP-read_file (goose)
        // reads register with the education gate in place of skill().
        const skillMatch = fp.match(/[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/)
        if (skillMatch) await qualTrackRead(agentId, 'skill:' + skillMatch[1])
      }
    }
    if (tool === 'Skill') {
      const skill = input.skill || ''
      if (skill) await qualTrackRead(agentId, 'skill:' + skill)
    }
    return
  }
  if (isSummonLoad) {
    await qualTrackRead(agentId, 'skill:' + String(summonSource))
    return
  }

  if (tool === 'Edit' || tool === 'Write') {
    const fp = input?.file_path || input?.path || arg || ''
    if (!fp) return
    const basename = fp.split('/').pop()
    const inLatex = await isInLatexProject(fp)
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
// Not awaited: this warms the _qualAgentReads cache, which starts empty and
// whose readers already tolerate a miss. Top-level await here would delay
// evaluation of the entire server module for a cache warm. Reported rather
// than dropped so a store that cannot answer is visible.
qualLoadReadsFromDb().catch(e => console.error(`[qualification] initial skill-read load failed: ${e?.message || e}`))
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
//
// Phase 2 will add `rpc` (server → daemon) and `rpc-reply` (daemon →
// server) for tmux operations.

const {
  handleDaemonOutboxEnvelope,
  enqueueDaemonMessage,
  flushServerDaemonOutbox,
  clearServerDaemonOutboxInflightForDaemon,
} = createDaemonWsControlPlane({
  daemonConnections,
  serverDaemonOutboxInflight,
  fleetStore,
  socketCanAcceptMore,
})

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

  if (type === 'activity-delivery-metrics') {
    const daemonKey = ws._daemonKey || (
      msg.machine_id && msg.env_name ? daemonAddress(msg.machine_id, msg.env_name) : null
    )
    if (!daemonKey) return
    daemonActivityDeliverySnapshots.set(daemonKey, {
      ts: new Date().toISOString(),
      reason: msg.reason || null,
      machine_id: msg.machine_id || ws._machineId || null,
      env_name: msg.env_name || ws._envName || null,
      boot_id: msg.boot_id || ws._bootId || null,
      metrics: msg.metrics || null,
    })
    return
  }

  if (type === 'daemon-hello') {
    const { machine_id, env_name, user, hostname, version, boot_id, install_path, last_agent_status_seq, connection_attempt_id, capabilities } = msg
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
        traceGate1('hello-refused', { daemon_key: daemonKey, boot_id, connection_attempt_id, ws_session_id: ws._wsSessionId })
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
    traceGate1('hello-accepted', { daemon_key: daemonKey, boot_id, connection_attempt_id, ws_session_id: ws._wsSessionId })
    ws._machineId = machine_id
    ws._envName = env_name
    ws._daemonKey = daemonKey
    ws._bootId = boot_id
    ws._installPath = install_path
    ws._user = user
    ws._hostname = hostname
    ws._version = version
    ws._connectionAttemptId = connection_attempt_id || null
    ws._agentStatusSeq = Number.isInteger(last_agent_status_seq) ? last_agent_status_seq : 0
    ws._capabilities = {
      terminalInputAllowed: capabilities?.terminalInputAllowed === true,
    }
    daemonConnections.set(daemonKey, ws)
    traceGate1('registry-set', {
      daemon_key: daemonKey,
      boot_id,
      connection_attempt_id,
      ws_session_id: ws._wsSessionId,
      readback_ok: daemonConnections.get(daemonKey) === ws,
    })
    // Complete the transport handshake before any roster-wide bookkeeping.
    // Worker-backed fleet queries can take seconds under load and none of them
    // is authority for whether this daemon connection is usable.
    try {
      ws.send(JSON.stringify({
        type: 'daemon-welcome',
        server_boot_id: SERVER_BOOT_ID,
        connection_attempt_id: ws._connectionAttemptId || null,
        server_ws_session_id: ws._wsSessionId || null,
      }))
      traceGate1('welcome-sent', { daemon_key: daemonKey, boot_id, connection_attempt_id: ws._connectionAttemptId, ws_session_id: ws._wsSessionId, ok: true })
    } catch (e) {
      console.error(`[fleet-daemon] welcome send failed: ${e.message}`)
      traceGate1('welcome-sent', { daemon_key: daemonKey, boot_id, connection_attempt_id: ws._connectionAttemptId, ws_session_id: ws._wsSessionId, ok: false, error: e.message })
      return
    }
    await refreshRuntimeRoutesForDaemon(daemonKey)
    notifyDaemonReady(daemonKey) // wake any control-op RPCs waiting to retry across this reconnect
    clearServerDaemonOutboxInflightForDaemon(daemonKey)
    daemonWelcomeSeenAt.set(daemonKey, Date.now())
    if (daemonConnections.get(daemonKey) !== ws) {
      console.error(`[fleet-daemon] routability invariant failed after welcome setup: daemon=${daemonKey}`)
    }
    await updateDaemonActivityTransportHealth(daemonKey, {
      state: ACTIVITY_HEALTH_OK,
      boundary: ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_CONNECTED,
      reason: 'daemon websocket connected',
      ts: new Date().toISOString(),
      lastKnownGoodAt: new Date().toISOString(),
    })
    console.log(`[fleet-daemon] connected: daemon=${daemonKey} user=${user}@${hostname} v=${version} boot_id=${boot_id}`)

    // Resume any active terminal watches for agents on this machine.
    // The browser-side watcher set is server-held; the daemon comes back
    // empty after a restart so we re-fire start-terminal-watch.
    if (fleetStore) {
      const watchedAgentIds = [...terminalWatchers.keys()]
      for (const { agent: a, seat } of await agentsForTerminalWatchResume({
        watchedAgentIds,
        getAgentsByIds: ids => fleetStore.getAgentsByIds(ids),
        getAgentDaemonRoute: id => fleetStore.getAgentDaemonRoute(id),
        daemonKey,
      })) {
        sendDaemonEphemeral(daemonKey, 'start-terminal-watch', {
          agent_id: a.id,
          poll_ms: 500,
        }).catch(e => console.warn(`[server] terminal-watch resume failed for ${a.id}: ${e.message}`))
      }
    }

    void flushServerDaemonOutbox(daemonKey)

    return
  }

  // From here on, the daemon must be identified.
  if (!ws._machineId) return

  if (type === 'subagent-observed' || type === 'native-subagent-notification-ack') {
    await handleFleetWsMessage(ws, msg)
    return
  }

  if (type === 'agent-status') {
    const { agentId, state, tool, ts } = msg
    if (!agentId || !state || !fleetStore) return
    await fleetStore.updateAgentStatus?.(agentId, state, tool, ts)
    markAgentAlive(agentId, Date.parse(ts) || Date.now(), {
      source: 'daemon-agent-status',
      daemon_key: ws._daemonKey,
      daemon_boot_id: ws._bootId,
    })
    runtimeStatusStore.updateActivity(agentId, state, { tool, atMs: Date.parse(ts) || Date.now() })
    broadcastEvent('agent-status', { agent: agentId, state, tool, ts })
    broadcastState()
    return
  }

  // The daemon describes what is RUNNING on its box; we replace what we had.
  // Present means running, absent means hibernating. No diff is sent and none is
  // needed — see docs/fleet-design-rules.md, "Liveness protocol".
  //
  // Status and activity events also prove a process exists. This snapshot is
  // the authoritative complete observation that can explicitly move an agent
  // back to hibernating when the daemon says it is absent.
  if (type === 'agent-liveness-snapshot') {
    if (!fleetStore) return
    // Message integrity: this socket's daemon speaks for itself only.
    if (!msg.daemon_key || msg.daemon_boot_id == null || msg.report_seq == null) return
    if (msg.daemon_key !== ws._daemonKey || msg.daemon_boot_id !== ws._bootId) return

    const reportedTs = msg.ts || new Date().toISOString()
    const atMs = Date.parse(reportedTs) || Date.now()
    const reported = [...new Set((msg.running_agent_ids || []).filter(id => typeof id === 'string' && id))]
    const reportedAbsent = msg.snapshot_complete === true
      ? [...new Set((msg.absent_agent_ids || []).filter(id => typeof id === 'string' && id))]
      : []

    const running = new Set(reported)
    const absent = new Set(reportedAbsent)

    for (const id of running) {
      spawnLibrarian.observeLiveness({ type, agent_id: id, state: 'alive', ts: reportedTs })
      markAgentAlive(id, atMs, {
        source: 'daemon-running-process-snapshot',
        reason: msg.report_reason || msg.reason,
        daemon_key: msg.daemon_key,
        daemon_boot_id: msg.daemon_boot_id,
        report_seq: msg.report_seq,
      })
    }
    // Gone from the box. Mark liveness only. The durable daemon route is the
    // wake/respawn route; deleting it here strands hibernating agents.
    for (const id of absent) {
      if (running.has(id)) continue
      spawnLibrarian.observeLiveness({
        type, agent_id: id, state: 'dead', reason: 'absent from daemon running-process snapshot', ts: reportedTs,
      })
      markAgentNotAlive(id, {
        source: 'daemon-running-process-snapshot',
        reason: 'absent from daemon running-process snapshot',
        atMs,
        daemon_key: msg.daemon_key,
        daemon_boot_id: msg.daemon_boot_id,
        report_seq: msg.report_seq,
      })
    }
    broadcastState()
    return
  }

  if (type === 'agent-liveness') {
    const { agent_id, state, pid, reason, ts } = msg
    if (!agent_id || !state) return
    spawnLibrarian.observeLiveness({ type, agent_id, state, pid, reason, ts })
    if (state === 'alive') {
      // Liveness ≠ activity (see the batch handler above): this is a 30s "process
      // exists" ping, not real work, so it must not reset the idle clock. Real
      // activity is recorded by agent-activity / agent-thinking / chat.
      markAgentAlive(agent_id, Date.parse(ts) || Date.now(), {
        source: 'daemon-agent-liveness',
        reason,
        pid,
        daemon_key: ws._daemonKey,
        daemon_boot_id: ws._bootId,
      })
    } else if (state === 'dead' || state === 'wedged') {
      markAgentNotAlive(agent_id, {
        source: 'daemon-agent-liveness',
        state,
        reason,
        pid,
        atMs: Date.parse(ts) || Date.now(),
        daemon_key: ws._daemonKey,
        daemon_boot_id: ws._bootId,
      })
    }
    broadcastState()
    return
  }

  if (type === 'agent-activity') {
    const { agent_id, jsonl_offset, ts } = msg
    if (!agent_id || typeof jsonl_offset !== 'number') return
    spawnLibrarian.observeActivity({ type, agent_id, jsonl_offset, ts })
    markAgentAlive(agent_id, Date.parse(ts) || Date.now(), {
      source: 'agent-activity',
      daemon_key: ws._daemonKey,
      daemon_boot_id: ws._bootId,
    })
    touchActivity(agent_id)
    if (fleetStore?.updateHeartbeat) {
      await fleetStore.updateHeartbeat(agent_id)
      broadcastState()
    }
    return
  }

  if (type === 'activity-health') {
    const { agent_id } = msg
    if (!agent_id) return
    await updateAgentActivityHealth(agent_id, {
      state: msg.state,
      boundary: msg.boundary,
      reason: msg.reason,
      ts: msg.ts,
      lastKnownGoodAt: msg.last_known_good_at || null,
      lastActivityAt: msg.last_activity_at || null,
    })
    return
  }

  if (type === 'activity-event') {
    if (!fleetStore) return
    const serverReceivedAtMs = Date.now()
    const { agent_id, tool, arg, input } = msg
    if (!agent_id) return
    markAgentAlive(agent_id, Date.parse(msg.ts) || serverReceivedAtMs, {
      source: 'daemon-activity-event',
      daemon_key: ws._daemonKey,
      daemon_boot_id: ws._bootId,
    })
    runtimeStatusStore.updateActivity(agent_id, tool ? `tool_call:${tool}` : 'activity', {
      tool,
      atMs: Date.parse(msg.ts) || serverReceivedAtMs,
    })
    serverActivityDeliveryCounters.record(ACTIVITY_DELIVERY_STAGES.SERVER_ACCEPTED, msg, 1, {
      type: 'activity-event',
      agent: agent_id,
      tool,
    })
    touchActivity(agent_id)
    if (!shouldStoreDaemonActivity(msg)) return
    try {
      const serverBroadcastQueuedAtMs = Date.now()
      const activity = buildDaemonActivityRecord(msg, { serverReceivedAtMs, serverBroadcastQueuedAtMs })
      const storedActivity = await measureHotOp('daemon-ws activity event insert', `agent=${agent_id} tool=${tool || ''}`, () => fleetStore.share(activity))
      if (['Edit', 'Write', 'MultiEdit'].includes(tool)) {
        appendAgentActionFromActivity({ ...activity, id: storedActivity?.id }, {
          daemonKey: ws._daemonKey || null,
          machineId: ws._machineId || null,
          envName: ws._envName || null,
        }).catch(e => console.error(`[edit-events] activity attribution ingest failed: ${e.message}`))
      }
    } catch (e) {
      await reportDaemonEventFailure(msg, 'activity-write', e)
      throw e
    }
    await checkQualifications(agent_id, tool, arg, input)
    return
  }

  if (type === 'native-task-event') {
    const { changed } = await applyNativeTaskEvents(fleetStore, msg)
    if (changed) broadcastState()
    return
  }

  if (type === 'jsonl-index') {
    if (!fleetStore) return
    const entries = msg.entries || []
    // Ack immediately (accept-on-queue), then index in the background — see the
    // fleet-ws jsonl-index handler for the rationale: decouple search FTS work
    // from the daemon's request health to stop the WS flap. Search is best-effort,
    // this reply advances no offset/liveness cursor, and background failures are
    // loudly counted (recordJsonlIndexBgFailure) so a search gap stays detectable.
    if (msg.id) ws.send(JSON.stringify({ id: msg.id, result: { ok: true } }))
    measureHotOp('daemon-ws jsonl-index', `entries=${entries.length}`, () => fleetStore.insertSessionEntries(entries))
      .catch(e => recordJsonlIndexBgFailure('daemon-ws', entries, e))
    return
  }

  if (type === 'terminal-chat') {
    const { agent_id, from, text: rawText, ts } = msg
    if (!agent_id || !rawText || !ts) return
    const text = rawText.length > 2000 ? rawText.slice(0, 2000) : rawText
    try {
      const duplicate = await fleetStore.terminalChatDuplicateExists(ts, from || SERVER_OWNER_ID, agent_id, text.slice(0, 500))
      if (duplicate) return // duplicate, swallow silently
      await fleetStore.share({
        type: 'chat',
        from: from || SERVER_OWNER_ID,
        to: agent_id,
        text,
        metadata: { source: 'terminal' },
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
      markAgentNotAlive(msg.agent_id, { source: 'terminal-dead', reason: 'terminal watch ended dead' })
      broadcastState()
    }
    return
  }

  if (type === 'spawn-startup-failed') {
    if (!fleetStore) return
    const { agent_id, agent_name, harness, model, respawn, code, reason, snippet } = msg
    if (!agent_id) return
    const agent = await fleetStore.getAgent?.(agent_id)
    const label = agent?.friendly_name || agent_name || agent_id.slice(0, 12)
    const text = `Mint startup failed for ${label}: ${reason || code || 'startup error'}`
    const metadata = {
      type: 'spawn_startup_failed',
      agentId: agent_id,
      agentLabel: label,
      harness: harness || agent?.metadata?.kind || null,
      model: model || agent?.metadata?.model || null,
      respawn: !!respawn,
      code: code || null,
      reason: reason || null,
      snippet: snippet || null,
    }
    try {
      markAgentNotAlive(agent_id, { source: 'spawn-startup-failed', reason: reason || code || 'startup failed' })
      // A shell that never booted (never claimed) must be marked dead so it
      // leaves the not-dead registry — otherwise the reserved identity
      // lingers as a phantom addressable agent that will never inhabit.
      if (agent?.metadata?.shell) await fleetStore.markDead?.(agent_id)
      await fleetStore.updateAgentMeta?.(agent_id, {
        startupFailure: {
          ts: new Date().toISOString(),
          code: metadata.code,
          reason: metadata.reason,
          harness: metadata.harness,
          model: metadata.model,
        },
      })
      const task = await fleetStore.getTaskByAgent?.(agent_id)
      if (task) {
        task.status = 'failed'
        task.last_checked = new Date().toISOString()
        task.metadata = { ...(task.metadata || {}), startupFailure: metadata }
        await fleetStore.upsertTask(task)
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
          text: `**Mint startup failed** for \`${label}\`\n\n${reason || 'The harness printed a fatal startup error before the agent logged in.'}`,
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
    const { agent_id, plan_text } = msg
    if (!agent_id || !plan_text) return
    try {
      const event = await fleetStore.share({
        type: 'plan_approval',
        from: agent_id,
        to: SERVER_OWNER_ID,
        text: plan_text,
        metadata: { daemon_key: ws._daemonKey || null },
        unread: true,
        timestamp: new Date().toISOString(),
      })
      pendingPlanApprovals.set(agent_id, {
        agent_id,
        eventId: event?.id,
      })
      const existing = await fleetStore.getAgent(agent_id)
      const planModeType = existing?.metadata?.planModeType || 'plan'
      await fleetStore.updateAgentMeta?.(agent_id, { inPlanMode: true, planModeType })
      broadcastState()
    } catch (e) {
      console.error(`[fleet-daemon] plan-mode-prompt write: ${e.message}`)
    }
    return
  }

  if (type === 'terminal_attention') {
    if (!fleetStore) return
    const { agent_id, text, reason, snippet } = msg
    if (!agent_id) return
    const dedupKey = `${agent_id}:${reason || text}`
    const now = Date.now()
    if (!globalThis._termAttentionDedup) globalThis._termAttentionDedup = new Map()
    const lastTs = globalThis._termAttentionDedup.get(dedupKey)
    if (lastTs && now - lastTs < 30_000) return
    globalThis._termAttentionDedup.set(dedupKey, now)
    const agent = await fleetStore.getAgent(agent_id)
    const label = agent?.friendly_name || agent_id.slice(0, 12)
    await fleetStore.share({
      type: 'terminal_attention',
      from: agent_id,
      to: SERVER_OWNER_ID,
      text: text || `${label}: needs attention`,
      metadata: { agentId: agent_id, agentLabel: label, reason: reason || null, snippet: snippet || null },
    })
    return
  }

  if (type === 'rpc-reply') {
    const entry = pendingRpcs.get(msg.id)
    if (!entry) return // unknown / already-timed-out RPC
    if (msg.error) entry.reject(rpcReplyError(msg))
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
        if (startedAt !== undefined) await emitTurnEnded(msg.agentId, startedAt)
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
    const { project, files, deletedFiles, sourceManifest, editedBy, expectedRevision, requestId } = msg
    const resultCache = ws._sourceChangeResultCache ||= createSourceChangeResultCache()
    const cached = resultCache.lookup(msg)
    if (cached.error) {
      ws.send(JSON.stringify({ type: 'source-change-result', requestId, project, ok: false, httpStatus: 400, status: 'invalid-request', error: cached.error }))
      return
    }
    if (cached.replay) { ws.send(JSON.stringify(cached.replay)); return }
    if (!project) return
    if (await readProject(project)) {
      await updateProject(project, { lastSourceMachineId: ws._machineId, lastSourceEnvName: ws._envName, lastSourceMachineAt: Date.now() })
    }
    // Hand off to the same pipeline used by HTTP /api/projects/:name/push.
    let replied = false
    try {
      const result = await processProjectPush(project, {
        files,
        deletedFiles,
        sourceManifest,
        editedBy,
        expectedRevision,
        requestId,
        sourceDaemonKey: ws._daemonKey || null,
        sourceMachineId: ws._machineId || null,
        sourceEnvName: ws._envName || null,
      })
      const { status: httpStatus, lifecycleStatus, ...payload } = result
      const reply = { type: 'source-change-result', requestId, project, ...payload, httpStatus, status: lifecycleStatus || (result.ok ? 'accepted' : 'error') }
      resultCache.record(requestId, cached.hash, reply)
      ws.send(JSON.stringify(reply))
      replied = true
      if (!result.ok) {
        console.error(`[fleet-daemon] source-change ${project}: ${result.error || 'unknown'}`)
      }
    } catch (e) {
      console.error(`[fleet-daemon] source-change ${project} crashed: ${e.message}`)
      if (!replied) {
        const reply = { type: 'source-change-result', requestId, project, ok: false, httpStatus: 500, status: 'error', error: e.message }
        resultCache.record(requestId, cached.hash, reply)
        ws.send(JSON.stringify(reply))
      }
    }
    return
  }

  if (type === 'daemon-warning') {
    const { project, message, severity } = msg
    const baseText = project ? `⚠️ daemon sync error on **${project}**: ${message}` : `⚠️ daemon warning: ${message}`
    const now = Date.now()
    const metadata = { type: 'daemon_warning', docName: project, severity: severity || 'warning' }

    const recipients = new Set([SERVER_OWNER_ID])

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
        await fleetStore?.updateEventText(existing.eventId, updatedText)
        broadcastEvent('event-update', { id: existing.eventId, text: updatedText })
      } else {
        const event = await fleetStore?.share?.({ type: 'chat', from: 'fleet:tlda', to, text: baseText, metadata })
        if (event) {
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
            ...(project.createdAt && { createdAt: project.createdAt }),
            ...(project.lastBuild && { lastBuild: project.lastBuild }),
            ...(project.starred && { starred: true }),
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

  // Resume Overleaf git-sync pollers for any project linked to a remote.
  resumeOverleafPollers(listProjects).catch(error => {
    console.error(`[overleaf] source transaction recovery failed: ${error.message}`)
  })
})
