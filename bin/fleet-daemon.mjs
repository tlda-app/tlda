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
 *   2. Document source watching - chokidar watches each tlda project's
 *      sourceDir; on file change, push a source-change message
 *      containing the file content. The server runs the build.
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
import {
  getRwToken, DEFAULT_PORT, hasTls,
  CONFIG_DIR as _SHARED_CONFIG_DIR, TLS_CA_PATH,
  getMachineId, saveMachineId, getStatusScanMs,
  getFleetServerUrl, getServerUrl, getActiveConfigName,
} from '../shared/config.mjs'
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
import { createDevReaper } from '../agent-runtime/dev-reaper.mjs'
import { createSourceSync } from '../daemon/source-sync.mjs'
import { createJsonlIngestor } from '../daemon/jsonl-ingestor.mjs'
import {
  createJsonlProcessBindingReconciler,
  jsonlProcessBindingSignature,
  projectJsonlAgentsFromProcessBindings,
} from '../daemon/jsonl-local-bindings.mjs'
import { createMachineRpc } from '../daemon/machine-rpc.mjs'
import { createTerminalRpc } from '../daemon/terminal-rpc.mjs'
import { createBackingFiles } from '../daemon/backing-files.mjs'
import { createLocalArtifacts } from '../daemon/local-artifacts.mjs'
import { createPromptPlan } from '../daemon/prompt-plan.mjs'
import { createAgentStatus } from '../daemon/agent-status.mjs'
import { createGooseSupervisor } from '../daemon/goose-supervisor.mjs'
import { createAgentLiveness, livenessAgentsFromProcessBindings } from '../daemon/agent-liveness.mjs'
import { ACTIVITY_NOISE } from '../shared/activity-tool-classification.mjs'
import { createHarnessRuntime } from '../daemon/harness-runtime.mjs'
import { createShadowMirror } from '../daemon/shadow-mirror.mjs'
import { DaemonDeliveryRuntime } from '../daemon/delivery-runtime.mjs'
import { DaemonOutbox, defaultOutboxPath } from '../daemon/outbox.mjs'
import { reconcileDaemonRoster } from '../daemon/roster-reconcile.mjs'
import { createAgentLauncher } from '../agent-launch/agent-launch.mjs'
import { launchMintProcess } from '../agent-launch/index.mjs'
import { createLocalAgentLedger } from '../agent-launch/local-agent-ledger.mjs'
import { bindAgentSeat } from '../agent-launch/seat-binding.mjs'
import { wsMintShell } from '../agent-launch/register.mjs'
import { resolveModelSpec } from '../agent-launch/models.mjs'
import { compilePermissionGrant, permissionGrantProfileName, resolveSpawnGrant } from '../server/lib/permission-grants.mjs'
import { cleanupPendingSeatBinding, completePendingSeatBinding, createPendingSeatBindingManager, reuseExactPendingSeatBinding } from '../agent-launch/pending-seat-binding.mjs'
import { resolveLiveSessionIdentity as resolveLiveCodexSessionIdentity } from '../agent-launch/harness/codex.mjs'
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
import { createDaemonMintCore } from '../daemon/mint-core.mjs'
import { MintStore } from '../daemon/mint-store.mjs'
import { createDaemonWakeCore } from '../daemon/wake-core.mjs'
import { projectBelongsToWorld, projectWorldsPath, readProjectWorlds } from '../shared/project-worlds.mjs'
const log = createLogger('daemon')
// CONFIG_DIR holds daemon configuration, cursors, PID and log files. Defaults to
// ~/.config/tlda. TLDA_DAEMON_CONFIG_DIR plus PROJECTS_DIR lets tests/dev rigs
// start a second daemon without clobbering the live daemon's PID file or JSONL
// tails.
const CONFIG_DIR = process.env.TLDA_DAEMON_CONFIG_DIR || _SHARED_CONFIG_DIR
const PROJECT_WORLDS_FILE = projectWorldsPath(_SHARED_CONFIG_DIR)
const DAEMON_CONFIG_FILE = defaultDaemonConfigPath(CONFIG_DIR)
const daemonSpawnConfig = readDaemonConfig(DAEMON_CONFIG_FILE)
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
const ACTIVE_CONFIG = getActiveConfigName()
if (!ACTIVE_CONFIG) {
  console.error('[fleet-daemon] REFUSING to start without a named active config; daemon env is required')
  process.exit(1)
}
function daemonStateSuffix(name) {
  const clean = String(name || '').trim()
  if (!clean) return ''
  return `.${clean.replace(/[^a-zA-Z0-9._-]+/g, '-')}`
}
const DAEMON_STATE_SUFFIX = daemonStateSuffix(ACTIVE_CONFIG)
const CURSORS_FILE = path.join(CONFIG_DIR, `daemon-cursors${DAEMON_STATE_SUFFIX}.json`)
const PID_FILE = path.join(CONFIG_DIR, `fleet-daemon${DAEMON_STATE_SUFFIX}.pid`)
const SOURCE_BINDINGS_FILE = path.join(CONFIG_DIR, `source-bindings${DAEMON_STATE_SUFFIX}.json`)
const PERMISSION_LEDGER_FILE = permissionLedgerPathFromDaemonConfig(daemonSpawnConfig, CONFIG_DIR)
let _onPermissionLedgerProcessBindingChange = null
const permissionLedger = createPermissionLedger(PERMISSION_LEDGER_FILE, {
  onProcessBindingChange: event => _onPermissionLedgerProcessBindingChange?.(event),
})
applyDaemonGrants(permissionLedger, daemonSpawnConfig)

const LOG_FILE = path.join(CONFIG_DIR, `fleet-daemon${DAEMON_STATE_SUFFIX}.log`)
const LOCAL_RPC_SOCKET = path.join(CONFIG_DIR, `fleet-daemon${DAEMON_STATE_SUFFIX}.sock`)
const DAEMON_OUTBOX_FILE = defaultOutboxPath(CONFIG_DIR, DAEMON_STATE_SUFFIX)
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

const config = loadDaemonLaunchConfig()
// The daemon is the local relay for the active named environment. The config
// name selects the complete database/store authority; TLDA_SERVER is not a
// second server selector.
const SERVER = getDaemonFleetServerUrl()
// The active server NAME (TLDA_CONFIG → defaultServer). This — not a URL — is the
// single selector we propagate to spawned agents so their MCP resolves the SAME
// complete config (database + store) the daemon did. A stray defaultConfig can't
// then misroute a spawn, because the spawn carries the real active name.
let MACHINE_ID = getMachineId()
if (!MACHINE_ID) {
  MACHINE_ID = deriveMachineId()
  saveMachineId(MACHINE_ID)
  log.info(`derived machine_id=${MACHINE_ID} (saved to daemon.yaml)`)
}
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
const DAEMON_LOCK_SCOPE = `${MACHINE_ID}:${ACTIVE_CONFIG}`
const LOCK_FILE = daemonSingletonLockPath({ configDir: CONFIG_DIR, origin: DAEMON_LOCK_SCOPE })

// HARD INVARIANT — a dev daemon literally cannot target the real fleet.
// `tlda-dev serve --sandbox` starts its daemon with TLDA_DEV_DAEMON=<the exact
// sandbox base it stood up> and TLDA_CONFIG=<the sandbox config>. When
// TLDA_DEV_DAEMON is set, the named config must resolve to that authorized base
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
const terminalCapabilitiesRegisteredThisBoot = new Set()
let terminalRpc
let activityDeliveryMetricsTimer = null
let daemonWsConnectedAtMs = null

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
    env_name: ACTIVE_CONFIG,
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
    if (Number.isFinite(existing)) return evt
    return {
      ...evt,
      daemonReceivedAt: new Date(daemonReceivedAtMs).toISOString(),
      daemonReceivedAtMs,
    }
  })
  // A JSONL line is a per-turn heartbeat. Warm the liveness cache keyed by
  // tmux_session so rpcCheckAlive / wake read "alive" from observed activity,
  // without a fleet-wide background demotion sweep.
  agentLiveness.noteActivity(agentId)
  // Any buffered activity (claude/codex JSONL or goose sqlite) is a reason to
  // watch this agent's pane frequently — arm it for the status state machine.
  agentStatus.armAgent(agentId)
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

function registerHostedTerminalCapabilities(reason) {
  const daemonKey = `${MACHINE_ID}:${ACTIVE_CONFIG}`
  for (const row of permissionLedger.listProcessBindings()) {
    if (!row?.id || row.daemonKey !== daemonKey || !row.sessionId || !row.tmuxSession) continue
    if (!row.sessionKind || !row.model || !row.cwd) continue
    try {
      const terminalCapability = terminalCapabilitiesRegisteredThisBoot.has(row.id)
        ? row.terminalCapability
        : permissionLedger.rotateTerminalCapabilitySync(row.id)
      if (!terminalCapability) continue
      terminalCapabilitiesRegisteredThisBoot.add(row.id)
      sendMsg({
        type: 'agent-seat',
        agent_id: row.id,
        session_id: row.sessionId,
        resume_id: row.sessionId,
        kind: row.sessionKind,
        model: row.model,
        cwd: row.cwd,
        machine_id: MACHINE_ID,
        env_name: ACTIVE_CONFIG,
        daemon_key: daemonKey,
        terminal_capability: terminalCapability,
        created_source: 'daemon-terminal-capability-refresh',
        transition_reason: reason,
      })
    } catch (e) {
      // Keep registering other hosted seats; this row will retry on the next roster reconciliation.
      log.warn(`terminal capability registration failed for ${row.id}: ${e.message}`)
    }
  }
}

// ---------- JSONL ingestion ----------
function currentJsonlBindingAgents() {
  return projectJsonlAgentsFromProcessBindings(permissionLedger.listProcessBindings(), {
    daemonKey: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
  })
}

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
  machineId: MACHINE_ID,
  envName: ACTIVE_CONFIG,
  daemonKey: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
})

jsonlBindingReconciler = createJsonlProcessBindingReconciler({
  listProcessBindings: () => permissionLedger.listProcessBindings(),
  sync: agents => jsonlIngestor.sync(agents),
  daemonKey: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
  log,
})

// ---------- source watching ----------
const sourceSync = createSourceSync({
  sourceBindingsFile: SOURCE_BINDINGS_FILE,
  log,
  sendMsg,
  isConnected: () => !!_rws?.connected,
  resolveEditor: jsonlIngestor.resolveEditor,
})

function applyProjectWorldOwnership(reason) {
  const projectWorlds = readProjectWorlds(PROJECT_WORLDS_FILE)
  projects = serverProjects.filter(project => projectBelongsToWorld(project, ACTIVE_CONFIG, projectWorlds))
  sourceSync.sync(projects)
  log.info(`project ownership applied (${reason}): ${projects.length}/${serverProjects.length} projects in ${ACTIVE_CONFIG}`)
}

fs.watchFile(PROJECT_WORLDS_FILE, { interval: 500 }, () => applyProjectWorldOwnership('registry-change'))

const backingFiles = createBackingFiles({
  getSourceDir: project => sourceSync.getSourceDir(project),
  log,
  sendMsg,
})

const localArtifacts = createLocalArtifacts({
  getServerUrl: () => getDaemonStoreUrl(),
  getFleetServerUrl: () => getDaemonFleetServerUrl(),
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

async function rpcKick({ agent_id }) {
  if (!agent_id) throw new Error('missing agent_id')
  agentStatus.armAgent(agent_id)   // kicking/waking → arm the status machine
  const dir = path.join(os.homedir(), '.fleet', 'signals')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, agent_id.replace(/[^a-zA-Z0-9_-]/g, '_'))
  fs.writeFileSync(file, Date.now().toString())
  return { ok: true, signal: file }
}

const agentStatus = createAgentStatus({
  tmuxArgs: TMUX_ARGS,
  sendMsg,
  log,
  getAgents: () => permissionLedger.listProcessBindings().map(row => ({
    id: row.id,
    friendly_name: row.friendlyName,
    tmux_session: row.tmuxSession,
    runtimeKind: row.sessionKind,
    metadata: { kind: row.sessionKind, model: row.model },
  })),
  harnessForAgent: harnessRuntime.harnessForAgent,
  isConnected: () => _serverReady && _rws?.connected,
  statusScanMs: getStatusScanMs(),
})

let gooseSupervisor
// The server projects current durable-seat bindings onto every roster row, so
// liveness and every other daemon consumer read the same server authority.
const agentLiveness = createAgentLiveness({
  getAgents: () => livenessAgentsFromProcessBindings(permissionLedger.listProcessBindings(), {
    daemonKey: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
  }),
  listSessions: () => terminalRpc.listSessions(),
  sendMsg,
  log,
  daemonKey: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
  daemonBootId: BOOT_ID,
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
  alivenessCache: agentLiveness.alivenessCache,
  thinkingSpinnerRe: THINKING_SPINNER_RE,
  interruptHintRe: INTERRUPT_HINT_RE,
  thinkingScanLines: THINKING_SCAN_LINES,
  terminalSizePollMs: TERMINAL_SIZE_POLL_MS,
  decideTerminalWatchExit,
  onArmAgent: agentStatus.armAgent,
  onArmBySession: agentStatus.armBySession,
  onEmitAgentStatus: agentStatus.emitAgentStatus,
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
  resolveTerminalCapability: ({ agentId, terminalCapability }) => (
    (() => {
      const row = permissionLedger.resolveTerminalCapability({ agentId, terminalCapability })
      return row?.daemonKey === `${MACHINE_ID}:${ACTIVE_CONFIG}` ? row : null
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

// ─── Dev reaper bot module wiring ──────────────────────────────────
const devReaper = createDevReaper({
  getAgents: () => agents,
  tmuxArgs: TMUX_ARGS,
  sendMsg,
})

const agentLauncher = createAgentLauncher({
  activeConfigName: ACTIVE_CONFIG,
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
  persistPendingSeatBinding: payload => daemonApi('POST', '/api/agent-seat-binding-obligation', payload),
})

const mintStore = new MintStore(path.join(CONFIG_DIR, 'daemon-mints.sqlite'))
daemonMintCore = createDaemonMintCore({
  store: mintStore,
  launchProcess: async params => {
    const launchStartedAt = new Date().toISOString()
    const processFact = await launchMintProcess({
      ...params,
      mintId: params.mint_id,
      fleetId: params.fleet_id,
      requestedKind: params.kind,
      activeConfigName: ACTIVE_CONFIG,
      machineId: MACHINE_ID,
      tmuxSocket: TMUX_SOCKET,
    })
    if (processFact.session_id) return processFact
    if (processFact.harness !== 'codex') return processFact
    const live = await resolveLiveCodexSessionIdentity({
      agent: {
        id: processFact.fleet_id || params.fleet_id || null,
        friendly_name: processFact.name || params.name || null,
        cwd: processFact.cwd,
        registered_at: launchStartedAt,
      },
      tmuxSession: processFact.tmux_session,
      tmuxArgs: TMUX_ARGS,
      tmuxSocket: TMUX_SOCKET,
    })
    return live?.sessionId
      ? { ...processFact, session_id: live.sessionId, session_path: live.jsonlPath || null, model: live.model || processFact.model }
      : processFact
  },
  requestSeat: ({ mint_id, name, metadata, launch }) => wsMintShell({
    localAgentId: mint_id,
    name,
    tmuxSession: null,
    cwd: launch.cwd,
    model: launch.model,
    effort: launch.effort,
    kind: launch.kind || 'codex',
    metadata,
    machineId: MACHINE_ID,
    envName: ACTIVE_CONFIG,
    daemonKey: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
  }),
  bindSeat: async facts => {
    const processFact = facts.processState || {}
    await permissionLedger.set(facts.fleetId, {
      permissionGrant: processFact.permission_grant,
      permissionSet: processFact.permission_set,
      source: 'daemon-mint',
    })
    await bindAgentSeat({
      ledger: permissionLedger,
      identity: {
        agentId: facts.fleetId,
        sessionId: facts.sessionId,
        resumeId: facts.sessionId,
        kind: processFact.harness,
        model: processFact.model,
        cwd: processFact.cwd,
        sessionPath: facts.sessionPath,
        friendlyName: facts.friendlyName,
      },
      route: {
        machineId: MACHINE_ID,
        envName: ACTIVE_CONFIG,
        daemonKey: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
        tmuxSession: processFact.tmux_session,
      },
      createdSource: 'daemon-mint-join',
      submit: payload => sendMsg({ type: 'agent-seat', ...payload }),
    })
  },
})

const wakeMint = createDaemonWakeCore({
  store: mintStore,
  processAlive: async facts => {
    const tmuxSession = facts.processState?.tmux_session
    if (!tmuxSession) return false
    try {
      await tmux('has-session', '-t', tmuxSession)
      return true
    } catch {
      return false
    }
  },
  resumeSession: async (facts, wakeParams = {}) => launchMintProcess({
    ...(facts.launchRecipe || {}),
    mintId: facts.mintId,
    fleetId: facts.fleetId,
    name: facts.friendlyName,
    resumeId: facts.sessionId,
    requestedKind: facts.processState?.harness || facts.launchRecipe?.kind || 'codex',
    permissionGrant: wakeParams.permissionGrant || wakeParams.permission_grant || facts.launchRecipe?.permissionGrant,
    permissionSet: wakeParams.permissionSet || wakeParams.permission_set || facts.launchRecipe?.permissionSet,
    activeConfigName: ACTIVE_CONFIG,
    machineId: MACHINE_ID,
    tmuxSocket: TMUX_SOCKET,
  }),
})

async function rpcMint(params = {}) {
  const cwd = params.cwd || process.cwd()
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
    model: modelSpec.id,
    kind: modelSpec.harness,
    modelCap: modelSpec.cap || null,
    config: grantConfig,
    cwd,
  })
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
      machineId: MACHINE_ID,
      envName: ACTIVE_CONFIG,
      daemonKey: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
    })
    const assignedFleetId = botSeat?.fleet_id || botSeat?.server_agent_id || botSeat?.agent?.id || null
    if (!assignedFleetId) throw new Error('bot mint returned no fleet_id')
    const assignedName = botSeat?.friendly_name || botSeat?.assigned_name || botSeat?.agent?.friendly_name || requestedName
    params = {
      ...params,
      mint_id: mintId,
      fleet_id: assignedFleetId,
      friendly_name: assignedName,
      botName: params.botName || params.bot_name || requestedName,
    }
  }
  const facts = await daemonMintCore.mint({
    mint_id: params.mint_id || null,
    fleet_id: params.fleet_id || params.agent_id || null,
    name: params.friendly_name || params.name || null,
    metadata: params.metadata || null,
    request_seat: !(params.fleet_id || params.agent_id),
    launch: {
      name: params.friendly_name || params.name || null,
      model: params.model,
      modelSpec,
      config: spawnConfig,
      kind: params.kind || modelSpec.harness,
      botScript: params.botScript || params.bot_script || params.script || null,
      botName: params.botName || params.bot_name || null,
      botIdFile: params.botIdFile || params.bot_id_file || null,
      botPidFile: params.botPidFile || params.bot_pid_file || null,
      botHeartbeatFile: params.botHeartbeatFile || params.bot_heartbeat_file || null,
      botWaitChannel: params.botWaitChannel || params.bot_wait_channel || null,
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
  return {
    ok: true,
    mint_id: facts.mintId,
    fleet_id: facts.fleetId,
    agent_id: facts.fleetId,
    name: facts.friendlyName,
    tmux_session: facts.processState?.tmux_session || null,
    session_id: facts.sessionId,
    joined: !!facts.joinedAt,
  }
}

async function rpcWake(params = {}) {
  return wakeMint(params)
}

const pendingSeatBindings = createPendingSeatBindingManager({
  watchPath: obligation => obligation.kind === 'codex'
    ? path.join(os.homedir(), '.codex', 'sessions')
    : path.join(os.homedir(), '.claude'),
  tmuxAlive: async tmuxSession => {
    try { await tmux('has-session', '-t', tmuxSession); return true } catch { return false }
  },
  resolveIdentity: obligation => {
    const resolver = obligation.kind === 'codex'
      ? resolveLiveCodexSessionIdentity
      : resolveLiveClaudeSessionIdentity
    return resolver({
      agent: {
        id: obligation.agent_id,
        session_id: obligation.session_id || null,
        friendly_name: obligation.friendly_name,
        cwd: obligation.cwd,
        registered_at: obligation.created_at,
      },
      tmuxSession: obligation.tmux_session,
      tmuxArgs: TMUX_ARGS,
      tmuxSocket: TMUX_SOCKET,
    })
  },
  complete: (obligation, identity) => completePendingSeatBinding({
    obligation,
    identity,
    readExistingBinding: async () => {
      const result = await daemonApi('GET', `/api/agent-seat?agent=${encodeURIComponent(obligation.agent_id)}`).catch(error => {
        if (error?.status === 404) return null
        throw error
      })
      const seat = result?.seat || null
      const local = permissionLedger.get(obligation.agent_id)
      return reuseExactPendingSeatBinding({ obligation, identity, seat, local })
    },
    bindSeat: () => bindAgentSeat({
      ledger: permissionLedger,
      identity: {
        agentId: obligation.agent_id,
        sessionId: identity.sessionId,
        resumeId: identity.sessionId,
        kind: obligation.kind,
        model: identity.model,
        cwd: obligation.cwd,
        sessionPath: identity.jsonlPath,
        friendlyName: obligation.friendly_name,
      },
      route: {
        machineId: obligation.machine_id,
        envName: obligation.env_name,
        daemonKey: obligation.daemon_key,
        tmuxSession: obligation.tmux_session,
      },
      submit: payload => daemonApi('POST', '/api/agent-seat', payload),
      readback: agentId => daemonApi('GET', `/api/agent-seat?agent=${encodeURIComponent(agentId)}`),
      requireReadback: true,
      createdSource: 'cli-pending-exact-process',
      transitionReason: 'cli-pending-exact-process',
    }),
    emitComplete: message => sendMsg(message),
  }),
  terminal: (obligation, error) => cleanupPendingSeatBinding({
    obligation,
    error,
    terminateTmux: async tmuxSession => { try { await tmux('kill-session', '-t', tmuxSession) } catch {} },
    tmuxAlive: async tmuxSession => { try { await tmux('has-session', '-t', tmuxSession); return true } catch { return false } },
    permissionLedger,
    openLocalLedger: () => createLocalAgentLedger(path.join(CONFIG_DIR, 'fleet-daemon.db')),
    retireServerReservation: agentId => daemonApi(
      'POST',
      `/api/agent-seat-binding-obligation/${encodeURIComponent(obligation.obligation_id)}/retire`,
      { agent_id: agentId, daemon_key: obligation.daemon_key },
    ),
    emitTerminal: message => sendMsg(message),
  }),
  log,
})

function hydratePendingSeatBindingObligation(obligation) {
  if (!obligation?.local_agent_id) {
    throw new Error(`pending seat binding ${obligation?.obligation_id || 'unknown'} is missing local_agent_id`)
  }
  const localLedger = createLocalAgentLedger(path.join(CONFIG_DIR, 'fleet-daemon.db'))
  try {
    const local = localLedger.get(obligation.local_agent_id)
    const tmuxSession = local?.process?.tmuxName || null
    if (!tmuxSession) {
      throw new Error(`pending seat binding ${obligation.obligation_id} has no local tmux recipe for ${obligation.local_agent_id}`)
    }
    return {
      ...obligation,
      tmux_session: tmuxSession,
    }
  } finally {
    localLedger.close()
  }
}

const machineRpc = createMachineRpc({
  sendMsg,
  getPid: () => process.pid,
  executionDbPath: path.join(CONFIG_DIR, 'daemon-rpc-executions.sqlite'),
})

machineRpc.register({
  ...terminalRpc.handlers,
  'kick': rpcKick,
  ...agentLauncher.handlers,
  'mint': rpcMint,
  'wake': rpcWake,
  ...localArtifacts.handlers,
  'write-backing-file': backingFiles.write,
  'mirror-shadow-ref': shadowMirror.mirrorShadowRef,
  'reaper-kill': devReaper.rpcKill,
  'reaper-sweep': devReaper.rpcSweep,
})

function startLocalLifecycleRpc() {
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
        if (op !== 'mint' && op !== 'wake') throw new Error(`unsupported local daemon op: ${op || '(missing)'}`)
        const handler = op === 'mint' ? rpcMint : rpcWake
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
    sender: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
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
  })
}

function teardownWatchers({ jsonl = true } = {}) {
  if (jsonl) {
    jsonlIngestor.teardown()
    _lastSessionWatcherRosterSig = ''
  }
  // Source watchers survive WS disconnects — they detect file changes
  // independently and queue them for the next connected window.
  terminalRpc.stopAllTerminalWatches()
  backingFiles.teardown()
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
    // Detect a half-open/zombie WS to the server: if no message OR protocol
    // ping arrives within 90s, ResilientWS closes + reconnects. Without this a
    // dead socket stays readyState===OPEN and the daemon keeps "delivering"
    // activity into the void while advancing JSONL cursors → permanent silent
    // card loss with no reconnect. The server pings every 30s
    // (unified-server.mjs WS_HEARTBEAT_INTERVAL_MS) and ResilientWS resets the
    // watchdog on 'ping', so 90s = 3× margin (tolerates two missed pings).
    heartbeatTimeoutMs: 90_000,
    onRetryScheduled: (attemptId, delayMs) => {
      traceGate1('retry-scheduled', {
        daemon_key: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
        boot_id: BOOT_ID,
        connection_attempt_id: attemptId ? `${BOOT_ID}:${attemptId}` : null,
        delay_ms: delayMs,
      })
    },
    onAttemptOpen: (attemptId) => {
      traceGate1('attempt-opened', {
        daemon_key: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
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
        env_name: ACTIVE_CONFIG,
        user: USER,
        hostname: HOSTNAME,
        version: VERSION,
        boot_id: BOOT_ID,
        install_path: INSTALL_PATH,
        connection_attempt_id: connectionAttemptId,
        // A cold daemon has no roster to apply a delta to, so 0 deliberately
        // requests the exceptional snapshot. Reconnects retain the cursor.
        last_agent_status_seq: agents.length ? agentStatusSeq : 0,
      })
      traceGate1('hello-send', {
        daemon_key: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
        boot_id: BOOT_ID,
        connection_attempt_id: connectionAttemptId,
        sent,
      })
    },
    onMessage: handleServerMessage,
    onClose: (reason, attemptId) => {
      const now = Date.now()
      const uptimeMs = daemonWsConnectedAtMs == null ? null : now - daemonWsConnectedAtMs
      daemonWsConnectedAtMs = null
      daemonActivityDeliveryCounters.record(
        ACTIVITY_DELIVERY_STAGES.DAEMON_WS_DISCONNECTED,
        { type: 'fleet-daemon-ws' },
        1,
        { error: `${reason || 'unknown'}${uptimeMs == null ? '' : ` uptimeMs=${uptimeMs}`}` }
      )
      traceGate1('client-close-detected', {
        daemon_key: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
        boot_id: BOOT_ID,
        connection_attempt_id: attemptId ? `${BOOT_ID}:${attemptId}` : null,
        reason,
      })
      _serverReady = false
      agentLiveness.stop()
      agentLiveness.clearTransientMissingState()
      teardownWatchers()
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
    onChanged: () => {
      registerHostedTerminalCapabilities(reason)
      void agentLiveness.reportHostedSessions(reason)
    },
  })
}

function reconcileJsonlProcessBindings(reason) {
  void jsonlBindingReconciler.reconcile(reason)
    .catch(e => log.error(`syncSessionWatchers failed: ${e.stack || e.message}`))
  return true
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

function handleServerMessage(msg, wsAttemptId) {
  if (machineRpc.handleReply(msg)) return
  if (msg.type === 'source-change-result') {
    sourceSync.handleSourceChangeResult(msg)
    return
  }
  if (msg.type === DAEMON_OUTBOX_ACK_TYPE) {
    if (msg.outbox_id) daemonDelivery.handleAck(msg.outbox_id)
    return
  }
  if (msg.type === DAEMON_OUTBOX_ERROR_TYPE) {
    if (msg.outbox_id) daemonDelivery.handleError(msg.outbox_id, msg.error || 'delivery failed', { permanent: msg.permanent === true })
    return
  }
  if (msg.type === 'agent-seat-binding-obligation') {
    try {
      const accepted = pendingSeatBindings.accept(hydratePendingSeatBindingObligation(msg))
      if (!accepted && !pendingSeatBindings.has(msg.obligation_id)) {
        throw new Error(`pending seat binding ${msg.obligation_id || 'unknown'} was not accepted locally`)
      }
    } catch (e) {
      log.warn?.(`pending seat binding ${msg.obligation_id || 'unknown'} rejected locally: ${e.message}`)
      errorServerDaemonOutboxMessage(msg, e)
      return
    }
    // This acknowledges transport receipt only. The server-held obligation is
    // cleared later by the exact seat/readback completion or terminal event.
    ackServerDaemonOutboxMessage(msg)
    return
  }
  if (msg.type === 'daemon-welcome') {
    traceGate1('welcome-received', {
      daemon_key: `${MACHINE_ID}:${ACTIVE_CONFIG}`,
      boot_id: BOOT_ID,
      connection_attempt_id: wsAttemptId ? `${BOOT_ID}:${wsAttemptId}` : null,
      server_ws_session_id: msg.server_ws_session_id || null,
      echoed_connection_attempt_id: msg.connection_attempt_id || null,
    })
    _serverReady = true
    serverProjects = msg.projects || []
    const projectWorlds = readProjectWorlds(PROJECT_WORLDS_FILE)
    projects = serverProjects.filter(project => projectBelongsToWorld(project, ACTIVE_CONFIG, projectWorlds))
    applyDaemonGrants(permissionLedger, daemonSpawnConfig)
    log.info(`connected work received: ${projects.length} projects`)
    daemonDelivery.noteReady()
    sendActivityDeliveryMetrics('daemon-welcome')
    sourceSync.sync(projects)
    sourceSync.flushPending()
    reconcileJsonlProcessBindings('daemon-welcome')
    jsonlIngestor.resumeAfterServerReady()
    gooseSupervisor.startActivityPolling()
    promptPlan.startAutoAcceptSweep()
    agentLiveness.start()
    log.info(`daemon-ready pid=${process.pid} server=${SERVER} machine_id=${MACHINE_ID} env_name=${ACTIVE_CONFIG} projects=${projects.length} watchers=started`)
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
  if (msg.type === 'projects-updated') {
    serverProjects = msg.projects || []
    applyProjectWorldOwnership('projects-updated')
    ackServerDaemonOutboxMessage(msg)
    return
  }
  if (msg.type === 'active-viewers') {
    // Source watching is chokidar-backed per project now; active viewer updates
    // no longer promote/demote a separate fs.watch layer.
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
    teardownWatchers()
    // reconnect() drops the current socket and re-arms backoff WITHOUT marking
    // the client permanently closed. The old code called a never-defined
    // scheduleReconnect() (→ uncaught ReferenceError crashing the evicted daemon)
    // right after _rws.close(), which would have wedged reconnects anyway.
    _rws?.reconnect()
    return
  }
  if (msg.type === 'watch-backing-files') {
    backingFiles.sync(msg.files || [])
    ackServerDaemonOutboxMessage(msg)
    return
  }
  if (msg.type === 'rpc') {
    handleRpc(msg)
    return
  }
  // Unknown message — ignore for forward compatibility.
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
    `another fleet-daemon already holds the environment lock ${LOCK_FILE} for ${ACTIVE_CONFIG} (${SERVER}) ` +
    `(holder pid=${h.pid ?? '?'} install=${h.installPath ?? '?'} origin=${h.origin ?? '?'}); ` +
    `refusing to start this one (${_ourInstallPath}). At most one daemon per environment.`,
  )
  process.stderr.write(
    `fleet-daemon: refusing to start — environment lock for ${ACTIVE_CONFIG} (${SERVER}) held by pid=${h.pid ?? '?'} ` +
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
  teardownWatchers({ jsonl: false })
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
log.info(`  env_name    = ${ACTIVE_CONFIG}`)
log.info(`  boot_id     = ${BOOT_ID}`)
log.info(`  user        = ${USER}@${HOSTNAME}`)
startHeartbeat()
if (process.env.TLDA_DAEMON_DEV_REAPER === '1') {
  devReaper.start()
} else {
  log.info('dev reaper auto-start disabled; use reaper-sweep RPC or TLDA_DAEMON_DEV_REAPER=1')
}
// Bots are independent, launchd-owned services (bots.yaml) — the daemon no
// longer starts a bot-supervisor.
// Local terminal inspection belongs to the daemon process lifecycle, not the
// server message protocol. Its tmux/runtime dependencies are fully constructed
// above; connectivity is checked inside each scan, and local activity explicitly
// arms the owned agents that may be inspected.
  agentStatus.start()
  connect()
