#!/usr/bin/env node
/**
 * fleet-daemon — per-machine local agent for the tlda hub server.
 *
 * The daemon is the local bridge from this machine into the tlda server:
 *
 *   1. JSONL watching - stream-tail Claude Code session files in
 *      ~/.claude/projects/<projectHash>/<sessionId>.jsonl, parse new
 *      bytes, and push activity-event + terminal-chat messages over
 *      WebSocket to the server.
 *
 *   2. Document source watching - chokidar watches each tlda project's Git
 *      checkout; a settled edit cluster is committed and pushed as an
 *      immutable proposal ref. Accepted heads arrive through HeadChanged.
 *
 * What it does NOT do:
 *   - No SQLite. The server owns the fleet store.
 *   - No HTTP. Browsers talk to the server, not the daemon.
 *
 * Lifecycle:
 *   - Reads server, permission grant, and machine identity from daemon.yaml;
 *     authentication tokens come from tokens.json.
 *   - Derives a stable machineId from the hostname if missing and persists it
 *     to daemon.yaml.
 *   - Opens WS to ${server}/ws/fleet-daemon?token=...
 *   - Sends `daemon-hello`; waits for `daemon-welcome` with the agent
 *     and project list for this machine, then starts watching.
 *   - Reconnects with exponential backoff on WS drop. State lives on
 *     the server; reconnection is a no-op for the daemon's logical state.
 *   - On reconnect (daemon-welcome after the first), auto-restarts the fleet
 *     MCP for every alive agent with a tmux_session (staggered 500ms apart).
 *     This handles the common case of a server restart disconnecting all MCPs.
 *
 * TODO: individual MCP crash detection (server restart covers the common case)
 *   - Agents' MCPs can crash independently without a server restart.
 *   - To detect these, add a heartbeat: MCP sends a ping every ~60s; server
 *     tracks last_ping_at per agent; daemon polls (or server pushes) agents
 *     whose last_ping_at is stale (> 2min) and restarts them.
 *   - Requires: heartbeat message type in MCP register loop, server
 *     last_ping_at column, and daemon polling logic or server-push "agent-stale".
 *
 * Cursor persistence:
 *   - JSONL byte offsets are persisted to ~/.config/tlda/daemon-cursors.json
 *     keyed by sessionId, including the file's inode. On reconnect or
 *     daemon restart we resume from the saved offset, but only if the
 *     inode still matches — Claude Code rotates JSONLs on compaction
 *     (delete + recreate), and the old offset would point into a
 *     different file.
 *   - On first observation of a session, we start at EOF (no backfill);
 *     historical events would be too expensive to replay.
 *
 * Spec: scratch/fleet-daemon-spec.md (Phase 1).
 */

import { WebSocket } from 'ws'
import { ResilientWS } from '../shared/fleet-transport.mjs'
import { createFleetOperationTransport } from '../shared/fleet-operation-transport.mjs'
import fs from 'fs'
import path from 'path'
import os from 'os'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'url'
import { daemonLifecycleSocketPath, daemonStateSuffix } from '../shared/daemon-socket-path.mjs'
import {
  getRwToken, DEFAULT_PORT, hasTls,
  CONFIG_DIR as _SHARED_CONFIG_DIR, TLS_CA_PATH,
  getMachineId, saveMachineId, getStatusScanMs, getJsonlTailIdleMs, getMintRegistrationDeadlineMs, getSourceChangeSettleDeadlineMs,
  getOutboxInflightDeadlineMs, getOutboxFlushByteBudget,
  getFleetServerUrl, getServerUrl, getActiveEnvName,
} from '../shared/config.mjs'
import { terminalInputAllowedFromConfig } from '../shared/terminal-input-policy.mjs'
const VERSION = '0.1.1'
import { createLogger } from '../shared/logger.mjs'
import { resolveDaemonIsolation } from '../shared/daemon-identity.mjs'
import { sendActivityEvents } from '../agent-runtime/activity-send.mjs'
import { createActivityDeliveryCounters, ACTIVITY_DELIVERY_STAGES } from '../shared/activity-delivery-counters.mjs'
import {
  ACTIVITY_HEALTH_BOUNDARIES,
  ACTIVITY_HEALTH_OK,
} from '../shared/activity-health.mjs'
import {
  THINKING_SPINNER_RE, INTERRUPT_HINT_RE, THINKING_SCAN_LINES,
} from '../agent-runtime/status-classifier.mjs'
import {
  DAEMON_OUTBOX_ACK_TYPE,
  DAEMON_OUTBOX_ERROR_TYPE,
  SERVER_DAEMON_OUTBOX_ACK_TYPE,
  SERVER_DAEMON_OUTBOX_ERROR_TYPE,
  SERVER_DAEMON_OUTBOX_ID_FIELD,
} from '../shared/daemon-delivery.mjs'
import {
  decideTerminalWatchExit,
  unlinkPidfileIfOwnPid,
} from '../agent-runtime/daemon-guards.mjs'
import { createGitSyncManager } from '../daemon/git-sync-manager.mjs'
import { rebuildLinkedProject } from '../daemon/project-rebuild.mjs'
import { resolveMintCwd } from '../daemon/mint-cwd.mjs'
import { createJsonlIngestor } from '../daemon/jsonl-ingestor.mjs'
import { actionForSymptom, performNotificationSymptomAction } from '../daemon/notification-symptom-action.mjs'
import {
  createJsonlProcessBindingReconciler,
  jsonlProcessBindingSignature,
  projectJsonlAgentsFromProcessBindings,
} from '../daemon/jsonl-local-bindings.mjs'
import { createMachineRpc } from '../daemon/machine-rpc.mjs'
import { createTerminalRpc } from '../daemon/terminal-rpc.mjs'
import { createAgentRouteResolver } from '../daemon/agent-route.mjs'
import { createLocalArtifacts } from '../daemon/local-artifacts.mjs'
import { createPromptPlan } from '../daemon/prompt-plan.mjs'
import { createAgentStatus } from '../daemon/agent-status.mjs'
import { createGooseSupervisor } from '../daemon/goose-supervisor.mjs'
import { ACTIVITY_NOISE } from '../shared/activity-tool-classification.mjs'
import { createHarnessRuntime } from '../daemon/harness-runtime.mjs'
import { createShadowMirror, seedAndConfirmHistory } from '../daemon/shadow-mirror.mjs'
import { DaemonDeliveryRuntime } from '../daemon/delivery-runtime.mjs'
import { DaemonOutbox, defaultOutboxPath } from '../daemon/outbox.mjs'
import { EditOperationStore } from '../daemon/edit-operation-store.mjs'
import { reconcileDaemonRoster } from '../daemon/roster-reconcile.mjs'
import { createAgentLauncher } from '../agent-launch/agent-launch.mjs'
import { launchMintProcess } from '../agent-launch/index.mjs'
import { listSessionNames, sessionConfirmedDead, sessionRuntimeState, terminateTmuxSession } from '../agent-launch/tmux.mjs'
import { sanitizeSessionName } from '../agent-launch/identity.mjs'
import { resolvePartialMintRuntime } from '../daemon/partial-mint-runtime-recovery.mjs'
import { resolvePartialMintPermissionAuthority } from '../daemon/partial-mint-permission-authority.mjs'
import { markAgentDead, wsMintShell } from '../agent-launch/register.mjs'
import { resolveModelSpec } from '../agent-launch/models.mjs'
import { compilePermissionGrant, normalizePermissionGrant, permissionClampLine, permissionGrantProfileName, resolveSpawnGrant } from '../server/lib/permission-grants.mjs'
import {
  resolveLiveSessionIdentity as resolveLiveCodexSessionIdentity,
  resolveLiveSessionIdentityUntil as resolveLiveCodexSessionIdentityUntil,
} from '../agent-launch/harness/codex.mjs'
import { resolveLiveSessionIdentity as resolveLiveClaudeSessionIdentity } from '../agent-launch/harness/claude.mjs'
import {
  applyDaemonGrants,
  createPermissionLedger,
  defaultDaemonConfigPath,
  permissionLedgerPathFromDaemonConfig,
  readDaemonConfig,
  readDaemonConfigForCwd,
  withDaemonModelAliases,
} from '../agent-launch/permission-ledger.mjs'
import { acquireSingletonLock, daemonSingletonLockPath } from '../agent-runtime/singleton-lock.mjs'
import { createDaemonMintCore, recordedMintIdentity } from '../daemon/mint-core.mjs'
import { MintStore } from '../daemon/mint-store.mjs'
import { createDaemonWakeCore } from '../daemon/wake-core.mjs'
import { compileWakePermissionProfile } from '../daemon/wake-permission-profile.mjs'
import {
  invalidProjectSourceEnvironmentOwners,
  projectBelongsToWorld as projectBelongsToEnvironment,
  projectWorldsPath,
  readProjectWorlds as readProjectSourceEnvironmentOwners,
} from '../shared/project-worlds.mjs'
const log = createLogger('daemon')
// CONFIG_DIR holds daemon configuration, cursors, PID and log files. Defaults to
// ~/.config/tlda. TLDA_DAEMON_CONFIG_DIR plus PROJECTS_DIR lets tests/dev rigs
// start a second daemon without clobbering the live daemon's PID file or JSONL
// tails.
const CONFIG_DIR = process.env.TLDA_DAEMON_CONFIG_DIR || _SHARED_CONFIG_DIR
const PROJECT_WORLDS_FILE = projectWorldsPath(_SHARED_CONFIG_DIR)
const DAEMON_CONFIG_FILE = defaultDaemonConfigPath(CONFIG_DIR)
const daemonSpawnConfig = readDaemonConfig(DAEMON_CONFIG_FILE)
const TERMINAL_INPUT_ALLOWED = terminalInputAllowedFromConfig(daemonSpawnConfig)
const CONFIGURED_ENV_NAMES = Object.keys(daemonSpawnConfig.environments?.values || {})
const BOT_MODEL_SPEC = {
  alias: 'bot',
  id: 'bot',
  model: 'bot',
  harness: 'bot',
  kind: 'bot',
  provider: 'bot',
  group: 'bot',
  level: null,
  description: 'local JavaScript bot harness',
  options: {},
  tags: [],
  available: true,
  verified: true,
}
function getDaemonFleetServerUrl() {
  return getFleetServerUrl()
}
function getDaemonStoreUrl() {
  return getServerUrl()
}
const ACTIVE_ENV = getActiveEnvName()
if (!ACTIVE_ENV) {
  console.error('[fleet-daemon] REFUSING to start without a named active environment; daemon env is required')
  process.exit(1)
}
// Stable per-machine identifier. Uses the short hostname (hostname -s) —
// human-readable in the DB, stable across reboots, and the fleet MCP runs
// the same derivation so agent ↔ daemon mapping is consistent without
// coordination. Skip has one Mac; collision avoidance is future work.
function deriveMachineId() {
  // os.hostname() may return an FQDN like "skip-air.local" or
  // "skip-air.tail-scale.ts.net" — strip everything after the first dot
  // so the id is the same on a Tailscale-renamed box.
  return os.hostname().split('.')[0]
}

let MACHINE_ID = getMachineId()
if (!MACHINE_ID) {
  MACHINE_ID = deriveMachineId()
  saveMachineId(MACHINE_ID)
  log.info(`derived machine_id=${MACHINE_ID} (saved to daemon.yaml)`)
}
const DAEMON_STATE_SUFFIX = daemonStateSuffix(ACTIVE_ENV)
const CURSORS_FILE = path.join(CONFIG_DIR, `daemon-cursors${DAEMON_STATE_SUFFIX}.json`)
const PID_FILE = path.join(CONFIG_DIR, `fleet-daemon${DAEMON_STATE_SUFFIX}.pid`)
const SOURCE_BINDINGS_FILE = path.join(CONFIG_DIR, `source-bindings${DAEMON_STATE_SUFFIX}.json`)
const PERMISSION_LEDGER_FILE = permissionLedgerPathFromDaemonConfig(daemonSpawnConfig, CONFIG_DIR)
let _onPermissionLedgerProcessBindingChange = null
const permissionLedger = createPermissionLedger(PERMISSION_LEDGER_FILE, {
  onProcessBindingChange: event => _onPermissionLedgerProcessBindingChange?.(event),
})
applyDaemonGrants(permissionLedger, daemonSpawnConfig)
const resolveAgentRoute = createAgentRouteResolver({
  permissionLedger,
  daemonKey: `${MACHINE_ID}:${ACTIVE_ENV}`,
})

const LOG_FILE = path.join(CONFIG_DIR, `fleet-daemon${DAEMON_STATE_SUFFIX}.log`)
const LOCAL_RPC_SOCKET = daemonLifecycleSocketPath(CONFIG_DIR, ACTIVE_ENV)
const DAEMON_OUTBOX_FILE = defaultOutboxPath(CONFIG_DIR, DAEMON_STATE_SUFFIX)
const EDIT_OPERATION_STORE_FILE = path.join(CONFIG_DIR, `edit-operations${DAEMON_STATE_SUFFIX}.sqlite`)
const LEGACY_DEAD_LETTER_FILE = path.join(CONFIG_DIR, `daemon-dead-letters${DAEMON_STATE_SUFFIX}.jsonl`)
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')

// ---------- config / machine identity ----------

// When using a custom config dir (E2E tests), read from there instead of shared.
const _usingCustomConfigDir = !!process.env.TLDA_DAEMON_CONFIG_DIR

// This daemon's own install path — distinguishes a main-tree daemon from a
// worktree/dev-rig one, both at startup (the isolation guard below) and on the
// server (the daemon-hello backstop: two distinct installs can't claim the same
// scoped daemon identity). Resolve symlinks so the comparison is on the real path.
const INSTALL_PATH = (() => {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) }
  catch { return fileURLToPath(import.meta.url) }
})()

// §4b guard: a worktree/dev-rig daemon must never silently join the LIVE fleet
// as the shared machine_id (tonight a worktree daemon claimed "air" and evicted
// the real one). Refuse to start when an isolation signal is set but isolation
// is incomplete, instead of falling through to the live config. Fail loud.
{
  const { refuseReason } = resolveDaemonIsolation({ env: process.env, scriptPath: INSTALL_PATH })
  if (refuseReason) {
    log.error(`refusing to start: ${refuseReason}`)
    process.stderr.write(`[fleet-daemon] REFUSING TO START — ${refuseReason}\n`)
    process.exit(1)
  }
}

// The daemon config (fence profiles + model aliases) is re-read from daemon.yaml
// fresh on every loadDaemonLaunchConfig() call — including per-spawn reads in the agent-launch
// module — so edits to daemon.yaml take effect on the NEXT spawn without a daemon restart. Both levers
// ride this single read: withDaemonModelAliases injects daemonConfig.profiles
// (fence) AND daemonConfig.models (aliases) into the config that permission grant
// resolution consumes. Keep-last-good: a malformed daemon.yaml (readDaemonConfig throws) must
// never half-apply — fall back to the last successfully parsed config and warn.
// Running agents' leases are untouched; only new spawns re-read. The startup const
// daemonSpawnConfig still seeds the ledger path + startup grants (those must not
// move without a restart), and seeds _lastGoodDaemon here.
let _lastGoodDaemon = daemonSpawnConfig
function loadDaemonLaunchConfig() {
  let freshDaemon
  try {
    freshDaemon = readDaemonConfig(DAEMON_CONFIG_FILE)
    _lastGoodDaemon = freshDaemon
  } catch (e) {
    log.warn(`daemon config re-read failed, using last good: ${e.message}`)
    freshDaemon = _lastGoodDaemon
  }
  return withDaemonModelAliases({}, freshDaemon)
}

const config = loadDaemonLaunchConfig()
// The daemon is the local relay for the active named environment. The
// environment name selects the complete database/store authority; TLDA_SERVER is
// not a second selector.
const SERVER = getDaemonFleetServerUrl()
// The active environment NAME (TLDA_ENV -> environments.default). This is the
// single selector we propagate to spawned agents so their MCP resolves the same
// complete environment (database + store) the daemon did. A stray default cannot
// then misroute a spawn, because the spawn carries the real active name.
{
  const { refuseReason } = resolveDaemonIsolation({
    env: process.env,
    scriptPath: INSTALL_PATH,
  })
  if (refuseReason) {
    log.error(`refusing to start: ${refuseReason}`)
    process.stderr.write(`[fleet-daemon] REFUSING TO START — ${refuseReason}\n`)
    process.exit(1)
  }
}
// Scoped singleton lock. Same path for a given machine + environment no matter
// which install/worktree launched us, so daemons that claim the same local
// environment collide while stable/testing lanes can coexist.
const DAEMON_LOCK_SCOPE = `${MACHINE_ID}:${ACTIVE_ENV}`
const LOCK_FILE = daemonSingletonLockPath({ configDir: CONFIG_DIR, origin: DAEMON_LOCK_SCOPE })

// HARD INVARIANT — a dev daemon literally cannot target the real fleet.
// `tlda-dev serve --sandbox` starts its daemon with TLDA_DEV_DAEMON=<the exact
// sandbox base it stood up> and TLDA_ENV=<the sandbox environment>. When
// TLDA_DEV_DAEMON is set, the named environment must resolve to that authorized base
// on a non-:5176 port, so this daemon can never join the real fleet.
if (process.env.TLDA_DEV_DAEMON) {
  let ok = false
  try {
    const u = new URL(SERVER)
    ok = SERVER === process.env.TLDA_DEV_DAEMON && !!u.port && Number(u.port) !== DEFAULT_PORT
  } catch { ok = false }
  if (!ok) {
    console.error(`[fleet-daemon] REFUSING to start dev daemon: resolved SERVER=${SERVER} is not the authorized sandbox target (${process.env.TLDA_DEV_DAEMON}) on a non-${DEFAULT_PORT} port. A dev daemon must never join the real fleet.`)
    process.exit(1)
  }
}

const TOKEN = getRwToken()
const TMUX_SOCKET = config.tmuxSocket || null
const TMUX_ARGS = TMUX_SOCKET ? ['-L', TMUX_SOCKET] : []

// boot_id — monotonic per process start. Used by the server to break ties
// when two daemons claim the same machine_id (newer wins, older evicted).
const BOOT_ID = Date.now()
const USER = os.userInfo().username
const HOSTNAME = os.hostname()

let jsonlIngestor
let daemonMintCore

// ---------- daemon state ----------

let _rws = null  // ResilientWS instance, created at startup
let _serverReady = false
let agents = []                   // current agent list (from welcome / updates)
let agentStatusSeq = 0
let serverProjects = []           // unfiltered project list from this world server
let projects = []                 // projects owned by this daemon config
let _lastSessionWatcherRosterSig = ''
let jsonlBindingReconciler
let terminalRpc
let activityDeliveryMetricsTimer = null
let daemonWsConnectedAtMs = null
const desiredTailReconcileTimer = setInterval(() => {
  jsonlIngestor?.reconcileDesiredTails?.()
    .catch(error => log.error(`desired JSONL tail reconciliation failed: ${error?.stack || error?.message || error}`))
}, 30_000)
desiredTailReconcileTimer.unref?.()

const TERMINAL_SIZE_POLL_MS = parseInt(process.env.TLDA_TERMINAL_SIZE_POLL_MS, 10) || 5000

const harnessRuntime = createHarnessRuntime({
  tmuxArgs: TMUX_ARGS,
  log,
})

const daemonActivityDeliveryCounters = createActivityDeliveryCounters({
  origin: 'daemon',
  onChange: () => scheduleActivityDeliveryMetrics(),
})

function scheduleActivityDeliveryMetrics() {
  if (activityDeliveryMetricsTimer) return
  activityDeliveryMetricsTimer = setTimeout(() => {
    activityDeliveryMetricsTimer = null
    sendActivityDeliveryMetrics('counter-change')
  }, 1000)
  activityDeliveryMetricsTimer?.unref?.()
}

function sendActivityDeliveryMetrics(reason = 'snapshot') {
  if (!_rws?.connected) return false
  return _rws.send({
    type: 'activity-delivery-metrics',
    reason,
    machine_id: MACHINE_ID,
    env_name: ACTIVE_ENV,
    boot_id: BOOT_ID,
    metrics: daemonActivityDeliveryCounters.snapshot(),
  })
}

// ---------- activity event buffer ----------

function bufferActivity(agentId, evts) {
  const daemonReceivedAtMs = Date.now()
  daemonActivityDeliveryCounters.record(
    ACTIVITY_DELIVERY_STAGES.JSONL_EXTRACTED,
    { type: 'activity-event' },
    evts.length,
    { agent: agentId }
  )
  const stampedEvents = evts.map(evt => {
    const existing = evt?.daemonReceivedAtMs == null || evt.daemonReceivedAtMs === ''
      ? null
      : Number(evt.daemonReceivedAtMs)
    const stamped = Number.isFinite(existing) ? evt : {
      ...evt,
      daemonReceivedAt: new Date(daemonReceivedAtMs).toISOString(),
      daemonReceivedAtMs,
    }
    const filePath = stamped?.input?.file_path || stamped?.input?.path
    const agent = agents.find(item => item.id === agentId)
    const cwd = agent?.cwd || agent?.metadata?.cwd
    const absolutePath = filePath && (path.isAbsolute(filePath) ? filePath : (cwd ? path.resolve(cwd, filePath) : null))
    const source = absolutePath ? sourceSync.sourceFileForAbsolutePath(absolutePath) : null
    const operation = stamped?.input?.edit_operation
    const files = operation?.files?.map(file => {
      const absolute = path.isAbsolute(file.path) ? file.path : (cwd ? path.resolve(cwd, file.path) : null)
      return absolute ? sourceSync.sourceFileForAbsolutePath(absolute)?.file : null
    }).filter(Boolean)
    const normalizedOperation = operation && files?.length ? {
      ...operation, operation_id: `${agentId}:${operation.operation_id}`, files: [...new Set(files)].map(file => ({ path: file })),
      ...(operation.changes ? { changes: operation.changes.map(change => {
        const absolute = change.path && (path.isAbsolute(change.path) ? change.path : (cwd ? path.resolve(cwd, change.path) : null))
        return { ...change, ...(absolute ? { path: sourceSync.sourceFileForAbsolutePath(absolute)?.file || change.path } : {}) }
      }) } : {}),
    } : null
    if (absolutePath && normalizedOperation) jsonlIngestor.recordEdit(agentId, absolutePath, normalizedOperation)
    const normalized = normalizedOperation ? { ...stamped, input: { ...stamped.input, edit_operation: normalizedOperation } } : stamped
    return source ? { ...normalized, project: source.project, sourceFile: source.file } : normalized
  })
  // A JSONL line is a per-turn heartbeat. Warm the liveness cache keyed by
  // tmux_session so rpcCheckAlive / wake read "alive" from observed activity,
  // without a fleet-wide background demotion sweep.
  const activeDaemonKey = `${MACHINE_ID}:${ACTIVE_ENV}`
  const activeBinding = permissionLedger.listProcessBindings().find(row =>
    row.id === agentId && row.daemonKey === activeDaemonKey)
  if (activeBinding?.tmuxSession) alivenessCache.set(activeBinding.tmuxSession, true)
  const toolActivity = [...stampedEvents].reverse().find(event =>
    event?.tool && !String(event.tool).startsWith('_'))
  if (activeBinding && toolActivity) agentStatus.noteToolActivity(agentId, toolActivity.tool)
  if (activeBinding) agentStatus.armAgent(agentId)
  sendMsg({
    type: 'activity-health',
    agent_id: agentId,
    state: ACTIVITY_HEALTH_OK,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.LAST_ACTIVITY,
    reason: 'activity extracted from harness stream',
    ts: new Date(daemonReceivedAtMs).toISOString(),
    last_known_good_at: new Date(daemonReceivedAtMs).toISOString(),
    last_activity_at: new Date(daemonReceivedAtMs).toISOString(),
  })
  return sendActivityEvents(agentId, stampedEvents, sendMsg)
}

// ---------- JSONL ingestion ----------
function currentJsonlBindingAgents() {
  return projectJsonlAgentsFromProcessBindings(permissionLedger.listProcessBindings(), {
    daemonKey: `${MACHINE_ID}:${ACTIVE_ENV}`,
  })
}

const editOperationStore = new EditOperationStore(EDIT_OPERATION_STORE_FILE)
jsonlIngestor = createJsonlIngestor({
  configDir: CONFIG_DIR,
  cursorsFile: CURSORS_FILE,
  projectsDir: PROJECTS_DIR,
  daemonDir: path.dirname(fileURLToPath(import.meta.url)),
  log,
  sendMsg,
  sendMsgWithReply,
  isConnected: () => !!_rws?.connected,
  isServerReady: () => _serverReady,
  getAgents: currentJsonlBindingAgents,
  listSessions: rpcListSessions,
  selectAgentKind: harnessRuntime.resolveAgentKind,
  harnessAdapters: harnessRuntime.harnessAdapters,
  permissionLedger,
  bufferActivity,
  extractActivityEvents: harnessRuntime.extractActivityEvents,
  activityDeliveryCounters: daemonActivityDeliveryCounters,
  editOperationStore,
  jsonlTailIdleMs: getJsonlTailIdleMs(),
  recordMintMarker: marker => {
    if (!daemonMintCore) throw new Error('daemon mint core is not initialized')
    Promise.resolve()
      .then(async () => {
        if (marker.fleet_id) {
          await daemonMintCore.recordSeat(marker.mint_id, {
            fleet_id: marker.fleet_id,
            friendly_name: marker.friendly_name,
          })
        }
        await daemonMintCore.recordSession(marker.mint_id, marker)
      })
      .catch(error => log.error(`mint marker fact write failed for ${marker.mint_id}: ${error.message}`))
  },
  resolveMintFacts: marker => mintStore.get(marker?.mint_id) || mintStore.getByFleetId(marker?.fleet_id),
  machineId: MACHINE_ID,
  envName: ACTIVE_ENV,
  daemonKey: `${MACHINE_ID}:${ACTIVE_ENV}`,
})

jsonlBindingReconciler = createJsonlProcessBindingReconciler({
  listProcessBindings: () => permissionLedger.listProcessBindings(),
  sync: agents => jsonlIngestor.sync(agents),
  daemonKey: `${MACHINE_ID}:${ACTIVE_ENV}`,
  log,
})

/**
 * Which agent's edit is in this proposal, answered from what this daemon already
 * recorded.
 *
 * The ingester stamps `recordEdit(agentId, path, operation)` on every agent
 * Edit/Write/MultiEdit and `resolveEditor` answers "who touched these paths
 * inside the attribution window". That has been live since `140101c7c` and has
 * never left this process, so the server had nothing to stamp `lastEditedBy`
 * with — which is why `resolveEditedBy` failed its ten-minute window for every
 * project and build cards stopped reaching the agent who caused them on
 * 2026-08-21. This is the one hop that was missing.
 *
 * `resolveEditor` returns matches oldest-first, so the last one is the most
 * recent edit.
 *
 * **Never throws and never blocks the push.** Attribution is a nicety on top of
 * somebody's writing reaching the server; a lookup that failed must cost a name
 * on a chat message, not a revision.
 */
function resolveProposalEditor(sourceDir, members) {
  if (!sourceDir || !Array.isArray(members) || members.length === 0) return null
  try {
    const found = jsonlIngestor.resolveEditor(members.map(rel => path.resolve(sourceDir, rel))) || []
    return found.length ? found[found.length - 1]?.agentId || null : null
  } catch (error) {
    // Swallowed deliberately: attribution is a name on a chat message sitting on
    // top of somebody's writing reaching the server. Rethrowing here would fail
    // the push itself, so a broken lookup must cost the name and nothing else.
    log.warn(`proposal attribution lookup failed: ${error.message}`)
    return null
  }
}

// ---------- source watching ----------
const sourceSync = createGitSyncManager({
  bindingsFile: SOURCE_BINDINGS_FILE,
  daemonId: `${MACHINE_ID}:${ACTIVE_ENV}`,
  server: SERVER,
  token: TOKEN,
  log,
  onProposalSubmitted: async ({ project, sourceDir, revision, proposalRef, members = null, forceRebuild = false }) => {
    const editedBy = resolveProposalEditor(sourceDir, members)
    const admitted = await sendMsgWithReply({ type: 'source-proposal-admit', project, revision, ref: proposalRef, retry_terminal: forceRebuild, ...(editedBy ? { editedBy } : {}) })
    if (!admitted?.ok) throw new Error(`${project}: server did not confirm proposal admission`)
    log.info(`${project}: proposal admission confirmed id=${admitted.submissionId} state=${admitted.state} started_once=${admitted.startedOnce} lifecycle_present=${admitted.lifecyclePresent} reason=${admitted.terminalReason || 'none'}`)
  },
  // A settle that leaves a tracked document out of the revision still reports
  // success, and on the watcher path there is no command output for it to
  // report into. `daemon-warning` is the one path from here to a person: the
  // server turns it into a chat message. Severity stays default so this does
  // not raise the per-document sync-error sentinel — nothing is broken, a file
  // is simply not in the project.
  onDocumentsDropped: ({ project, dropped }) => {
    const them = dropped.length === 1 ? 'it' : 'them'
    const message = `not in the revision — tracked in the checkout, but no document root reaches ${them}: ${dropped.join(', ')}. Reference ${them} from a document root, or add ${them} to the project's document roots.`
    log.warn(`${project}: ${message}`)
    sendMsg({ type: 'daemon-warning', project, warning: 'document-not-in-revision', message, dropped })
  },
  // A REFUSED settle, said where a person is. Same path and the same reasoning
  // as the callback above: the watcher has no command output to report into,
  // and `daemon-warning` is the one route from here to somebody.
  //
  // What this is for: a checkout standing on a branch the daemon does not
  // manage is refused `not-on-work-branch`, and until now the only trace was a
  // line in this daemon's own log file. The person's edit commits, their tree
  // goes clean, nothing errors, and the project never receives a revision — so
  // sync looks like it worked.
  //
  // The branch rule itself is unchanged and deliberately so. Skip: "if you have
  // a daemon-managed branch checked out, it commits, and pushes, and all that
  // shit. otherwise it doesn't." Nothing here pushes a branch the daemon does
  // not manage; the refusal stands, it just stops being silent.
  //
  // Severity stays default, so this does NOT raise the per-document sync-error
  // sentinel. The document is fine and the project is fine; a checkout is
  // parked somewhere the daemon does not read. Raising the badge would be a
  // product decision nobody asked for.
  onSyncRefused: ({ project, status, reason, head, workBranch }) => {
    log.warn(`${project}: ${reason}`)
    sendMsg({ type: 'daemon-warning', project, warning: `sync-refused:${status}`, message: reason, head, workBranch })
  },
})

let lastInvalidSourceOwnerSignature = null

function reportInvalidProjectSourceOwners(ownerMap) {
  const invalid = invalidProjectSourceEnvironmentOwners(ownerMap, CONFIGURED_ENV_NAMES)
  const signature = JSON.stringify(invalid)
  if (!invalid.length) {
    lastInvalidSourceOwnerSignature = null
    return
  }
  if (signature === lastInvalidSourceOwnerSignature) return
  lastInvalidSourceOwnerSignature = signature
  const byOwner = new Map()
  for (const entry of invalid) {
    if (!byOwner.has(entry.owner)) byOwner.set(entry.owner, [])
    byOwner.get(entry.owner).push(entry.sourceDir)
  }
  const known = CONFIGURED_ENV_NAMES.join(', ') || '(none)'
  const detail = [...byOwner.entries()]
    .map(([owner, dirs]) => `${owner} (not configured; known: ${known}): ${dirs.join(', ')}`)
    .join('; ')
  const message = `Project source directories have invalid environment owners and are not being watched by any daemon: ${detail}. Repair ${PROJECT_WORLDS_FILE}.`
  log.error(message)
  sendMsg({
    type: 'daemon-warning',
    warning: 'invalid-project-source-environment-owner',
    severity: 'critical',
    message,
    invalidOwners: invalid,
    knownEnvironments: CONFIGURED_ENV_NAMES,
    file: PROJECT_WORLDS_FILE,
  })
}

function applyProjectWorldOwnership(reason) {
  const projectSourceOwners = readProjectSourceEnvironmentOwners(PROJECT_WORLDS_FILE)
  reportInvalidProjectSourceOwners(projectSourceOwners)
  projects = serverProjects.filter(project => projectBelongsToEnvironment(project, ACTIVE_ENV, projectSourceOwners))
  sourceSync.sync(projects).catch(error => log.error(`project Git sync failed (${reason}): ${error.message}`))
  log.info(`project ownership applied (${reason}): ${projects.length}/${serverProjects.length} projects in ${ACTIVE_ENV}`)
}

/**
 * Carry a document-roots change from the server into the RUNNING binding.
 *
 * `applyProjectWorldOwnership` below calls `sourceSync.sync(projects)`, and
 * `start()` returns the existing runtime untouched when one is already up. So
 * before this, the only thing that ever reached `setDocumentRoots` on a live
 * runtime was `bindSource` with explicit roots -- which happens at link time.
 * A root added afterwards updated the server, arrived here as
 * `project-metadata-changed`, and stopped one step short of the sync that needed
 * it. The list the daemon computed its closure from stayed the list the project
 * had on the day it was linked, for as long as the daemon stayed up.
 *
 * That is the same defect the comment at `linkProject` records and repairs at
 * BIND time, and this is the other half of it: the bind-time repair only helps a
 * daemon that restarts.
 *
 * Scoped identically, and for the reason stated there: only a binding that
 * ALREADY declares roots is refreshed. A binding with none syncs every tracked
 * `.tex`/`.md`/`.qmd` in the tree, and handing it a declared list would NARROW
 * what it syncs -- a change to the 92 of 102 bindings on this machine that
 * nobody asked for. The bug is the stale list, so only the stale list is fixed.
 */
function refreshBoundDocumentRoots(project) {
  const status = sourceSync.bindingStatus(project, sourceSync.getSourceDir(project) || '')
  const binding = status?.binding
  if (!binding?.sourceDir) return
  if (!Array.isArray(binding.documentRoots) || binding.documentRoots.length === 0) return
  const metadata = serverProjects.find(item => item?.name === project)
  const roots = Array.isArray(metadata?.documentRoots)
    ? metadata.documentRoots.map(root => (typeof root === 'string' ? root : root?.path)).filter(Boolean)
    : null
  if (!roots?.length) return
  const unchanged = roots.length === binding.documentRoots.length
    && roots.every((root, index) => root === binding.documentRoots[index])
  if (unchanged) return
  try {
    sourceSync.bindSource(project, binding.sourceDir, { documentRoots: roots })
    log.info(`${project}: document roots refreshed from the server: ${roots.join(', ')}`)
  } catch (error) {
    // Swallowed on purpose: this runs inside the server-message handler, and a
    // binding that refuses a rebind must not take the daemon's message loop
    // down with it. Nothing is lost by not throwing — the refresh is a
    // convergence, not a one-shot. It re-derives the whole list from the server
    // record on the next `project-metadata-changed`, and `bindSource` re-reads
    // it at link time besides, so a failure here costs one settle rather than
    // wedging the list until somebody notices.
    log.warn(`${project}: document roots could not be refreshed: ${error.message}`)
  }
}

async function loadLocallyBoundProjects() {
  const loaded = []
  for (const name of sourceSync.boundProjectNames()) {
    try {
      const encodedName = encodeURIComponent(name)
      loaded.push(await daemonApi('GET', `/api/projects/${encodedName}`))
    } catch (error) {
      sendMsg({
        type: 'daemon-warning',
        warning: 'linked-project-metadata-unavailable',
        severity: 'error',
        project: name,
        message: `Linked project metadata is unavailable for ${name}: ${error.message}`,
      })
    }
  }
  return loaded
}

// Linking is a clone, so the history goes with it. This working copy has been
// receiving that history on every build; the server being linked to has none.
//
// Two calls make a link, and they are not the same operation. Without
// projectMetadata the caller is still deciding — the project may not exist on
// that server yet — so this only ANSWERS whether the directory is already
// linked, and writes nothing. With projectMetadata the caller has just read
// `GET /api/projects/<name>`, which is what makes it true that the destination
// has the project, and only then is there somewhere for history to land.
//
// Offering history used to happen on both calls, so every link sent the bundle
// twice and the first one named a project the server had never heard of.
//
// The offer is a GATE. Skip, asked whether "the adopt usually arrives first" was
// good enough: "the answer is we do not lose data in this fucking app." So the
// link blocks until the destination reports the versions are there, and fails if
// they are not — and because the binding is written only after that answer, a
// failed link leaves nothing behind. A link that half-succeeds and leaves the
// paper starting from version one is the old broken behaviour wearing a success
// message.
async function rpcLinkProjectSource({ project, sourceDir, projectMetadata = null, kind = null, remote = null, mirrorMode = null, seedBranch = null, seedRevision = 'HEAD', documentRoots = null, forceRebuild = false, acceptContainedServerHistory = false, preflightOnly = false, server = null }) {
  if (!project || !sourceDir) throw new Error('project and sourceDir are required')

  const status = sourceSync.bindingStatus(project, sourceDir)
  if (preflightOnly || projectMetadata?.name !== project) {
    // Nothing to adopt into yet. Report, do not write.
    return { linked: false, alreadyLinked: status.alreadyLinked, sourceDir: status.sourceDir }
  }

  if (!status.alreadyLinked) {
    let serverHistoryContained = false
    if (acceptContainedServerHistory) {
      const page = await daemonApi('GET', `/api/projects/${encodeURIComponent(project)}/history/shadow?limit=10000`)
      if (page.page_limited) throw new Error(`${project} was not linked: server history exceeds the containment audit page`)
      const hashes = (page.versions || []).map(version => version.hash)
      if (hashes.length) {
        const containment = await shadowMirror.containsCommits({ sourceDir, hashes })
        if (!containment.ok) {
          throw new Error(`${project} was not linked: local Git history is missing ${containment.missing.length} server version(s), beginning ${containment.missing.slice(0, 3).join(', ')}`)
        }
        serverHistoryContained = true
        log.info(`${project}: all ${hashes.length} server versions are contained in ${sourceDir}; preserving server history during relink`)
      }
    }
    if (!serverHistoryContained) {
      await seedAndConfirmHistory({
        project,
        log,
        prepareSeed: () => shadowMirror.prepareHistorySeed({ project, sourceDir, seedBranch, seedRevision, documentRoots: documentRoots || [] }),
        // `server` is the one the caller named. It has to be handed over here
        // because the binding that would otherwise carry it is written after
        // adoption is confirmed, which is deliberately later than this push.
        pushSeed: history => sourceSync.pushHistorySeed(project, history.repositoryDir, history.head, server),
        confirmAdoption: ({ head, ref }) => sendMsgWithReply({ type: 'adopt-shadow-history-ref', project, head, ref }),
      })
    }
  }

  // The binding's document roots were written at link time and never again.
  // `tlda project push` does not pass `documentRoots` — it passes
  // `projectMetadata`, which carries the project's CURRENT roots — so a root
  // added later (PATCH /document-roots) updated the server and never reached
  // here. The daemon then computed its closure from the roots the project had
  // on the day it was linked, and the new document was absent from every
  // revision while the server, the CLI and the push all reported success.
  //
  // The server's record is the one fact. An explicit `documentRoots` argument
  // still wins, because `project link` passes the roots it is creating before
  // the server knows them.
  // Scoped deliberately to bindings that ALREADY declare roots — this refreshes
  // a stale list, it does not give a list to a binding that has none. 92 of the
  // 102 bindings on this machine record no roots at all, and for those the sync
  // falls back to every .tex/.md/.qmd in the tree. Handing them a declared list
  // would narrow what they sync, and a declared root that is absent from the
  // working tree makes the whole settle throw — caught and logged at warn, so
  // the project would silently stop syncing anything. That is a change to 92
  // projects nobody asked for; the bug is the stale list, so only the stale
  // list is fixed.
  const metadataRoots = Array.isArray(projectMetadata?.documentRoots)
    ? projectMetadata.documentRoots.map(root => (typeof root === 'string' ? root : root?.path)).filter(Boolean)
    : null
  const boundRoots = Array.isArray(status.binding?.documentRoots)
    ? status.binding.documentRoots.map(root => (typeof root === 'string' ? root : root?.path)).filter(Boolean)
    : []
  const bindingHasRoots = boundRoots.length > 0
  const rootsChanged = status.alreadyLinked && Array.isArray(metadataRoots)
    ? JSON.stringify(boundRoots) !== JSON.stringify(metadataRoots)
    : false
  const effectiveRoots = Array.isArray(documentRoots)
    ? documentRoots
    : (bindingHasRoots && metadataRoots?.length ? metadataRoots : null)
  const result = sourceSync.bindSource(project, sourceDir, {
    kind,
    remote,
    mirrorMode,
    // Only when the caller named one. Absent, the binding carries no server and
    // the manager falls back to the daemon's, which is every ordinary link.
    ...(server ? { server } : {}),
    ...(effectiveRoots ? { documentRoots: effectiveRoots } : {}),
  })
  try {
    const registration = await sendMsgWithReply({
      type: 'source-bindings-set',
      source_bindings: sourceSync.bindingRecords(),
    })
    if (!registration?.ok) throw new Error('server did not confirm source binding registration')
  } catch (error) {
    if (result.linked) sourceSync.unbindSource(project, sourceDir)
    throw new Error(`${project} was not linked: its source binding could not be registered (${error.message})`)
  }
  serverProjects = [...serverProjects.filter(item => item.name !== project), projectMetadata]
  await sourceSync.sync([projectMetadata])
  // Stand the checkout on its work branch, BEFORE the first submit.
  //
  // Nothing did this, and it is the whole reason linking produced a checkout
  // that never synced cleanly: the daemon commits to `tlda/<project>` and the
  // author was left on whatever they linked from, so their own branch never
  // moved and their tree was dirty against it from the first edit onward.
  //
  // Reported rather than thrown. A checkout that could not be moved is still
  // linked and still has its history on the server; failing the link would be a
  // worse outcome than a link that says which branch to check out.
  const workBranch = await sourceSync.standOnWorkBranch(project, {
    refilter: !status.alreadyLinked || rootsChanged,
  }).catch(error => ({ ok: false, status: 'error', reason: error.message }))
  if (!workBranch.ok) log.warn?.(`${project}: linked, but this checkout is not on its work branch — ${workBranch.reason || workBranch.status}`)
  const submission = await sourceSync.submit(project, { forceRebuild })
  applyProjectWorldOwnership('local-source-link')
  return { ...result, workBranch, submission }
}

async function rpcUnlinkProjectSource({ project, sourceDir }) {
  if (!project) throw new Error('project is required')
  const result = sourceSync.unbindSource(project, sourceDir)
  const registration = await sendMsgWithReply({
    type: 'source-bindings-set',
    source_bindings: sourceSync.bindingRecords(),
  })
  if (!registration?.ok) throw new Error('server did not confirm source binding registration')
  applyProjectWorldOwnership('local-source-unlink')
  return result
}

async function rpcRebuildProject({ project }) {
  return rebuildLinkedProject(sourceSync, project)
}

// Republish a revision the project's repository already holds. `project-rebuild`
// publishes the working tree, so it cannot be used on a checkout somebody else
// is editing; this one reads the commit from the object database and leaves the
// tree, the branch and the binding alone.
async function rpcPublishProjectRevision({ project, revision }) {
  if (!project) throw new Error('project is required')
  if (!revision) throw new Error('revision is required')
  return sourceSync.publishRevision(project, revision)
}

fs.watchFile(PROJECT_WORLDS_FILE, { interval: 500 }, () => applyProjectWorldOwnership('registry-change'))

const localArtifacts = createLocalArtifacts({
  getServerUrl: () => getDaemonStoreUrl(),
  getFleetServerUrl: () => getDaemonFleetServerUrl(),
  resolveAgentCwd: agentId => permissionLedger.get(agentId)?.cwd || null,
})

const shadowMirror = createShadowMirror({
  getSourceDir: project => sourceSync.getSourceDir(project),
  log,
})

// Bots are independent, launchd-owned services configured in bots.yaml — the
// daemon no longer manages them (see getManagedBots / bots.yaml).

// ---------- terminal RPC facades ----------

function checkSession(session) {
  return terminalRpc.checkSession(session)
}

async function tmux(...args) {
  return terminalRpc.tmux(...args)
}

async function rpcListSessions() {
  return terminalRpc.listSessions()
}

async function gooseKickSend(args) {
  return terminalRpc.gooseKickSend(args)
}

async function rpcCheckAlive(args) {
  return terminalRpc.checkAlive(args)
}

// Step 3 of the notification proposal. The server tells this daemon what it
// observed on its own socket to one of our agents' MCPs — "this is your machine,
// look into it". It carries no remedy and no text to deliver, which is the whole
// point: choosing the remedy is this daemon's job and delivering the
// notification is nobody's job but the channel's.
//
// **This is now where the remedy is chosen**, and it had to become so in the
// same change that deleted the sideband: until that deletion the old path acted
// and this one only recorded, because two live remedies would mean restarting
// agents that are running perfectly well. Delete the old path without this and
// nothing acts at all — a wedged MCP would be observed, recorded, and left
// wedged.
//
// The two jobs, and there are only two. Skip, 14:07:25: "No process. Make one
// unresponsive process. Fucking fix it. Right? Have you tried turning it off and
// turning it back on again, basically."
//
//   no process            -> make one            (wake)
//   process, no channel   -> suggest an explicit restart in the live session
//   explicit refusal      -> nothing             (not a liveness fault)
//
// Both actions are idempotent, which is why the server keeps no memory of having
// reported and this handler needs no deduplication: a process that is already
// there makes `wake` a no-op, and hibernate-and-wake loses nothing — "it's just
// a blip in the agent's running process."
//
// It delivers nothing. There is no text in the message and none is constructed
// here: the agent comes up, calls `login()`, and the SERVER hands over the mail.
// That is the whole reason the daemon is out of the notification path.
async function rpcNotificationSymptom({ agent_id, symptom, observed_at, detail }) {
  if (!agent_id) throw new Error('missing agent_id')
  if (!symptom) throw new Error('missing symptom')
  log.warn(`[notification-symptom] ${agent_id}: ${symptom}` +
    `${observed_at ? ` observed_at=${observed_at}` : ''}` +
    `${detail?.reason ? ` reason=${detail.reason}` : ''}` +
    `${detail?.deadline_ms ? ` deadline_ms=${detail.deadline_ms}` : ''}`)

  // Whether to act at all. `null` means record and stop — a refusal (the MCP
  // answered, so nothing on this machine is wrong) or a symptom this daemon does
  // not recognise, which must never be guessed into a restart.
  if (!actionForSymptom(symptom)) {
    return { ok: true, agent_id, symptom, recorded: true, acted: false, action: null }
  }

  try {
    // `ensure-process` converges by being a no-op when the process is already
    // there, and that no-op is the overwhelmingly common outcome for
    // `no-channel`: the agent is sitting in a live tmux session and it is the
    // SOCKET that is gone, not the process. `wakeMint` returns
    // `{ alreadyAlive: true }` and logs nothing, so the log showed 42
    // `no-channel` lines for one agent on 2026-08-27 with no record beside any
    // of them of what this machine did about it — reading as a daemon that
    // ignored the report rather than one whose remedy did not apply.
    //
    // Saying so is not a change of remedy. Whether a live process with no
    // channel should escalate past `ensure-process` is a behaviour question and
    // belongs to docs/notifications-and-liveness.md §"What is not settled".
    let wakeResult = null
    const performed = await performNotificationSymptomAction({
      symptom,
      ensureProcess: async () => { wakeResult = await rpcWake({ fleet_id: agent_id, agent_id }); return wakeResult },
      suggestRestart: () => terminalRpc.notifyConnectionDisconnected({ agent_id }),
    })
    if (performed) {
      log.warn(`[notification-symptom] ${agent_id}: ${symptom} -> ${performed}`
        + (performed === 'wake' ? ` (${wakeResult?.alreadyAlive ? 'no-op: process already alive' : 'started a process'})` : ''))
    }
    return { ok: true, agent_id, symptom, recorded: true, acted: true, action: performed, already_alive: wakeResult?.alreadyAlive ?? null }
  } catch (e) {
    // Reported, not thrown, and NOT death. The server is not waiting on this and
    // decides nothing from it; a remedy that failed is this machine's problem to
    // show in its own log, and the next symptom report will try again because
    // both actions converge. See AGENTS.md §"DEATH IS A FLAG IN THE DATABASE".
    log.warn(`[notification-symptom] ${agent_id}: remedy failed: ${e?.message || e}`)
    return { ok: false, agent_id, symptom, recorded: true, acted: false, error: e?.message || String(e) }
  }
}

let gooseSupervisor
const alivenessCache = new Map()

const agentStatus = createAgentStatus({
  tmuxArgs: TMUX_ARGS,
  sendMsg,
  log,
  getAgents: () => permissionLedger.listProcessBindings()
    .filter(row => row.daemonKey === `${MACHINE_ID}:${ACTIVE_ENV}`)
    .map(row => ({
      id: row.id,
      daemonKey: row.daemonKey,
      friendly_name: row.friendlyName,
      tmux_session: row.tmuxSession,
      runtimeKind: row.sessionKind,
      metadata: { kind: row.sessionKind, model: row.model },
    })),
  harnessForAgent: harnessRuntime.harnessForAgent,
  isConnected: () => _serverReady && _rws?.connected,
  statusScanMs: getStatusScanMs(),
})

const promptPlan = createPromptPlan({
  tmuxArgs: TMUX_ARGS,
  log,
  sendMsg,
  getAgents: () => agents,
  isArmed: agentStatus.isArmed,
  hasActiveTerminalWatch: tmuxSession => terminalRpc?.hasActiveWatch(tmuxSession),
  autoAcceptPrompt: (tmuxSession, reason, acceptKey) => terminalRpc.autoAcceptPrompt(tmuxSession, reason, acceptKey),
})

terminalRpc = createTerminalRpc({
  tmuxArgs: TMUX_ARGS,
  log,
  sendMsg,
  detectPrompt: promptPlan.detectPrompt,
  stripAnsi: promptPlan.stripAnsi,
  promptCooldowns: promptPlan.promptCooldowns,
  surfacedPrompts: promptPlan.surfacedPrompts,
  alivenessCache,
  thinkingSpinnerRe: THINKING_SPINNER_RE,
  interruptHintRe: INTERRUPT_HINT_RE,
  thinkingScanLines: THINKING_SCAN_LINES,
  terminalSizePollMs: TERMINAL_SIZE_POLL_MS,
  terminalInputAllowed: TERMINAL_INPUT_ALLOWED,
  decideTerminalWatchExit,
  resolveAgentRoute,
  onArmAgent: agentStatus.armAgent,
  onArmBySession: agentStatus.armBySession,
  onSessionInventoryChanged: reason => agentStatus.scanStatus(reason),
  onPlanModeSeen: promptPlan.scheduleCheckForPlanModePrompt,
  onPlanModeGone: promptPlan.clearPlanMode,
  hasPlanMode: promptPlan.hasPlanMode,
  validateTmuxOwner: ({ agentId, sessionId, tmuxSession }) => {
    const row = permissionLedger.get(agentId)
    if (!row) throw new Error(`tmux endpoint ownership rejected: no daemon ledger row for ${agentId}`)
    if (sessionId && row.sessionId && row.sessionId !== sessionId) {
      throw new Error(`tmux endpoint ownership rejected for ${agentId}: session ${sessionId} does not match ${row.sessionId}`)
    }
    if (!row.tmuxSession) throw new Error(`tmux endpoint ownership rejected: no tmux session recorded for ${agentId}`)
    if (row.tmuxSession !== tmuxSession) {
      throw new Error(`tmux endpoint ownership rejected for ${agentId}: tmux ${tmuxSession} does not match ${row.tmuxSession}`)
    }
    return true
  },
  resolveTerminalAgent: ({ agentId }) => (
    (() => {
      const row = permissionLedger.get(agentId)
      return row?.daemonKey === `${MACHINE_ID}:${ACTIVE_ENV}` ? row : null
    })()
  ),
})

gooseSupervisor = createGooseSupervisor({
  tmuxArgs: TMUX_ARGS,
  log,
  getAgents: () => agents,
  harnessForAgent: harnessRuntime.harnessForAgent,
  bufferActivity,
  isNoise: base => ACTIVITY_NOISE.has(base),
  sendText: gooseKickSend,
})

const agentLauncher = createAgentLauncher({
  activeEnvName: ACTIVE_ENV,
  configDir: CONFIG_DIR,
  loadDaemonLaunchConfig,
  log,
  machineId: MACHINE_ID,
  permissionLedger,
  sendMsg,
  getProjects: () => projects,
  tmux,
  tmuxArgs: TMUX_ARGS,
  tmuxSocket: TMUX_SOCKET,
  // A pending Codex launch has no durable resume identity until its rollout
  // exists. Resolve only the launched runtime's record; never infer identity
  // from the globally newest rollout.
  liveCodexSessionIdentityResolver: async ({ fleetId, sessionId, cwd, launchStartedAt, tmuxSession }) => {
    const agent = { id: fleetId, session_id: sessionId || null, cwd, registered_at: launchStartedAt }
    const live = await resolveLiveCodexSessionIdentity({ agent, tmuxSession, tmuxArgs: TMUX_ARGS, tmuxSocket: TMUX_SOCKET })
    if (live?.sessionId) return live
    return null
  },
  liveClaudeSessionIdentityResolver: async ({ fleetId, sessionId, cwd, launchStartedAt, tmuxSession }) => {
    return await resolveLiveClaudeSessionIdentity({
      agent: { id: fleetId, session_id: sessionId || null, cwd, registered_at: launchStartedAt },
      tmuxSession,
      tmuxArgs: TMUX_ARGS,
      tmuxSocket: TMUX_SOCKET,
    })
  },
})

const mintStore = new MintStore(path.join(CONFIG_DIR, 'daemon-mints.sqlite'), { defaultEnvName: ACTIVE_ENV })
function stripCompiledPermissionSet(processFact = {}) {
  const { permission_set: _permissionSet, ...rest } = processFact || {}
  return rest
}

async function bindMintSeat(facts, processFact = facts?.processState || {}, createdSource = 'daemon-mint-join') {
  if (!facts?.fleetId) return
  await permissionLedger.set(facts.fleetId, {
    permissionGrant: processFact.permission_grant,
    source: createdSource,
  })
  if (!facts.sessionId) return
  permissionLedger.setSessionSync(facts.fleetId, {
    sessionId: facts.sessionId,
    sessionKind: processFact.harness,
    sessionPath: facts.sessionPath,
    tmuxSession: processFact.tmux_session,
    model: processFact.model,
    machineId: MACHINE_ID,
    envName: ACTIVE_ENV,
    daemonKey: `${MACHINE_ID}:${ACTIVE_ENV}`,
    cwd: processFact.cwd,
    friendlyName: facts.friendlyName,
  })
}

async function mintProcessAlive(facts) {
  const tmuxSession = facts?.processState?.tmux_session
  if (!tmuxSession) return false
  return (await sessionRuntimeState(tmuxSession, { tmuxSocket: TMUX_SOCKET })).runtime
}

// The same probe, but reporting whether it managed to look. `mintProcessAlive`
// folds "no runtime" and "could not tell" into one `false`, which is right for a
// caller that will retry and wrong for one that is about to retire an identity.
async function mintProcessConfirmedDead(facts) {
  const tmuxSession = facts?.processState?.tmux_session
  if (!tmuxSession) return true
  return sessionConfirmedDead(await sessionRuntimeState(tmuxSession, { tmuxSocket: TMUX_SOCKET }))
}

// The bounded evidence a partial mint row can be checked against, in the order
// the daemon already trusts it: the seat's own process binding, any binding
// recorded under the same friendly name, and the tmux session the launch recipe
// would have produced. Each entry names a session to look at; none of them is
// itself permission to adopt one.
function partialMintCandidateSessions(facts) {
  const candidates = []
  const add = (tmuxSession, source, binding = null) => {
    if (tmuxSession) candidates.push({ tmuxSession, source, binding })
  }
  if (facts.fleetId) {
    const row = permissionLedger.get(facts.fleetId)
    if (row) add(row.tmuxSession, 'ledger-fleet-id', row)
  }
  if (facts.friendlyName) {
    for (const row of permissionLedger.listProcessBindings()) {
      if (row.friendlyName === facts.friendlyName) add(row.tmuxSession, 'ledger-friendly-name', row)
    }
    add(`fleet-${sanitizeSessionName(facts.friendlyName)}`, 'launch-recipe-session')
  }
  return candidates
}

function partialMintExpectedIdentity(facts) {
  const recipe = facts.launchRecipe || {}
  return {
    fleetId: facts.fleetId || null,
    mintId: facts.mintId || null,
    sessionId: facts.sessionId || null,
    friendlyName: facts.friendlyName || null,
    cwd: recipe.cwd || null,
    harness: recipe.kind || null,
    model: recipe.modelSpec?.alias || recipe.model || null,
    envName: facts.envName || ACTIVE_ENV,
    daemonKey: `${MACHINE_ID}:${ACTIVE_ENV}`,
  }
}

// What the running process says about itself, not what the mint hopes. The
// probe reads FLEET_ID, TLDA_ENV and FLEET_DAEMON_KEY off the runtime's own
// argv; the harness resolver reads the session the process has open, PID-owned
// rather than by launch window; the ledger row supplies the fields neither of
// those carries. A field nobody observed stays null, so it compares as unknown
// instead of as agreement.
async function partialMintObservedIdentity(facts, candidate) {
  // A ledger row speaks for a runtime only while it is the one row bound to it.
  // Two rows naming the same tmux session, or a row whose session is not the
  // one being adopted, is a ledger that has drifted from the box -- and a fleet
  // id taken from it is then a claim about bookkeeping rather than about the
  // process. It is still compared, so it can still refuse; it just stops being
  // able to authorize the adoption by itself.
  const rowsForSession = permissionLedger.listProcessBindings()
    .filter(row => row.tmuxSession && row.tmuxSession === candidate.tmuxSession)
  const binding = candidate.binding || rowsForSession[0] || null
  const ledgerBindsSingleRuntime = !!binding
    && rowsForSession.length === 1
    && binding.tmuxSession === candidate.tmuxSession
  const harness = binding?.sessionKind || facts.launchRecipe?.kind || null
  const agent = {
    id: candidate.probe?.fleetId || binding?.id || facts.fleetId || null,
    friendly_name: binding?.friendlyName || facts.friendlyName || null,
    cwd: binding?.cwd || facts.launchRecipe?.cwd || null,
    registered_at: facts.createdAt || null,
  }
  let live = null
  if (harness === 'codex') {
    live = await resolveLiveCodexSessionIdentity({
      agent,
      tmuxSession: candidate.tmuxSession,
      tmuxArgs: TMUX_ARGS,
      tmuxSocket: TMUX_SOCKET,
      processOwnedOnly: true,
    })
  } else if (harness === 'claude') {
    live = await resolveLiveClaudeSessionIdentity({
      agent,
      tmuxSession: candidate.tmuxSession,
      tmuxArgs: TMUX_ARGS,
      tmuxSocket: TMUX_SOCKET,
    })
  }
  return {
    fleetId: candidate.probe?.fleetId || binding?.id || null,
    mintId: null,
    sessionId: live?.sessionId || binding?.sessionId || null,
    sessionPath: live?.jsonlPath || binding?.sessionPath || null,
    ledgerBindsSingleRuntime,
    strongFieldSources: {
      fleetId: candidate.probe?.fleetId ? 'runtime-argv' : (binding?.id ? 'ledger' : null),
      sessionId: live?.sessionId ? 'harness-runtime' : (binding?.sessionId ? 'ledger' : null),
    },
    friendlyName: binding?.friendlyName || null,
    cwd: binding?.cwd || null,
    harness,
    model: binding?.model || null,
    envName: candidate.probe?.envName || binding?.envName || null,
    daemonKey: candidate.probe?.daemonKey || binding?.daemonKey || null,
    permissionGrant: binding?.permissionGrant || null,
  }
}

// The one write this path performs, and it is the write the mint was missing:
// the process facts of a runtime that is already up. `recordProcess` is the
// same call the launcher's result goes through, so the session facts and the
// seat binding follow the existing join. Nothing here spawns a process,
// requests a seat, or asks for a session name.
// The grant this runtime is bound under, resolved from the two authorities and
// normalized against this daemon's configuration -- before any write. The
// ordering matters as much as the answer: `recordProcess` persists the process
// fact and only then does `bindSeat` read the grant, so a grant rejected after
// the fact is rejected after the row has already been changed.
function partialMintPermissionGrant(facts, observed = {}) {
  const cwd = observed.cwd || facts.processState?.cwd || facts.launchRecipe?.cwd || null
  const config = withDaemonModelAliases(loadDaemonLaunchConfig(), readDaemonConfigForCwd(cwd))
  return resolvePartialMintPermissionAuthority({
    ledgerGrant: observed.permissionGrant || null,
    ledgerBindsSingleRuntime: !!observed.ledgerBindsSingleRuntime,
    // The recipe recorded on THIS mint row. `persistentLaunchRecipe` keeps
    // `permissionGrant` across restarts precisely so a wake can replay the
    // permissions the mint was issued under.
    recipeGrant: facts.launchRecipe?.permissionGrant ?? null,
    normalizeGrant: grant => normalizePermissionGrant(grant, config),
  })
}

async function recoverPartialMintRuntime(facts) {
  const decision = await resolvePartialMintRuntime({
    facts,
    expectedIdentity: partialMintExpectedIdentity,
    candidateSessions: partialMintCandidateSessions,
    listSessions: () => listSessionNames({ tmuxSocket: TMUX_SOCKET }),
    probeSession: session => sessionRuntimeState(session, { tmuxSocket: TMUX_SOCKET }),
    observeRuntimeIdentity: candidate => partialMintObservedIdentity(facts, candidate),
  })
  const adopting = decision.action === 'rebind' || decision.action === 'enrich'
  if (!adopting) {
    if (decision.action === 'hold') {
      log.warn(`mint ${facts.friendlyName || facts.mintId}: partial-mint recovery held (${decision.reason})`)
    }
    return decision
  }
  const observed = decision.observed || {}

  // Before the write, and it refuses rather than defaulting. A runtime nobody
  // can say what permissions it holds is not one to bind an identity to.
  const authority = partialMintPermissionGrant(facts, observed)
  if (!authority.ok) {
    log.warn(`mint ${facts.friendlyName || facts.mintId}: partial-mint recovery held (${authority.reason})`)
    return {
      action: 'hold',
      reason: authority.reason,
      session: decision.session,
      detail: authority.detail || null,
      examined: decision.examined,
    }
  }

  const expected = partialMintExpectedIdentity(facts)
  const recorded = facts.processState || {}
  // An enrich fills gaps in the fact that is already there. Every identity
  // field is taken from the record first, so completing the binding cannot
  // move the agent onto a different mint, fleet id, name, session or tmux --
  // and `updateProcessState` replaces the stored JSON wholesale, which is why
  // the untouched fields have to be carried through explicitly rather than
  // omitted.
  const enriching = decision.action === 'enrich'
  const processFact = {
    ...recorded,
    mint_id: recorded.mint_id || facts.mintId,
    fleet_id: recorded.fleet_id || expected.fleetId || observed.fleetId || null,
    name: recorded.name || facts.friendlyName || observed.friendlyName || null,
    tmux_session: enriching ? recorded.tmux_session : decision.session,
    cwd: recorded.cwd || observed.cwd || expected.cwd || null,
    harness: recorded.harness || observed.harness || expected.harness || null,
    model: recorded.model || observed.model || expected.model || null,
    session_id: recorded.session_id || observed.sessionId || facts.sessionId || null,
    session_path: recorded.session_path || observed.sessionPath || facts.sessionPath || null,
    permission_grant: authority.grant,
    machine_id: recorded.machine_id || MACHINE_ID,
    env_name: recorded.env_name || ACTIVE_ENV,
    daemon_key: recorded.daemon_key || `${MACHINE_ID}:${ACTIVE_ENV}`,
    alive: true,
  }
  const rebound = await daemonMintCore.recordProcess(facts.mintId, processFact)
  log.info(
    `mint ${facts.friendlyName || facts.mintId}: ${enriching ? 'completed' : 'rebound'} live runtime `
    + `${processFact.tmux_session} (${decision.reason}, grant from ${authority.source}) without spawning`,
  )
  return {
    action: enriching ? 'enriched' : 'rebound',
    reason: decision.reason,
    session: processFact.tmux_session,
    grantSource: authority.source,
    facts: rebound,
  }
}

daemonMintCore = createDaemonMintCore({
  store: mintStore,
  envName: ACTIVE_ENV,
  recoverExistingRuntime: recoverPartialMintRuntime,
  registrationDeadlineMs: getMintRegistrationDeadlineMs(),
  processAlive: mintProcessAlive,
  launchProcess: async params => {
    const launchStartedAt = new Date().toISOString()
    const processFact = await launchMintProcess({
      ...params,
      mintId: params.mint_id,
      fleetId: params.fleet_id,
      requestedKind: params.kind,
      activeEnvName: ACTIVE_ENV,
      machineId: MACHINE_ID,
      tmuxSocket: TMUX_SOCKET,
    })
    const recorded = stripCompiledPermissionSet(processFact)
    if (processFact.session_id || processFact.harness !== 'codex') return recorded
    // A fresh Codex process can be alive before it opens its rollout. Persist
    // the process and grant now; transcript discovery completes the join later.
    // In particular, do not put the global session-tree fallback on the mint's
    // commit path: under machine load that synchronous walk held process_state
    // and the permission grant unwritten for minutes after the agent logged in.
    void resolveLiveCodexSessionIdentityUntil({
      agent: {
        id: processFact.fleet_id || params.fleet_id || null,
        friendly_name: processFact.name || params.name || null,
        cwd: processFact.cwd,
        registered_at: launchStartedAt,
      },
      tmuxSession: processFact.tmux_session,
      tmuxArgs: TMUX_ARGS,
      tmuxSocket: TMUX_SOCKET,
      processOwnedOnly: true,
      deadlineMs: getMintRegistrationDeadlineMs(),
      isProcessAlive: () => mintProcessAlive({ processState: processFact }),
    }).then(async live => {
      if (!live?.sessionId) return
      await daemonMintCore.recordSession(params.mint_id, {
        session_id: live.sessionId,
        session_path: live.jsonlPath || null,
      })
    }).catch(error => {
      log.warn(`mint ${processFact.name || params.name || params.mint_id}: deferred Codex session discovery failed: ${error.message}`)
    })
    return recorded
  },
  requestSeat: ({ mint_id, name, metadata, launch, fail_if_not_fresh }) => wsMintShell({
    localAgentId: mint_id,
    name,
    tmuxSession: null,
    cwd: launch.cwd,
    // The resolved alias, not the requested string: a mint that names no model
    // still runs on one, and `register.mjs` only writes metadata.model when it
    // is given a value. Sending the request meant every default-model agent
    // reached the roster with no model at all — the agents panel expansion has
    // a model chip and simply had nothing to show. `kind` below already takes
    // the resolved harness for the same reason.
    model: launch.modelSpec?.alias || launch.model,
    effort: launch.effort,
    kind: launch.kind || 'codex',
    metadata,
    failIfNotFresh: fail_if_not_fresh,
    machineId: MACHINE_ID,
    envName: ACTIVE_ENV,
    daemonKey: `${MACHINE_ID}:${ACTIVE_ENV}`,
  }),
  bindSeat: async facts => {
    const processFact = facts.processState || {}
    await bindMintSeat(facts, processFact, 'daemon-mint-join')
  },
})

const wakeMint = createDaemonWakeCore({
  store: mintStore,
  targetDaemonKey: `${MACHINE_ID}:${ACTIVE_ENV}`,
  recoverExistingRuntime: recoverPartialMintRuntime,
  retryPolicy: facts => ({
    attempts: 6,
    delayMs: 100,
    confirmExisting: (facts.processState?.harness || facts.launchRecipe?.kind) === 'bot',
  }),
  processAlive: async facts => {
    const tmuxSession = facts.processState?.tmux_session
    if (!tmuxSession) return false
    const state = await sessionRuntimeState(tmuxSession, { tmuxSocket: TMUX_SOCKET })
    return state.runtime
  },
  processDaemonKey: async facts => {
    const tmuxSession = facts.processState?.tmux_session
    if (!tmuxSession) return null
    const runtime = await sessionRuntimeState(tmuxSession, { tmuxSocket: TMUX_SOCKET })
    return runtime.daemonKey || facts.processState?.daemon_key || null
  },
  replaceProcess: async facts => {
    const tmuxSession = facts.processState?.tmux_session
    if (!tmuxSession) return false
    return terminateTmuxSession(tmuxSession, { tmuxSocket: TMUX_SOCKET })
  },
  resumeSession: async (facts, wakeParams = {}) => {
    const wakePermission = compileWakePermissionProfile({
      facts,
      wakeParams,
      ledgerGrant: facts.fleetId ? (permissionLedger.get(facts.fleetId)?.permissionGrant || null) : null,
      loadDaemonLaunchConfig,
      readDaemonConfigForCwd,
      withDaemonModelAliases,
      compilePermissionGrant,
    })
    const processFact = await launchMintProcess({
      ...(facts.launchRecipe || {}),
      config: wakePermission.config || facts.launchRecipe?.config,
      mintId: facts.mintId,
      fleetId: facts.fleetId,
      name: facts.friendlyName,
      resumeId: facts.sessionId,
      requestedKind: facts.processState?.harness || facts.launchRecipe?.kind || 'codex',
      permissionGrant: wakePermission.permissionGrant,
      permissionSet: wakePermission.permissionSet,
      activeEnvName: ACTIVE_ENV,
      machineId: MACHINE_ID,
      tmuxSocket: TMUX_SOCKET,
      exactTmuxSession: true,
    })
    await bindMintSeat({ ...facts, processState: processFact }, processFact, 'daemon-wake')
    return processFact
  },
})

async function rpcMint(params = {}) {
  const cwd = resolveMintCwd({
    cwd: params.cwd,
    project: params.project,
    getProjectSourceDir: project => sourceSync.getSourceDir(project),
  })
  const daemonConfig = readDaemonConfigForCwd(cwd)
  const spawnConfig = withDaemonModelAliases(loadDaemonLaunchConfig(), daemonConfig)
  const explicitKind = String(params.kind || '').trim().toLowerCase()
  const modelSpec = explicitKind === 'bot'
    ? BOT_MODEL_SPEC
    : resolveModelSpec(params.model, { config: spawnConfig })
  const requester = params.requester || { id: 'localhost', human: true }
  const spawnerGrant = permissionLedger.get(requester.id) || permissionLedger.grantFor(requester)
  const defaultProfile = daemonConfig?.default || null
  const grantConfig = defaultProfile
    ? { ...spawnConfig, projectPermissionProfiles: { ...(spawnConfig.projectPermissionProfiles || {}), [cwd]: defaultProfile } }
    : spawnConfig
  const grant = resolveSpawnGrant({
    permissionRequest: params.permissionRequest,
    requester,
    spawnerPermissionSet: compilePermissionGrant(grantConfig, spawnerGrant.permissionGrant, { cwd }),
    spawnerPermissionProfile: permissionGrantProfileName(spawnerGrant.permissionGrant),
    spawnerPermissionGrant: spawnerGrant.permissionGrant,
    model: modelSpec.id,
    kind: modelSpec.harness,
    modelCap: modelSpec.cap || null,
    config: grantConfig,
    cwd,
  })
  const mintClampLine = permissionClampLine(grant.permissionClamp)
  if (mintClampLine) {
    log.warn(`mint ${params.friendly_name || params.name || '(unnamed)'}: ${mintClampLine}`)
  }
  const failIfNotFresh = !!params.failIfNotFresh || !!params.fail_if_not_fresh
  let preReservedBotFleetId = null
  const cleanupPreReservedBotSeat = async reason => {
    if (!preReservedBotFleetId) return
    try {
      await markAgentDead(preReservedBotFleetId)
    } catch (e) {
      log.warn(`mint ${params.friendly_name || params.name || '(unnamed)'}: could not mark pre-reserved bot shell ${preReservedBotFleetId} dead after ${reason}: ${e.message}`)
    }
  }
  // A named bot mint that already recorded an identity is the same bot starting
  // again, not a new one, so it launches under the identity it has. mint-core makes
  // exactly this check before requesting a seat; the bot pre-reservation below runs
  // outside it, and without the same check every restart asks the allocator for a
  // fresh agent named after the bot. The shell that request creates then holds the
  // name, so the next restart cannot have it — the launcher competes with its own
  // child, and loses to itself every time.
  const recordedBotMint = explicitKind === 'bot' && !(params.fleet_id || params.agent_id)
    ? recordedMintIdentity(mintStore, params.mint_id)
    : null
  if (recordedBotMint) {
    params = {
      ...params,
      fleet_id: recordedBotMint.fleetId,
      friendly_name: recordedBotMint.friendlyName || params.friendly_name || params.name || null,
      botName: params.botName || params.bot_name || params.name || null,
    }
  }
  if (explicitKind === 'bot' && !(params.fleet_id || params.agent_id)) {
    const requestedName = params.friendly_name || params.name || null
    const mintId = params.mint_id || randomUUID()
    const botSeat = await wsMintShell({
      localAgentId: mintId,
      name: requestedName,
      tmuxSession: null,
      cwd,
      model: 'bot',
      kind: 'bot',
      metadata: params.metadata || null,
      failIfNotFresh,
      machineId: MACHINE_ID,
      envName: ACTIVE_ENV,
      daemonKey: `${MACHINE_ID}:${ACTIVE_ENV}`,
    })
    const assignedFleetId = botSeat?.fleet_id || botSeat?.server_agent_id || botSeat?.agent?.id || null
    if (!assignedFleetId) throw new Error('bot mint returned no fleet_id')
    const assignedName = botSeat?.friendly_name || botSeat?.assigned_name || botSeat?.agent?.friendly_name || requestedName
    preReservedBotFleetId = assignedFleetId
    if (failIfNotFresh && requestedName && assignedName !== requestedName) {
      await cleanupPreReservedBotSeat(`name changed to ${assignedName || '(none)'}`)
      throw new Error(`Spawn name "${requestedName}" is unavailable: mint-shell assigned "${assignedName || '(none)'}" instead. Wake the existing agent.`)
    }
    params = {
      ...params,
      mint_id: mintId,
      fleet_id: assignedFleetId,
      friendly_name: assignedName,
      botName: params.botName || params.bot_name || requestedName,
    }
  }
  let facts
  try {
    facts = await daemonMintCore.mint({
      mint_id: params.mint_id || null,
      fleet_id: params.fleet_id || params.agent_id || null,
      name: params.friendly_name || params.name || null,
      metadata: params.metadata || null,
      request_seat: !(params.fleet_id || params.agent_id),
      fail_if_not_fresh: failIfNotFresh,
      onLifecycleEvent: params.onLifecycleEvent,
      launch: {
        name: params.friendly_name || params.name || null,
        model: params.model,
        modelSpec,
        config: spawnConfig,
        kind: params.kind || modelSpec.harness,
        botScript: params.botScript || params.bot_script || params.script || null,
        botName: params.botName || params.bot_name || null,
        botPidFile: params.botPidFile || params.bot_pid_file || null,
        botHeartbeatFile: params.botHeartbeatFile || params.bot_heartbeat_file || null,
        botWaitChannel: params.botWaitChannel || params.bot_wait_channel || null,
        // The bot's declared `env:`. Both ends of this were already built --
        // agent-launch/index.mjs threads `botEnv` through and the bot harness
        // emits it -- and this object, the transport between them, simply did not
        // list the field. It sits in the launch recipe, so a wake replays the
        // same settings rather than starting the bot unconfigured.
        botEnv: params.botEnv || params.bot_env || null,
        cwd,
        effort: params.effort,
        mode: params.mode,
        permissionRequest: params.permissionRequest,
        permissionGrant: grant.permissionGrant,
        permissionSet: grant.permissionSet,
        acknowledgeNoSecurity: params.acknowledgeNoSecurity,
        requester: params.requester,
      },
    })
  } catch (e) {
    await cleanupPreReservedBotSeat(e.message || 'launch failed')
    throw e
  }
  if ((params.failIfNotFresh || params.fail_if_not_fresh) && facts.registrationError) {
    throw new Error(facts.registrationError)
  }
  const joined = !!facts.joinedAt
  const launchedPendingIdentity = !joined && !!facts.fleetId && !!facts.processState
  // A mint that gives up returns; it does not throw. Every cleanup here was
  // written as a `catch`, so the pre-reserved bot shell survived a failure
  // expressed as a return value. That branch was unreachable while both mint
  // retry loops were unbounded -- mint() could not return un-joined -- and
  // bounding them is what makes it reachable, so it is closed in the same
  // change.
  //
  // Only when nothing is running under it. An un-joined mint whose process is
  // alive is an agent that has not bound yet, and it can still bind through the
  // login marker; marking its seat dead would retire a live agent's identity.
  //
  // Confirmed dead, not merely not-confirmed-alive. The probe answers `runtime:
  // false` both when the session is empty and when it could not look -- a missing
  // tmux socket, or `ps` exceeding its 5s timeout, which is likeliest exactly when
  // the box is loaded and mints are already failing. Read as a plain boolean it
  // retires the identity of a live agent on a slow `ps`, which is the outcome the
  // paragraph above exists to prevent. Not looking is not evidence of absence.
  if (!joined && await mintProcessConfirmedDead(facts)) {
    await cleanupPreReservedBotSeat(facts.registrationError || 'launched but never joined the fleet')
  }
  return {
    ok: joined || launchedPendingIdentity,
    pending: launchedPendingIdentity || undefined,
    mint_id: facts.mintId,
    fleet_id: facts.fleetId,
    agent_id: facts.fleetId,
    name: facts.friendlyName,
    // Which daemon prepared this mint. The bot path above already hands these
    // three to wsMintShell, so the daemon has always known them — it just did
    // not say so on the way back. Their absence is why the route-proof gate was
    // reverted twice on 08-11: the real success path returned no proof and so
    // failed identically to the denial path, which no denial test can catch.
    machine_id: MACHINE_ID,
    env_name: ACTIVE_ENV,
    daemon_key: `${MACHINE_ID}:${ACTIVE_ENV}`,
    tmux_session: facts.processState?.tmux_session || null,
    session_id: facts.sessionId,
    joined,
    ...(!joined && !launchedPendingIdentity ? {
      reason: facts.registrationError ? 'registration-deferred' : 'join-failed',
      error: facts.registrationError || `mint ${facts.mintId} launched but never joined the fleet`,
    } : {}),
    registration_deferred: !!facts.registrationError,
    registration_error: facts.registrationError || null,
    permission_grant: grant.permissionGrant,
    permission_clamp: grant.permissionClamp || null,
  }
}

async function rpcWake(params = {}) {
  const identifier = params.mint_id || params.mintId || params.fleet_id || params.fleetId || params.name
  const facts = mintStore.resolve(identifier)
  if (
    facts?.processState?.harness === 'codex'
    && !facts.joinedAt
    && await mintProcessAlive(facts)
  ) {
    const live = await resolveLiveCodexSessionIdentityUntil({
      agent: {
        id: facts.fleetId || null,
        friendly_name: facts.friendlyName || null,
        cwd: facts.processState.cwd,
        registered_at: facts.createdAt,
      },
      tmuxSession: facts.processState.tmux_session,
      tmuxArgs: TMUX_ARGS,
      tmuxSocket: TMUX_SOCKET,
      processOwnedOnly: true,
      deadlineMs: getMintRegistrationDeadlineMs(),
      isProcessAlive: () => mintProcessAlive(facts),
    })
    if (live?.sessionId) {
      await daemonMintCore.recordSession(facts.mintId, {
        session_id: live.sessionId,
        session_path: live.jsonlPath || null,
      })
    }
  }
  return wakeMint(params)
}

// Kill the agent's session and bring it back, entirely inside the daemon.
//
// This exists so an agent can restart ITSELF. Doing it from the agent's own
// shell cannot work: the hibernate kills the tmux session the CLI is running in,
// so the process that was going to issue the wake dies first and the agent never
// comes back. Skip, 2026-08-08 17:22 EDT: "you have to bounce it off the demon,
// so that you can do it to yourself. That is the point."
//
// It matters because MCP-client code reaches an agent only when that agent's
// process restarts — so a fix can be merged, deployed, and invisible to every
// running agent, including the one that shipped it.
//
// Both halves already exist here; this only composes them, so there is no second
// mechanism to keep in step with hibernate or wake.
async function rpcRestart(params = {}) {
  const agentId = params.agent_id || params.agentId
  const mintId = params.mint_id || params.mintId
  if (!agentId && !mintId) throw new Error('restart requires agent_id or mint_id')
  const killed = await terminalRpc.handlers['kill-session']({
    agent_id: agentId,
    mint_id: mintId,
  }).catch(e => ({ ok: false, error: e?.message || String(e) }))
  // BOTH HALVES DECIDE, and the kill is the one that was silently optional.
  // A restart exists to replace the process, so if the kill did not happen there
  // is nothing to wake: `wakeMint` finds the session already alive, returns ok,
  // and the caller is told the restart succeeded. That is not a hypothetical —
  // `really-able-to-do-stuff` was reported restarted twice while its codex
  // process ran unbroken from 17:18:41, and its missing tlda MCP survived both
  // because no process ever ended. Stop before the wake so the kill's own error
  // is what the caller sees.
  if (killed?.ok === false) {
    throw new Error(`restart did not kill the session: ${killed.error || 'kill-session refused'}`)
  }
  // And `ok` is not enough, because kill-session answers `{ ok: true,
  // already_unavailable: true }` whenever resolveTerminalEndpoint cannot place
  // the agent — correct for a hibernate, whose goal is "not running", and wrong
  // here, whose goal is a replaced process. That is the path that reported
  // really-able-to-do-stuff restarted while tmux still held its session. So ask
  // tmux, rather than believing the handler: if the session is still listed,
  // nothing was killed and there is nothing to wake.
  // The caller supplies the session name because the daemon cannot derive it
  // here: resolveTerminalEndpoint reads it off the agent row, and a row missing
  // it is exactly the `already_unavailable` case this check exists to catch.
  const sessionName = params.tmux_session || params.tmuxSession
  if (sessionName) {
    const listed = await terminalRpc.handlers['list-sessions']().catch(() => null)
    if (listed?.sessions?.includes(sessionName)) {
      throw new Error(`restart did not kill the session: tmux still lists "${sessionName}"${killed?.already_unavailable ? ' (the daemon could not place this agent, so kill-session was a no-op)' : ''}`)
    }
  }
  const woke = await wakeMint(params)
  // And a restart that killed and did not wake is a hibernate.
  return { ok: woke?.ok !== false, killed, woke }
}

const machineRpc = createMachineRpc({
  sendMsg,
  getPid: () => process.pid,
  executionDbPath: path.join(CONFIG_DIR, 'daemon-rpc-executions.sqlite'),
})
machineRpc.register({
  'resolve-agent-route': resolveAgentRoute,
  'native-subagent-routes': ({ parent_agent_id, child_agent_ids }) =>
    jsonlIngestor.nativeSubagentRoutes(parent_agent_id, child_agent_ids),
  'native-subagent-route-for-tool-use': ({ parent_agent_id, tool_use_id }) =>
    jsonlIngestor.nativeSubagentRouteForToolUse(parent_agent_id, tool_use_id),
  ...terminalRpc.handlers,
  'notification-symptom': rpcNotificationSymptom,
  ...agentLauncher.handlers,
  'mint': rpcMint,
  'wake': rpcWake,
  ...localArtifacts.handlers,
  'mirror-shadow-ref': shadowMirror.mirrorShadowRef,
  'project-git-remote': ({ project, operation, ...params }) => sourceSync.remoteOperation(project, operation, params),
})

function startLocalLifecycleRpc() {
  fs.mkdirSync(path.dirname(LOCAL_RPC_SOCKET), { recursive: true })
  fs.rmSync(LOCAL_RPC_SOCKET, { force: true })
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    let raw = ''
    let observing = true
    const writeFrame = payload => {
      if (!observing || socket.destroyed || !socket.writable) return
      socket.write(`${JSON.stringify(payload)}\n`)
    }
    socket.setEncoding('utf8')
    socket.on('data', chunk => { raw += chunk })
    socket.on('error', () => { observing = false })
    socket.on('close', () => { observing = false })
    socket.on('end', () => {
      let request
      try {
        request = JSON.parse(raw || '{}')
        const op = String(request.op || '').trim()
        const handlers = {
          mint: rpcMint,
          wake: rpcWake,
          restart: rpcRestart,
          spawn: agentLauncher.handlers.spawn,
          'project-source-link': rpcLinkProjectSource,
          'project-source-unlink': rpcUnlinkProjectSource,
          'project-rebuild': rpcRebuildProject,
          'project-publish-revision': rpcPublishProjectRevision,
          'project-git-remote': ({ project, operation, ...params }) => sourceSync.remoteOperation(project, operation, params),
        }
        const handler = handlers[op]
        if (!handler) throw new Error(`unsupported local daemon op: ${op || '(missing)'}`)
        const params = {
          ...(request.params || {}),
          onLifecycleEvent: (event, data = {}) => writeFrame({ event, data }),
        }
        Promise.resolve(handler(params))
          .then(result => {
            if (observing) socket.end(`${JSON.stringify({ ok: true, result })}\n`)
          })
          .catch(e => {
            if (observing) socket.end(`${JSON.stringify({ ok: false, error: e.message || String(e) })}\n`)
          })
      } catch (e) {
        if (observing) socket.end(`${JSON.stringify({ ok: false, error: e.message || String(e) })}\n`)
      }
    })
  })
  server.on('error', error => {
    log.error(`local lifecycle rpc failed: ${error.message}`)
    sendMsg({
      type: 'daemon-warning',
      warning: 'local-lifecycle-rpc-failed',
      error: error.message,
      socket: LOCAL_RPC_SOCKET,
    })
    process.exit(1)
  })
  server.listen(LOCAL_RPC_SOCKET, () => {
    try {
      fs.chmodSync(LOCAL_RPC_SOCKET, 0o600)
    } catch (error) {
      log.error(`local lifecycle rpc socket hardening failed: ${error.message}`)
      server.close(() => process.exit(1))
      return
    }
    log.info(`local lifecycle rpc listening on ${LOCAL_RPC_SOCKET}`)
  })
}

startLocalLifecycleRpc()

async function handleRpc(msg) {
  return daemonOperationContext.run(msg.fleet_operation || null, () => machineRpc.handleRpc(msg))
}

// ---------- WS connection ----------

const daemonOutbox = new DaemonOutbox(DAEMON_OUTBOX_FILE)
migrateLegacyDeadLetters()
const daemonDelivery = new DaemonDeliveryRuntime({
  outbox: daemonOutbox,
  send: message => _rws?.send(message) === true,
  isConnected: () => _rws?.connected === true,
  isReady: () => _serverReady === true,
  log,
  inflightDeadlineMs: getOutboxInflightDeadlineMs(),
  flushByteBudget: getOutboxFlushByteBudget(),
  activityDeliveryCounters: daemonActivityDeliveryCounters,
})

function migrateLegacyDeadLetters() {
  if (!fs.existsSync(LEGACY_DEAD_LETTER_FILE)) return
  const lines = fs.readFileSync(LEGACY_DEAD_LETTER_FILE, 'utf8').split(/\n/).filter(line => line.trim())
  let migrated = 0
  let malformed = 0
  for (const line of lines) {
    try {
      const msg = JSON.parse(line)
      delete msg.dropped
      daemonOutbox.enqueue(msg)
      migrated++
    } catch {
      malformed++
    }
  }
  fs.rmSync(LEGACY_DEAD_LETTER_FILE, { force: true })
  log.warn(`migrated legacy daemon dead letters into outbox: migrated=${migrated} malformed=${malformed}`)
}

function sendDaemonMessageAttempt(obj) {
  return daemonDelivery.send(obj)
}

const daemonServerTransport = createFleetOperationTransport({
  name: 'daemon-server',
  sendEphemeral: (_operation, payload, options) => sendDaemonMessageAttempt({
    ...payload,
    operation_id: payload?.operation_id || options.envelope.operation_id,
    fleet_operation: options.envelope,
  }),
  sendDurable: (_operation, payload, options) => sendDaemonMessageAttempt({
    ...payload,
    operation_id: payload?.operation_id || options.envelope.operation_id,
    fleet_operation: options.envelope,
  }),
})

const daemonOperationContext = new AsyncLocalStorage()

function sendMsg(obj) {
  const parent = daemonOperationContext.getStore()
  return daemonServerTransport.durable(obj?.type || 'daemon-message', obj, {
    sender: `${MACHINE_ID}:${ACTIVE_ENV}`,
    destination: 'server',
    parentOperationId: parent?.operation_id || null,
  })
}

function sendMsgWithReply(obj, { timeoutMs = 15000 } = {}) {
  return machineRpc.requestWithReply(obj, { timeoutMs })
}

async function daemonApi(method, route, body = null) {
  const response = await fetch(`${SERVER}${route}`, {
    method,
    headers: {
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || `${method} ${route} failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return payload
}

function ackServerDaemonOutboxMessage(msg) {
  const outboxId = msg?.[SERVER_DAEMON_OUTBOX_ID_FIELD]
  if (!outboxId) return
  sendMsg({
    type: SERVER_DAEMON_OUTBOX_ACK_TYPE,
    outbox_id: outboxId,
  })
}

function errorServerDaemonOutboxMessage(msg, error) {
  const outboxId = msg?.[SERVER_DAEMON_OUTBOX_ID_FIELD]
  if (!outboxId) return
  sendMsg({
    type: SERVER_DAEMON_OUTBOX_ERROR_TYPE,
    outbox_id: outboxId,
    error: String(error?.message || error || 'receiver did not accept delivery'),
    permanent: error?.permanent === true,
  })
}

function teardownWatchers({ jsonl = true, reason = 'unspecified' } = {}) {
  // This path emitted nothing, so "did teardown actually run?" was unanswerable
  // from the log -- grepping for it returned zero hits from a path that
  // definitely runs, which reads identically to "it never happened."
  //
  // That cost a real answer on 2026-07-28: across a live deploy, whether an
  // established-connection loss still tore down could only be INFERRED from the
  // code, while the never-established case was directly measurable (8 of 10
  // onClose events). Same class as slowquery.log wrapping .all()/.get() and
  // never .run() -- an instrument structurally blind to the thing it is aimed
  // at. `log.info` so it lands with no flag to set.
  log.info(`teardown watchers (${reason})${jsonl ? '' : ' [jsonl retained]'}`)
  if (jsonl) {
    jsonlIngestor.teardown()
    jsonlBindingReconciler.invalidate()
    _lastSessionWatcherRosterSig = ''
  }
  // Source watchers survive WS disconnects — they detect file changes
  // independently and queue them for the next connected window.
  terminalRpc.stopAllTerminalWatches()
}

// Gate 1 observability: correlates one daemon WS connection attempt across
// client and server logs. `connection_attempt_id` is client-minted
// (BOOT_ID:attemptSeq, never reused across a process lifetime); the server
// echoes its own ws._wsSessionId in daemon-welcome so the two can be joined
// after the fact. Content-free: no token, URL query, session/resume/terminal
// capability identifiers. Observability only — does not affect connect/retry
// behavior, does not add a self-poll, does not change delivery policy.
function traceGate1(stage, detail) {
  log.info(`[gate1-trace] ${stage} ${JSON.stringify({ ts: new Date().toISOString(), ...detail })}`)
}

function connect() {
  _rws = new ResilientWS({
    url: () => SERVER.replace(/^http/, 'ws') + '/ws/fleet-daemon' +
      (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''),
    label: 'daemon',
    // Log a silent server path after three missed 30s pings. Silence alone is
    // not a teardown predicate; ResilientWS reconnects on close/error,
    // connect-timeout, or send failure.
    heartbeatTimeoutMs: 90_000,
    onRetryScheduled: (attemptId, delayMs) => {
      traceGate1('retry-scheduled', {
        daemon_key: `${MACHINE_ID}:${ACTIVE_ENV}`,
        boot_id: BOOT_ID,
        connection_attempt_id: attemptId ? `${BOOT_ID}:${attemptId}` : null,
        delay_ms: delayMs,
      })
    },
    onAttemptOpen: (attemptId) => {
      traceGate1('attempt-opened', {
        daemon_key: `${MACHINE_ID}:${ACTIVE_ENV}`,
        boot_id: BOOT_ID,
        connection_attempt_id: `${BOOT_ID}:${attemptId}`,
      })
    },
    onOpen: (ws, attemptId) => {
      daemonWsConnectedAtMs = Date.now()
      daemonActivityDeliveryCounters.record(
        ACTIVITY_DELIVERY_STAGES.DAEMON_WS_CONNECTED,
        { type: 'fleet-daemon-ws' },
        1,
        { error: `attempt=${attemptId}` }
      )
      const connectionAttemptId = `${BOOT_ID}:${attemptId}`
      const sent = sendMsg({
        type: 'daemon-hello',
        machine_id: MACHINE_ID,
        env_name: ACTIVE_ENV,
        user: USER,
        hostname: HOSTNAME,
        version: VERSION,
        boot_id: BOOT_ID,
        install_path: INSTALL_PATH,
        capabilities: {
          terminalInputAllowed: terminalRpc.capabilities.terminalInputAllowed,
        },
        source_bindings: sourceSync.bindingRecords(),
        connection_attempt_id: connectionAttemptId,
      })
      traceGate1('hello-send', {
        daemon_key: `${MACHINE_ID}:${ACTIVE_ENV}`,
        boot_id: BOOT_ID,
        connection_attempt_id: connectionAttemptId,
        sent,
      })
    },
    onMessage: handleServerMessage,
    onClose: (reason, attemptId, { established = true } = {}) => {
      const now = Date.now()
      const uptimeMs = daemonWsConnectedAtMs == null ? null : now - daemonWsConnectedAtMs
      daemonWsConnectedAtMs = null
      // Deliberately ungated: this traces the attempt lifecycle, so a failed
      // attempt is exactly what it is for. Only claims about a *connection*
      // move below the gate.
      traceGate1('client-close-detected', {
        daemon_key: `${MACHINE_ID}:${ACTIVE_ENV}`,
        boot_id: BOOT_ID,
        connection_attempt_id: attemptId ? `${BOOT_ID}:${attemptId}` : null,
        reason,
      })
      // Teardown belongs to losing an ESTABLISHED connection. A connect attempt
      // that never reached OPEN holds none of this state, so there is nothing to
      // tear down and doing it anyway is pure damage.
      //
      // Measured in fleet-daemon.testing.log on 2026-07-28: 237
      // `connection attempt timed out after 5000ms`, against 30 heartbeat
      // drops -- the 5s connect timeout retrying while Fly cold-starts for
      // 90-120s, reaching attempt 34 inside a single boot. (The teardown itself
      // is not logged, so that count is the attempts; the teardown per attempt
      // follows from onClose having been unconditional.)
      //
      // Raising the timeout is not the fix: at any value the teardown-per-attempt
      // is wrong, a longer timeout only makes it rarer.
      if (!established) return
      // A disconnect is the loss of a connection. Counting a connect attempt
      // that never opened as one inflated this by an order of magnitude -- 237
      // non-connections against 30 real drops on 2026-07-28 -- and an inflated
      // counter is how someone later builds a theory on a number that was never
      // real. Nothing reads its value (only the constant and a structural
      // regression test reference it), so gating changes the count without
      // changing what it means to any reader.
      daemonActivityDeliveryCounters.record(
        ACTIVITY_DELIVERY_STAGES.DAEMON_WS_DISCONNECTED,
        { type: 'fleet-daemon-ws' },
        1,
        { error: `${reason || 'unknown'}${uptimeMs == null ? '' : ` uptimeMs=${uptimeMs}`}` }
      )
      _serverReady = false
      alivenessCache.clear()
      teardownWatchers({ reason: `connection-lost:${reason || 'unknown'}` })
    },
  })
  _rws.connect()
}

function reconcileRoster(reason) {
  _lastSessionWatcherRosterSig = reconcileDaemonRoster({
    agents,
    signature: _lastSessionWatcherRosterSig,
    reason,
    syncIdentityNames: roster => jsonlIngestor.syncIdentityNames(roster),
    syncIfRosterChanged: options => jsonlIngestor.syncIfRosterChanged(options),
    onChanged: () => {},
  })
}

function reconcileJsonlProcessBindings(reason) {
  return jsonlBindingReconciler.reconcile(reason)
    .catch(e => log.error(`syncSessionWatchers failed: ${e.stack || e.message}`))
}

_onPermissionLedgerProcessBindingChange = () => {
  if (!_serverReady) return
  reconcileJsonlProcessBindings('permission-ledger-session-binding')
}

function applyAgentStatusEvents(events = []) {
  for (const event of events) {
    if (event.seq <= agentStatusSeq) continue
    if (event.type === 'agent-upsert') {
      const index = agents.findIndex(agent => agent.id === event.agent.id)
      if (index >= 0) agents[index] = event.agent
      else agents.push(event.agent)
    }
    agentStatusSeq = event.seq
  }
}

async function handleServerMessage(msg, wsAttemptId) {
  if (machineRpc.handleReply(msg)) return
  if (msg.type === 'head-changed' || msg.type === 'HeadChanged') {
    await sourceSync.headChanged(msg.project, msg.revision || msg.sourceRevision || null)
    return
  }
  if (msg.type === 'project-metadata-changed') {
    if (!sourceSync.boundProjectNames().includes(msg.project)) return
    serverProjects = await loadLocallyBoundProjects()
    refreshBoundDocumentRoots(msg.project)
    applyProjectWorldOwnership('project-metadata-changed')
    return
  }
  if (msg.type === DAEMON_OUTBOX_ACK_TYPE) {
    if (msg.outbox_id) daemonDelivery.handleAck(msg.outbox_id)
    return
  }
  if (msg.type === DAEMON_OUTBOX_ERROR_TYPE) {
    if (msg.outbox_id) {
      surfaceDaemonOutboxError(msg)
      daemonDelivery.handleError(msg.outbox_id, msg.error || 'delivery failed', { permanent: msg.permanent === true })
    }
    return
  }
  if (msg.type === 'daemon-welcome') {
    traceGate1('welcome-received', {
      daemon_key: `${MACHINE_ID}:${ACTIVE_ENV}`,
      boot_id: BOOT_ID,
      connection_attempt_id: wsAttemptId ? `${BOOT_ID}:${wsAttemptId}` : null,
      server_ws_session_id: msg.server_ws_session_id || null,
      echoed_connection_attempt_id: msg.connection_attempt_id || null,
    })
    _serverReady = true
    serverProjects = await loadLocallyBoundProjects()
    applyProjectWorldOwnership('daemon-welcome')
    for (const project of msg.projects || msg.project_heads || []) {
      const name = project.name || project.project
      const revision = project.sourceRevision || project.revision || project.head || null
      if (name && revision) await sourceSync.headChanged(name, revision)
    }
    applyDaemonGrants(permissionLedger, daemonSpawnConfig)
    log.info(`connected work received: ${projects.length} projects`)
    daemonDelivery.noteReady()
    sendActivityDeliveryMetrics('daemon-welcome')
    await reconcileJsonlProcessBindings('daemon-welcome')
    jsonlIngestor.resumeAfterServerReady()
    jsonlIngestor.retryPendingNativeSubagents()
    gooseSupervisor.startActivityPolling()
    promptPlan.startAutoAcceptSweep()
    log.info(`daemon-ready pid=${process.pid} server=${SERVER} machine_id=${MACHINE_ID} env_name=${ACTIVE_ENV} projects=${projects.length} watchers=started`)
    return
  }
  if (msg.type === 'agent-status-events') {
    applyAgentStatusEvents(msg.agent_status_events || [])
    agentStatusSeq = Math.max(agentStatusSeq, msg.agent_status_seq || agentStatusSeq)
    // Cold-start deltas arrive before daemon-welcome. Building watchers for each
    // partial roster repeatedly starves the WebSocket and leaves the browser with
    // no usable agent surface. Welcome reconciles the complete roster once.
    if (!_serverReady) return
    reconcileRoster('agent-status-events')
    return
  }
  if (msg.type === 'agents-updated') {
    agents = msg.agents || []
    agentStatusSeq = msg.agent_status_seq || agentStatusSeq
    reconcileRoster('agents-updated')
    ackServerDaemonOutboxMessage(msg)
    return
  }
  if (msg.type === 'agent-status-event') {
    if (msg.seq > agentStatusSeq) {
      if (msg.event_type === 'agent-upsert') {
        const index = agents.findIndex(agent => agent.id === msg.agent.id)
        if (index >= 0) agents[index] = msg.agent
        else agents.push(msg.agent)
      }
      agentStatusSeq = msg.seq
      reconcileRoster('agent-status-event')
    }
    // Deltas use the same durable server-to-daemon outbox as snapshots. ACK
    // even an already-applied delta so a reconnect cannot leave it inflight.
    ackServerDaemonOutboxMessage(msg)
    return
  }
  if (msg.type === 'daemon-evict') {
    if (msg.replaced_by_boot_id) {
      // Another live daemon took our slot — exit rather than loop-reconnecting.
      log.warn(`evicted by newer daemon (boot_id=${msg.replaced_by_boot_id}) — exiting`)
      shutdown('evicted-by-newer-daemon')
      return
    }
    // No replacement boot_id = server restarted and lost our connection.
    // Reconnect — the daemon should survive server restarts.
    log.warn(`evicted (${msg.reason || 'unknown'}) — reconnecting`)
    teardownWatchers({ reason: 'evicted-reconnecting' })
    // reconnect() drops the current socket and re-arms backoff WITHOUT marking
    // the client permanently closed. The old code called a never-defined
    // scheduleReconnect() (→ uncaught ReferenceError crashing the evicted daemon)
    // right after _rws.close(), which would have wedged reconnects anyway.
    _rws?.reconnect()
    return
  }
  if (msg.type === 'rpc') {
    handleRpc(msg)
    return
  }
  // Unknown message — ignore for forward compatibility.
}

function surfaceDaemonOutboxError(msg) {
  const row = daemonOutbox.get(msg.outbox_id)
  const payload = row?.payload || null
  if (payload?.type !== 'agent-route') return
  const error = msg.error || 'delivery failed'
  log.warn(`agent-route delivery failed for ${payload.agent_id || 'unknown'}: ${error}`)
  sendMsg({
    type: 'daemon-warning',
    warning: 'agent-route-delivery-failed',
    fleet_id: payload.agent_id || null,
    error,
    permanent: msg.permanent === true,
  })
}

// ---------- lifecycle ----------

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })

// INVARIANT: at most one fleet-daemon per active environment on this machine.
// This is the PRIMARY, STRUCTURAL guard — an environment-keyed exclusive OS lock
// that a second daemon targeting the same environment (from ANY install/worktree) fails to
// acquire and so REFUSES to start BEFORE it opens any WS to the server. The old
// check here was a racy PID-file existence test; the server-side machine_id lease
// (still in place, see the 'daemon-evict' handler) is now only defense-in-depth,
// because the loser never gets far enough to be evicted. The kernel releases the
// lock automatically when the holder dies, so a crashed daemon's lock is
// reclaimed with no stale-pid bookkeeping.
const _ourInstallPath = fileURLToPath(import.meta.url)
const _lock = acquireSingletonLock({ lockPath: LOCK_FILE, installPath: _ourInstallPath, origin: SERVER })
if (!_lock.ok) {
  const h = _lock.holder || {}
  log.error(
    `another fleet-daemon already holds the environment lock ${LOCK_FILE} for ${ACTIVE_ENV} (${SERVER}) ` +
    `(holder pid=${h.pid ?? '?'} install=${h.installPath ?? '?'} origin=${h.origin ?? '?'}); ` +
    `refusing to start this one (${_ourInstallPath}). At most one daemon per environment.`,
  )
  process.stderr.write(
    `fleet-daemon: refusing to start — environment lock for ${ACTIVE_ENV} (${SERVER}) held by pid=${h.pid ?? '?'} ` +
    `(${h.installPath ?? 'unknown install'}). At most one daemon per environment.\n`,
  )
  process.exit(1)
}
// Keep the lock fd referenced for the process lifetime; closing/exiting releases it.
const _singletonLockFd = _lock.fd
void _singletonLockFd

try { fs.writeFileSync(PID_FILE, String(process.pid)) } catch (e) { log.warn(`failed to write PID file: ${e.message}`) }

function shutdown(signal) {
  // Log WHY we're dying so the next post-mortem isn't a scavenger hunt.
  log.info(`shutdown via ${signal || 'unknown'} signal; saving cursors and exiting`)
  jsonlIngestor.shutdown()
  editOperationStore.close()
  teardownWatchers({ jsonl: false, reason: 'shutdown' })
  unlinkPidfileIfOwnPid(PID_FILE, process.pid)
  _rws?.close()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGHUP', () => shutdown('SIGHUP'))
// Catch every cause-of-death we can intercept. SIGKILL and SIGSTOP can't
// be handled, but logging the rest narrows the post-mortem dramatically.
process.on('SIGPIPE', () => {
  log.warn('received SIGPIPE — ignoring broken pipe signal')
})
for (const sig of ['SIGQUIT', 'SIGABRT', 'SIGUSR1', 'SIGUSR2', 'SIGBUS', 'SIGSEGV', 'SIGFPE']) {
  try {
    process.on(sig, () => {
      log.error(`received ${sig} — exiting`)
      process.exit(1)
    })
  } catch { /* some signals can't be handled on this platform */ }
}
process.on('uncaughtException', (e) => {
  log.error(`uncaught: ${e.stack || e.message}`)
})
process.on('unhandledRejection', (e) => {
  log.error(`unhandled rejection: ${e?.stack || e?.message || e}`)
})
// Also log the regular `exit` event so silent process exits get a trace.
process.on('exit', (code) => {
  log.info(`process exit (code=${code})`)
})

// Heartbeat: lets the post-mortem distinguish "died at startup" from
// "died mid-life". If the log shows a heartbeat right before silence and
// no exit trace, it's SIGKILL or equivalent. If startup never reached the
// first heartbeat, the crash is in init. Once a minute is plenty.
const HEARTBEAT_INTERVAL_MS = 60_000
let _heartbeatTimer = null
function startHeartbeat() {
  if (_heartbeatTimer) return
  _heartbeatTimer = setInterval(() => {
    const mem = process.memoryUsage()
    log.info(`heartbeat pid=${process.pid} rss=${(mem.rss / 1e6).toFixed(1)}MB heap=${(mem.heapUsed / 1e6).toFixed(1)}MB uptime=${Math.round(process.uptime())}s`)
  }, HEARTBEAT_INTERVAL_MS).unref?.() || _heartbeatTimer
}

log.info(`fleet-daemon ${VERSION} starting pid=${process.pid}`)
log.info(`  server      = ${SERVER}`)
log.info(`  machine_id  = ${MACHINE_ID}`)
log.info(`  env_name    = ${ACTIVE_ENV}`)
log.info(`  boot_id     = ${BOOT_ID}`)
log.info(`  user        = ${USER}@${HOSTNAME}`)
startHeartbeat()
// Bots are independent, launchd-owned services (bots.yaml) — the daemon no
// longer starts a bot-supervisor.
agentStatus.start()
connect()
