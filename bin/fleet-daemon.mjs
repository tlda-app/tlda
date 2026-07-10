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
 *   - No bot/service supervision. The CLI installs those as managed services.
 *
 * Lifecycle:
 *   - Reads ~/.config/tlda/config.json for { server, tokenRw, machineId }.
 *   - Derives a stable machineId from the MAC if missing; persists it.
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
import { ResilientWS } from '../shared/resilient-ws.mjs'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import {
  loadConfig as _loadSharedConfig, saveConfig as _saveSharedConfig,
  getServerUrl, getFleetServerUrl, getRwToken, DEFAULT_PORT, hasTls,
  CONFIG_DIR as _SHARED_CONFIG_DIR,
  getActiveConfigName, assertServerCoherence,
} from '../shared/config.mjs'
const VERSION = '0.1.1'
import { createLogger } from '../shared/logger.mjs'
import { resolveDaemonIsolation } from '../shared/daemon-identity.mjs'
import { sendActivityEvents } from '../agent-runtime/activity-send.mjs'
import {
  THINKING_SPINNER_RE, INTERRUPT_HINT_RE, THINKING_SCAN_LINES,
} from '../agent-runtime/status-classifier.mjs'
import { sessionIdentityPath } from '../agent-runtime/session-identity-store.mjs'
import {
  DAEMON_OUTBOX_ACK_TYPE,
  SERVER_DAEMON_OUTBOX_ACK_TYPE,
  SERVER_DAEMON_OUTBOX_ID_FIELD,
} from '../shared/daemon-delivery.mjs'
import {
  decideTerminalWatchExit,
  unlinkPidfileIfOwnPid,
} from '../agent-runtime/daemon-guards.mjs'
import { createDevReaper } from '../bots/dev/reaper.mjs'
import { createSourceSync } from '../daemon/source-sync.mjs'
import { createJsonlIngestor } from '../daemon/jsonl-ingestor.mjs'
import { createMachineRpc } from '../daemon/machine-rpc.mjs'
import { createTerminalRpc } from '../daemon/terminal-rpc.mjs'
import { createBackingFiles } from '../daemon/backing-files.mjs'
import { createLocalArtifacts } from '../daemon/local-artifacts.mjs'
import { createPromptPlan } from '../daemon/prompt-plan.mjs'
import { createAgentStatus } from '../daemon/agent-status.mjs'
import { createGooseSupervisor } from '../daemon/goose-supervisor.mjs'
import { createAgentLiveness } from '../daemon/agent-liveness.mjs'
import { ACTIVITY_NOISE } from '../shared/activity-tool-classification.mjs'
import { createHarnessRuntime } from '../daemon/harness-runtime.mjs'
import { createShadowMirror } from '../daemon/shadow-mirror.mjs'
import { DaemonDeliveryRuntime } from '../daemon/delivery-runtime.mjs'
import { DaemonOutbox, defaultOutboxPath } from '../daemon/outbox.mjs'
import { createAgentLauncher } from '../agent-launch/agent-launch.mjs'
import {
  applyDaemonGrants,
  applyGrandfatherInfill,
  createPermissionLedger,
  defaultDaemonConfigPath,
  permissionLedgerPathFromDaemonConfig,
  readDaemonConfig,
  withDaemonModelAliases,
} from '../agent-launch/permission-ledger.mjs'
import { acquireSingletonLock, daemonSingletonLockPath } from '../agent-runtime/singleton-lock.mjs'
const log = createLogger('daemon')
// CONFIG_DIR holds config.json, cursors, PID and log files. Defaults to
// ~/.config/tlda. TLDA_DAEMON_CONFIG_DIR lets the E2E test start a second
// daemon in parallel without clobbering the live daemon's PID file.
const CONFIG_DIR = process.env.TLDA_DAEMON_CONFIG_DIR || _SHARED_CONFIG_DIR
const CURSORS_FILE = path.join(CONFIG_DIR, 'daemon-cursors.json')
const SESSION_IDENTITY_FILE = sessionIdentityPath(CONFIG_DIR)
const PID_FILE = path.join(CONFIG_DIR, 'fleet-daemon.pid')
const SOURCE_BINDINGS_FILE = path.join(CONFIG_DIR, 'source-bindings.json')
const DAEMON_CONFIG_FILE = defaultDaemonConfigPath(CONFIG_DIR)
const daemonSpawnConfig = readDaemonConfig(DAEMON_CONFIG_FILE)
const PERMISSION_LEDGER_FILE = permissionLedgerPathFromDaemonConfig(daemonSpawnConfig, CONFIG_DIR)
const permissionLedger = createPermissionLedger(PERMISSION_LEDGER_FILE)
applyDaemonGrants(permissionLedger, daemonSpawnConfig)

const LOG_FILE = path.join(CONFIG_DIR, 'fleet-daemon.log')
const DAEMON_OUTBOX_FILE = defaultOutboxPath(CONFIG_DIR)
const LEGACY_DEAD_LETTER_FILE = path.join(CONFIG_DIR, 'daemon-dead-letters.jsonl')
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

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
// fresh on every loadConfig() call — including per-spawn reads in the agent-launch
// module — so edits to daemon.yaml take effect on the NEXT spawn without a daemon restart. Both levers
// ride this single read: withDaemonModelAliases injects daemonConfig.profiles
// (fence) AND daemonConfig.models (aliases) into the config that spawn policy
// resolution consumes. Keep-last-good: a malformed daemon.yaml (readDaemonConfig throws) must
// never half-apply — fall back to the last successfully parsed config and warn.
// Running agents' leases are untouched; only new spawns re-read. The startup const
// daemonSpawnConfig still seeds the ledger path + startup grants (those must not
// move without a restart), and seeds _lastGoodDaemon here.
let _lastGoodDaemon = daemonSpawnConfig
function loadConfig() {
  let cfg
  if (_usingCustomConfigDir) {
    const f = path.join(CONFIG_DIR, 'config.json')
    cfg = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}
  } else {
    cfg = _loadSharedConfig()
  }
  let freshDaemon
  try {
    freshDaemon = readDaemonConfig(DAEMON_CONFIG_FILE)
    _lastGoodDaemon = freshDaemon
  } catch (e) {
    log.warn(`daemon config re-read failed, using last good: ${e.message}`)
    freshDaemon = _lastGoodDaemon
  }
  return withDaemonModelAliases(cfg, freshDaemon)
}

function saveConfig(cfg) {
  if (_usingCustomConfigDir) {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(cfg, null, 2))
    return
  }
  _saveSharedConfig(cfg)
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

const config = loadConfig()
// The daemon is the local relay to THE server. There is one server (Fly); the
// daemon watches local things (files, agents, terminals) and relays everything
// to it — source-change → server builds in its shadow, activity/terminal/RPC →
// fleet. Resolve the fleet server (config.fleetServer → Fly), not a local one.
// Honor TLDA_SERVER on BOTH paths. Previously it was read only when a custom
// config dir was set, so `TLDA_SERVER=… node fleet-daemon.mjs` silently fell
// through to getFleetServerUrl(config) = live Fly — a rig that thought it was
// isolated joined the live fleet. TLDA_SERVER set now always targets that server.
const SERVER = process.env.TLDA_SERVER
  ? process.env.TLDA_SERVER
  : (_usingCustomConfigDir
      ? (config.fleetServer || config.server || `${hasTls ? 'https' : 'http'}://localhost:${DEFAULT_PORT}`)
      : getFleetServerUrl(config))
// The active config NAME (TLDA_CONFIG → defaultConfig). This — not a URL — is the
// single selector we propagate to spawned agents so their MCP resolves the SAME
// complete config (database + store) the daemon did. A stray defaultConfig can't
// then misroute a spawn, because the spawn carries the real active name.
// Safe to resolve unconditionally: SERVER already ran resolveConfig via
// getFleetServerUrl(config) above, so a broken config would have thrown there.
const ACTIVE_CONFIG = getActiveConfigName(config)
if (!ACTIVE_CONFIG) {
  console.error('[fleet-daemon] REFUSING to start without a named active config; daemon env is required')
  process.exit(1)
}
{
  const configuredServer = _usingCustomConfigDir
    ? (config.fleetServer || config.server || `${hasTls ? 'https' : 'http'}://localhost:${DEFAULT_PORT}`)
    : getFleetServerUrl(config)
  const { refuseReason } = resolveDaemonIsolation({
    env: process.env,
    scriptPath: INSTALL_PATH,
    configuredServer,
    targetServer: SERVER,
  })
  if (refuseReason) {
    log.error(`refusing to start: ${refuseReason}`)
    process.stderr.write(`[fleet-daemon] REFUSING TO START — ${refuseReason}\n`)
    process.exit(1)
  }
}
// Scoped singleton lock. Same path for a given fleet origin + active config
// lane no matter which install/worktree launched us, so daemons that claim the
// same registry job collide while stable/unstable/test lanes can coexist.
const DAEMON_LOCK_SCOPE = `${SERVER}#${ACTIVE_CONFIG}`
const LOCK_FILE = daemonSingletonLockPath({ configDir: CONFIG_DIR, origin: DAEMON_LOCK_SCOPE })

// HARD INVARIANT — a dev daemon literally cannot target the real fleet.
// `tlda-dev serve --sandbox` starts its daemon with TLDA_DEV_DAEMON=<the exact
// sandbox base it stood up>, plus TLDA_SERVER=<that same base> and TLDA_CONFIG=<the
// sandbox config> (whose fleet host is also that base — so the worktree-isolation
// guard and the server-coherence guard are both satisfied: the declared target
// agrees with the config). When TLDA_DEV_DAEMON is set we additionally require the
// resolved SERVER to be EXACTLY the URL serve authorized (catching a config drifted
// to point at prod), on a port that is NOT the main :5176. Only `tlda-dev serve`
// ever sets TLDA_DEV_DAEMON, and only ever to a this-machine sandbox on a free high
// port — so the daemon can't reach prod. Any mismatch aborts before a single WS
// connect. This is the whole reason raw `daemon start` is not exposed as a dev verb.
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

// True only when SERVER was derived from the named config (the normal path) —
// not pinned via TLDA_SERVER or a custom config dir. Only then can a later edit
// to config.json's defaultConfig drift us off the origin we're connected to, so
// only then does the runtime drift watcher (watchConfigDrift) arm.
const _serverFromConfig = !process.env.TLDA_SERVER && !_usingCustomConfigDir

// Fail loud if a hand-pinned TLDA_SERVER disagrees with the active config — the
// 6/27 divergence, refused at the door rather than served silently. Bubbles.
assertServerCoherence(config)
const TOKEN = _usingCustomConfigDir
  ? (process.env.TLDA_TOKEN || config.tokenRw || config.token || null)
  : getRwToken(config)
const TMUX_SOCKET = config.tmuxSocket || null
const TMUX_ARGS = TMUX_SOCKET ? ['-L', TMUX_SOCKET] : []

let MACHINE_ID = config.machineId || null
if (!MACHINE_ID) {
  MACHINE_ID = deriveMachineId()
  saveConfig({ ...config, machineId: MACHINE_ID })
  log.info(`derived machine_id=${MACHINE_ID} (saved to config)`)
}

// boot_id — monotonic per process start. Used by the server to break ties
// when two daemons claim the same machine_id (newer wins, older evicted).
const BOOT_ID = Date.now()
const USER = os.userInfo().username
const HOSTNAME = os.hostname()

let jsonlIngestor

// ---------- daemon state ----------

let _rws = null  // ResilientWS instance, created at startup
let _serverReady = false
let agents = []                   // current agent list (from welcome / updates)
let projects = []                 // current project list
let _lastSessionWatcherRosterSig = ''
let terminalRpc

const TERMINAL_SIZE_POLL_MS = parseInt(process.env.TLDA_TERMINAL_SIZE_POLL_MS, 10) || 5000

const harnessRuntime = createHarnessRuntime({
  tmuxArgs: TMUX_ARGS,
  log,
})

// ---------- activity event buffer ----------

function bufferActivity(agentId, evts) {
  // A JSONL line is a per-turn heartbeat. Warm the liveness cache keyed by
  // tmux_session so rpcCheckAlive / wake read "alive" from observed activity,
  // without a fleet-wide background demotion sweep.
  agentLiveness.noteActivity(agentId)
  // Any buffered activity (claude/codex JSONL or goose sqlite) is a reason to
  // watch this agent's pane frequently — arm it for the status state machine.
  agentStatus.armAgent(agentId)
  return sendActivityEvents(agentId, evts, sendMsg)
}

// grant-on-mint: ensure every agent THIS daemon hosts has a permission-ledger
// grant (fill-null-only), from the authoritative in-memory roster. Machine-scoped
// (`machine_id === MACHINE_ID`) so we never grant off-machine seats; dead/human are
// filtered inside applyGrandfatherInfill. Runs at welcome and on every hosted-roster
// change (debounced by the roster signature below), so a newly-registered agent is
// wakeable the moment the daemon sees it — no separate register hook, no infill lag.
function grantOnMintInfill(reason) {
  try {
    const hosted = agents.filter(a => a && a.machine_id === MACHINE_ID)
    const r = applyGrandfatherInfill(permissionLedger, { agents: hosted, config, projects })
    if (r.written) log.info(`grant-on-mint (${reason}): granted ${r.written} previously-ungranted seat(s) (${r.skippedExisting} already granted)`)
  } catch (e) {
    log.error(`grant-on-mint infill failed (${reason}): ${e.stack || e.message}`)
  }
}

// ---------- JSONL ingestion ----------
jsonlIngestor = createJsonlIngestor({
  configDir: CONFIG_DIR,
  cursorsFile: CURSORS_FILE,
  sessionIdentityFile: SESSION_IDENTITY_FILE,
  projectsDir: PROJECTS_DIR,
  daemonDir: path.dirname(fileURLToPath(import.meta.url)),
  log,
  sendMsg,
  sendMsgWithReply,
  isConnected: () => !!_rws?.connected,
  isServerReady: () => _serverReady,
  getAgents: () => agents,
  listSessions: rpcListSessions,
  selectAgentKind: harnessRuntime.resolveAgentKind,
  harnessAdapters: harnessRuntime.harnessAdapters,
  bufferActivity,
  extractActivityEvents: harnessRuntime.extractActivityEvents,
})

// ---------- source watching ----------
const sourceSync = createSourceSync({
  sourceBindingsFile: SOURCE_BINDINGS_FILE,
  log,
  sendMsg,
  isConnected: () => !!_rws?.connected,
  resolveEditor: jsonlIngestor.resolveEditor,
})

const backingFiles = createBackingFiles({
  getSourceDir: project => sourceSync.getSourceDir(project),
  log,
  sendMsg,
})

const localArtifacts = createLocalArtifacts({
  getServerUrl: () => getServerUrl(loadConfig()),
  getFleetServerUrl: () => getFleetServerUrl(loadConfig()),
})

const shadowMirror = createShadowMirror({
  getSourceDir: project => sourceSync.getSourceDir(project),
  log,
})

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
  getAgents: () => agents,
  harnessForAgent: harnessRuntime.harnessForAgent,
  isConnected: () => _serverReady && _rws?.connected,
})

let gooseSupervisor
const agentLiveness = createAgentLiveness({
  getAgents: () => agents,
  listSessions: () => terminalRpc.listSessions(),
  sendMsg,
  log,
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
  loadConfig,
  log,
  machineId: MACHINE_ID,
  permissionLedger,
  sendMsg,
  getProjects: () => projects,
  tmux,
  tmuxArgs: TMUX_ARGS,
  tmuxSocket: TMUX_SOCKET,
})

const machineRpc = createMachineRpc({
  sendMsg,
  getPid: () => process.pid,
})

machineRpc.register({
  ...terminalRpc.handlers,
  'kick': rpcKick,
  ...agentLauncher.handlers,
  ...localArtifacts.handlers,
  'write-backing-file': backingFiles.write,
  'mirror-shadow-ref': shadowMirror.mirrorShadowRef,
  'reaper-kill': devReaper.rpcKill,
  'reaper-sweep': devReaper.rpcSweep,
})

async function handleRpc(msg) {
  return machineRpc.handleRpc(msg)
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

function sendMsg(obj) {
  return daemonDelivery.send(obj)
}

function sendMsgWithReply(obj, { timeoutMs = 15000 } = {}) {
  return machineRpc.requestWithReply(obj, { timeoutMs })
}

function ackServerDaemonOutboxMessage(msg) {
  const outboxId = msg?.[SERVER_DAEMON_OUTBOX_ID_FIELD]
  if (!outboxId) return
  sendMsg({
    type: SERVER_DAEMON_OUTBOX_ACK_TYPE,
    outbox_id: outboxId,
  })
}

function teardownWatchers({ jsonl = true } = {}) {
  if (jsonl) jsonlIngestor.teardown()
  // Source watchers survive WS disconnects — they detect file changes
  // independently and queue them for the next connected window.
  terminalRpc.stopAllTerminalWatches()
  backingFiles.teardown()
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
    onOpen: () => {
      sendMsg({
        type: 'daemon-hello',
        machine_id: MACHINE_ID,
        env_name: ACTIVE_CONFIG,
        user: USER,
        hostname: HOSTNAME,
        version: VERSION,
        boot_id: BOOT_ID,
        install_path: INSTALL_PATH,
      })
    },
    onMessage: handleServerMessage,
    onClose: () => {
      _serverReady = false
      agentLiveness.clearTransientMissingState()
      teardownWatchers()
    },
  })
  _rws.connect()
}

function handleServerMessage(msg) {
  if (machineRpc.handleReply(msg)) return
  if (msg.type === DAEMON_OUTBOX_ACK_TYPE) {
    if (msg.outbox_id) daemonDelivery.handleAck(msg.outbox_id)
    return
  }
  if (msg.type === 'daemon-welcome') {
    _serverReady = true
    agents = msg.agents || []
    projects = msg.projects || []
    jsonlIngestor.syncIdentityNames(agents)
    applyDaemonGrants(permissionLedger, daemonSpawnConfig)
    grantOnMintInfill('daemon-welcome')
    log.info(`welcome: ${agents.length} agents, ${projects.length} projects`)
    daemonDelivery.noteReady()
    _lastSessionWatcherRosterSig = jsonlIngestor.rosterSignature(agents)
    void jsonlIngestor.sync(agents).catch(e => log.error(`syncSessionWatchers failed: ${e.stack || e.message}`))
    sourceSync.sync(projects)
    sourceSync.flushPending()
    agentLiveness.start()
    void agentLiveness.reportHostedSessions('daemon-welcome')
    // Fast status state machine — pulls panes only for agents armed by recent
    // activity, so it's bounded to the few agents actually working (1-3s status,
    // accurate turn edges) without a fleet-wide sweep.
    agentStatus.start()
    gooseSupervisor.startActivityPolling()
    promptPlan.startAutoAcceptSweep()
    jsonlIngestor.startOwnerHarvester()
    return
  }
  if (msg.type === 'agents-updated') {
    agents = msg.agents || []
    jsonlIngestor.syncIdentityNames(agents)
    _lastSessionWatcherRosterSig = jsonlIngestor.syncIfRosterChanged({
      agents,
      signature: _lastSessionWatcherRosterSig,
      reason: 'agents-updated',
      onChanged: () => {
        grantOnMintInfill('agents-updated')
        void agentLiveness.reportHostedSessions('agents-updated')
      },
    })
    ackServerDaemonOutboxMessage(msg)
    return
  }
  if (msg.type === 'projects-updated') {
    projects = msg.projects || []
    sourceSync.sync(projects)
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

// INVARIANT: at most one fleet-daemon per active fleet origin on this machine.
// This is the PRIMARY, STRUCTURAL guard — an origin-keyed exclusive OS lock that
// a second daemon targeting the same origin (from ANY install/worktree) fails to
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
    `another fleet-daemon already holds the origin lock ${LOCK_FILE} for ${SERVER} ` +
    `(holder pid=${h.pid ?? '?'} install=${h.installPath ?? '?'} origin=${h.origin ?? '?'}); ` +
    `refusing to start this one (${_ourInstallPath}). At most one daemon per origin.`,
  )
  process.stderr.write(
    `fleet-daemon: refusing to start — origin lock for ${SERVER} held by pid=${h.pid ?? '?'} ` +
    `(${h.installPath ?? 'unknown install'}). At most one daemon per origin.\n`,
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
for (const sig of ['SIGQUIT', 'SIGABRT', 'SIGPIPE', 'SIGUSR1', 'SIGUSR2', 'SIGBUS', 'SIGSEGV', 'SIGFPE']) {
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
devReaper.start()
connect()
watchConfigDrift()

// ---------- config drift guard ----------
// SERVER is frozen at startup. If config.json is later edited so the active
// config resolves to a DIFFERENT fleet origin than the one this daemon is
// connected to, every fresh CLI/MCP/spawn resolves the NEW origin while this
// running daemon keeps serving the OLD one — exactly the 6/27 split, just
// arriving over the daemon's lifetime instead of at boot. Don't serve a stale
// roster silently: shout (daemon-warning) and exit non-zero. launchd's KeepAlive
// relaunches us, re-reading config fresh, so we come back on the corrected
// target. (Only armed when SERVER came from the named config — a URL-pinned or
// custom-dir daemon has no config to drift against.)
function watchConfigDrift() {
  if (!_serverFromConfig) return
  const f = path.join(CONFIG_DIR, 'config.json')
  if (!fs.existsSync(f)) return
  const norm = (u) => String(u).replace(/\/+$/, '')
  let fired = false
  const onChange = () => {
    if (fired) return
    let fresh
    try {
      fresh = getFleetServerUrl(loadConfig())
    } catch (e) {
      // A config that no longer resolves is itself a loud failure — surface it
      // and exit so launchd reloads once it's fixed. Not a silent swallow: we
      // re-raise as an exit after announcing.
      fired = true
      const msg = `config.json no longer resolves (${e.message}) — daemon exiting for launchd relaunch`
      log.error(msg)
      sendMsg({ type: 'daemon-warning', message: msg })
      setTimeout(() => process.exit(1), 250)
      return
    }
    if (norm(fresh) !== norm(SERVER)) {
      fired = true
      const msg = `config drift: config.json now targets ${fresh} but this daemon is connected to ${SERVER}. ` +
        `Exiting so launchd relaunches on the corrected target.`
      log.error(msg)
      sendMsg({ type: 'daemon-warning', message: msg })
      setTimeout(() => process.exit(1), 250)
    }
  }
  fs.watchFile(f, { interval: 1500 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) onChange()
  })
  log.info(`config drift watcher armed on ${f} (connected to ${SERVER})`)
}
