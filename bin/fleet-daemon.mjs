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
import chokidar from 'chokidar'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { execFile, fork } from 'child_process'
import { promisify } from 'util'
import { resolveFilePath, uploadFileToServer } from '../shared/chat-file-processing.mjs'
import { processMessageText } from '../shared/message-processing.mjs'
import { scanMarkdownDeps } from '../shared/markdown-deps.mjs'
import { MATERIALIZATION_MAX_BYTES, materializeAttachmentBytes } from '../shared/inbox-reference-materialization.mjs'
import {
  loadConfig as _loadSharedConfig, saveConfig as _saveSharedConfig,
  getServerUrl, getFleetServerUrl, getRwToken, DEFAULT_PORT, hasTls,
  CONFIG_DIR as _SHARED_CONFIG_DIR,
  getActiveConfigName, assertServerCoherence,
} from '../shared/config.mjs'
const execFileP = promisify(execFile)

const VERSION = '0.1.1'
import { createLogger } from '../shared/logger.mjs'
import { resolveDaemonIsolation } from '../shared/daemon-identity.mjs'
import { sendActivityEvents } from './lib/activity-send.mjs'
import { recordPartialSkillReads } from '../shared/partial-skill-reads.mjs'
import { maybeKickGoose, resolveGooseStatus } from './lib/goose-kick.mjs'
import {
  classifyPane, decideThinkingEdge, shouldDisarm, shouldPromptSweepAgent,
  THINKING_SPINNER_RE, INTERRUPT_HINT_RE, COMPACTING_RE, APPROVAL_PROMPT_RE,
  THINKING_SCAN_LINES, APPROVAL_PROMPT_SCAN_LINES,
} from './lib/status-classifier.mjs'
import { gooseActivityTick } from './lib/goose-activity.mjs'
import { parseCodexLine, parseCodexRecord } from './lib/codex-activity.mjs'
import { truncatePrettyResult } from '../shared/activity-pretty-result.mjs'
import { persistDeadLetter, replayDeadLetters } from './lib/daemon/dead-letters.mjs'
import {
  scanFileOwnersSync,
} from './lib/daemon-jsonl-hot-path.mjs'
import {
  loadSessionIdentityStore,
  saveSessionIdentityStore,
  sessionIdentityPath,
  updateFleetFriendlyName,
  updateIngestionStatus,
  upsertSessionIdentity,
} from './lib/session-identity-store.mjs'
import { tailSessionIdentityInput } from './lib/session-identity-tail.mjs'
import {
  terminalBackscrollCaptureArgs,
  terminalVisibleCaptureArgs,
  trimTerminalSeedBlankRows,
} from '../shared/terminal-seed.mjs'
import {
  decideMissingLiveness,
  decideTerminalWatchExit,
  detectSpawnStartupFailureTranscript,
  harnessKindForAgent,
  isPlaywrightBrowserArgs,
  selectOrphanAgentProcesses,
  shouldClaimClaudeWatcher,
  shouldClaimCodexWatcher,
  unlinkPidfileIfOwnPid,
} from './lib/daemon-guards.mjs'
import { codexRolloutBelongsToAgent, codexRolloutHasOwnerEvidence, resolveTranscript } from './lib/resolve-transcript.mjs'
import { resolveSpawnGrant } from '../server/lib/spawn-policy.mjs'
import { probeSpawnAvailability } from './lib/spawn/availability.mjs'
import {
  applyDaemonGrants,
  applyGrandfatherInfill,
  createPermissionLedger,
  defaultDaemonConfigPath,
  permissionLedgerPathFromDaemonConfig,
  readDaemonConfig,
  readDaemonConfigForCwd,
  withDaemonModelAliases,
} from './lib/spawn/permission-ledger.mjs'
import { newFleetId } from './lib/spawn/identity.mjs'
import { acquireSingletonLock, daemonSingletonLockPath, sessionReaderLockPath } from './lib/singleton-lock.mjs'
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

// Per-machine source bindings: { projectName -> absolute local source dir }.
// This is the per-machine fact "where MY copy of project X lives" — it belongs
// on the daemon, not on the server (whose single project.sourceDir is the host's
// path). With a binding present, this daemon watches/pushes its OWN local clone
// for a shared project name; with none, it falls back to the server's sourceDir,
// so the single-host case is unchanged. Read fresh each sync so `tlda doc link`
// takes effect without a daemon restart.
function loadSourceBindings() {
  try {
    if (!fs.existsSync(SOURCE_BINDINGS_FILE)) return {}
    return JSON.parse(fs.readFileSync(SOURCE_BINDINGS_FILE, 'utf8')) || {}
  } catch (e) { log.warn(`corrupt source-bindings file, ignoring: ${e.message}`); return {} }
}
const LOG_FILE = path.join(CONFIG_DIR, 'fleet-daemon.log')
const DEAD_LETTER_FILE = path.join(CONFIG_DIR, 'daemon-dead-letters.jsonl')
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
// fresh on every loadConfig() call — which runs per-spawn at rpcSpawn — so edits to
// daemon.yaml take effect on the NEXT spawn without a daemon restart. Both levers
// ride this single read: withDaemonModelAliases injects daemonConfig.profiles
// (fence) AND daemonConfig.models (aliases) into the spawnPolicy resolveSpawnGrant
// consumes. Keep-last-good: a malformed daemon.yaml (readDaemonConfig throws) must
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

// ---------- cursor persistence ----------

function loadCursors() {
  if (!fs.existsSync(CURSORS_FILE)) return {}
  try { return JSON.parse(fs.readFileSync(CURSORS_FILE, 'utf8')) }
  catch (e) { log.warn(`corrupt cursors file, resetting: ${e.message}`); return {} }
}
function saveCursors() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
  try { fs.writeFileSync(CURSORS_FILE, JSON.stringify(cursors, null, 2)) }
  catch (e) { log.error(`cursor save failed: ${e.message}`) }
}
let cursors = loadCursors() // { sessionId: { inode, offset } }
let sessionIdentityStore = loadSessionIdentityStore(SESSION_IDENTITY_FILE)

// Throttle saveCursors — flush at most once per 2s.
let _cursorSaveTimer = null
function scheduleCursorSave() {
  if (_cursorSaveTimer) return
  _cursorSaveTimer = setTimeout(() => { _cursorSaveTimer = null; saveCursors() }, 2000)
}

function saveSessionIdentityStoreNow() {
  try { saveSessionIdentityStore(SESSION_IDENTITY_FILE, sessionIdentityStore) }
  catch (e) {
    log.error(`session identity save failed: ${e.message}`)
    throw e
  }
}

function recordSessionIdentity(input, { save = true } = {}) {
  if (!input?.session_id) return
  if (upsertSessionIdentity(sessionIdentityStore, input) && save) saveSessionIdentityStoreNow()
}

function syncSessionIdentityNamesFromAgents(agentList = agents) {
  let changed = false
  for (const agent of agentList || []) {
    if (!agent?.id || !agent?.friendly_name) continue
    if (updateFleetFriendlyName(sessionIdentityStore, agent.id, agent.friendly_name)) changed = true
  }
  if (changed) saveSessionIdentityStoreNow()
}

function isIngestionCaughtUp() {
  if (searchBackfillJobs.size > 0 || priorSessionBackfillPending.size > 0) return false
  for (const pw of pathWatchers.values()) {
    if (!pw || pw.stopped) continue
    if (pw.pendingDeliveries > 0 || pw.pendingFlushOffset != null) return false
    let size
    try { size = fs.statSync(pw.jsonlPath).size } catch { continue }
    const offset = cursors[pw.sessionId]?.offset ?? pw.lastSavedOffset ?? 0
    if (offset < size) return false
  }
  return true
}

function refreshIngestionCaughtUp() {
  const changed = updateIngestionStatus(sessionIdentityStore, {
    caught_up: isIngestionCaughtUp(),
    active_tails: [...pathWatchers.values()].filter(pw => pw && !pw.stopped).length,
    pending_jobs: searchBackfillJobs.size + priorSessionBackfillPending.size,
  })
  if (changed) saveSessionIdentityStoreNow()
}

// ---------- session-owner cache ----------
// Each cursor entry gains `owners: [fleetId,...]` — which agent(s) registered in
// that session file. Populated the one time we read the file. Once a session is
// classified, "which sessions does agent X own?" is a cache lookup, never a re-scan
// of every JSONL. This is the daemon's single writer of cursor state.
function recordSessionOwners(sessionId, owners, { jsonlPath = null, harnessKind = 'claude', identity = null } = {}) {
  if (!sessionId) return
  const entry = cursors[sessionId] || (cursors[sessionId] = {})
  const prev = entry.owners || []
  // classified=true means we've fully read the file and `owners` is authoritative
  // (empty owners on a fully-read file is a valid answer: "nobody registered here").
  const merged = owners && owners.length ? [...new Set([...prev, ...owners])] : prev
  const changed = !entry.classified || merged.length !== prev.length
  entry.owners = merged
  entry.classified = true
  let identityChanged = false
  for (const owner of merged) {
    if (upsertSessionIdentity(sessionIdentityStore, {
      session_id: sessionId,
      harness_kind: harnessKind,
      jsonl_path: jsonlPath,
      fleet_id: owner,
      ...(identity?.fleet_id === owner ? identity : {}),
      classified: true,
    })) {
      identityChanged = true
    }
  }
  if (changed) scheduleCursorSave()
  if (changed || identityChanged) saveSessionIdentityStoreNow()
}

function claudeOwnersForSessionFile(sessionId, jsonlPath) {
  const entry = cursors[sessionId]
  if (entry?.classified) return entry.owners || []
  try {
    const scanned = scanFileOwnersSync(jsonlPath)
    recordSessionOwners(sessionId, scanned.owners, { jsonlPath })
    return scanned.owners || []
  } catch {
    return []
  }
}

function indexClaudeJsonlsByOwner() {
  const byOwner = new Map()
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const dirPath = path.join(PROJECTS_DIR, dir)
      let files
      try { files = fs.readdirSync(dirPath) } catch { continue }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.slice(0, -6)
        const jsonlPath = path.join(dirPath, file)
        let stat
        try { stat = fs.statSync(jsonlPath) } catch { continue }
        const owners = claudeOwnersForSessionFile(sessionId, jsonlPath)
        for (const owner of owners) {
          if (!byOwner.has(owner)) byOwner.set(owner, [])
          byOwner.get(owner).push({ sessionId, jsonlPath, mtimeMs: stat.mtimeMs })
        }
      }
    }
  } catch (e) {
    // Best-effort index: per-agent candidate paths below still run.
    log.warn(`Claude JSONL owner index failed: ${e.message}`)
  }
  return byOwner
}

// The niced child that classifies every session's owners in the background
// (recent→old by mtime), so the daemon's main loop never byte-scans files on a spawn.
let _ownerHarvester = null
function startOwnerHarvester() {
  if (_ownerHarvester) return
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-owner-harvester.mjs')
  if (!fs.existsSync(script)) return
  try {
    // execArgv:[] so the child doesn't inherit --import tsx etc.; it's plain ESM.
    _ownerHarvester = fork(script, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  } catch (e) {
    log.warn(`owner harvester failed to start: ${e.message}`)
    _ownerHarvester = null
    return
  }
  _ownerHarvester.on('message', (msg) => {
    if (msg?.type === 'owners') {
      recordSessionOwners(msg.sessionId, msg.owners, {
        jsonlPath: msg.jsonlPath,
        identity: msg.identity,
      })
    } else if (msg?.type === 'harvest-complete') {
      log.info(`owner harvest complete: ${msg.count} session(s) classified`)
    }
  })
  _ownerHarvester.on('exit', () => { _ownerHarvester = null })
  _ownerHarvester.on('error', (e) => { log.warn(`owner harvester error: ${e.message}`); _ownerHarvester = null })
}

let _jsonlIngester = null
let _jsonlIngesterRestartTimer = null
let _shuttingDown = false
let _sessionReaderLock = null
const childWatchers = new Map() // watchId -> path watcher state

function startJsonlIngester() {
  if (_jsonlIngester) return _jsonlIngester
  if (!_sessionReaderLock) {
    const lockPath = sessionReaderLockPath({ configDir: CONFIG_DIR })
    const lock = acquireSingletonLock({
      lockPath,
      installPath: path.dirname(fileURLToPath(import.meta.url)),
      origin: null,
    })
    if (!lock.ok) {
      const holder = lock.holder?.pid ? ` pid=${lock.holder.pid}` : ''
      throw new Error(`session JSONL reader already running for ${CONFIG_DIR}${holder}`)
    }
    _sessionReaderLock = { ...lock, lockPath }
  }
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-jsonl-ingester.mjs')
  if (!fs.existsSync(script)) throw new Error(`JSONL ingester child missing: ${script}`)
  try {
    _jsonlIngester = fork(script, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  } catch (e) {
    _jsonlIngester = null
    throw e
  }
  _jsonlIngester.on('message', handleJsonlIngesterMessage)
  _jsonlIngester.on('exit', (code, signal) => {
    _jsonlIngester = null
    handleJsonlIngesterExit(code, signal)
  })
  _jsonlIngester.on('error', (e) => {
    log.warn(`JSONL ingester child error: ${e.message}`)
  })
  return _jsonlIngester
}

function handleJsonlIngesterExit(code, signal) {
  if (_shuttingDown) return
  log.warn(`JSONL ingester exited code=${code ?? 'null'} signal=${signal ?? 'null'}; resyncing live session tails`)
  for (const [, pw] of childWatchers) {
    pw.stopped = true
    if (pathWatchers.get(pw.jsonlPath) === pw) {
      pathWatchers.delete(pw.jsonlPath)
      releaseJsonlDirWatcher(pw.jsonlPath)
    }
  }
  childWatchers.clear()
  agentPaths.clear()
  if (!_jsonlIngesterRestartTimer) {
    _jsonlIngesterRestartTimer = setTimeout(() => {
      _jsonlIngesterRestartTimer = null
      if (_serverReady) {
        retryPendingJsonlBackfillJobs()
        void syncSessionWatchers(agents).catch(e => log.error(`syncSessionWatchers after ingester exit failed: ${e.stack || e.message}`))
      }
    }, 1000)
  }
}

function retryPendingJsonlBackfillJobs() {
  const jobs = [...searchBackfillJobs.values()]
  if (jobs.length === 0) return
  log.warn(`retrying ${jobs.length} JSONL backfill job(s) after ingester exit`)
  for (const job of jobs) {
    startJsonlBackfillJob({
      ...job,
      ...(job.kind === 'prior' ? { cursors } : {}),
    })
  }
}

// ---------- Qualification checking ----------
// Detects agents editing files without having read required reference docs.
// Config: ~/.claude/qualifications.json — array of { edit: glob, requires: [paths] }

const QUALIFICATIONS_FILE = path.join(os.homedir(), '.claude', 'qualifications.json')
let _qualRules = []
// Per-agent read tracking: agentId → Set of resolved file paths they've Read
const _agentReads = new Map()
const _agentPartialSkillReads = new Map()
// Per-agent warnings already fired: agentId → Set of "editPath:requiredPath" to avoid spam
const _agentWarned = new Map()

function loadQualifications() {
  try {
    if (!fs.existsSync(QUALIFICATIONS_FILE)) return
    const data = JSON.parse(fs.readFileSync(QUALIFICATIONS_FILE, 'utf8'))
    // Only edit-gating rules build an editRe. `tool:`-gating rules have no
    // `edit` field (they're enforced elsewhere) and must be skipped here — else
    // globToRegex(undefined) throws and the whole load fails with
    // "Cannot read properties of undefined (reading 'replace')".
    _qualRules = (data.rules || [])
      .filter(r => typeof r.edit === 'string' && r.edit)
      .map(r => ({
        editPattern: r.edit,
        editRe: globToRegex(r.edit),
        requires: r.requires || [],
      }))
    log.info(`loaded ${_qualRules.length} qualification rules`)
  } catch (e) {
    log.error(`failed to load qualifications: ${e.message}`)
  }
}

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '[^/]')
  // Handle {a,b} alternation
  const withAlts = escaped.replace(/\\\{([^}]+)\\\}/g, (_, inner) =>
    '(' + inner.split(',').join('|') + ')')
  return new RegExp('^' + withAlts + '$')
}

// Derive the virtual skill key from a skill SKILL.md path, e.g.
// ~/.claude/skills/writing/SKILL.md → 'skill:writing'
function skillKeyFromPath(resolvedPath) {
  const home = os.homedir()
  const skillsDir = path.join(home, '.claude', 'skills')
  if (!resolvedPath.startsWith(skillsDir + path.sep)) return null
  const rel = resolvedPath.slice(skillsDir.length + 1) // e.g. 'writing/SKILL.md'
  const parts = rel.split(path.sep)
  if (parts.length === 2 && parts[1] === 'SKILL.md') return 'skill:' + parts[0]
  return null
}

function checkQualification(agentId, toolName, filePath) {
  if (!filePath || _qualRules.length === 0) return
  if (toolName !== 'Edit' && toolName !== 'Write') return

  // Normalize path for matching — strip leading home dir for glob matching
  const home = os.homedir()
  const relative = filePath.startsWith(home) ? filePath.slice(home.length + 1) : filePath
  const reads = _agentReads.get(agentId) || new Set()
  const warned = _agentWarned.get(agentId) || new Set()

  for (const rule of _qualRules) {
    if (!rule.editRe.test(relative) && !rule.editRe.test(filePath)) continue
    for (const req of rule.requires) {
      const resolvedReq = req.startsWith('~') ? path.join(home, req.slice(2)) : req
      // Satisfied by a literal Read of the file OR by invoking the corresponding skill
      const skillKey = skillKeyFromPath(resolvedReq)
      if (reads.has(resolvedReq)) continue
      if (skillKey && reads.has(skillKey)) continue
      const warnKey = `${filePath}:${resolvedReq}`
      if (warned.has(warnKey)) continue
      warned.add(warnKey)
      if (!_agentWarned.has(agentId)) _agentWarned.set(agentId, warned)
      // Fire warning
      const reqShort = req.startsWith('~/') ? req : path.basename(req)
      const fileShort = path.basename(filePath)
      sendMsg({
        type: 'qualification-warning',
        agent_id: agentId,
        file: filePath,
        required: resolvedReq,
        message: `⚠ ${agentId} edited ${fileShort} without reading \`${reqShort}\``,
      })
    }
  }
}

function trackRead(agentId, filePath) {
  if (!filePath) return
  if (!_agentReads.has(agentId)) _agentReads.set(agentId, new Set())
  _agentReads.get(agentId).add(filePath)
}

function trackPartialSkillReads(agentId, command) {
  recordPartialSkillReads(_agentPartialSkillReads, agentId, command, (id, skillKey, filePath) => {
    trackRead(id, filePath)
    trackRead(id, skillKey)
  })
}

// Edit attribution: remember which agent most recently Edited/Wrote each file
// (by canonical absolute path), so a source-change can be attributed to the
// agent whose edit triggered the build. Keyed by realpath where resolvable.
/** @type {Map<string, { agentId: string, ts: number }>} absPath → editor */
const _lastEditor = new Map()
function canonPath(p) {
  try { return fs.realpathSync(p) } catch { return p }
}
function recordEdit(agentId, filePath) {
  if (!agentId || !filePath) return
  _lastEditor.set(canonPath(filePath), { agentId, ts: Date.now() })
}
// Resolve the most-recent agent who edited one of the given absolute paths
// within the recency window. Returns null if none match.
const EDIT_ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000
function resolveEditor(absPaths) {
  let best = null
  const now = Date.now()
  for (const p of absPaths) {
    const rec = _lastEditor.get(canonPath(p))
    if (!rec || now - rec.ts > EDIT_ATTRIBUTION_WINDOW_MS) continue
    if (!best || rec.ts > best.ts) best = rec
  }
  return best?.agentId || null
}

loadQualifications()

// ---------- JSONL parsing (mirrors fleet/dashboard/search-index.mjs) ----------

function parseSessionLine(jsonStr) {
  let obj
  try { obj = JSON.parse(jsonStr) } catch { return null }
  return parseSessionRecord(obj)
}

function parseSessionRecord(obj) {
  const t = obj.type
  if (t === 'progress' || t === 'file-history-snapshot') return null
  const msg = obj.message || {}
  const ev = { type: t, timestamp: obj.timestamp }

  if (t === 'assistant' && msg.content) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
    ev.blocks = content.map(c => {
      if (c.type === 'tool_use') return { type: 'tool_use', name: c.name, input: c.input, id: c.id }
      if (c.type === 'text') return { type: 'text', text: c.text }
      return { type: c.type }
    })
    if (msg.usage) {
      const u = msg.usage
      ev.usage = {
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
      }
    }
  } else if (t === 'user' && msg.content) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
    ev.blocks = content.map(c => {
      if (c.type === 'tool_result') {
        const items = typeof c.content === 'string' ? [{ type: 'text', text: c.content }] :
          Array.isArray(c.content) ? c.content : []
        const text = items.map(x => x.text || '').join('')
        const imgItem = items.find(x => x.type === 'image')
        const imgData = imgItem?.source?.type === 'base64' ? imgItem.source.data : (imgItem?.data || null)
        const imgMime = imgItem?.source?.media_type || imgItem?.mimeType || 'image/png'
        return { type: 'tool_result', id: c.tool_use_id, text, is_error: c.is_error || false, imgData, imgMime }
      }
      if (c.type === 'text') return { type: 'text', text: c.text }
      return { type: c.type }
    })
  } else {
    return null
  }
  return ev
}

// Activity noise filter — these tools are fleet infrastructure, not real
// agent work, and don't deserve activity cards. Mirrored from
// fleet/dashboard/server.mjs ACTIVITY_NOISE.
const ACTIVITY_NOISE = new Set([
  'wait_for_task', 'my_task', 'task_list', 'register', 'register_manager',
  'task_check', 'unregister_manager', 'task_done', 'timer',
  'chat', 'delegate', 'report', 'share', 'spawn', 'respawn', 'interrupt',
  'name_agent', 'label_agent', 'observe', 'promote', 'cleanup',
  'mcp__tlda__wait_for_task', 'mcp__tlda__my_task', 'mcp__tlda__task_list',
  'mcp__tlda__register', 'mcp__tlda__register_manager', 'mcp__tlda__task_check',
  'mcp__tlda__task_done', 'mcp__tlda__timer',
  'mcp__tlda__chat', 'mcp__tlda__delegate', 'mcp__tlda__report',
  'mcp__tlda__share', 'mcp__tlda__spawn', 'mcp__tlda__respawn',
  'mcp__tlda__interrupt', 'mcp__tlda__name_agent', 'mcp__tlda__label_agent',
  'mcp__tlda__observe', 'mcp__tlda__promote', 'mcp__tlda__cleanup',
  'ToolSearch',
])

// Tools whose results should be captured and forwarded as pretty-printed cards.
// Keep the accepted names broad: Claude/Codex use mcp__tlda__get_thread, while
// Goose and stored activity can use tlda__get_thread or get_thread.
const PRETTY_PRINT_TOOLS = new Set([
  'mcp__tlda__inbox',
  'mcp__tlda__search_logs',
  'mcp__tlda__get_thread',
  'tlda/inbox',
  'tlda__inbox',
  'tlda__search_logs',
  'tlda__get_thread',
  'inbox',
  'search_logs',
  'get_thread',
  'ScheduleWakeup',
  'mcp__tlda__screenshot',
  'tlda__screenshot',
  'screenshot',
  'mcp__tlda__propose_edit',
  'tlda__propose_edit',
  'propose_edit',
])

function toolBaseName(name) {
  return String(name || '').split('__').pop()
}

function isPrettyPrintTool(name) {
  return PRETTY_PRINT_TOOLS.has(name) || PRETTY_PRINT_TOOLS.has(toolBaseName(name))
}

// Pending pretty-print tool_uses waiting for their results. Keyed by tool_use_id.
// When a tool_use for a pretty-print tool arrives without a matching result in
// the same batch, delay the activity card instead of sending a bare card and a
// later _prettyResult follow-up. That keeps delayed results in the same stored
// input shape as same-batch Claude results: the original tool event with
// prettyResult attached. Entries expire after 30s to avoid leaking memory on
// abandoned tool calls.
const pendingPrettyPrint = new Map()  // id -> { agentId, evt, expiresAt }

function extractActivityEvents(events) {
  const result = []
  // Collect tool_results keyed by tool_use_id so we can match them
  const toolResults = new Map()
  for (const ev of events) {
    if (!ev.blocks) continue
    for (const block of ev.blocks) {
      if (block.type === 'tool_result' && block.id) {
        let text = block.text || ''
        if (block.imgData) {
          try {
            const imgPath = `/tmp/tlda-ss-${block.id.replace(/[^a-z0-9]/gi, '_')}.png`
            fs.writeFileSync(imgPath, Buffer.from(block.imgData, 'base64'))
            text = text ? text + '\n\nimage:' + imgPath : 'image:' + imgPath
          } catch { /* disk write failed — fall back to text-only prettyResult */ }
        }
        toolResults.set(block.id, text)
      }
    }
  }
  for (const ev of events) {
    if (!ev.blocks) continue
    for (const block of ev.blocks) {
      // Skip text from user turns — terminal input is captured separately
      // as terminal-chat. tool_result blocks fall through fine.
      if (ev.type === 'user' && block.type === 'text') continue
      if (block.type === 'tool_use') {
        const name = block.name || ''
        if (ACTIVITY_NOISE.has(name)) continue
        const humanName = name.replace(/^mcp__/, '').replace(/__/g, '/')
        const input = block.input || {}
        const arg = input.file_path || input.path ||
          input.command || input.pattern || input.message ||
          input.query || input.description || input.reason ||
          input.agent || input.doc || input.ref || input.text || ''
        const evt = { tool: humanName, arg, ts: ev.timestamp, id: block.id }
        if (Object.keys(input).length > 0) evt.input = input
        // Attach result for pretty-printed tools
        if (isPrettyPrintTool(name) && block.id) {
          if (toolResults.has(block.id)) {
            const raw = toolResults.get(block.id)
            evt.prettyResult = truncatePrettyResult(raw, name)
          } else {
            // Result not in this batch — stash and wait so the eventual card
            // has the same shape as a same-batch Claude pretty-result card.
            pendingPrettyPrint.set(block.id, { evt: { ...evt }, expiresAt: Date.now() + 30000 })
            continue
          }
        }
        result.push(evt)
      } else if (block.type === 'text' && block.text?.trim().length > 0) {
        result.push({ tool: '_text', arg: block.text, ts: ev.timestamp })
      }
    }
    if (ev.usage) result.push({ tool: '_usage', ts: ev.timestamp, usage: ev.usage })
  }
  // Check if any tool_results in this batch match pending pretty-print requests
  for (const [id, resultText] of toolResults) {
    const pending = pendingPrettyPrint.get(id)
    if (pending) {
      pendingPrettyPrint.delete(id)
      const capped = truncatePrettyResult(resultText, pending.evt.tool)
      result.push({ ...pending.evt, prettyResult: capped })
    }
  }
  // Expire old pending entries
  const now = Date.now()
  for (const [id, entry] of pendingPrettyPrint) {
    if (now > entry.expiresAt) {
      pendingPrettyPrint.delete(id)
      result.push(entry.evt)
    }
  }
  return result
}

// ---------- daemon state ----------

let _rws = null  // ResilientWS instance, created at startup
let _serverReady = false
let _lastLivenessDisconnectWarnAt = 0
let _daemonRequestSeq = 0
const pendingDaemonReplies = new Map()
let agents = []                   // current agent list (from welcome / updates)
let projects = []                 // current project list
const pathWatchers = new Map()    // jsonlPath -> child-backed watcher state
const agentPaths = new Map()      // agentId -> jsonlPath
const jsonlDirWatchers = new Map() // dir -> { watcher, refs }
let _lastSessionWatcherRosterSig = ''
const sourceWatchers = new Map()  // projectName -> { watcher, sourceDir, debounce, pending }
const searchBackfillJobs = new Map() // jobId -> { sessionId, jsonlPath }
const searchBackfillPendingBySession = new Set()
const priorSessionBackfillPending = new Set()
const priorSessionBackfillComplete = new Set()

// ---------- plan mode detection ----------

// Tracks last plan fingerprint per agent to avoid sending duplicates.
const planModeHashes = new Map()        // agentId -> fingerprint string
// Pending setTimeout handles for plan-mode checks. One check per agent at a time.
const pendingPlanChecks = new Map()     // agentId -> timeoutHandle

// Strip ANSI escape codes from terminal output.
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

// ---------- prompt detection + auto-accept ----------
//
// The sweep captures panes every 5s and classifies permission prompts:
//   - Memory file writes → auto-accept (option 1)
//   - Other permission prompts → surface as terminal_attention card

const MEMORY_PATH_RE = /\.claude\/projects\/[^/]+\/memory\//

// Detect the TUI radio-button prompt pattern (❯ 1. Yes / 2. ... / 3. No)
const RADIO_PROMPT_RE = /[❯>]\s*1\.\s*Yes/
// Detect y/n permission prompts (Allow this command? (y/n))
const YN_PROMPT_RE = /Allow this (?:command|action)\?\s*\(y\/n\)/i

function extractPromptContext(stripped) {
  // Extract the tool call line above the prompt (e.g. "⏺ Write(path/to/file)" or "⏺ Bash(command)")
  const toolMatch = stripped.match(/[⏺●]\s*(Write|Edit|Bash|Read|NotebookEdit)\(([^)]*)\)/s)
  if (toolMatch) return `${toolMatch[1]}(${toolMatch[2].trim().slice(0, 120)})`
  // Try "Do you want to [verb] [thing]?" directly
  const doMatch = stripped.match(/Do you want to (\w+) (.+?)\?/)
  if (doMatch) return `${doMatch[1]} ${doMatch[2]}`
  // Try "Allow this command/action" with surrounding context
  const allowMatch = stripped.match(/Allow (.+?)\?/i)
  if (allowMatch) return allowMatch[1].trim().slice(0, 120)
  return null
}

function extractPromptBody(stripped) {
  const lines = stripped.split('\n')
  // Find the last tool call marker (⏺ Tool(...))
  let toolIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/[⏺●]\s*(Write|Edit|Bash|Read|NotebookEdit|Agent|Skill)\(/.test(lines[i])) {
      toolIdx = i
      break
    }
  }
  if (toolIdx < 0) return null
  // Find the prompt question line ("Do you want to..." or "Allow this...")
  let promptIdx = -1
  for (let i = toolIdx + 1; i < lines.length; i++) {
    if (/Do you want to|Allow this/i.test(lines[i])) {
      promptIdx = i
      break
    }
  }
  if (promptIdx < 0) return null
  // Extract the tool call line plus any body between it and the question
  const bodyLines = lines.slice(toolIdx, promptIdx)
    .map(l => l.replace(/^\s{0,4}/, ''))
    .filter(l => l.trim())
  if (bodyLines.length === 0) return null
  return bodyLines.join('\n').slice(0, 1000)
}

// Codex raises its own per-tool MCP approval prompt (distinct from Claude's
// radio prompt): `Allow the tlda MCP server to run tool "<X>"?` with a 1–4
// option list (1 Allow / 2 session / 3 Always allow / 4 Cancel). Codex's
// "Always allow" is per-TOOL, so this fires once for each new tool the agent
// calls; we send `3` so that tool never prompts again. Scoped to the `tlda`
// MCP server (the agent's own fleet ops) — we don't blanket-accept arbitrary MCP.
const CODEX_MCP_PROMPT_RE = /Allow the tlda MCP server to run tool ["']?([^"'?\n]+?)["']?\?/

function detectPrompt(paneText) {
  const stripped = typeof paneText === 'string' ? stripAnsi(paneText) : ''

  // Codex MCP tool-approval prompt → auto-accept with "Always allow" (key 3).
  const codexMatch = stripped.match(CODEX_MCP_PROMPT_RE)
  if (codexMatch && /Always allow/.test(stripped)) {
    return { type: 'auto-accept', reason: `codex mcp tool: ${codexMatch[1]}`, acceptKey: '3' }
  }

  // Radio-button TUI prompt (Create/Edit file, self-edit)
  if ((stripped.includes('Do you want to') || stripped.includes('Allow this')) && RADIO_PROMPT_RE.test(stripped)) {
    if (MEMORY_PATH_RE.test(stripped)) {
      return { type: 'auto-accept', reason: 'memory file write' }
    }
    const context = extractPromptContext(stripped)
    const reason = context ? `permission prompt: ${context}` : 'permission prompt'
    const snippet = extractPromptBody(stripped)
    return { type: 'surface', reason, snippet }
  }

  // y/n permission prompt
  if (YN_PROMPT_RE.test(stripped)) {
    const context = extractPromptContext(stripped)
    const reason = context ? `permission prompt: ${context}` : 'permission prompt (y/n)'
    const snippet = extractPromptBody(stripped)
    return { type: 'surface', reason, snippet }
  }

  return { type: 'none' }
}

async function autoAcceptPrompt(tmuxSession, reason, acceptKey = '1') {
  try {
    const ptyState = terminalWatchPtys.get(tmuxSession)
    if (ptyState?.alive) {
      ptyState.pty.write(`${acceptKey}\r`)
    } else {
      await tmux('send-keys', '-t', tmuxSession, acceptKey)
      await new Promise(r => setTimeout(r, 100))
      await tmux('send-keys', '-t', tmuxSession, 'Enter')
    }
    log.info(`auto-accepted prompt (${reason}, key=${acceptKey}) in ${tmuxSession}`)
    return true
  } catch (e) {
    log.error(`auto-accept failed in ${tmuxSession}: ${e.message}`)
    return false
  }
}

const AUTO_ACCEPT_INTERVAL_MS = 5000
const TERMINAL_SIZE_POLL_MS = parseInt(process.env.TLDA_TERMINAL_SIZE_POLL_MS, 10) || 5000
const promptCooldowns = new Map()
const surfacedPrompts = new Map()

function startAutoAcceptSweep() {
  setInterval(async () => {
    const sweptSessions = new Set()
    for (const agent of agents) {
      if (!agent.tmux_session) continue
      const armed = _armedSince.has(agent.id)
      const surfaced = surfacedPrompts.has(agent.tmux_session)
      if (!shouldPromptSweepAgent(agent, { armed, surfaced })) continue
      if (sweptSessions.has(agent.tmux_session)) continue
      sweptSessions.add(agent.tmux_session)
      // Skip agents with active PTY watchers — they get real-time detection
      if (terminalWatchPtys.get(agent.tmux_session)?.alive) continue
      try {
        const { stdout } = await execFileP('tmux',
          [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-S', '-80'],
          { timeout: 2000, encoding: 'utf8', maxBuffer: 512 * 1024 })
        const stripped = stripAnsi(stdout)
        const result = detectPrompt(stdout)
        if (result.type === 'auto-accept') {
          const lastAccept = promptCooldowns.get(agent.tmux_session)
          if (lastAccept && Date.now() - lastAccept < 10_000) continue
          promptCooldowns.set(agent.tmux_session, Date.now())
          surfacedPrompts.delete(agent.tmux_session)
          await autoAcceptPrompt(agent.tmux_session, result.reason, result.acceptKey)
          sendMsg({ type: 'prompt-auto-accepted', agent_id: agent.id, reason: result.reason, ts: new Date().toISOString() })
        } else if (result.type === 'surface') {
          if (surfacedPrompts.get(agent.tmux_session) === result.reason) continue
          surfacedPrompts.set(agent.tmux_session, result.reason)
          log.info(`surfacing prompt for ${agent.friendly_name || agent.id}: ${result.reason}`)
          sendMsg({ type: 'terminal_attention', agent_id: agent.id, tmux_session: agent.tmux_session, text: result.reason, reason: result.reason, snippet: result.snippet || null })
        } else {
          surfacedPrompts.delete(agent.tmux_session)
        }
        if (stripped.includes("Here is Claude's plan") && stripped.includes('Would you like to')) {
          scheduleCheckForPlanModePrompt(agent.id)
        } else {
          planModeHashes.delete(agent.id)
        }
      } catch {
        // Session gone or capture failed — skip silently
      }
    }
  }, AUTO_ACCEPT_INTERVAL_MS)
}

let _autoAcceptStarted = false

async function checkForPlanModePrompt(agentId) {
  pendingPlanChecks.delete(agentId)
  const agent = agents.find(a => a.id === agentId)
  if (!agent?.tmux_session) return

  let pane
  try {
    const { stdout } = await execFileP('tmux',
      [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-e', '-S', '-150'],
      { timeout: 5000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    pane = stripAnsi(stdout)
  } catch (e) {
    log.error(`plan-mode capture ${agentId}: ${e.message}`)
    return
  }

  if (!pane.includes("Here is Claude's plan") || !pane.includes('Would you like to')) return

  if (planModeHashes.has(agentId)) return
  planModeHashes.set(agentId, true)

  // Strategy 1: Read the plan file directly (most reliable).
  // Claude Code prints the path in the terminal output.
  let planText = ''
  const planFileMatch = pane.match(/\/[^\s]*\.claude\/plans\/[^\s]+\.md/)
  if (planFileMatch) {
    try {
      planText = fs.readFileSync(planFileMatch[0], 'utf8').trim()
      log.info(`plan-mode: read plan file ${planFileMatch[0]}`)
    } catch (e) {
      log.warn(`plan-mode: couldn't read plan file ${planFileMatch[0]}: ${e.message}`)
    }
  }

  // Strategy 2: Extract between ╌╌╌ divider lines (original approach).
  if (!planText) {
    const lines = pane.split('\n')
    const dividerIdx = []
    for (let i = 0; i < lines.length; i++) {
      if (/^[\s╌]{10,}$/.test(lines[i].trim()) || lines[i].includes('╌╌╌╌')) {
        dividerIdx.push(i)
      }
    }
    for (let d = 0; d < dividerIdx.length - 1; d++) {
      const between = lines.slice(dividerIdx[d] + 1, dividerIdx[d + 1]).join('\n').trim()
      if (between.length > 20) {
        planText = between
        break
      }
    }
  }

  // Strategy 3: Raw text between the sentinel strings (last resort).
  if (!planText) {
    const startIdx = pane.indexOf("Here is Claude's plan")
    const endIdx = pane.indexOf('Would you like to')
    if (startIdx >= 0 && endIdx > startIdx) {
      planText = pane.slice(startIdx + "Here is Claude's plan".length, endIdx).trim()
    }
  }

  // Always send — even with empty plan text, the card signals "agent is in plan mode"
  if (!planText) planText = '(Plan text could not be extracted — check the agent terminal)'

  sendMsg({
    type: 'plan-mode-prompt',
    agent_id: agentId,
    plan_text: planText,
    tmux_session: agent.tmux_session,
  })
  log.info(`plan-mode-prompt sent for agent ${agentId}`)
}

function scheduleCheckForPlanModePrompt(agentId) {
  if (pendingPlanChecks.has(agentId)) return  // already scheduled
  const handle = setTimeout(() => checkForPlanModePrompt(agentId), 1500)
  pendingPlanChecks.set(agentId, handle)
}


// ---------- activity event buffer ----------

function bufferActivity(agentId, evts) {
  // Liveness #B(a): a JSONL line IS a per-turn heartbeat — the agent just processed
  // a turn, so it is alive NOW. Warm the liveness cache (keyed by tmux_session) and
  // stamp last_seen, so rpcCheckAlive / the wake path read "alive" from activity
  // without a tmux probe. Strictly additive: it only ever marks a live agent alive
  // (never dead), so it can't cause respawn-churn — it just keeps the cache warm and
  // shrinks the cold-miss window the 30s sweep used to own (the step that lets the
  // sweep later demote to a slow drift-reconciler).
  const agent = agents.find(a => a.id === agentId)
  if (agent?.tmux_session) {
    _alivenessCache.set(agent.tmux_session, true)
    _missingSessionSince.delete(agentId)
    agent.last_seen = new Date().toISOString()
  }
  // Any buffered activity (claude/codex JSONL or goose sqlite) is a reason to
  // watch this agent's pane frequently — arm it for the status state machine.
  armAgent(agentId)
  return sendActivityEvents(agentId, evts, sendMsg)
}

// ---------- JSONL watching ----------

async function findRuntimePidForAgent(agent, kind) {
  const adapter = HARNESS_ADAPTERS[kind]
  if (!adapter) return null
  if (!agent?.tmux_session) return null
  let paneOut = ''
  try {
    ;({ stdout: paneOut } = await execFileP('tmux',
      [...TMUX_ARGS, 'list-panes', '-t', agent.tmux_session, '-F', '#{pane_pid}'],
      { timeout: 3000, encoding: 'utf8' }))
  } catch {
    return null
  }
  const panePids = paneOut.trim().split('\n').filter(Boolean)
  if (!panePids.length) return null

  let psOut = ''
  try {
    ;({ stdout: psOut } = await execFileP('ps', ['-eo', 'pid,ppid,args'],
      { timeout: 5000, encoding: 'utf8' }))
  } catch {
    return null
  }

  const childrenByPpid = new Map()
  const runtimePids = new Set()
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const [, pid, ppid, args] = m
    if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, [])
    childrenByPpid.get(ppid).push(pid)
    if (adapter.processRe.test(args)) runtimePids.add(pid)
  }

  const stack = [...panePids]
  const seen = new Set()
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    if (runtimePids.has(pid)) return pid
    for (const child of (childrenByPpid.get(pid) || [])) stack.push(child)
  }
  return null
}

async function resolveCodexJsonl(agent) {
  const pid = await findRuntimePidForAgent(agent, 'codex')
  // No live Codex process means there is no transcript being written. Do not
  // fall back to scanning ~/.codex/sessions for hibernating/stale rows; the real
  // roster can contain hundreds of old rollouts, and doing that per row pegs the
  // daemon before it reaches live activity.
  if (!pid) return null
  const launchTs = Date.parse(agent.registered_at || agent.last_seen || '') || 0
  return resolveTranscript({ pid, kind: 'codex', agent, launchTs })
}

const HARNESS_ADAPTERS = {
  claude: {
    kind: 'claude',
    processRe: /(?:^|\s|[/\\])claude(?:\.exe)?(?:\s|$)/,
    activity: {
      kind: 'claude',
      parseLine: parseSessionLine,
      parseRecord: parseSessionRecord,
      usesClaudeSessionIds: true,
      backfillSearch: true,
      terminalChat: true,
    },
  },
  codex: {
    kind: 'codex',
    processRe: /(?:^|\s|[/\\])codex(?:\.exe)?(?:\s|$)/,
    activity: {
      kind: 'codex',
      parseLine: parseCodexLine,
      parseRecord: parseCodexRecord,
      resolveJsonl: resolveCodexJsonl,
      usesClaudeSessionIds: false,
      backfillSearch: false,
      terminalChat: false,
    },
  },
  goose: {
    kind: 'goose',
    processRe: /(?:^|\s|[/\\])goose(?:\.exe)?(?:\s|$).*?\brun\b|\bgoose(?:\.exe)? run\b/,
    activity: {
      kind: 'goose',
      source: 'sqlite',
      poll(agents, deps) { gooseActivityTick(agents, deps) },
      usesClaudeSessionIds: false,
      backfillSearch: false,
      terminalChat: false,
    },
  },
}

function harnessForAgent(agent) {
  const kind = harnessKindForAgent(agent, log)
  const adapter = HARNESS_ADAPTERS[kind]
  if (!adapter) throw new Error(`unknown harness kind "${kind}" for ${agent?.friendly_name || agent?.id}`)
  return adapter
}

function activityHarnessForAgent(agent) {
  return harnessForAgent(agent).activity
}

// Resolve an agent's harness kind from its LIVE pane process when the stored
// metadata.kind is absent or stale. resolve-transcript's contract is that kind
// comes from process classification, not trusted metadata: a codex agent whose
// metadata.kind never propagated (roster split / pre-refactor row) must NOT be
// defaulted to claude — that points the watcher at ~/.claude/projects, finds no
// JSONL, and the agent silently gets zero activity cards. Mirrors the pane-
// subtree scan in findRuntimePidForAgent, but matches ALL adapters' processRe.
async function resolveAgentKind(agent) {
  const stored = agent?.metadata?.kind
  if (!agent?.tmux_session) return (stored && HARNESS_ADAPTERS[stored]) ? stored : 'claude'
  let paneOut = ''
  try {
    ;({ stdout: paneOut } = await execFileP('tmux',
      [...TMUX_ARGS, 'list-panes', '-t', agent.tmux_session, '-F', '#{pane_pid}'],
      { timeout: 3000, encoding: 'utf8' }))
  } catch { return (stored && HARNESS_ADAPTERS[stored]) ? stored : 'claude' }
  const panePids = paneOut.trim().split('\n').filter(Boolean)
  if (!panePids.length) return (stored && HARNESS_ADAPTERS[stored]) ? stored : 'claude'
  let psOut = ''
  try {
    ;({ stdout: psOut } = await execFileP('ps', ['-eo', 'pid,ppid,args'], { timeout: 5000, encoding: 'utf8' }))
  } catch { return (stored && HARNESS_ADAPTERS[stored]) ? stored : 'claude' }
  const childrenByPpid = new Map()
  const argsByPid = new Map()
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const [, pid, ppid, args] = m
    if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, [])
    childrenByPpid.get(ppid).push(pid)
    argsByPid.set(pid, args)
  }
  const stack = [...panePids], seen = new Set()
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    const args = argsByPid.get(pid)
    // Check codex/goose before claude: a codex/goose runtime is the specific
    // signal; claude's regex is the broad default. (processRes are word-bounded
    // so this is belt-and-suspenders, not load-bearing.)
    if (args) {
      if (HARNESS_ADAPTERS.codex.processRe.test(args)) return 'codex'
      if (HARNESS_ADAPTERS.goose.processRe.test(args)) return 'goose'
      if (HARNESS_ADAPTERS.claude.processRe.test(args)) return 'claude'
    }
    for (const child of (childrenByPpid.get(pid) || [])) stack.push(child)
  }
  return (stored && HARNESS_ADAPTERS[stored]) ? stored : 'claude'
}

async function syncSessionWatchers(agentList) {
  let liveSessions = new Set()
  try {
    const r = await rpcListSessions()
    liveSessions = new Set(r.sessions || [])
  } catch (e) {
    log.warn(`tmux session list failed during JSONL watcher sync: ${e.message}`)
    return
  }
  const activePaths = new Set()
  const claudeJsonlsByOwner = indexClaudeJsonlsByOwner()

  for (const agent of agentList) {
    if (agent.dead) continue
    if (!agent.tmux_session || !liveSessions.has(agent.tmux_session)) continue
    let harness
    try {
      const kind = await resolveAgentKind(agent)
      const adapter = HARNESS_ADAPTERS[kind]
      if (!adapter) throw new Error(`unknown harness kind "${kind}" for ${agent?.friendly_name || agent?.id}`)
      harness = adapter.activity
    } catch (e) {
      log.error(`activity harness selection failed: ${e.message}`)
      continue
    }
    const cwd = agent.cwd ?? ''
    // Strip worktree suffixes so the project hash matches where Claude Code
    // stores the JSONL (at the original project root, not the worktree).
    const canonicalCwd = cwd.replace(/\/\.claude\/worktrees\/[^/]+$/, '').replace(/\/\.worktrees\/[^/]+$/, '')
    const projectHash = canonicalCwd.replace(/[/.]/g, '-')

    // Pick the freshest JSONL across this agent's registered session_ids.
    // Claude ownership is not inferred from roster aliases, tmux panes, or
    // other agents' claimed session_id values. The JSONL's embedded
    // "Registered fleet:<id>" owner is the only identity source.
    const candidateIds = []
    if (agent.session_id) candidateIds.push(agent.session_id)
    for (const sid of (agent.session_ids || [])) {
      if (!candidateIds.includes(sid)) candidateIds.push(sid)
    }

    let jsonlPath = null
    let bestMtime = 0
    if (harness.resolveJsonl) {
      jsonlPath = await harness.resolveJsonl(agent)
      if (!jsonlPath) continue
    } else {
      if (!harness.usesClaudeSessionIds) continue
      for (const sid of candidateIds) {
        let p = path.join(PROJECTS_DIR, projectHash, sid + '.jsonl')
        let foundStat = null
        try {
          foundStat = fs.statSync(p)
        } catch {
          // Not in cwd-derived dir — global search across all project dirs.
          // Needed when agent's JSONL is in a worktree-specific project dir
          // that doesn't match the stripped canonical cwd.
          try {
            for (const dir of fs.readdirSync(PROJECTS_DIR)) {
              const candidate = path.join(PROJECTS_DIR, dir, sid + '.jsonl')
              try { foundStat = fs.statSync(candidate); p = candidate; break } catch {}
            }
          } catch {}
        }
        if (foundStat) {
          const owners = claudeOwnersForSessionFile(sid, p)
          if (!shouldClaimClaudeWatcher({ currentPrimaryId: null, agent, owners })) continue
        }
        if (foundStat && foundStat.mtimeMs > bestMtime) {
          bestMtime = foundStat.mtimeMs
          jsonlPath = p
        }
      }
      for (const owned of (claudeJsonlsByOwner.get(agent.id) || [])) {
        if (owned.mtimeMs > bestMtime) {
          bestMtime = owned.mtimeMs
          jsonlPath = owned.jsonlPath
        }
      }
    }
    if (!jsonlPath) continue

    activePaths.add(jsonlPath)
    agentPaths.set(agent.id, jsonlPath)

    if (pathWatchers.has(jsonlPath)) {
      const pw = pathWatchers.get(jsonlPath)
      if (pw.stopped) {
        pathWatchers.delete(jsonlPath)
        releaseJsonlDirWatcher(jsonlPath)
      } else {
        const fileSessionId = path.basename(jsonlPath, '.jsonl')
        // The JSONL's embedded owner is authoritative for Claude. Roster
        // session_id values are only candidate handles, not ownership evidence.
        if (harness.kind === 'codex') {
          if (shouldClaimCodexWatcher({
            currentPrimaryId: pw.primaryAgentId,
            agent,
            jsonlPath,
            rolloutHasOwnerEvidence: codexRolloutHasOwnerEvidence,
            rolloutBelongsToAgent: codexRolloutBelongsToAgent,
          })) {
            pw.primaryAgentId = agent.id
          }
        } else if (!harness.usesClaudeSessionIds || harness.kind === 'claude') {
          if (!harness.usesClaudeSessionIds) {
            pw.primaryAgentId = agent.id
          } else {
            const owners = claudeOwnersForSessionFile(fileSessionId, jsonlPath)
            if (shouldClaimClaudeWatcher({
              currentPrimaryId: pw.primaryAgentId,
              agent,
              owners,
            })) {
              pw.primaryAgentId = agent.id
            }
          }
        }
        pw.harnessKind = harness.kind
        try {
          _jsonlIngester?.send?.({
            type: 'update',
            watchId: pw.watchId,
            agentId: pw.primaryAgentId,
            harnessKind: harness.kind,
            terminalChat: !!harness.terminalChat,
            backfillSearch: !!harness.backfillSearch,
          })
        } catch (e) {
          log.warn(`JSONL ingester update failed for ${path.basename(jsonlPath)}: ${e?.message || e}`)
          retireJsonlTail(pw, `ingester update failed for ${path.basename(jsonlPath)}`)
        }
        continue
      }
    }

    // First time watching this JSONL — initialize cursor.
    const sessionId = path.basename(jsonlPath, '.jsonl')
    let stat
    try { stat = fs.statSync(jsonlPath) } catch { continue }
    const inode = stat.ino
    const stored = cursors[sessionId]
    let offset
    if (stored && stored.inode === inode) {
      offset = Math.min(stored.offset, stat.size)
      // Backfill search index if not done yet for this session.
      if (!stored.searchBackfilled) {
        if (harness.backfillSearch) backfillSearchEntries(agent.id, jsonlPath, sessionId, harness.kind)
      }
    } else {
      // New file (or rotated): start at EOF for activity cards, but backfill
      // all historical content to the search index.
      offset = stat.size
      cursors[sessionId] = { inode, offset }
      scheduleCursorSave()
      if (harness.backfillSearch) backfillSearchEntries(agent.id, jsonlPath, sessionId, harness.kind)
      // Also backfill all prior sessions for this agent (other JSONLs that
      // contain a registration line for this fleet ID).
      if (harness.backfillSearch) backfillAllPriorSessions(agent.id, agent.id)
    }

    try {
      const pwState = startJsonlTail({ agent, jsonlPath, sessionId, harness, startOffset: offset })
      pathWatchers.set(jsonlPath, pwState)
      retainJsonlDirWatcher(jsonlPath)

      log.info(`watching ${harness.kind} JSONL for ${agent.friendly_name || agent.id}: ${path.basename(jsonlPath)} @ offset=${offset}`)
    } catch (e) {
      log.error(`watcher creation failed for ${jsonlPath}: ${e.message}`)
    }
  }

  // Close watchers for paths no longer needed.
  for (const [p, pw] of pathWatchers) {
    if (!activePaths.has(p)) {
      stopJsonlTail(pw, `no longer active: ${path.basename(p)}`)
      pathWatchers.delete(p)
      releaseJsonlDirWatcher(p)
      for (const [aid, watchedPath] of agentPaths) {
        if (watchedPath === p) agentPaths.delete(aid)
      }
    }
  }
  for (const aid of [...agentPaths.keys()]) {
    if (!agentList.some(a => a.id === aid && !a.dead)) agentPaths.delete(aid)
  }
}

function sessionWatcherRosterSignature(agentList) {
  return agentList
    .filter(a => !a.human)
    .map(a => {
      const sessionIds = Array.isArray(a.session_ids) ? [...a.session_ids].sort().join(',') : ''
      return [
        a.id,
        a.dead ? 'dead' : 'live',
        a.tmux_session || '',
        a.session_id || '',
        sessionIds,
        a.cwd || '',
        a.metadata?.kind || '',
        a.runtimeKind || '',
      ].join('\t')
    })
    .sort()
    .join('\n')
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

function syncSessionWatchersIfRosterChanged(reason) {
  const sig = sessionWatcherRosterSignature(agents)
  if (sig === _lastSessionWatcherRosterSig) return
  _lastSessionWatcherRosterSig = sig
  log.info(`session watcher roster changed (${reason}); syncing live session tails`)
  // A roster change is exactly when a newly-registered agent first appears, so this
  // is the grant-on-mint moment for the agents-updated path (debounced by the sig check).
  grantOnMintInfill(reason)
  void syncSessionWatchers(agents).catch(e => log.error(`syncSessionWatchers failed: ${e.stack || e.message}`))
}

let _jsonlDirSyncTimer = null
function scheduleJsonlDirSync(reason) {
  if (_jsonlDirSyncTimer) return
  _jsonlDirSyncTimer = setTimeout(() => {
    _jsonlDirSyncTimer = null
    log.info(`JSONL directory change detected (${reason}); syncing live session tails`)
    void syncSessionWatchers(agents).catch(e => log.error(`syncSessionWatchers failed: ${e.stack || e.message}`))
  }, 500)
}

function retainJsonlDirWatcher(jsonlPath) {
  const dir = path.dirname(jsonlPath)
  const existing = jsonlDirWatchers.get(dir)
  if (existing) {
    existing.refs += 1
    return
  }
  const watcher = chokidar.watch(dir, {
    depth: 0,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: false,
  })
  watcher
    .on('add', p => {
      if (String(p).endsWith('.jsonl')) scheduleJsonlDirSync(`add ${path.basename(p)}`)
    })
    .on('unlink', p => {
      if (String(p).endsWith('.jsonl')) scheduleJsonlDirSync(`unlink ${path.basename(p)}`)
    })
    .on('error', e => log.warn(`chokidar JSONL dir watcher failed for ${dir}: ${e?.message || e}`))
  jsonlDirWatchers.set(dir, { watcher, refs: 1 })
}

function releaseJsonlDirWatcher(jsonlPath) {
  const dir = path.dirname(jsonlPath)
  const entry = jsonlDirWatchers.get(dir)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) return
  jsonlDirWatchers.delete(dir)
  Promise.resolve(entry.watcher.close()).catch(e => log.warn(`chokidar close failed for ${dir}: ${e?.message || e}`))
}

function startJsonlTail({ agent, jsonlPath, sessionId, harness, startOffset }) {
  const child = startJsonlIngester()
  const watchId = `${sessionId}:${agent.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const pw = {
    watchId,
    jsonlPath,
    primaryAgentId: agent.id,
    sessionId,
    harnessKind: harness.kind,
    stopped: false,
    lastDeliveryOk: true,
    lastSavedOffset: startOffset,
    pendingDeliveries: 0,
    pendingFlushOffset: null,
  }
  childWatchers.set(watchId, pw)
  child.send?.({
    type: 'watch',
    watchId,
    jsonlPath,
    sessionId,
    agentId: agent.id,
    harnessKind: harness.kind,
    startOffset,
    terminalChat: !!harness.terminalChat,
    backfillSearch: !!harness.backfillSearch,
  })
  refreshIngestionCaughtUp()
  return pw
}

function handleJsonlIngesterMessage(msg) {
  if (msg?.type === 'ready') {
    log.info('JSONL ingester child ready')
    return
  }
  if (msg?.type === 'job-batch') {
    void handleJsonlBackfillBatch(msg)
    return
  }
  if (msg?.type === 'job-session-complete') {
    handleJsonlBackfillSessionComplete(msg)
    return
  }
  if (msg?.type === 'job-complete' || msg?.type === 'job-failed') {
    handleJsonlBackfillJobDone(msg)
    return
  }
  const pw = msg?.watchId ? childWatchers.get(msg.watchId) : null
  if (msg?.type === 'warn') {
    log.warn(`${msg.warning || 'JSONL ingester warning'}${msg.jsonlPath ? ` for ${path.basename(msg.jsonlPath)}` : ''}`)
    return
  }
  if (!pw) return
  if (msg.type === 'started') return
  if (msg.type === 'start-failed') {
    if (!pw.stopped) {
      log.warn(`tail-file start failed for ${path.basename(pw.jsonlPath)}: ${msg.error || 'unknown error'}`)
      retireJsonlTail(pw, `start failed for ${path.basename(pw.jsonlPath)}`)
    }
    return
  }
  if (msg.type === 'error') {
    log.warn(`JSONL ingester error for ${path.basename(pw.jsonlPath)}: ${msg.error || 'unknown error'}`)
    retireJsonlTail(pw, `ingester error for ${path.basename(pw.jsonlPath)}`)
    return
  }
  if (msg.type === 'renamed' || msg.type === 'truncated') {
    const entry = cursors[pw.sessionId] || (cursors[pw.sessionId] = {})
    entry.offset = 0
    scheduleCursorSave()
    refreshIngestionCaughtUp()
    return
  }
  if (msg.type === 'batch') {
    pw.pendingDeliveries += 1
    const delivered = processJsonlChildOutputs(pw, msg.outputs || [])
    pw.pendingDeliveries -= 1
    pw.lastDeliveryOk = delivered
    try {
      _jsonlIngester?.send?.({ type: 'ack', watchId: pw.watchId, seq: msg.seq, ok: delivered })
    } catch (e) {
      // Child IPC failed; retire this watcher so a later sync can recreate it.
      log.warn(`JSONL ingester ack failed for ${path.basename(pw.jsonlPath)}: ${e?.message || e}`)
      retireJsonlTail(pw, `ack failed for ${path.basename(pw.jsonlPath)}`)
      return
    }
    if (!delivered) {
      retireJsonlTail(pw, `delivery failed for ${path.basename(pw.jsonlPath)}`)
      return
    }
    if (pw.pendingDeliveries === 0 && pw.pendingFlushOffset != null) {
      const offset = pw.pendingFlushOffset
      pw.pendingFlushOffset = null
      updateJsonlCursorFromTail(pw, offset)
    }
    return
  }
  if (msg.type === 'flush') {
    if (!pw.lastDeliveryOk) {
      log.warn(`not advancing cursor for ${path.basename(pw.jsonlPath)}; activity delivery failed`)
      return
    }
    if (pw.pendingDeliveries > 0) {
      pw.pendingFlushOffset = msg.offset
      return
    }
    updateJsonlCursorFromTail(pw, msg.offset)
  }
}

async function handleJsonlBackfillBatch(msg) {
  let delivered = true
  if (msg.entries?.length) {
    try {
      await sendMsgWithReply({ type: 'jsonl-index', entries: msg.entries })
    } catch (e) {
      log.warn(`JSONL backfill batch delivery failed for ${msg.jobId}: ${e?.message || e}`)
      delivered = false
    }
  }
  try {
    _jsonlIngester?.send?.({ type: 'job-ack', jobId: msg.jobId, seq: msg.seq, ok: delivered })
  } catch (e) {
    log.warn(`JSONL backfill job ack failed for ${msg.jobId}: ${e?.message || e}`)
    delivered = false
  }
  if (!delivered) {
    refreshIngestionCaughtUp()
  }
}

function handleJsonlBackfillSessionComplete(msg) {
  if (!msg.sessionId) return
  cursors[msg.sessionId] = { ...(cursors[msg.sessionId] || {}), searchBackfilled: true }
  scheduleCursorSave()
  refreshIngestionCaughtUp()
}

function handleJsonlBackfillJobDone(msg) {
  const job = searchBackfillJobs.get(msg.jobId)
  if (msg.type === 'job-complete') {
    searchBackfillJobs.delete(msg.jobId)
    if (job?.sessionId) searchBackfillPendingBySession.delete(job.sessionId)
    if (job?.kind === 'prior') {
      priorSessionBackfillPending.delete(job.fleetId)
      priorSessionBackfillComplete.add(job.fleetId)
    }
    for (const identity of msg.result?.identities || []) recordSessionIdentity(identity, { save: false })
    if (job?.sessionId) {
      cursors[job.sessionId] = { ...(cursors[job.sessionId] || {}), searchBackfilled: true }
      scheduleCursorSave()
    }
    saveSessionIdentityStoreNow()
    log.info(`JSONL ${job?.kind || 'backfill'} job complete: ${msg.jobId}`)
  } else {
    log.warn(`JSONL ${job?.kind || 'backfill'} job failed: ${msg.jobId}: ${msg.error || 'unknown error'}`)
    if (job && (job.attempts || 0) < 3 && !_shuttingDown) {
      setTimeout(() => {
        if (searchBackfillJobs.has(msg.jobId)) {
          startJsonlBackfillJob({
            ...job,
            ...(job.kind === 'prior' ? { cursors } : {}),
          })
        }
      }, 1000)
    } else {
      searchBackfillJobs.delete(msg.jobId)
      if (job?.sessionId) searchBackfillPendingBySession.delete(job.sessionId)
      if (job?.kind === 'prior') priorSessionBackfillPending.delete(job.fleetId)
    }
  }
  refreshIngestionCaughtUp()
}

function processJsonlChildOutputs(pw, outputs) {
  if (!_rws?.connected) return false
  const agentId = pw.primaryAgentId
  let delivered = true
  for (const output of outputs) {
    if (output.type === 'activity') {
      const activity = output.events || []
      if (activity.length > 0) {
        log.info(`activity extracted for ${agentId}: ${activity.length} event(s) from ${path.basename(pw.jsonlPath)}`)
        if (bufferActivity(agentId, activity) === false) delivered = false
      }
    } else if (output.type === 'context') {
      if (!sendMsg({
        type: 'agent-context',
        agentId,
        contextPercent: output.contextPercent,
        inputTokens: output.inputTokens,
      })) delivered = false
    } else if (output.type === 'qualification') {
      processQualificationEvent(agentId, output.event)
    } else if (output.type === 'terminalChat') {
      if (!sendMsg({
        type: 'terminal-chat',
        agent_id: agentId,
        from: `fleet:${os.userInfo?.()?.username || 'user'}`,
        text: output.text,
        ts: output.ts,
        session_id: pw.sessionId,
      })) delivered = false
    } else if (output.type === 'searchIndex') {
      if (!sendMsg({ type: 'jsonl-index', entries: output.entries || [] })) delivered = false
    } else if (output.type === 'nativeTask') {
      if (!sendMsg({
        type: 'native-task-event',
        agent_id: agentId,
        harness: pw.harnessKind,
        session_id: pw.sessionId,
        source_path: pw.jsonlPath,
        events: output.events || [],
      })) delivered = false
    } else if (output.type === 'identity') {
      recordSessionIdentity(tailSessionIdentityInput({
        sessionId: pw.sessionId,
        harnessKind: pw.harnessKind,
        jsonlPath: pw.jsonlPath,
        ownerFleetId: agentId,
        contentIdentity: output.identity,
      }))
    }
  }
  return delivered
}

function retireJsonlTail(pw, reason) {
  if (!pw) return
  if (pathWatchers.get(pw.jsonlPath) === pw) {
    pathWatchers.delete(pw.jsonlPath)
    releaseJsonlDirWatcher(pw.jsonlPath)
    for (const [aid, watchedPath] of agentPaths) {
      if (watchedPath === pw.jsonlPath) agentPaths.delete(aid)
    }
  }
  stopJsonlTail(pw, reason)
}

function stopJsonlTail(pw, reason = 'stop') {
  if (!pw || pw.stopped) return
  pw.stopped = true
  childWatchers.delete(pw.watchId)
  try { _jsonlIngester?.send?.({ type: 'stop', watchId: pw.watchId, reason }) } catch (e) {
    log.warn(`JSONL ingester stop failed (${reason}): ${e?.message || e}`)
  }
  refreshIngestionCaughtUp()
}

function updateJsonlCursorFromTail(pw, offset) {
  const entry = cursors[pw.sessionId] || (cursors[pw.sessionId] = {})
  if (entry.offset === offset && entry.inode) return
  try {
    const stat = fs.statSync(pw.jsonlPath)
    entry.inode = stat.ino
  } catch (e) {
    // Metadata is advisory; offset persistence is still needed if the file vanished mid-flush.
    log.warn(`could not stat tailed JSONL ${path.basename(pw.jsonlPath)}: ${e?.message || e}`)
  }
  entry.offset = offset
  pw.lastSavedOffset = offset
  scheduleCursorSave()
  refreshIngestionCaughtUp()
}

function processParsedJsonlRecord(pw, record) {
  if (!_rws?.connected) return false
  const harness = HARNESS_ADAPTERS[pw.harnessKind]?.activity
  if (!harness) {
    log.error(`processParsedJsonlRecord: unknown harness kind ${pw.harnessKind}`)
    return true
  }
  const agentId = pw.primaryAgentId
  let delivered = true
  const ev = harness.parseRecord ? harness.parseRecord(record) : null
  if (ev) {
    const activity = extractActivityEvents([ev])
    if (activity.length > 0) {
      log.info(`activity extracted for ${agentId}: ${activity.length} event(s) from ${path.basename(pw.jsonlPath)}`)
      if (bufferActivity(agentId, activity) === false) delivered = false
    }
    if (ev.usage) {
      const MAX_CONTEXT = 200_000
      const used = ev.usage.input
      const pct = Math.max(0, Math.round((1 - used / MAX_CONTEXT) * 100))
      if (!sendMsg({ type: 'agent-context', agentId, contextPercent: pct, inputTokens: used })) delivered = false
    }
    processQualificationEvent(agentId, ev)
  }

  if (harness.terminalChat && !sendTerminalChatFromRecord(agentId, pw.sessionId, record)) delivered = false
  if (harness.backfillSearch && !sendSearchIndexFromRecord(agentId, pw.sessionId, record)) delivered = false
  return delivered
}

function processQualificationEvent(agentId, ev) {
  if (!ev.blocks) return
  for (const block of ev.blocks) {
    if (block.type !== 'tool_use') continue
    const input = block.input || {}
    const filePath = input.file_path || input.path || ''
    if (block.name === 'Read' && filePath) trackRead(agentId, filePath)
    if (block.name === 'Skill' && input.skill) trackRead(agentId, 'skill:' + input.skill)
    if (block.name === 'Bash' && input.command) trackPartialSkillReads(agentId, input.command)
    if ((block.name === 'Edit' || block.name === 'Write' || block.name === 'MultiEdit') && filePath) {
      checkQualification(agentId, block.name, filePath)
      recordEdit(agentId, filePath)
    }
  }
}

function sendTerminalChatFromRecord(agentId, sessionId, parsed) {
  if (parsed.type !== 'user') return true
  if (parsed.isMeta) return true
  const content = parsed.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) text = content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
  if (!text || text.length < 3) return true
  if (text.length > 2000) text = text.substring(0, 2000)
  if (text.startsWith('<task-notification') || text.startsWith('<system-reminder') ||
      text.startsWith('<channel') || text.startsWith('📬') ||
      /^Call register\([^)]*\) with the fleet MCP server\b/.test(text)) return true
  const ts = parsed.timestamp || null
  if (!ts) return true
  return sendMsg({
    type: 'terminal-chat',
    agent_id: agentId,
    from: `fleet:${os.userInfo?.()?.username || 'user'}`,
    text,
    ts,
    session_id: sessionId,
  })
}

function sendSearchIndexFromRecord(agentId, sessionId, parsed) {
  if (parsed.type !== 'user' && parsed.type !== 'assistant') return true
  const ts = parsed.timestamp || parsed.message?.timestamp || parsed.snapshot?.timestamp || null
  if (!ts) return true
  const content = parsed.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) text = content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
  if (!text || text.length < 3) return true
  return sendMsg({ type: 'jsonl-index', entries: [{ agent_id: agentId, session_id: sessionId, role: parsed.type, timestamp: ts, text }] })
}

function startJsonlBackfillJob(job) {
  const child = startJsonlIngester()
  const nextJob = { ...job, attempts: (job.attempts || 0) + 1 }
  searchBackfillJobs.set(nextJob.jobId, nextJob)
  child.send?.({ type: 'job', ...nextJob })
  refreshIngestionCaughtUp()
}

// One-time backfill of a JSONL's full content to the search index.
// Called when the daemon first starts watching a new session. The child does the
// file IO/parsing; main only delivers batches and marks searchBackfilled after
// the child reports completion.
function backfillSearchEntries(agentId, jsonlPath, sessionId, harnessKind = null) {
  if (cursors[sessionId]?.searchBackfilled) return
  if (searchBackfillPendingBySession.has(sessionId)) return
  searchBackfillPendingBySession.add(sessionId)
  const jobId = `search:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  startJsonlBackfillJob({
    jobId,
    kind: 'search',
    jobKind: 'search',
    agentId,
    jsonlPath,
    sessionId,
    harnessKind,
  })
}

// Find + search-index this agent's prior sessions. Consults the session-owner
// cache: a session already classified (owners known) is answered with ZERO I/O —
// if it isn't this agent's, we skip it cold. The bug this fixes: the old code
// only marked the agent's OWN files, so every *non-owned* file was byte-scanned
// again on every single spawn (O(files × spawns)). Now each file is classified
// once (chunked owner-scan, no JSON.parse), cached, and never re-read to answer a
// different agent. The niced child harvester pre-populates this cache in the
// background so even the first classification is off the daemon's main loop.
function backfillAllPriorSessions(agentId, fleetId) {
  if (priorSessionBackfillComplete.has(fleetId)) return
  if (priorSessionBackfillPending.has(fleetId)) return
  priorSessionBackfillPending.add(fleetId)
  const jobId = `prior:${fleetId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  startJsonlBackfillJob({
    jobId,
    kind: 'prior',
    jobKind: 'prior',
    agentId,
    fleetId,
    projectsDir: PROJECTS_DIR,
    cursors,
  })
}

// ---------- source watching ----------

// Source files we care about for tlda projects. Kept in sync with
// cli/lib/source-files.mjs's allowlist (extensions only — the cli
// helper does more, but the daemon stays standalone).
const SOURCE_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.md', '.qmd', '.html', '.css', '.js', '.svg', '.png', '.jpg', '.jpeg', '.pdf', '.json', '.yml', '.yaml'])
const JUNK_PATTERNS = [/^\.#/, /\.swp$/, /~$/, /\.tmp$/, /\.lock$/]

// Bootstrap input scanner — regex-scan .tex files for \input-like commands
// to discover dependencies before the first successful build produces a .fls.
const DEFAULT_INPUT_COMMANDS = ['input', 'include', 'inputscratch', 'addbibresource', 'bibliography', 'usepackage']

function scanTexInputs(sourceDir, mainFile, extraCommands = []) {
  const commands = [...DEFAULT_INPUT_COMMANDS, ...extraCommands]
  const pattern = new RegExp(`\\\\(?:${commands.join('|')})\\{([^}]+)\\}`, 'g')
  const seen = new Set()
  const result = new Set()

  function scan(relPath) {
    if (seen.has(relPath)) return
    seen.add(relPath)
    const full = path.join(sourceDir, relPath)
    if (!fs.existsSync(full)) return
    let stat
    try { stat = fs.statSync(full) } catch { return }
    if (!stat.isFile()) return
    result.add(relPath)

    const ext = path.extname(relPath).toLowerCase()
    if (ext !== '.tex' && ext !== '.sty' && ext !== '.cls') return

    let content
    try { content = fs.readFileSync(full, 'utf8') } catch { return }
    for (const m of content.matchAll(pattern)) {
      const raw = m[1].trim()
      if (!raw) continue
      const cmd = m[0].split('{')[0]
      // \usepackage and \bibliography accept comma-separated lists
      const refs = (cmd === '\\usepackage' || cmd === '\\bibliography')
        ? raw.split(',').map(s => s.trim()).filter(Boolean)
        : [raw]
      for (let ref of refs) {
        if (cmd === '\\usepackage') {
          if (!ref.endsWith('.sty')) ref += '.sty'
        } else if (cmd === '\\bibliography' || cmd === '\\addbibresource') {
          if (!ref.endsWith('.bib')) ref += '.bib'
        } else if (!path.extname(ref)) {
          ref += '.tex'
        }
        const dir = path.dirname(relPath)
        const resolved = path.normalize(path.join(dir, ref))
        if (resolved.startsWith('..')) continue
        scan(resolved)
        if (cmd === '\\inputscratch' && resolved.endsWith('.tex')) {
          const mdCompanion = resolved.replace(/\.tex$/, '.md')
          if (fs.existsSync(path.join(sourceDir, mdCompanion))) result.add(mdCompanion)
        }
      }
    }
  }

  scan(mainFile)
  return result
}

// A markdown doc is NOT a single file — it's the main .md PLUS the images it
// references. This is the markdown analog of scanTexInputs: returns a Set of
// sourceDir-relative paths (main + referenced images that live under sourceDir),
// computed locally on the agent's machine via the shared scanner. Mirrors the
// server's ref-scan in build-markdown.mjs.
function scanMarkdownInputs(sourceDir, mainFile) {
  const result = new Set([mainFile])
  const full = path.join(sourceDir, mainFile)
  let content
  try { content = fs.readFileSync(full, 'utf8') } catch { return result }
  for (const { abs } of scanMarkdownDeps(content, path.dirname(full))) {
    if (!abs) continue
    const rel = path.relative(sourceDir, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    result.add(rel)
  }
  return result
}

// A markdown doc bundles only its dependency graph (main + images), never the
// rest of sourceDir — so the "any source file always passes" escape hatch must
// not apply to it.
function isMarkdownDoc(format, mainFile) {
  return format === 'markdown' || (mainFile?.toLowerCase().endsWith('.md') ?? false)
}

function isSourceFile(name) {
  if (JUNK_PATTERNS.some(r => r.test(name))) return false
  if (name.includes('node_modules') || name.includes('.git/')) return false
  const ext = path.extname(name).toLowerCase()
  return SOURCE_EXTS.has(ext)
}

function readFileForUpload(fullPath) {
  const data = fs.readFileSync(fullPath)
  // Heuristic: text-y if mostly ASCII; otherwise base64.
  const ext = path.extname(fullPath).toLowerCase()
  const TEXT_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.md', '.qmd', '.html', '.css', '.js', '.svg', '.json', '.yml', '.yaml'])
  if (TEXT_EXTS.has(ext)) return { content: data.toString('utf8') }
  return { content: data.toString('base64'), encoding: 'base64' }
}

function sourceRel(sourceDir, filePath) {
  if (!filePath) return null
  const abs = path.isAbsolute(String(filePath)) ? String(filePath) : path.join(sourceDir, String(filePath))
  const rel = path.relative(sourceDir, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

function closeWatcher(watcher, label) {
  if (!watcher) return
  try {
    const closed = watcher.close()
    if (closed?.catch) closed.catch(e => log.warn(`chokidar close failed for ${label}: ${e?.message || e}`))
  } catch (e) {
    log.warn(`chokidar close threw for ${label}: ${e?.message || e}`)
  }
}

function shouldIgnoreSourceWatchPath(sourceDir, filePath, stats) {
  const rel = sourceRel(sourceDir, filePath)
  if (!rel) return false
  const parts = rel.split('/')
  if (parts.includes('node_modules') || parts.includes('.git')) return true
  if (!stats) return false
  if (stats?.isDirectory?.()) return false
  return !isSourceFile(rel) && !rel.includes('.tlda/scratch/')
}

function sourceWatcherPaths(state) {
  const rels = new Set(state.watchSet || [])
  if (state.mainFile) rels.add(state.mainFile)
  const paths = []
  for (const rel of rels) {
    if (!rel || typeof rel !== 'string') continue
    const normalized = rel.split(/[\\/]+/).filter(Boolean).join(path.sep)
    if (!normalized) continue
    const full = path.join(state.sourceDir, normalized)
    paths.push(full)
  }
  paths.sort()
  return paths
}

function sourceWatcherKey(state) {
  return sourceWatcherPaths(state).join('\0')
}

function startSourceWatcher(state, reason = 'start') {
  closeWatcher(state.watcher, state.projectName)
  const watchPaths = sourceWatcherPaths(state)
  state.watcherKey = watchPaths.join('\0')
  if (watchPaths.length === 0) {
    state.watcher = null
    log.warn(`source watcher disabled for ${state.projectName}: no bounded source files to watch`)
    return
  }
  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    followSymlinks: true,
    ignored: (filePath, stats) => shouldIgnoreSourceWatchPath(state.sourceDir, filePath, stats),
  })
  state.watcher = watcher
  const handle = (filePath) => {
    if (state.watcher !== watcher) return
    const rel = sourceRel(state.sourceDir, filePath)
    if (rel) state.onFileChange(rel)
  }
  watcher
    .on('add', handle)
    .on('change', handle)
    .on('unlink', handle)
    .on('error', e => {
      if (state.watcher !== watcher) return
      log.warn(`chokidar source watcher failed for ${state.projectName}: ${e?.message || e}`)
      state.watcher = null
      closeWatcher(watcher, state.projectName)
      setTimeout(() => {
        if (sourceWatchers.get(state.projectName) === state && !state.watcher) startSourceWatcher(state, 'retry')
      }, 1000).unref?.()
    })
  log.info(`chokidar source watcher started for ${state.projectName} (${reason}, ${watchPaths.length} paths)`)
}

function closeSourceState(state) {
  closeWatcher(state.watcher, state.projectName)
  state.watcher = null
  if (state._symlinkWatchers) {
    for (const [target, watcher] of state._symlinkWatchers) closeWatcher(watcher, `symlink target ${target}`)
    state._symlinkWatchers.clear()
  }
}

function syncSourceWatchers(projectList) {
  const activeNames = new Set()
  const bindings = loadSourceBindings()
  for (const p of projectList) {
    // Per-machine binding wins over the server-provided sourceDir (the host's
    // path). No binding → fall back to the server's sourceDir (single-host case).
    const sourceDir = bindings[p.name] || p.sourceDir
    if (!sourceDir) continue
    if (!fs.existsSync(sourceDir)) continue
    activeNames.add(p.name)

    const isMarkdown = isMarkdownDoc(p.format, p.mainFile)
    const hasFlsWatchList = p.watchFiles?.length > 0
    // Bootstrap watchSet (no .fls yet) must include the main's \input deps, not
    // just the main, so the initial connect push contains dependencies before
    // the first build produces a .fls.
    const watchSet = new Set(
      hasFlsWatchList ? p.watchFiles
        : isMarkdown && p.mainFile ? scanMarkdownInputs(sourceDir, p.mainFile)
        : p.mainFile ? scanTexInputs(sourceDir, p.mainFile, p.extraInputCommands || []) : []
    )

    if (sourceWatchers.has(p.name)) {
      const existing = sourceWatchers.get(p.name)
      if (existing.sourceDir !== sourceDir) {
        closeSourceState(existing)
        sourceWatchers.delete(p.name)
      } else {
        existing.watchSet = watchSet
        existing.mainFile = p.mainFile
        existing.extraInputCommands = p.extraInputCommands || []
        existing.isMarkdown = isMarkdown
        const nextWatcherKey = sourceWatcherKey(existing)
        if (!existing.watcher || existing.watcherKey !== nextWatcherKey) startSourceWatcher(existing, 'resync')
        continue
      }
    }

    const state = { sourceDir, debounce: null, pending: new Set(), watchSet, onFileChange: null, projectName: p.name, mainFile: p.mainFile, extraInputCommands: p.extraInputCommands || [], isMarkdown, watcher: null, watcherKey: '', _symlinkWatchers: new Map() }

    const onFileChange = (filename) => {
      if (!filename) return
      if (state.isMarkdown) {
        // A markdown doc bundles exactly its dependency graph (main + referenced
        // images). Enforce the watchSet strictly — do NOT let arbitrary source
        // files in sourceDir through, or the doc eats the whole dir's churn.
        // Newly-referenced images are discovered by rescanning when the main .md
        // changes (see flushSourceChanges), not via the escape hatch below.
        if (!state.watchSet.has(filename)) return
      } else {
        const isScratch = filename.includes('.tlda/scratch/')
        if (!isScratch) {
          // Source files (.tex, .bib, .sty, etc.) always pass - even if not in the watchSet.
          // The watchSet comes from the PREVIOUS build's .fls; a newly-added \input dep
          // won't be in it yet, but we must still push it so the build can pick it up.
          // Non-source files (build artifacts, .aux, etc.) are filtered by watchSet when
          // available, or dropped entirely when the watchSet is empty (bootstrap mode).
          if (!isSourceFile(filename)) {
            if (state.watchSet.size > 0) {
              if (!state.watchSet.has(filename)) return
            } else {
              return
            }
          }
        }
      }
      state.pending.add(filename)
      if (state.debounce) clearTimeout(state.debounce)
      state.debounce = setTimeout(() => flushSourceChanges(state.projectName), 200)
    }
    state.onFileChange = onFileChange

    try {
      sourceWatchers.set(p.name, state)
      startSourceWatcher(state, 'project sync')
      log.info(`watching source ${p.name}: ${sourceDir}${bindings[p.name] ? ' (local binding)' : ''} (${watchSet.size} files${hasFlsWatchList ? '' : ', bootstrap'})`)
      pushWatchedFiles(p.name, sourceDir, watchSet, hasFlsWatchList ? null : p.mainFile, p.extraInputCommands, isMarkdown)
    } catch (e) {
      log.error(`source watcher failed for ${p.name}: ${e.message}`)
    }
  }
  for (const [name, state] of sourceWatchers) {
    if (!activeNames.has(name)) {
      closeSourceState(state)
      sourceWatchers.delete(name)
    }
  }
}

/**
 * Push source files to the server on connect.
 * When mainFile is set (no .fls yet), scan it recursively for \input-like
 * commands and push all discovered dependencies — the bootstrap path.
 * Otherwise push the .fls-derived watchSet.
 */
function pushWatchedFiles(projectName, sourceDir, watchSet, mainFile, extraInputCommands, isMarkdown) {
  const files = []
  if (mainFile) {
    // Bootstrap mode: no .fls yet. Scan the main file for its deps — \input-like
    // commands for tex, referenced images for markdown — and push main + deps.
    const deps = isMarkdown
      ? scanMarkdownInputs(sourceDir, mainFile)
      : scanTexInputs(sourceDir, mainFile, extraInputCommands || [])
    log.info(`bootstrap scan for ${projectName}: ${deps.size} files from ${mainFile}`)
    for (const rel of deps) {
      const full = path.join(sourceDir, rel)
      try { files.push({ path: rel, ...readFileForUpload(full) }) }
      catch (e) { log.error(`read ${full}: ${e.message}`) }
    }
  } else if (watchSet.size > 0) {
    for (const rel of watchSet) {
      const full = path.join(sourceDir, rel)
      if (!fs.existsSync(full)) continue
      try { files.push({ path: rel, ...readFileForUpload(full) }) }
      catch (e) { log.error(`read ${full}: ${e.message}`) }
    }
  }
  if (files.length === 0) return
  log.info(`connect push: ${files.length} files for ${projectName}`)
  sendMsg({ type: 'source-change', project: projectName, files })
}

const _pendingSourceProjects = new Set()

function flushSourceChanges(projectName) {
  const state = sourceWatchers.get(projectName)
  if (!state) return
  state.debounce = null

  if (!_rws?.connected) {
    _pendingSourceProjects.add(projectName)
    return
  }

  const filePaths = [...state.pending]
  state.pending.clear()
  _pendingSourceProjects.delete(projectName)

  const files = []
  const deleted = []
  for (const rel of filePaths) {
    const full = path.join(state.sourceDir, rel)
    if (!fs.existsSync(full)) { deleted.push(rel); continue }
    // Resolve symlinks so the server stores files at their canonical path.
    // Fixes the case where .tlda/scratch/ is a directory symlink (e.g. pointing
    // to revision/.tlda/scratch/) — without this the daemon pushes
    // .tlda/scratch/file.tex but the build expects revision/.tlda/scratch/file.tex.
    let pushPath = rel
    try {
      const realFull = fs.realpathSync(full)
      if (realFull !== full) {
        const canonical = path.relative(state.sourceDir, realFull)
        if (!canonical.startsWith('..')) {
          pushPath = canonical
          if (canonical !== rel) log.info(`resolved symlink: ${rel} → ${canonical}`)
        }
      }
    } catch {}
    try { files.push({ path: pushPath, ...readFileForUpload(full) }) }
    catch (e) { log.error(`read ${full}: ${e.message}`) }
  }

  // When a .tex file changes, rescan for new \input deps not yet on the server.
  // This catches newly-added \input{} or \inputscratch{} lines before the build
  // fails with "file not found".
  const changedTexFiles = filePaths.filter(f => f.endsWith('.tex'))
  if (changedTexFiles.length > 0 && state.mainFile) {
    const alreadyPushed = new Set(filePaths)
    const deps = scanTexInputs(state.sourceDir, state.mainFile, state.extraInputCommands)
    for (const rel of deps) {
      if (alreadyPushed.has(rel) || state.watchSet.has(rel)) continue
      const full = path.join(state.sourceDir, rel)
      if (!fs.existsSync(full)) continue
      state.watchSet.add(rel)
      try {
        files.push({ path: rel, ...readFileForUpload(full) })
        log.info(`rescan discovered new dep: ${rel}`)
      } catch (e) { log.error(`read ${full}: ${e.message}`) }
    }
  }

  // When the main .md of a markdown doc changes, rescan its image refs. A newly-
  // referenced image must be pushed now (the build will otherwise 404 it) and
  // added to the watchSet so later edits to it pass the strict filter.
  if (state.isMarkdown && state.mainFile && filePaths.includes(state.mainFile)) {
    const alreadyPushed = new Set(filePaths)
    const deps = scanMarkdownInputs(state.sourceDir, state.mainFile)
    for (const rel of deps) {
      if (!state.watchSet.has(rel)) {
        state.watchSet.add(rel)
      }
      if (alreadyPushed.has(rel)) continue
      const full = path.join(state.sourceDir, rel)
      if (!fs.existsSync(full)) continue
      try {
        files.push({ path: rel, ...readFileForUpload(full) })
        log.info(`md rescan discovered dep: ${rel}`)
      } catch (e) { log.error(`read ${full}: ${e.message}`) }
    }
  }

  // Watch symlink targets in .tlda/scratch/ — changes to the linked file should
  // trigger a rebuild even when the target sits outside the source dir.
  for (const rel of filePaths) {
    if (!rel.includes('.tlda/scratch/')) continue
    const full = path.join(state.sourceDir, rel)
    try {
      const stat = fs.lstatSync(full)
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(full)
        if (!state._symlinkWatchers) state._symlinkWatchers = new Map()
        if (!state._symlinkWatchers.has(target)) {
          const watcher = chokidar.watch(target, { ignoreInitial: true, persistent: true, followSymlinks: true })
            .on('change', () => state.onFileChange(rel))
            .on('unlink', () => state.onFileChange(rel))
            .on('error', e => log.warn(`chokidar symlink target watcher failed for ${target}: ${e?.message || e}`))
          state._symlinkWatchers.set(target, watcher)
          log.info(`watching symlink target: ${target} -> ${rel}`)
        }
      }
    } catch {}
  }

  if (files.length === 0 && deleted.length === 0) return

  const nextWatcherKey = sourceWatcherKey(state)
  if (state.watcherKey !== nextWatcherKey) startSourceWatcher(state, 'dependency rescan')

  // Edit attribution: which agent's recent Edit/Write touched a changed file.
  const editedBy = resolveEditor(filePaths.map(rel => path.join(state.sourceDir, rel)))

  sendMsg({
    type: 'source-change',
    project: projectName,
    files,
    ...(deleted.length > 0 && { deletedFiles: deleted }),
    ...(editedBy && { editedBy }),
  })
}

function flushPendingSourceChanges() {
  for (const name of _pendingSourceProjects) {
    flushSourceChanges(name)
  }
}

// ---------- Backing file watchers ----------
// The server sends `watch-backing-files` for THIS daemon's owned project-local
// backing names only. The daemon resolves backingName against its local project
// source binding and never receives server-local absolute paths.

/** @type {Map<string, {watcher: import('fs').FSWatcher | null, project: string, backingName: string, docNames: string[], lastWriteAt: number}>} */
const backingWatchers = new Map()

function backingKey(project, backingName) {
  return `${project}\0${backingName}`
}

function resolveBackingFile(project, backingName) {
  if (!project) throw new Error('missing project')
  if (!backingName || path.isAbsolute(backingName) || backingName.includes('\0')) {
    throw new Error(`invalid backingName for ${project}`)
  }
  const sourceDir = sourceWatchers.get(project)?.sourceDir
  if (!sourceDir) throw new Error(`project ${project} is not watched on this daemon`)
  const full = path.resolve(sourceDir, backingName)
  const root = path.resolve(sourceDir)
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`backingName escapes project: ${backingName}`)
  }
  return full
}

function sendBackingStatus({ project, backingName, docNames, status, content, message }) {
  sendMsg({
    type: 'backing-file-status',
    project,
    backingName,
    docNames,
    status,
    ...(content !== undefined && { content }),
    ...(message && { message }),
  })
}

function syncBackingWatchers(files) {
  // files = [{project: string, backingName: string, docNames: string[]}]
  const incoming = new Map()
  for (const f of files) {
    if (!f?.project || !f?.backingName) continue
    incoming.set(backingKey(f.project, f.backingName), f)
  }

  // Close all existing watchers and rebuild from scratch.
  for (const [, entry] of backingWatchers) closeWatcher(entry.watcher, `${entry.project}:${entry.backingName}`)
  backingWatchers.clear()

  for (const [, file] of incoming) {
    const { project, backingName } = file
    const docNames = Array.isArray(file.docNames) ? file.docNames : []
    let fp
    try {
      fp = resolveBackingFile(project, backingName)
    } catch (e) {
      log.warn(`resolve backing file ${project}:${backingName}: ${e.message}`)
      sendBackingStatus({ project, backingName, docNames, status: 'owner-missing', message: e.message })
      continue
    }
    const key = backingKey(project, backingName)
    if (!fs.existsSync(fp)) {
      backingWatchers.set(key, { watcher: null, project, backingName, docNames, lastWriteAt: 0 })
      sendBackingStatus({ project, backingName, docNames, status: 'deleted' })
      log.warn(`backing file missing: ${project}:${backingName}`)
      continue
    }
    try {
      let debounce = null
      const handle = () => {
        const entry = backingWatchers.get(key)
        if (!entry) return
        if (Date.now() - entry.lastWriteAt < 2000) return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          try {
            const content = fs.readFileSync(fp, 'utf8')
            log.info(`backing file changed: ${project}:${backingName} (${content.length} bytes)`)
            sendBackingStatus({ project, backingName, docNames, status: 'synced', content })
          } catch (e) {
            const status = e?.code === 'ENOENT' ? 'deleted' : 'failed'
            log.warn(`read backing file ${project}:${backingName}: ${e.message}`)
            sendBackingStatus({ project, backingName, docNames, status, message: e.message })
          }
        }, 200)
      }
      const watcher = chokidar.watch(fp, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: true,
      })
        .on('add', handle)
        .on('change', handle)
        .on('unlink', handle)
        .on('error', e => {
          log.warn(`chokidar backing watcher failed for ${project}:${backingName}: ${e?.message || e}`)
          sendBackingStatus({ project, backingName, docNames, status: 'failed', message: e?.message || String(e) })
        })
      backingWatchers.set(key, { watcher, project, backingName, docNames, lastWriteAt: 0 })
      log.info(`chokidar backing watcher started for ${project}:${backingName}`)
    } catch (e) {
      log.warn(`watch backing file ${project}:${backingName}: ${e.message}`)
      sendBackingStatus({ project, backingName, docNames, status: 'failed', message: e.message })
    }
  }
  if (incoming.size > 0) log.info(`backing watchers: ${backingWatchers.size} active`)
}

async function rpcWriteBackingFile({ project, backingName, content, restore }) {
  const fp = resolveBackingFile(project, backingName)
  if (!restore && !fs.existsSync(fp)) {
    const err = new Error(`backing file deleted externally: ${project}:${backingName}`)
    err.status = 'deleted'
    throw err
  }
  // Record write time before writing to suppress the watcher echo
  const entry = backingWatchers.get(backingKey(project, backingName))
  if (entry) entry.lastWriteAt = Date.now()
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content ?? '', 'utf8')
  if (entry && !entry.watcher) {
    syncBackingWatchers([...backingWatchers.values()].map(w => ({
      project: w.project,
      backingName: w.backingName,
      docNames: w.docNames,
    })))
  }
  return { ok: true, status: 'synced' }
}

async function gitRetryOnLock(fn, retries = 3, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try { return await fn() } catch (e) {
      if (i < retries - 1 && /index\.lock|Unable to create.*lock|cannot lock ref|unable to update local ref/i.test(e.message || '')) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
        continue
      }
      throw e
    }
  }
}

async function rpcMirrorShadowRef({ project, hash, bundleBase64 }) {
  if (!project) throw new Error('missing project')
  if (!/^[0-9a-f]{40}$/i.test(String(hash || ''))) throw new Error(`invalid shadow hash: ${hash}`)
  if (!bundleBase64) throw new Error('missing shadow bundle')

  const state = sourceWatchers.get(project)
  const sourceDir = state?.sourceDir
  if (!sourceDir) throw new Error(`project ${project} is not watched on this daemon`)

  try {
    await execFileP('git', ['rev-parse', '--git-dir'], { cwd: sourceDir, timeout: 5000 })
  } catch {
    throw new Error(`sourceDir is not a git repo: ${sourceDir}`)
  }

  const hash7 = hash.slice(0, 7)
  const bundlePath = path.join(os.tmpdir(), `tlda-shadow-${project}-${hash7}-${Date.now()}.bundle`)
  try {
    fs.writeFileSync(bundlePath, Buffer.from(bundleBase64, 'base64'))
    await execFileP('git', ['bundle', 'verify', bundlePath], { cwd: sourceDir, timeout: 10000 })
    await gitRetryOnLock(() => execFileP('git', ['fetch', bundlePath, `+${hash}:refs/tags/shadow/${hash7}`], { cwd: sourceDir, timeout: 30000 }))
    await execFileP('git', ['cat-file', '-e', `${hash}^{commit}`], { cwd: sourceDir, timeout: 5000 })
    await gitRetryOnLock(() => execFileP('git', ['update-ref', 'refs/tlda/shadow/HEAD', hash], { cwd: sourceDir, timeout: 5000 }))
    log.info(`mirrored ${project}@${hash7} into ${sourceDir}`)
    return { ok: true, project, hash, sourceDir, tag: `shadow/${hash7}` }
  } finally {
    try { fs.rmSync(bundlePath, { force: true }) }
    catch (e) { log.warn(`failed to remove temporary shadow bundle ${bundlePath}: ${e.message}`) }
  }
}

// ---------- RPC handlers (server → daemon) ----------
//
// Each handler receives the params object from the inbound `rpc`
// message and returns a value (resolved into `result`) or throws (turned
// into `error`). The dispatcher in handleServerMessage takes care of
// sending `rpc-reply`.
//
// All tmux interaction goes through `execFile('tmux', [args])` (never a shell),
// so shell metacharacters need no escaping — a name like `fleet-leverage?` is
// safe to pass verbatim. The only chars that genuinely break tmux are its target
// separators (`:` for session:window) plus whitespace/control, so reject only
// those and tolerate everything else. The old allowlist `[a-zA-Z0-9_.\-]` wrongly
// rejected expressive agent names like `leverage?`, wedging auto-hibernate in a
// retry loop. New spawns are sanitized at the source; this keeps
// the daemon tolerant of legacy sessions that already carry punctuation.
const SAFE_SESSION_RE = /^[^\s:\x00-\x1f]+$/

function checkSession(session) {
  if (!session || !SAFE_SESSION_RE.test(session)) {
    throw new Error(`unsafe tmux session name: ${session}`)
  }
}

async function tmux(...args) {
  return execFileP('tmux', [...TMUX_ARGS, ...args], {
    timeout: 5000,
    encoding: 'utf8',
    env: { ...process.env, TMUX: '', TMUX_PANE: '' },
  })
}

async function rpcSendKey({ tmux_session, key }) {
  checkSession(tmux_session)
  if (!key) throw new Error('missing key')
  armBySession(tmux_session)   // delivering a keystroke (e.g. submit) → arm
  // Translate `ctrl+x` → `C-x` for tmux's send-keys grammar; everything
  // else passes through as-is (Enter, Escape, etc.).
  const tmuxKey = key.replace(/^ctrl\+(.)/i, (_, c) => `C-${c}`)
  await tmux('send-keys', '-t', tmux_session, tmuxKey)
  return { ok: true }
}

async function rpcSendText({ tmux_session, text, enter, enter_delay_ms }) {
  checkSession(tmux_session)
  armBySession(tmux_session)   // delivering input/wake-bootstrap → arm the status machine
  // Prefer the existing long-lived PTY watcher when a terminal card is open.
  // Do not create on-demand "ephemeral" PTYs here: node-pty's macOS spawn path
  // can throw after opening native PTY fds and before returning a JS handle, so
  // the daemon cannot close that handle. tmux send-keys is the bounded fallback.
  const pty = terminalWatchPtys.get(tmux_session)?.alive
    ? terminalWatchPtys.get(tmux_session).pty
    : null
  if (pty) {
    if (text) pty.write(text)
    if (enter !== false) {
      const delay = Number(enter_delay_ms ?? 120)
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      await tmux('send-keys', '-t', tmux_session, 'Enter')
    }
    return { ok: true, via: 'pty' }
  }
  if (text) await tmux('send-keys', '-t', tmux_session, '--', text)
  if (enter !== false) {
    const delay = Number(enter_delay_ms ?? 120)
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
    await tmux('send-keys', '-t', tmux_session, 'Enter')
  }
  return { ok: true, via: 'tmux' }
}

// Deliver a turn-end kick to a goose agent's TUI. rpcSendText prefers the PTY,
// but goose reads a bare PTY `\r` as a literal newline-in-field ("Ctrl+J
// newline"), NOT submit ("Enter to send") — so a kick written that way lands in
// the input un-submitted and the agent just sits there (observed on ds-v4b
// 2026-06-13). tmux's discrete `Enter` key IS submitted (it's how the MCP chat
// delivery reaches goose), so the kick uses send-keys text + a short gap +
// Enter. Same reliable path, no PTY.
async function gooseKickSend({ tmux_session, text }) {
  checkSession(tmux_session)
  if (text) await tmux('send-keys', '-t', tmux_session, '--', text)
  await new Promise(r => setTimeout(r, 300))
  await tmux('send-keys', '-t', tmux_session, 'Enter')
  return { ok: true, via: 'tmux-sendkeys' }
}

async function rpcCapturePane({ tmux_session, lines, agent_id, visible }) {
  checkSession(tmux_session)
  const captureArgs = visible
    ? terminalVisibleCaptureArgs(tmux_session, { ansi: true })
    : terminalBackscrollCaptureArgs(tmux_session, lines, { ansi: true })
  const { stdout } = await execFileP('tmux',
    [...TMUX_ARGS, ...captureArgs],
    { timeout: 5000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const prompt = detectPrompt(stdout)
  if (prompt.type === 'auto-accept') {
    const lastAction = promptCooldowns.get(tmux_session)
    if (!lastAction || Date.now() - lastAction >= 10_000) {
      promptCooldowns.set(tmux_session, Date.now())
      autoAcceptPrompt(tmux_session, prompt.reason, prompt.acceptKey)
      if (agent_id) sendMsg({ type: 'prompt-auto-accepted', agent_id, reason: prompt.reason, ts: new Date().toISOString() })
    }
  } else if (prompt.type === 'surface' && agent_id) {
    if (surfacedPrompts.get(tmux_session) !== prompt.reason) {
      surfacedPrompts.set(tmux_session, prompt.reason)
      sendMsg({ type: 'terminal_attention', agent_id, tmux_session, text: prompt.reason, reason: prompt.reason, snippet: prompt.snippet || null })
    }
  } else {
    surfacedPrompts.delete(tmux_session)
  }
  return { ok: true, pane: stdout }
}

async function capturePaneTail(tmux_session, lines = 50) {
  const cap = await execFileP('tmux',
    [...TMUX_ARGS, ...terminalBackscrollCaptureArgs(tmux_session, lines)],
    { timeout: 3000, encoding: 'utf8' })
  return cap.stdout
}

// True while Claude Code is mid-turn: it shows a "…ing" spinner and/or the
// "esc to interrupt" hint. Both vanish the moment the agent goes idle. Same
// signal the liveness sweep trusts (THINKING_SPINNER_RE / INTERRUPT_HINT_RE).
function paneIsWorking(pane) {
  const tail = pane.split('\n').slice(-THINKING_SCAN_LINES).join('\n')
  return THINKING_SPINNER_RE.test(tail) || INTERRUPT_HINT_RE.test(tail)
}

async function rpcInterrupt({ tmux_session, agent_id }) {
  checkSession(tmux_session)
  // Hard interrupt. A SINGLE Escape stops a working agent (verified directly).
  // The critical invariant: never send a second Escape once the agent is idle —
  // two gapped escapes on an idle Claude Code open the Rewind menu. So send one
  // Escape, then poll; the instant the working indicators are gone, STOP. Only
  // re-send a single Escape while the agent is still visibly working.
  //
  // (The old code sent `Escape Escape` and retried that pair every 2.5s × 5.
  // The first pair stopped the agent; every later pair landed on an idle agent
  // with a gap → Rewind menu + a pile of spurious interrupt cards.)
  //
  // We AWAIT confirmation and return `stopped` so the server can render the
  // interrupt card only when the agent actually halted. A soft-promote also
  // writes "[Request interrupted by user]" to the pane but the agent resumes —
  // so "did it stop?" is the only signal that distinguishes a real hard
  // interrupt (card) from a soft promote (no card).
  try { await tmux('send-keys', '-t', tmux_session, 'Escape') } catch {}
  let stopped = false
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 1200))
    let pane = ''
    try { pane = await capturePaneTail(tmux_session) } catch {}
    if (!paneIsWorking(pane)) { stopped = true; break }  // idle — do NOT send another escape
    try { await tmux('send-keys', '-t', tmux_session, 'Escape') } catch {}
  }
  return { ok: true, stopped }
}

// Soft interrupt: promote a QUEUED channel message without stopping the agent's
// work. A single Escape does this — but ONLY when there's something queued. With
// nothing queued, that same Escape hard-interrupts, which is exactly what soft
// must never do.
//
// Anchor on the INPUT BOX (`❯`), not the spinner: the spinner word (`…ing`) only
// shows during the *thinking* phase — while the agent is streaming output there
// is no spinner line, just the "esc to interrupt" hint. The input prompt is the
// one landmark present in every phase. A pending queued message renders as a
// `← …` line sitting a couple of lines above the input box. Once promoted, the
// agent picks it up and new content appears below it, so it's no longer adjacent
// to the box — that's how we confirm.
const QUEUED_LINE_RE = /^\s*←\s/
// Index of a PENDING `← …` queued marker, or -1. The rule (Skip's): a queued
// marker is one that sits ANYWHERE BELOW the spinner. The message the agent is
// already answering has its `←` marker ABOVE the spinner (its output/spinner
// renders below it), so it's excluded automatically — only genuinely-queued
// messages, which land below the current activity line, count. Robust to todo
// lists / status panels, since we only ever match `←` markers. No spinner line
// (idle, or pure text streaming) → nothing to be "below" → no pending queue,
// which fails safe: soft never fires an escape it can't justify.
function pendingQueuedIdx(lines) {
  let s = -1
  for (let i = lines.length - 1; i >= 0; i--) { if (THINKING_SPINNER_RE.test(lines[i])) { s = i; break } }
  if (s < 0) return -1
  for (let i = s + 1; i < lines.length; i++) if (QUEUED_LINE_RE.test(lines[i])) return i
  return -1
}
async function rpcSoftInterrupt({ tmux_session, agent_id }) {
  checkSession(tmux_session)
  if (agent_id) armAgent(agent_id); else armBySession(tmux_session)   // promoting a queued message → arm
  let pane = ''
  try { pane = await capturePaneTail(tmux_session) } catch {}
  let lines = pane.split('\n').slice(-THINKING_SCAN_LINES)
  // Only fire when the agent is working AND a queued message is pending just
  // above the input box. Otherwise the escape would hard-interrupt — no-op.
  if (!paneIsWorking(pane) || pendingQueuedIdx(lines) < 0) {
    return { ok: true, promoted: false, reason: 'nothing-queued' }
  }
  try { await tmux('send-keys', '-t', tmux_session, 'Escape') } catch {}
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 700))
    try { pane = await capturePaneTail(tmux_session) } catch {}
    lines = pane.split('\n').slice(-THINKING_SCAN_LINES)
    // Promoted = the queued line is no longer pending just above the input box
    // (the agent consumed it; new content/turn now sits below it).
    if (pendingQueuedIdx(lines) < 0) return { ok: true, promoted: true }
  }
  return { ok: true, promoted: false, reason: 'timeout' }
}

async function rpcListSessions() {
  try {
    const { stdout } = await execFileP('tmux',
      [...TMUX_ARGS, 'list-sessions', '-F', '#{session_name}'],
      { timeout: 3000, encoding: 'utf8' })
    return { ok: true, sessions: stdout.trim().split('\n').filter(Boolean) }
  } catch (e) {
    // tmux exits non-zero with no sessions; treat as empty list, not error.
    if (/no server running|no sessions/i.test(e.stderr || '')) return { ok: true, sessions: [] }
    throw e
  }
}

async function rpcCheckAlive({ tmux_session }) {
  // Liveness for the WAKE path. A cache miss must NOT default to "dead": the
  // server respawns on dead, and respawning a LIVE agent injects register +
  // "continue from where you left off" — the costly, user-visible error. Cache
  // misses are routine (cold cache for ~30s after any daemon bounce; a session
  // the sweep hasn't reached yet), so defaulting them to dead made every
  // interaction in that window respawn its (live) target. Instead, on a miss do
  // one cheap on-demand existence check and only report dead when we actually
  // confirm the session is gone. Uncertain ≠ dead.
  if (!tmux_session) return { alive: false }
  const cached = _alivenessCache.get(tmux_session)
  if (cached !== undefined) return { alive: cached }
  try {
    const r = await rpcListSessions()
    const alive = (r.sessions || []).includes(tmux_session)
    _alivenessCache.set(tmux_session, alive)
    return { alive }
  } catch {
    // Couldn't probe tmux — can't confirm death. Don't trigger a respawn on a
    // guess; a missed wake self-corrects on the next message.
    return { alive: true }
  }
}

async function rpcKick({ agent_id }) {
  if (!agent_id) throw new Error('missing agent_id')
  armAgent(agent_id)   // kicking/waking → arm the status machine
  const dir = path.join(os.homedir(), '.fleet', 'signals')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, agent_id.replace(/[^a-zA-Z0-9_-]/g, '_'))
  fs.writeFileSync(file, Date.now().toString())
  return { ok: true, signal: file }
}

async function rpcKillSession({ tmux_session, agent_id: _agent_id }) {
  if (!tmux_session) throw new Error('missing tmux_session')
  checkSession(tmux_session)
  await tmux('kill-session', '-t', tmux_session)
  // NOTE: killing a tmux session is hibernation, not death. Don't mark dead.
  // Explicit kills go through a separate path that hits /mark-dead directly.
  if (_agent_id) emitAgentStatus(_agent_id, 'hibernating')
  _alivenessCache.set(tmux_session, false)
  return { ok: true, tmux_session }
}


// Live terminal-card watching via PTY streaming.
// Instead of polling `tmux capture-pane`, we spawn a PTY running
// `tmux attach -t SESSION` and stream the raw terminal output over WS.
const terminalWatchPtys = new Map() // tmux_session -> { pty, alive }
let ptyModule = null
async function getPty() {
  if (!ptyModule) {
    try {
      const mod = await import('node-pty')
      ptyModule = mod.default || mod
    } catch (e) { throw new Error('node-pty not available: ' + e.message) }
  }
  return ptyModule
}

function detectPromptFromPty(agentId, tmuxSession, state) {
  const result = detectPrompt(state.recentOutput)
  if (result.type === 'auto-accept') {
    const lastAccept = promptCooldowns.get(tmuxSession)
    if (lastAccept && Date.now() - lastAccept < 10_000) return
    promptCooldowns.set(tmuxSession, Date.now())
    state.lastPromptSurfaced = ''
    if (state.alive) {
      state.pty.write('1\r')
      log.info(`pty auto-accepted prompt (${result.reason}) in ${tmuxSession}`)
      sendMsg({ type: 'prompt-auto-accepted', agent_id: agentId, reason: result.reason, ts: new Date().toISOString() })
    }
  } else if (result.type === 'surface') {
    if (state.lastPromptSurfaced === result.reason) return
    state.lastPromptSurfaced = result.reason
    log.info(`pty surfacing prompt for ${agentId}: ${result.reason}`)
    sendMsg({ type: 'terminal_attention', agent_id: agentId, tmux_session: tmuxSession, text: result.reason, reason: result.reason, snippet: result.snippet || null })
  } else {
    state.lastPromptSurfaced = ''
  }
  // Plan mode detection
  if (state.recentOutput.includes("Here is Claude's plan") && state.recentOutput.includes('Would you like to')) {
    if (!planModeHashes.has(agentId)) {
      scheduleCheckForPlanModePrompt(agentId)
    }
  } else {
    planModeHashes.delete(agentId)
  }
}

// Query a tmux session's current window size. The agent's TUI repaints at this
// width using absolute cursor moves, so the viewer's xterm grid MUST match it or
// every frame garbles — see the peek's grid sizing in FleetChatShape.tsx.
async function queryWindowSize(tmux_session) {
  try {
    const { stdout } = await tmux('display-message', '-p', '-t', tmux_session, '#{window_width} #{window_height}')
    const [w, h] = stdout.trim().split(/\s+/).map(n => parseInt(n, 10))
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return { cols: w, rows: h }
  } catch {}
  return null
}

async function tmuxPaneIsLive(tmux_session) {
  try {
    const { stdout } = await tmux('display-message', '-p', '-t', tmux_session, '#{pane_dead}')
    return stdout.trim() === '0'
  } catch {
    return false
  }
}

async function rpcStartTerminalWatch({ tmux_session, agent_id, poll_ms }) {
  checkSession(tmux_session)
  {
    const existing = terminalWatchPtys.get(tmux_session)
    if (existing) return { ok: true, already: true, cols: existing.cols, rows: existing.rows }
  }

  // Disable tmux status bar — it generates escape code noise in the PTY stream
  try { await execFileP('tmux', [...TMUX_ARGS, 'set-option', '-t', tmux_session, 'status', 'off'], { timeout: 3000 }) } catch {}

  // Pin the window to a fixed width before attaching. The global window-size=latest
  // makes the window follow whatever client last attached, so an idle agent's frame
  // (painted at one width) gets shown in the peek grid at a different width ->
  // absolute-position garble. Pinning (manual + a fixed size) removes the reflow at
  // the source; the resize also forces a one-time repaint that cleans any stale frame
  // left over from a previous width. New agents are already pinned at spawn
  // This also covers agents that predate spawn-side pinning.
  const PINNED_COLS = 120, PINNED_ROWS = 40
  try {
    await execFileP('tmux', [...TMUX_ARGS, 'set-option', '-t', tmux_session, 'window-size', 'manual'], { timeout: 3000 })
    await execFileP('tmux', [...TMUX_ARGS, 'resize-window', '-t', tmux_session, '-x', String(PINNED_COLS), '-y', String(PINNED_ROWS)], { timeout: 3000 })
  } catch (e) { log.warn(`terminal-watch: failed to pin window for ${tmux_session}: ${e?.message || e}`) }

  // Attach the watch PTY at the (now pinned) window size. tmux renders the window at
  // the window size; a PTY narrower than the window receives garbled, absolute-
  // positioned frames, so the PTY must match it.
  const size = await queryWindowSize(tmux_session) || { cols: PINNED_COLS, rows: PINNED_ROWS }

  const nodePty = await getPty()
  const pty = nodePty.spawn('tmux', [...TMUX_ARGS, 'attach-session', '-t', tmux_session], {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    env: { ...process.env, TERM: 'xterm-256color', TMUX: '', TMUX_PANE: '' },
  })

  const state = { pty, alive: true, recentOutput: '', lastPromptSurfaced: '', cols: size.cols, rows: size.rows, sizePoll: null }
  terminalWatchPtys.set(tmux_session, state)

  sendMsg({ type: 'terminal-size', agent_id, tmux_session, cols: size.cols, rows: size.rows })
  try {
    const { stdout } = await execFileP('tmux',
      [...TMUX_ARGS, ...terminalVisibleCaptureArgs(tmux_session)],
      { timeout: 3000, encoding: 'utf8' })
    const snapshot = trimTerminalSeedBlankRows(stdout).replace(/\n/g, '\r\n')
    if (snapshot.trim()) {
      sendMsg({
        type: 'terminal-data',
        agent_id,
        tmux_session,
        data: Buffer.from(snapshot).toString('base64'),
      })
      state.recentOutput = stripAnsi(snapshot).slice(-4000)
      detectPromptFromPty(agent_id, tmux_session, state)
    }
  } catch (e) {
    log.warn(`terminal-watch: initial capture failed for ${tmux_session}: ${e?.message || e}`)
  }

  // The window can change while we watch (a real terminal client attaches,
  // detaches, or resizes). Poll and follow it: resize our PTY to match so the
  // stream stays clean, and tell the viewer the new grid width.
  state.sizePoll = setInterval(async () => {
    if (!state.alive) return
    const cur = await queryWindowSize(tmux_session)
    if (!cur || (cur.cols === state.cols && cur.rows === state.rows)) return
    state.cols = cur.cols
    state.rows = cur.rows
    try { state.pty.resize(Math.max(1, cur.cols), Math.max(1, cur.rows)) } catch {}
    sendMsg({ type: 'terminal-size', agent_id, tmux_session, cols: cur.cols, rows: cur.rows })
  }, TERMINAL_SIZE_POLL_MS)

  pty.onData((data) => {
    if (!state.alive) return
    sendMsg({
      type: 'terminal-data',
      agent_id,
      tmux_session,
      data: Buffer.from(data).toString('base64'),
    })
    // Rolling buffer for prompt detection — keep last ~4KB of stripped text
    state.recentOutput += stripAnsi(data)
    if (state.recentOutput.length > 8000) state.recentOutput = state.recentOutput.slice(-4000)
    detectPromptFromPty(agent_id, tmux_session, state)
  })

  pty.onExit(({ exitCode }) => {
    state.alive = false
    if (state.sizePoll) { clearInterval(state.sizePoll); state.sizePoll = null }
    terminalWatchPtys.delete(tmux_session)
    void (async () => {
      const decision = decideTerminalWatchExit({ paneLive: await tmuxPaneIsLive(tmux_session) })
      if (!decision.terminalDead) {
        log.warn(`terminal-watch exited while pane is still live: agent=${agent_id} session=${tmux_session} exitCode=${exitCode}; suppressing terminal-dead`)
        return
      }
      log.info(`terminal exited: agent=${agent_id} session=${tmux_session} exitCode=${exitCode}`)
      sendMsg({ type: 'terminal-dead', agent_id, tmux_session, exitCode })
    })()
  })

  return { ok: true, streaming: true, cols: size.cols, rows: size.rows }
}

function rpcStopTerminalWatch({ tmux_session }) {
  const state = terminalWatchPtys.get(tmux_session)
  if (!state) return { ok: true, already: true }
  state.alive = false
  if (state.sizePoll) { clearInterval(state.sizePoll); state.sizePoll = null }
  try { state.pty.kill() } catch {}
  terminalWatchPtys.delete(tmux_session)
  return { ok: true }
}

async function rpcTerminalResize({ tmux_session, cols, rows }) {
  checkSession(tmux_session)
  const state = terminalWatchPtys.get(tmux_session)
  if (!state || !state.alive) return { ok: false, reason: 'no active pty' }
  // Browser resize messages must not resize the watcher PTY away from tmux's
  // real window size; Claude/goose repaint with absolute cursor positions at
  // the tmux width, so a PTY-only resize recreates the wrapping bug.
  const size = await queryWindowSize(tmux_session)
  const target = size || { cols: state.cols, rows: state.rows }
  state.cols = target.cols
  state.rows = target.rows
  try {
    state.pty.resize(Math.max(1, target.cols), Math.max(1, target.rows))
  } catch (e) {
    log.warn(`terminal-watch: failed to resize watcher PTY for ${tmux_session}: ${e?.message || e}`)
  }
  return { ok: true, cols: target.cols, rows: target.rows }
}

function rpcTerminalInput({ tmux_session, data }) {
  checkSession(tmux_session)
  const state = terminalWatchPtys.get(tmux_session)
  if (!state || !state.alive) return { ok: false, reason: 'no active pty' }
  state.pty.write(data)
  return { ok: true }
}


const _activeSpawns = new Map()
const STARTUP_FAILURE_PROBE_MS = Number(process.env.TLDA_SPAWN_STARTUP_FAILURE_PROBE_MS || 2500)
const SPAWN_LAUNCH_TIMEOUT_MS = Number(process.env.TLDA_SPAWN_LAUNCH_TIMEOUT_MS || 20000)
const SPAWN_CRASH_LOG_DIR = path.join(CONFIG_DIR, 'spawn-crashes')
const _reportedStartupFailures = new Set()

function traceDaemonSpawn(label, detail) {
  log.info(`[spawn-trace] ${label} ${JSON.stringify({ ts: new Date().toISOString(), machineId: MACHINE_ID, ...detail })}`)
}

function spawnCrashLogPath({ agentName, agent_id, tmux_session }) {
  const base = String(agent_id || agentName || tmux_session || 'unknown').replace(/[^A-Za-z0-9_.:-]/g, '_')
  return path.join(SPAWN_CRASH_LOG_DIR, `${base}.log`)
}

function readFileTail(file, max = 6000) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.slice(-max)
  } catch {
    return ''
  }
}

async function probeSpawnStartupFailure({ agentName, agent_id, tmux_session, harness, model, respawn, crash_log_path }) {
  if (!agent_id || !tmux_session) return null
  const dedupKey = `${agent_id}:${tmux_session}`
  if (_reportedStartupFailures.has(dedupKey)) return null
  try {
    await new Promise(resolve => setTimeout(resolve, STARTUP_FAILURE_PROBE_MS))
    const { stdout } = await execFileP('tmux',
      [...TMUX_ARGS, 'capture-pane', '-t', tmux_session, '-p', '-e', '-S', '-120'],
      { timeout: 5000, encoding: 'utf8' })
    const failure = detectSpawnStartupFailureTranscript(stdout, { harness })
    if (!failure) return null
    _reportedStartupFailures.add(dedupKey)
    sendMsg({
      type: 'spawn-startup-failed',
      agent_id,
      agent_name: agentName || null,
      tmux_session,
      harness: harness || null,
      model: model || null,
      respawn: !!respawn,
      code: failure.code,
      reason: failure.reason,
      snippet: failure.snippet,
      crash_log_path: crash_log_path || null,
    })
    return failure
  } catch (e) {
    const crashTail = crash_log_path ? readFileTail(crash_log_path) : ''
    log.warn(`startup failure probe failed for ${agentName || agent_id}: ${e.message}${crash_log_path ? `; crash_log=${crash_log_path}` : ''}${crashTail ? `\n${crashTail}` : ''}`)
    return null
  }
}

async function rpcSpawn({
  agent_id,
  name,
  model,
  kind,
  cwd,
  doc,
  respawn,
  refresh,
  session,
  session_id,
  enroll,
  effort,
  mode,
  requestedPermission,
  requestedPermissions,
  policy,
  acknowledgeNoSecurity,
  callerRung,
  requester,
}) {
  const sessionId = session || session_id
  const agentName = name || (sessionId ? `session-${String(sessionId).slice(0, 8)}` : `agent-${Date.now().toString(36).slice(-4)}`)
  let launchModel = model
  let launchKind = kind
  if (_activeSpawns.has(agentName)) {
    const age = Date.now() - _activeSpawns.get(agentName)
    if (age < 90_000) {
      log.info(`spawn deduped: ${agentName} already spawning (${Math.round(age / 1000)}s ago)`)
      return {
        ok: false,
        name: agentName,
        deduped: true,
        age_ms: age,
        retry_after_ms: Math.max(0, 90_000 - age),
        error: `${agentName} is already spawning; no new terminal/session has been verified yet`,
      }
    }
    _activeSpawns.delete(agentName)
  }
  let resolvedCwd = cwd
  if (!resolvedCwd && doc) {
    const project = projects.find(p => p.name === doc)
    if (!project) {
      // An unresolvable project used to drop --cwd silently → the agent launched
      // in launchd's cwd (`/`) and died as a ghost row. Reject loud instead.
      const known = projects.map(p => p.name).sort().join(', ')
      return { ok: false, error: `no project '${doc}'${known ? ` — known: ${known}` : ''}` }
    }
    if (project.sourceDir) resolvedCwd = project.sourceDir
  }
  const projectForGrant = doc
    ? projects.find(p => p.name === doc)
    : projects.find(p => {
        if (!resolvedCwd || !p.sourceDir) return false
        const cwdPath = path.resolve(resolvedCwd)
        const sourcePath = path.resolve(p.sourceDir)
        return cwdPath === sourcePath || cwdPath.startsWith(`${sourcePath}${path.sep}`)
      })
  let grant
  let spawnConfig
  try {
    const config = loadConfig()
    spawnConfig = config
    if (respawn) {
      // Wake = resume an EXISTING seat with its OWN ledger grant. A wake carries no
      // requester, no spawn-auth gate, no grantFor, no fleet:root, no none-grant: it
      // is just the invisible step that delivers a chat, so chatting a hibernating
      // agent is identical to chatting an awake one, and wake is open to anyone.
      // A real agent IS its seat (a fleet-id + its ledger entry). If a resolved seat
      // has no ledger entry that's an anomaly — fail LOUDLY, never fabricate a grant.
      const own = agent_id ? permissionLedger.get(agent_id) : null
      if (!own) {
        throw new Error(`wake refused: seat ${agent_id || '(no id)'} has no ledger entry — a real agent must have a seat; refusing to resume with a fabricated grant`)
      }
      grant = { grantedPolicy: own.spawnPolicy, grantedPermissionSet: own.permissionSet, grantPreserved: true }
    } else {
      // Fresh spawn stays privileged: requester required, grant derived from it.
      if (!requester?.id) {
        const err = new Error('spawn refused: daemon RPC requester identity is required')
        err.code = 'SPAWN_PERMISSION_NO_REQUESTER'
        throw err
      }
      const spawnerGrant = permissionLedger.grantFor(requester)
      // Project-local override (git-style): the agent's cwd project may carry a
      // `.tlda-daemon.yaml` whose `default` profile is joined over the base daemon
      // config. Surface it as the project profile so an un-granted agent in that
      // project gets the project's default (e.g. tlda → app-dev), still bounded by
      // the spawner + model-ceiling intersection.
      const projectDefaultProfile = resolvedCwd ? readDaemonConfigForCwd(resolvedCwd)?.default : null
      const grantConfig = projectDefaultProfile
        ? { ...config, spawnPolicy: { ...(config?.spawnPolicy || {}), projectProfiles: { ...((config?.spawnPolicy || {}).projectProfiles || {}), [resolvedCwd]: projectDefaultProfile } } }
        : config
      grant = resolveSpawnGrant({
        requestedPermission: requestedPermission || (policy != null ? 'write' : undefined),
        requestedPermissions,
        callerRung,
        requester,
        spawnerPolicy: spawnerGrant?.spawnPolicy,
        spawnerPermissionSet: spawnerGrant?.permissionSet,
        model: launchModel,
        kind: launchKind,
        config: grantConfig,
        doc,
        project: projectForGrant,
        cwd: resolvedCwd,
      })
    }
  } catch (e) {
    return { ok: false, name: agentName, error: `spawn policy resolution failed: ${e.message}` }
  }
  traceDaemonSpawn('grant', {
    agentName,
    agent_id: agent_id || null,
    requestedKind: kind || null,
    launchKind: launchKind || null,
    requestedModel: model || null,
    launchModel: launchModel || null,
    requestedPermission: requestedPermission || null,
    requestedPolicy: policy || null,
    hasRequestedPermissions: !!requestedPermissions,
    grantedPermission: grant.grantedPermission || null,
    grantedPolicy: grant.grantedPolicy || null,
    hasGrantedPermissionSet: !!grant.grantedPermissionSet,
    cwd: resolvedCwd || null,
    doc: doc || null,
    requester: requester ? { id: requester.id || null, name: requester.name || null, human: !!requester.human, spawnPolicy: requester.spawnPolicy || null } : null,
  })
  _activeSpawns.set(agentName, Date.now())
  try {
    const { spawn: nodeSpawn } = await import('./lib/spawn/index.mjs')
    const spawnMode = sessionId ? 'session' : (refresh ? 'refresh' : (respawn ? 'respawn' : 'fresh'))
    const preallocatedAgentId = agent_id || ((spawnMode === 'fresh' || spawnMode === 'session') ? newFleetId() : undefined)
    // Only a FRESHLY-MINTED id (fresh/session, no caller agent_id) is a throwaway we
    // preallocate + roll back in this call. A respawn carries an existing agent_id →
    // its grant is durable (possibly grandfather/infill-sourced) and must NOT be written
    // or deleted by the spawn lifecycle, or a launch failure silently wipes a real
    // seat's grant (the respawn-delete bug that vanished 7725aeba's grant repeatedly).
    const mintedThisCall = !agent_id && (spawnMode === 'fresh' || spawnMode === 'session')
    const crashLogPath = spawnCrashLogPath({ agentName, agent_id: preallocatedAgentId || agent_id, tmux_session: null })
    if (mintedThisCall) {
      await permissionLedger.set(preallocatedAgentId, {
        spawnPolicy: grant.grantedPolicy,
        permissionSet: grant.grantedPermissionSet,
        source: 'spawn',
      })
    }
    let launched
    try {
      launched = await nodeSpawn({
        spawnMode,
        agentId: preallocatedAgentId,
        name: agentName,
        model: launchModel,
        kind: launchKind,
        config: spawnConfig,
        activeConfigName: ACTIVE_CONFIG,
        cwd: resolvedCwd,
        sessionId,
        enroll: !!enroll,
        effort,
        permissionMode: mode,
        spawnPolicy: grant.grantedPolicy,
        permissionSet: grant.grantedPermissionSet,
        explicitPolicy: policy != null,
        acknowledgeNoSecurity: !!acknowledgeNoSecurity,
        machineId: MACHINE_ID,
        tmuxSocket: TMUX_SOCKET,
        crashLogPath,
        identityConfigDir: CONFIG_DIR,
      })
    } catch (e) {
      if (mintedThisCall) await permissionLedger.delete(preallocatedAgentId).catch(() => {})
      throw e
    }
    traceDaemonSpawn('launched', {
      agentName,
      agent_id: launched.fleetId,
      tmux_session: launched.tmuxSession,
      crash_log_path: crashLogPath,
      harness: launched.harness,
      model: launched.model,
      spawnPolicy: grant.grantedPolicy || null,
      grantedPermission: grant.grantedPermission || null,
    })
    try {
      await tmux('has-session', '-t', launched.tmuxSession)
    } catch (e) {
      if (mintedThisCall) await permissionLedger.delete(preallocatedAgentId).catch(() => {})
      const detail = ((e.stderr || e.message || '').trim().split('\n').filter(Boolean).pop()) || 'tmux session check failed'
      return {
        ok: false,
        name: agentName,
        agent_id: launched.fleetId,
        tmux_session: launched.tmuxSession,
        error: `spawn launcher returned but tmux session is not usable: ${detail}`,
      }
    }
    if (launched.harness === 'codex' && !launched.resumeId) {
      if (mintedThisCall) await permissionLedger.delete(preallocatedAgentId).catch(() => {})
      return {
        ok: false,
        name: agentName,
        agent_id: launched.fleetId,
        tmux_session: launched.tmuxSession,
        code: 'missing-resume-handle',
        error: 'spawn launcher returned a codex session without a durable resume handle',
      }
    }
    if (!preallocatedAgentId || launched.fleetId !== preallocatedAgentId) {
      await permissionLedger.set(launched.fleetId, {
        spawnPolicy: grant.grantedPolicy,
        permissionSet: grant.grantedPermissionSet,
        source: 'spawn',
      })
    }
    probeSpawnStartupFailure({
      agentName,
      agent_id: launched.fleetId,
      tmux_session: launched.tmuxSession,
      crash_log_path: crashLogPath,
      harness: launched.harness,
      model: launched.model,
      respawn,
    }).catch(e => log.warn(`detached startup-failure probe errored for ${agentName}: ${e.message}`))
    return {
      ok: true,
      name: launched.name || agentName,
      agent_id: launched.fleetId,
      tmux_session: launched.tmuxSession,
      resume_id: launched.resumeId,
      enrolled: launched.enrolled,
      spawnerPermission: grant.spawnerPermission,
      projectPermission: grant.projectPermission,
      modelPermission: grant.modelPermission,
      requestedPermissionSet: grant.requestedPermissionSet,
      grantedPermissionSet: grant.grantedPermissionSet,
      spawnPolicy: grant.grantedPolicy,
      grantedPermission: grant.grantedPermission,
    }
  } catch (e) {
    const detail = typeof e?.message === 'string' ? e.message : (e?.message ? JSON.stringify(e.message) : String(e))
    const reason = e?.reason || e?.code || 'launch-failed'
    if (reason !== 'identity-ingestion-pending') {
      log.warn(`node fleet-spawn finished with error: ${agentName}: ${reason}: ${detail}`)
      sendMsg({ type: 'daemon-warning', message: `couldn't ${respawn ? 'wake' : 'spawn'} ${agentName} — ${detail}` })
    }
    return {
      ok: false,
      name: agentName,
      error: detail,
      code: reason,
      reason,
      detail: e?.detail || null,
      retry_after_ms: e?.detail?.retry_after_ms || undefined,
    }
  } finally {
    _activeSpawns.delete(agentName)
  }
}

async function rpcSpawnAvailability() {
  return await probeSpawnAvailability()
}

// --- Agent death detection ---
// Periodically check if agents' claude processes are still running.
// When a process is gone, the agent is hibernating — NOT dead. We log it
// and stop tracking liveness locally (so we don't log every 30s), but
// crucially we do NOT mark them dead on the server. `dead` means an
// explicit kill; absent processes are just sleeping.
let _deathCheckInterval = null
const DEATH_CHECK_MS = 30_000   // liveness check every 30s
// Liveness #B(c): if an agent emitted JSONL activity within this window it's a
// known-alive heartbeat — the sweep skips the expensive pane-pgrep for it. Longer
// than a normal turn so a mid-turn agent isn't falsely treated as quiet (worst
// case it just gets probed, which confirms alive). Death cadence is unchanged.
const ACTIVITY_FRESH_MS = 90_000

// Cache populated by checkAgentLiveness every 30s.
// rpcCheckAlive reads from here — zero spawns per call.
const _alivenessCache = new Map()  // tmux_session → boolean
// Session/process probes can flap briefly during wake, tmux server churn, or
// platform permission hiccups. Do not park an agent on the first missed probe:
// keep reporting it live for a short grace window, then hibernate only if the
// absence persists.
const HIBERNATE_GRACE_MS = Number(process.env.TLDA_HIBERNATE_GRACE_MS || 120_000)
const _missingSessionSince = new Map()  // agent_id → ms timestamp
const _missingRuntimeSince = new Map()  // agent_id → ms timestamp
// Be conservative about transient runtime probe misses inside an existing tmux
// session. A missing tmux session itself is not evidence of a live agent, so do
// not publish "awake" for first-observed absent sessions.
const _observedLiveSessions = new Set() // tmux_session
const _observedLiveRuntimes = new Set() // agent_id

// Thinking/compacting/approval detection — moved from MCP to daemon so it
// survives MCP restarts and the hibernate sweep can trust it.
// Status classification (per-harness regexes + classifier) is imported from
// ./lib/status-classifier.mjs above \u2014 single source of truth. The daemon OWNS the
// status STATE (the maps + scanArmedStatus loop below) and emits the transitions;
// server/client/bots consume them and do not reconstruct status.
const STATUS_SCAN_MS = parseInt(process.env.TLDA_STATUS_SCAN_MS, 10) || 5000
const ARM_LINGER_MS = parseInt(process.env.TLDA_STATUS_ARM_LINGER_MS, 10) || 8000
const IDLE_CONFIRM_SCANS = 2         // consecutive idle scans before thinking:false (anti-flicker)
let _statusScanInterval = null
const _armedSince = new Map()        // agent_id -> last arm/activity ts (armed iff present)
const _idleScans = new Map()         // agent_id -> consecutive non-thinking scans (hysteresis)
const _classifierState = new Map()   // agent_id -> carried classifier state (goose freeze tracking)
// Arm an agent for frequent status checks. Cheap; called from the activity path
// (any JSONL/sqlite write = the agent is doing something). `armed` is a watch
// state, never shown \u2014 the pane scan decides the actual thinking state.
function armAgent(agentId) {
  if (agentId) _armedSince.set(agentId, Date.now())
}
function armBySession(tmux_session) {
  if (!tmux_session) return
  for (const a of agents) {
    if (a.tmux_session !== tmux_session) continue
    // A session-targeted RPC can correspond to more than one registry row
    // (stale rows, handoff windows, duplicate registrations). Arming only the
    // first row makes correctness depend on registry order, so arm every active
    // non-human row attached to this session. The scan loop is still bounded to
    // active rows and will disarm stale rows quickly if they cannot produce pane
    // truth.
    if (!a.dead && !a.human && !a.hibernating) armAgent(a.id)
  }
}
// Disarm an agent, emitting a clean idle edge first if it was mid-turn. The daemon
// OWNS the transition, so a thinking agent that vanishes (dead/hibernating) or is
// disarmed must get a thinking:false edge HERE — otherwise the server's
// _thinkingState stays true (its disconnect path clears it WITHOUT a turn_ended),
// so a bot never sees the turn end. The normal idle-past-linger path already
// emitted false via the hysteresis, so _prevThinking is false there and this
// re-emits nothing — it just clears state.
function disarmAgent(agentId) {
  if (_prevThinking.get(agentId) === true) sendMsg({ type: 'agent-thinking', agentId, thinking: false })
  if (_prevCompacting.get(agentId) === true) sendMsg({ type: 'agent-compacting', agentId, compacting: false })
  _armedSince.delete(agentId)
  _idleScans.delete(agentId)
  _classifierState.delete(agentId)
  _prevThinking.delete(agentId)
  _prevCompacting.delete(agentId)
  _prevApprovalFP.delete(agentId)
}
function emitAgentStatus(agentId, state, tool = null) {
  if (!agentId || !state) return
  if (_prevAgentStatus.get(agentId) === state) return
  _prevAgentStatus.set(agentId, state)
  sendMsg({ type: 'agent-status', agentId, state, tool, ts: new Date().toISOString() })
}
const _prevThinking = new Map()   // agent_id → boolean
const _prevCompacting = new Map() // agent_id → boolean
const _prevAgentStatus = new Map() // agent_id → finite daemon-owned status label
const _prevGooseLive = new Map()  // agent_id → { fingerprint, since } (goose freeze tracking)
const _prevApprovalFP = new Map() // agent_id → string (fingerprint)
// Goose turn-end auto-kick state: agent_id → kick state, owned by
// checkAgentLiveness's sweep. The detection/decision logic lives in
// ./lib/goose-kick.mjs (pure decideKick + sqlite reads); the daemon supplies
// the side-effecting deps (rpcSendText, execFileP, log) and this state map.
const _gooseKickState = new Map()

// Goose activity-card source state (see ./lib/goose-activity.mjs). Polls the
// goose sqlite for new messages and feeds bufferActivity(); lastSeen tracks the
// last message id emitted per goose agent.
let _gooseActivityInterval = null
const GOOSE_ACTIVITY_MS = 3000
const _gooseActivityLastSeen = new Map()

// Walk a pane's process subtree (the pane pid plus all descendants) and return
// true if any process is an agent runtime. Handles BOTH claude (a direct child
// of the pane shell) and goose (nested under a `zsh -lc` login wrapper, so its
// ppid is the inner shell, not the pane) — a flat pane-pid check misses goose.
function _paneSubtreeHasAgent(panePid, childrenByPpid, agentProcPids) {
  const stack = [panePid], seen = new Set()
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    if (agentProcPids.has(pid)) return true
    const kids = childrenByPpid.get(pid)
    if (kids) for (const k of kids) stack.push(k)
  }
  return false
}

async function checkAgentLiveness() {
  return // KILL-SWITCH (Skip 2026-07-06): hibernation/liveness sweep disabled so agents are never marked hibernating. Revert this line to re-enable.
  if (!agents.length) return
  if (!_serverReady || !_rws?.connected) {
    // A server/Fly redeploy can drop the daemon websocket while local tmux
    // sessions are still fine. During that window liveness is unknown, not
    // hibernating; do not let disconnect time consume the grace period.
    _missingSessionSince.clear()
    _missingRuntimeSince.clear()
    const now = Date.now()
    if (now - _lastLivenessDisconnectWarnAt > 30_000) {
      log.warn('skipping agent liveness check while daemon websocket is not ready')
      _lastLivenessDisconnectWarnAt = now
    }
    return
  }
  const now = Date.now()
  const aliveAgentIds = []
  const checkedAgentIds = []
  let sessions
  try {
    const r = await rpcListSessions()
    sessions = new Set(r.sessions || [])
  } catch (e) {
    log.warn(`tmux session probe failed during liveness check — preserving prior liveness: ${e.message}`)
    return
  }

  // Membership source of truth: tmux's live session set. Historical roster rows
  // are only metadata for sessions that actually exist now; an absent row that
  // this daemon never observed live is not local work.
  const agentsBySession = new Map()
  for (const agent of agents) {
    if (agent.dead || agent.human || !agent.tmux_session) continue
    if (!agentsBySession.has(agent.tmux_session)) agentsBySession.set(agent.tmux_session, [])
    agentsBySession.get(agent.tmux_session).push(agent)
  }

  for (const session of [..._observedLiveSessions]) {
    if (sessions.has(session)) continue
    for (const agent of (agentsBySession.get(session) || [])) {
      checkedAgentIds.push(agent.id)
      const decision = decideMissingLiveness({
        now,
        missingSince: _missingSessionSince.get(agent.id),
        graceMs: HIBERNATE_GRACE_MS,
        alreadyHibernating: agent.hibernating,
      })
      _missingSessionSince.set(agent.id, decision.since)
      if (decision.alive) {
        _alivenessCache.set(session, true)
        aliveAgentIds.push(agent.id)
        continue
      }
      if (!agent.hibernating) {
        log.info(`agent ${agent.friendly_name || agent.id} is hibernating (tmux session ${session} gone for ${Math.round((now - decision.since) / 1000)}s)`)
      }
      agent.hibernating = true
      emitAgentStatus(agent.id, 'hibernating')
      _alivenessCache.set(session, false)
    }
    _observedLiveSessions.delete(session)
  }

  // Collect live candidate sessions, then batch-query pane PIDs.
  const candidateAgents = []
  for (const session of sessions) {
    for (const agent of (agentsBySession.get(session) || [])) {
    checkedAgentIds.push(agent.id)
    _observedLiveSessions.add(agent.tmux_session)
    _missingSessionSince.delete(agent.id)
    // Liveness #B(c): session exists AND the agent emitted JSONL activity recently
    // (a per-turn heartbeat) → known alive; skip the expensive pane-pgrep and mark
    // it alive. A genuinely quiet/dead agent has no fresh activity, so it still
    // falls through to the probe below — death-detection cadence is unchanged; the
    // sweep just stops re-pgrep'ing the obviously-active fleet (heartbeat-driven
    // liveness, sweep as backstop for the quiet ones).
    const lastSeenMs = Date.parse(agent.last_seen || '') || 0
    if (now - lastSeenMs < ACTIVITY_FRESH_MS) {
      _alivenessCache.set(agent.tmux_session, true)
      aliveAgentIds.push(agent.id)
      continue
    }
    candidateAgents.push(agent)
    }
  }

  if (!candidateAgents.length) {
    sendMsg({ type: 'agent-liveness', agent_ids: aliveAgentIds, checked_agent_ids: checkedAgentIds })
    return
  }

  // One tmux call: get all pane PIDs across all sessions at once.
  const sessionToPanes = new Map()
  try {
    const { stdout } = await execFileP('tmux',
      [...TMUX_ARGS, 'list-panes', '-a', '-F', '#{session_name} #{pane_pid}'],
      { timeout: 5000, encoding: 'utf8' })
    for (const line of stdout.trim().split('\n')) {
      const sp = line.indexOf(' ')
      if (sp < 0) continue
      const sess = line.slice(0, sp), pid = line.slice(sp + 1)
      if (!sessionToPanes.has(sess)) sessionToPanes.set(sess, [])
      sessionToPanes.get(sess).push(pid)
    }
  } catch { /* tmux unavailable */ }

  // One ps call: get all processes with their args and PPIDs. Each harness
  // adapter declares what its runtime process looks like; the daemon owns the
  // hibernating/dead state transition and only asks "is this adapter's runtime
  // alive under this tmux pane?".
  const runtimePidsByKind = new Map(
    Object.keys(HARNESS_ADAPTERS).map(kind => [kind, new Set()])
  )
  const childrenByPpid = new Map()
  try {
    const { stdout } = await execFileP('ps', ['-eo', 'pid,ppid,args'],
      { timeout: 5000, encoding: 'utf8' })
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s/)
      if (m) {
        const pid = m[1], ppid = m[2]
        if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, [])
        childrenByPpid.get(ppid).push(pid)
      }
      const pid = line.trim().split(/\s+/)[0]
      if (!pid) continue
      for (const adapter of Object.values(HARNESS_ADAPTERS)) {
        if (adapter.processRe.test(line)) {
          runtimePidsByKind.get(adapter.kind)?.add(pid)
        }
      }
    }
  } catch (e) {
    log.warn(`ps failed during death detection — skipping cycle: ${e.message}`)
    return
  }

  let watcherNeedsSync = false
  for (const agent of candidateAgents) {
    const panes = sessionToPanes.get(agent.tmux_session) || []
    // Liveness + true kind from the ACTUAL pane process, not the (often
    // absent/stale) metadata.kind. The previous code resolved kind via
    // harnessForAgent → defaulted codex agents to claude → checked the codex
    // pane for a *claude* runtime, found none, and wrongly marked the live
    // codex agent hibernating (so it never got a JSONL watcher → no cards).
    // An agent is alive if its pane subtree holds ANY harness runtime; its kind
    // is whichever matched. Prefer the claimed kind only if its runtime is
    // actually present, so a parent that spawned a child of another kind isn't
    // misclassified.
    const claimed = agent?.metadata?.kind
    let matchedKind = null
    if (claimed && runtimePidsByKind.has(claimed) &&
        panes.some(pid => _paneSubtreeHasAgent(pid, childrenByPpid, runtimePidsByKind.get(claimed)))) {
      matchedKind = claimed
    } else {
      for (const [kind, pids] of runtimePidsByKind) {
        if (panes.some(pid => _paneSubtreeHasAgent(pid, childrenByPpid, pids))) { matchedKind = kind; break }
      }
    }
    const agentAlive = matchedKind !== null
    const priorRuntimeKind = agent.runtimeKind
    agent.runtimeKind = matchedKind || (runtimePidsByKind.has(claimed) ? claimed : 'claude')
    if (matchedKind && priorRuntimeKind && priorRuntimeKind !== matchedKind) watcherNeedsSync = true

    _alivenessCache.set(agent.tmux_session, agentAlive)

    if (!agentAlive) {
      const decision = decideMissingLiveness({
        now,
        missingSince: _missingRuntimeSince.get(agent.id),
        graceMs: 0,
        alreadyHibernating: agent.hibernating,
      })
      _missingRuntimeSince.set(agent.id, decision.since)
      if (decision.alive) {
        if (!_observedLiveRuntimes.has(agent.id)) {
          log.info(`preserving awake status for ${agent.friendly_name || agent.id}: no agent process in session ${agent.tmux_session} on first local observation, within grace`)
        }
        _alivenessCache.set(agent.tmux_session, true)
        aliveAgentIds.push(agent.id)
        continue
      }
      if (!agent.hibernating) {
        log.info(`agent ${agent.friendly_name || agent.id} is hibernating (no agent process in session ${agent.tmux_session} for ${Math.round((now - decision.since) / 1000)}s)`)
        // Capture last lines of tmux for crash diagnosis
        try {
          const { stdout: lastLines } = await execFileP('tmux',
            [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-S', '-15'],
            { timeout: 3000, encoding: 'utf8' })
          const trimmed = lastLines.trim()
          if (trimmed) {
            sendMsg({
              type: 'agent-crash',
              agent_id: agent.id,
              agent_name: agent.friendly_name || agent.id,
              tmux_session: agent.tmux_session,
              last_output: trimmed,
            })
          }
        } catch {}
      }
      agent.hibernating = true
      emitAgentStatus(agent.id, 'hibernating')
      _alivenessCache.set(agent.tmux_session, false)
      continue
    }
    _observedLiveRuntimes.add(agent.id)
    _missingRuntimeSince.delete(agent.id)

    if (agent.hibernating) {
      log.info(`agent ${agent.friendly_name || agent.id} is present`)
      agent.hibernating = false
      emitAgentStatus(agent.id, 'present')
      armAgent(agent.id)
      watcherNeedsSync = true
    }
    if (matchedKind && matchedKind !== 'claude') {
      const watchedPath = agentPaths.get(agent.id)
      const watcher = watchedPath ? pathWatchers.get(watchedPath) : null
      if (!watchedPath || !watcher) {
        watcherNeedsSync = true
      } else if (watcher.harnessKind !== matchedKind) {
        watcherNeedsSync = true
      }
    }
    aliveAgentIds.push(agent.id)
  }

  if (watcherNeedsSync) {
    void syncSessionWatchers(agents).catch(e => log.error(`syncSessionWatchers failed: ${e.stack || e.message}`))
  }

  // Goose turn-end auto-kick — bot supervision, deliberately kept on this slow
  // sweep, SEPARATE from the shared status state machine. scanArmedStatus() now
  // owns agent-thinking / agent-compacting for EVERY harness (goose included via
  // its classifier), so this pass no longer emits status — it only nudges an
  // idle/stuck goose that has undelivered work. It keeps its own freeze-tracking
  // map (_prevGooseLive) so it never contends with the display classifier state.
  for (const agent of candidateAgents) {
    if (agent.hibernating) continue
    if (harnessForAgent(agent).kind !== 'goose') continue
    try {
      const { stdout: pane } = await execFileP('tmux',
        [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-S', `-${THINKING_SCAN_LINES}`],
        { timeout: 3000, encoding: 'utf8' })
      const paneBottom = pane.split('\n').slice(-THINKING_SCAN_LINES).join('\n')
      const { status, live } = resolveGooseStatus(paneBottom, _prevGooseLive.get(agent.id), Date.now())
      if (live) _prevGooseLive.set(agent.id, live)
      else _prevGooseLive.delete(agent.id)
      await maybeKickGoose(agent, status, {
        sendText: gooseKickSend, execFileP, log, stateMap: _gooseKickState,
      })
    } catch {
      // capture-pane failed (tmux session gone / transient churn) — skip this
      // goose this sweep; the next sweep retries. A genuinely dead session is
      // handled by the death/hibernate path above, so the recovery here is simply
      // to move on to the next agent.
      continue
    }
  }

  sendMsg({ type: 'agent-liveness', agent_ids: aliveAgentIds, checked_agent_ids: checkedAgentIds })
}

// ---------------------------------------------------------------------------
// Shared agent status state machine (every harness). The daemon OWNS these
// transitions; server/client/bots consume the emitted edges. `armed` is a watch
// state (an agent earns frequent pane pulls when it shows activity) and is never
// displayed. `thinking`/`compacting` are derived ONLY from the pane.
// ---------------------------------------------------------------------------

// Emit the agent-thinking edge with anti-flicker hysteresis on the idle side: a
// single missed spinner frame must not fabricate a turn end. The server holds
// _thinkingState until our explicit false edge (no TTL), so it consumes edges,
// not per-scan resends; the true->false edge is what becomes turn_ended.
function emitThinkingEdge(agentId, isThinking) {
  const d = decideThinkingEdge(
    _prevThinking.get(agentId) === true,
    _idleScans.get(agentId) || 0,
    isThinking,
    IDLE_CONFIRM_SCANS,
  )
  _prevThinking.set(agentId, d.prev)
  if (d.idleCount) _idleScans.set(agentId, d.idleCount)
  else _idleScans.delete(agentId)
  if (d.emit !== null) sendMsg({ type: 'agent-thinking', agentId, thinking: d.emit })
  return d.prev
}

function emitCompactingEdge(agentId, isCompacting) {
  if (isCompacting !== (_prevCompacting.get(agentId) === true)) {
    _prevCompacting.set(agentId, isCompacting)
    sendMsg({ type: 'agent-compacting', agentId, compacting: isCompacting })
  }
  return isCompacting
}

// Pull one armed agent's pane and emit its real status. All harnesses share this
// path; the only per-harness branch is classifyPane(). Returns whether the agent
// is busy (thinking/compacting) so the loop can keep it armed or let it disarm.
async function scanAgentPaneStatus(agent) {
  let pane
  try {
    const { stdout } = await execFileP('tmux',
      [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-S', `-${THINKING_SCAN_LINES}`],
      { timeout: 3000, encoding: 'utf8' })
    pane = stdout
  } catch {
    // Capture failed (session gone / tmux hiccup). Feed the idle side so a truly
    // dead pane resolves to thinking:false via hysteresis; a one-off miss is
    // absorbed by the 2-scan guard.
    const effectiveThinking = emitThinkingEdge(agent.id, false)
    const effectiveCompacting = emitCompactingEdge(agent.id, false)
    if (!effectiveThinking && !effectiveCompacting) emitAgentStatus(agent.id, 'idle')
    return { busy: false }
  }
  const c = classifyPane(harnessForAgent(agent).kind, pane, _classifierState.get(agent.id) || null, Date.now())
  if (c.state) _classifierState.set(agent.id, c.state)
  else _classifierState.delete(agent.id)

  const effectiveThinking = emitThinkingEdge(agent.id, c.thinking)
  const effectiveCompacting = emitCompactingEdge(agent.id, c.compacting)

  const statusState = c.approval
    ? 'needs_terminal_attention'
    : effectiveCompacting
      ? 'compacting'
      : effectiveThinking
        ? 'thinking'
        : 'idle'
  emitAgentStatus(agent.id, statusState)

  if (c.approval) {
    if (c.approvalFp !== _prevApprovalFP.get(agent.id)) {
      _prevApprovalFP.set(agent.id, c.approvalFp)
      sendMsg({ type: 'terminal_attention', agent_id: agent.id, reason: 'permission prompt', text: 'permission prompt' })
    }
  } else {
    _prevApprovalFP.delete(agent.id)
  }
  return { busy: c.thinking || c.compacting }
}

// The frequent loop: pull each armed agent's pane (~STATUS_SCAN_MS), keep it armed
// while busy, disarm once it has sat idle past ARM_LINGER_MS. Bounded to the few
// agents actually working — idle / un-armed agents are never pulled.
async function scanArmedStatus() {
  if (!_serverReady || !_rws?.connected) return
  if (!_armedSince.size) return
  const now = Date.now()
  for (const agentId of [..._armedSince.keys()]) {
    const agent = agents.find(a => a.id === agentId)
    if (!agent || agent.dead || agent.human || agent.hibernating || !agent.tmux_session) {
      disarmAgent(agentId)
      continue
    }
    let busy = false
    try { ({ busy } = await scanAgentPaneStatus(agent)) } catch { busy = false }
    if (busy) {
      _armedSince.set(agentId, now)
    } else if (shouldDisarm(now, _armedSince.get(agentId) || 0, busy, ARM_LINGER_MS)) {
      disarmAgent(agentId)
    }
  }
}

async function rpcResolveFile({ path: filePath, cwd, server_url }) {
  const abs = resolveFilePath(filePath, cwd)
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`)
  const serverBase = server_url || getServerUrl()
  return await uploadFileToServer(abs, serverBase)
}

async function rpcRechat({ text, cwd, server_url }) {
  const serverBase = server_url || getServerUrl()
  return await processMessageText(text, cwd, serverBase)
}

async function rpcMaterializeAttachment({ event_id, attachment_id, source_agent, server_url, url, name, size, sha256 }) {
  if (!url) throw new Error('attachment url required')
  if (Number.isFinite(Number(size)) && Number(size) > MATERIALIZATION_MAX_BYTES) {
    throw new Error(`attachment exceeds max size (${size} > ${MATERIALIZATION_MAX_BYTES})`)
  }
  const serverBase = server_url || getFleetServerUrl()
  const target = new URL(url, serverBase).toString()
  const res = await fetch(target, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`attachment fetch failed: HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MATERIALIZATION_MAX_BYTES) {
    throw new Error(`attachment exceeds max size (${len} > ${MATERIALIZATION_MAX_BYTES})`)
  }
  const ab = await res.arrayBuffer()
  return await materializeAttachmentBytes({
    bytes: Buffer.from(ab),
    eventId: event_id,
    attachmentId: attachment_id,
    sourceAgent: source_agent,
    name,
    expectedSha256: sha256 || null,
  })
}

// Kill the local playwright chromium process that owns a given TCP source
// port. Called by the server's zombie reaper when a /sync/ or /ws/fleet
// connection has been idle for too long.
//
// Discriminator: playwright launches the system Google Chrome binary with
// a temp profile path that always contains "playwright_chromiumdev_profile".
// The user's real Chrome uses their normal ~/Library profile dir. Anything
// that doesn't match the playwright signature in its `ps args=` output is
// refused — the user's real browser must be safe.
async function rpcKillOrphanChromium({ port }) {
  if (!port) return { killed: false, reason: 'no port' }
  let lsofOut = ''
  try {
    const { stdout } = await execFileP('lsof',
      ['-nP', '-iTCP:' + port, '-sTCP:ESTABLISHED', '-F', 'pcn'],
      { timeout: 5000, encoding: 'utf8' })
    lsofOut = stdout
  } catch (e) {
    // lsof exits non-zero when no rows match; nothing to kill.
    return { killed: false, reason: 'no process holds port ' + port }
  }
  // Parse -F pcn output. Each record starts with p<pid>, followed by
  // c<command> and one or more n<conn> lines.
  const records = []
  let cur = null
  for (const line of lsofOut.split('\n')) {
    if (!line) continue
    const k = line[0], v = line.slice(1)
    if (k === 'p') { if (cur) records.push(cur); cur = { pid: v, names: [] } }
    else if (k === 'c' && cur) cur.command = v
    else if (k === 'n' && cur) cur.names.push(v)
  }
  if (cur) records.push(cur)

  // Match rows where the LOCAL endpoint is :<port> (i.e. that PID owns the
  // outgoing connection from this port). Format: "addr:localPort->addr:remotePort"
  const localTag = ':' + port + '->'
  const owners = []
  for (const r of records) {
    if (r.names.some(n => n.includes(localTag))) owners.push(r)
  }
  if (owners.length === 0) {
    return { killed: false, reason: `no local owner of port ${port}` }
  }

  // Walk up to the top of any chromium process tree (the playwright main
  // browser process), so killing it cleans up all the renderer children.
  // Verify the binary path includes "ms-playwright" — anything else is a
  // process the user started and we must not touch it.
  const psArgs = async (pid) => {
    try {
      const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'args='],
        { timeout: 2000, encoding: 'utf8' })
      return stdout.trim()
    } catch { return '' }
  }
  const psPpid = async (pid) => {
    try {
      const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'ppid='],
        { timeout: 2000, encoding: 'utf8' })
      const v = parseInt(stdout.trim(), 10)
      return Number.isFinite(v) ? v : null
    } catch { return null }
  }
  const isPlaywright = (args) => {
    // Either the playwright-bundled chromium cache, or the system Chrome
    // launched with a playwright-style temp profile path (playwright-mcp's
    // pattern). Skip's regular Chrome would not match either.
    return args.includes('playwright_chromiumdev_profile') ||
           args.includes('ms-playwright')
  }

  for (const owner of owners) {
    let pid = parseInt(owner.pid, 10)
    let args = await psArgs(pid)
    if (!isPlaywright(args)) {
      // Not a playwright chromium — skip. (Could be node, ssh tunnel,
      // user's real browser, etc.) Defense in depth against killing the
      // wrong thing.
      continue
    }
    // Walk up while the parent is also playwright chromium.
    while (true) {
      const ppid = await psPpid(pid)
      if (!ppid || ppid <= 1) break
      const pargs = await psArgs(ppid)
      if (!isPlaywright(pargs)) break
      pid = ppid
      args = pargs
    }
    try {
      process.kill(pid, 'SIGKILL')
      // Best-effort: also nuke any orphaned children that didn't go down
      // with the parent. pkill returns non-zero when no match; ignore.
      try {
        await execFileP('pkill', ['-9', '-P', String(pid)], { timeout: 2000 })
      } catch {}
      return { killed: true, pid, binary: args.slice(0, 200) }
    } catch (e) {
      return { killed: false, reason: `kill ${pid}: ${e.message}` }
    }
  }
  return { killed: false, reason: 'no playwright owner among port holders' }
}

// ─── Memory pressure ────────────────────────────────────────────────

function getMemoryPressure() {
  const total = os.totalmem()
  const free = os.freemem()
  return 1 - free / total  // 0 = empty, 1 = full
}

// Scale an idle timeout by memory pressure. At ≥90% usage the timeout
// drops to 1/10 of the base; below 50% usage it stays at the full base.
function pressureScaledTimeout(baseMs) {
  const p = getMemoryPressure()
  if (p < 0.5) return baseMs
  const scale = Math.max(0.1, 1 - (p - 0.5) / 0.4)  // linear 1→0.1 over 50%→90%
  return Math.round(baseMs * scale)
}

// ─── Process → agent attribution ───────────────────────────────────
// Walk up the ppid chain to find a `claude` process. Extract --resume
// session ID or tmux session name, match against the agent list.

async function getProcessInfo(pid) {
  try {
    const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'pid=,ppid=,args='],
      { timeout: 2000, encoding: 'utf8' })
    const m = stdout.trim().match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) return null
    return { pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), args: m[3] }
  } catch { return null }
}

async function attributeToAgent(pid) {
  let cur = pid
  const visited = new Set()
  for (let depth = 0; depth < 10; depth++) {
    if (visited.has(cur) || cur <= 1) break
    visited.add(cur)
    const info = await getProcessInfo(cur)
    if (!info) break
    if (info.args.includes('claude') && !info.args.includes('playwright')) {
      const resumeMatch = info.args.match(/--resume\s+([a-f0-9-]+)/)
      if (resumeMatch) {
        const sessionId = resumeMatch[1]
        const agent = agents.find(a => a.session_id === sessionId)
        if (agent) return { id: agent.id, name: agent.name || agent.id.slice(0, 8) }
      }
      const agentByTmux = agents.find(a => a.tmux_session && info.args.includes(a.tmux_session))
      if (agentByTmux) return { id: agentByTmux.id, name: agentByTmux.name || agentByTmux.id.slice(0, 8) }
    }
    cur = info.ppid
  }
  return null
}

async function attributeViteByCwd(pid) {
  try {
    const { stdout } = await execFileP('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { timeout: 2000, encoding: 'utf8' })
    const cwdLine = stdout.split('\n').find(l => l.startsWith('n/'))
    if (!cwdLine) return null
    const cwd = cwdLine.slice(1)
    const wtMatch = cwd.match(/\.worktrees\/([^/]+)/)
    if (wtMatch) return wtMatch[1]
  } catch {}
  return null
}

// ─── Vite reaper — kill dev servers nobody's using ──────────────────
const VITE_IDLE_THRESHOLD_MS = parseInt(process.env.REAPER_VITE_MS, 10) || 10 * 60 * 1000
// Floor the pressure-scaled timeout: even at 99% memory the threshold collapsed
// to ~1 min, which SIGKILLed dev servers during a normal edit pause (the "idle"
// signal is just "no browser currently on the port" — true for most of an agent's
// edit loop). Never reap a dev server with less than this much idle, so a brief
// pause can't lose an in-use server; a genuinely abandoned one still gets reaped.
const VITE_MIN_IDLE_MS = parseInt(process.env.REAPER_VITE_MIN_MS, 10) || 5 * 60 * 1000
const VITE_SWEEP_INTERVAL_MS = parseInt(process.env.REAPER_VITE_INTERVAL_MS, 10) || 60 * 1000
const _viteLastClient = new Map()
const BROWSER_NAME_RE = /Google|Chrome|Chromium|Firefox|Safari|WebKit/i

function isViteArgs(args) {
  if (!args.startsWith('node ')) return false
  return /[\/\\]vite(\.js)?(\s|$)/.test(args)
}

async function findListeningPorts(pid) {
  try {
    const { stdout } = await execFileP('lsof',
      ['-a', '-nP', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-F', 'n'],
      { timeout: 3000, encoding: 'utf8' })
    const ports = []
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('n')) continue
      const m = line.slice(1).match(/:(\d+)$/)
      if (m) ports.push(parseInt(m[1], 10))
    }
    return [...new Set(ports)]
  } catch { return [] }
}

async function listVites() {
  let psOut = ''
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,args='], { timeout: 5000, encoding: 'utf8' })
    psOut = stdout
  } catch { return [] }
  const vites = []
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    const args = m[2]
    if (!isViteArgs(args)) continue
    const ports = await findListeningPorts(pid)
    if (ports.length > 0) vites.push({ pid, ports, args })
  }
  return vites
}

async function viteHasBrowserClient(port) {
  let lsofOut = ''
  try {
    const { stdout } = await execFileP('lsof',
      ['-nP', '-iTCP:' + port, '-sTCP:ESTABLISHED', '-F', 'pcn'],
      { timeout: 3000, encoding: 'utf8' })
    lsofOut = stdout
  } catch { return false }
  const records = []
  let cur = null
  for (const line of lsofOut.split('\n')) {
    if (!line) continue
    const k = line[0], v = line.slice(1)
    if (k === 'p') { if (cur) records.push(cur); cur = { pid: v, names: [] } }
    else if (k === 'c' && cur) cur.command = v
    else if (k === 'n' && cur) cur.names.push(v)
  }
  if (cur) records.push(cur)
  const remoteTag = ':' + port
  for (const r of records) {
    if (!r.names.some(n => n.endsWith(remoteTag))) continue
    if (BROWSER_NAME_RE.test(r.command || '')) return true
  }
  return false
}

async function reapVites() {
  const vites = await listVites()
  const now = Date.now()
  const killed = []
  for (const v of vites) {
    let hasClient = false
    for (const port of v.ports) {
      if (await viteHasBrowserClient(port)) { hasClient = true; break }
    }
    if (hasClient) {
      _viteLastClient.set(v.pid, now)
      continue
    }
    if (!_viteLastClient.has(v.pid)) _viteLastClient.set(v.pid, now)
    const idleMs = now - _viteLastClient.get(v.pid)
    const threshold = Math.max(VITE_MIN_IDLE_MS, pressureScaledTimeout(VITE_IDLE_THRESHOLD_MS))
    if (idleMs > threshold) {
      try {
        process.kill(v.pid, 'SIGKILL')
        console.log(`[vite-reaper] killed pid=${v.pid} ports=${v.ports.join(',')} idle=${Math.round(idleMs / 60000)}m pressure=${(getMemoryPressure() * 100).toFixed(0)}%`)
        const attr = await attributeToAgent(v.pid).catch(() => null)
        killed.push({ pid: v.pid, kind: 'vite', ts: now, reason: `idle ${Math.round(idleMs / 60000)}m`, agent: attr?.name || null })
      } catch (e) {
        console.log(`[vite-reaper] kill pid=${v.pid} failed: ${e.message}`)
      }
      _viteLastClient.delete(v.pid)
    }
  }
  const liveVites = new Set(vites.map(v => v.pid))
  for (const pid of [..._viteLastClient.keys()]) {
    if (!liveVites.has(pid)) _viteLastClient.delete(pid)
  }
  return { vites, killed }
}

// ─── Playwright reaper — kill orphan chromium browsers ──────────────
const PW_IDLE_THRESHOLD_MS = parseInt(process.env.REAPER_PW_MS, 10) || 5 * 60 * 1000
const _pwLastSeen = new Map()

async function listPlaywrightBrowsers() {
  let psOut = ''
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,args='], { timeout: 5000, encoding: 'utf8' })
    psOut = stdout
  } catch { return [] }
  const browsers = []
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    const ppid = parseInt(m[2], 10)
    const args = m[3]
    if (!isPlaywrightBrowserArgs(args)) continue
    if (args.includes('--type=')) continue
    // Skip the playwright-cli session DAEMON itself (`run-cli-server`). Its
    // --daemon-session path lives under .../ms-playwright/..., so it matches the
    // browser filter above — but it's a node daemon, not a browser. It's detached
    // (ppid=1) so the orphan heuristic always flags it, and killing it orphans
    // the Chrome it owns and closes the session — the recurring "shared browser
    // keeps dying / nobody can use pw" bug. The reaper still reaps real orphan Chrome.
    if (args.includes('run-cli-server')) continue
    // Never reap the canonical `tlda-dev pw` shared browser. It's a launcher-less
    // daemon by design (persists until `tlda pw reap`), so the orphan heuristic
    // always flags it — and under memory pressure the threshold collapses to ~30s,
    // killing it every minute, which strands agents on a blank data: tab.
    if (args.includes('ud-shared-chrome')) continue
    browsers.push({ pid, ppid, args })
  }
  return browsers
}

async function isPlaywrightControllerAlive(ppid) {
  if (!ppid || ppid <= 1) return false
  try {
    const { stdout } = await execFileP('ps', ['-p', String(ppid), '-o', 'args='],
      { timeout: 2000, encoding: 'utf8' })
    const args = stdout.trim()
    return args.includes('playwright') || args.includes('node')
  } catch { return false }
}

async function reapPlaywright() {
  const browsers = await listPlaywrightBrowsers()
  if (browsers.length === 0) return { browsers: [], killed: [] }
  const now = Date.now()
  const threshold = pressureScaledTimeout(PW_IDLE_THRESHOLD_MS)
  const killed = []
  const enriched = []
  let orphanCount = 0
  for (const b of browsers) {
    const controllerAlive = await isPlaywrightControllerAlive(b.ppid)
    const idleMs = controllerAlive ? 0 : (now - (_pwLastSeen.get(b.pid) || now))
    enriched.push({ pid: b.pid, ppid: b.ppid, controllerAlive, idleMs })
    if (controllerAlive) {
      _pwLastSeen.set(b.pid, now)
      continue
    }
    orphanCount++
    if (!_pwLastSeen.has(b.pid)) _pwLastSeen.set(b.pid, now)
    const orphanMs = now - _pwLastSeen.get(b.pid)
    if (orphanMs > threshold) {
      try {
        process.kill(b.pid, 'SIGKILL')
        try { await execFileP('pkill', ['-9', '-P', String(b.pid)], { timeout: 2000 }) } catch {}
        console.log(`[pw-reaper] killed pid=${b.pid} orphan=${Math.round(orphanMs / 1000)}s threshold=${Math.round(threshold / 1000)}s pressure=${(getMemoryPressure() * 100).toFixed(0)}%`)
        const attr = await attributeToAgent(b.pid).catch(() => null)
        killed.push({ pid: b.pid, kind: 'playwright', ts: now, reason: `orphan ${Math.round(orphanMs / 1000)}s`, agent: attr?.name || null })
      } catch (e) {
        console.log(`[pw-reaper] kill pid=${b.pid} failed: ${e.message}`)
      }
      _pwLastSeen.delete(b.pid)
    } else {
      console.log(`[pw-reaper] orphan pid=${b.pid} age=${Math.round(orphanMs / 1000)}s waiting (threshold=${Math.round(threshold / 1000)}s)`)
    }
  }
  const livePids = new Set(browsers.map(b => b.pid))
  for (const pid of [..._pwLastSeen.keys()]) {
    if (!livePids.has(pid)) _pwLastSeen.delete(pid)
  }
  return { browsers: enriched, killed }
}

// ─── Agent-process reaper — kill orphaned harness runtimes ─────────
const AGENT_PROCESS_ORPHAN_MS = parseInt(process.env.REAPER_AGENT_PROCESS_MS, 10) || 30 * 60 * 1000
const AGENT_PROCESS_TERM_GRACE_MS = parseInt(process.env.REAPER_AGENT_PROCESS_TERM_GRACE_MS, 10) || 5000

async function listAgentHarnessProcesses() {
  let psOut = ''
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,etimes=,args='], { timeout: 5000, encoding: 'utf8' })
    psOut = stdout
  } catch {
    return []
  }
  const now = Date.now()
  const procs = []
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    const ppid = parseInt(m[2], 10)
    const ageSeconds = parseInt(m[3], 10)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(ageSeconds)) continue
    procs.push({ pid, ppid, ageMs: ageSeconds * 1000, startedAt: now - ageSeconds * 1000, args: m[4] })
  }
  return procs
}

async function liveTmuxSessionNames() {
  try {
    const { stdout } = await execFileP('tmux', [...TMUX_ARGS, 'list-sessions', '-F', '#S'], { timeout: 3000, encoding: 'utf8' })
    return new Set(stdout.split('\n').map(s => s.trim()).filter(Boolean))
  } catch {
    return new Set()
  }
}

async function liveTmuxPaneProcessPids(processes) {
  let paneOut = ''
  try {
    const { stdout } = await execFileP('tmux', [...TMUX_ARGS, 'list-panes', '-a', '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf8' })
    paneOut = stdout
  } catch {
    return new Set()
  }
  const roots = paneOut.split('\n').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite)
  const childrenByPpid = new Map()
  for (const proc of processes) {
    const ppid = Number(proc.ppid)
    if (!Number.isFinite(ppid)) continue
    if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, [])
    childrenByPpid.get(ppid).push(Number(proc.pid))
  }
  const protectedPids = new Set()
  const stack = [...roots]
  while (stack.length) {
    const pid = stack.pop()
    if (protectedPids.has(pid)) continue
    protectedPids.add(pid)
    for (const child of (childrenByPpid.get(pid) || [])) stack.push(child)
  }
  return protectedPids
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return !processAlive(pid)
}

async function terminateOrphanAgentProcess(proc) {
  try {
    process.kill(proc.pid, 'SIGTERM')
    try { await execFileP('pkill', ['-TERM', '-P', String(proc.pid)], { timeout: 2000 }) } catch {
      // Expected when the harness has no child processes left to signal.
    }
  } catch (e) {
    if (!processAlive(proc.pid)) return { ok: true, signal: 'already-exited' }
    throw e
  }
  if (await waitForProcessExit(proc.pid, AGENT_PROCESS_TERM_GRACE_MS)) return { ok: true, signal: 'SIGTERM' }
  process.kill(proc.pid, 'SIGKILL')
  try { await execFileP('pkill', ['-9', '-P', String(proc.pid)], { timeout: 2000 }) } catch {
    // Expected when the harness has no child processes left to kill.
  }
  return { ok: true, signal: 'SIGKILL' }
}

async function reapOrphanAgentProcesses() {
  const processes = await listAgentHarnessProcesses()
  const [liveSessions, protectedPids] = await Promise.all([
    liveTmuxSessionNames(),
    liveTmuxPaneProcessPids(processes),
  ])
  const { selected, skipped } = selectOrphanAgentProcesses({
    processes,
    agents,
    liveTmuxSessions: liveSessions,
    protectedPids,
    minAgeMs: AGENT_PROCESS_ORPHAN_MS,
  })
  const killed = []
  const failed = []
  for (const proc of selected) {
    try {
      const result = await terminateOrphanAgentProcess(proc)
      console.log(`[agent-reaper] killed pid=${proc.pid} agent=${proc.agentName || proc.agentId} harness=${proc.harness} tmux=${proc.tmuxSession || '-'} age=${Math.round(proc.ageMs / 60000)}m signal=${result.signal} pressure=${(getMemoryPressure() * 100).toFixed(0)}%`)
      killed.push({
        pid: proc.pid,
        kind: 'agent-process',
        ts: Date.now(),
        reason: `orphan agent process ${Math.round(proc.ageMs / 60000)}m`,
        agent: proc.agentName || null,
        agentId: proc.agentId || null,
        harness: proc.harness,
        signal: result.signal,
      })
    } catch (e) {
      console.log(`[agent-reaper] kill pid=${proc.pid} agent=${proc.agentName || proc.agentId} failed: ${e.message}`)
      failed.push({
        pid: proc.pid,
        agent: proc.agentName || null,
        agentId: proc.agentId || null,
        error: e.message,
      })
    }
  }
  return {
    processes: selected.map(proc => ({
      pid: proc.pid,
      ppid: proc.ppid,
      ageMs: proc.ageMs,
      harness: proc.harness,
      agent: proc.agentName || null,
      agentId: proc.agentId || null,
      tmuxSession: proc.tmuxSession || null,
    })),
    killed,
    failed,
    skippedCount: skipped.length,
  }
}

async function getMemoryByAgent() {
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { timeout: 5000, encoding: 'utf8' })
    const procs = []
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      const rss = parseInt(m[3], 10) * 1024
      if (rss < 10 * 1024 * 1024) continue
      const comm = m[4].trim().split('/').pop()
      procs.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), rss, name: comm })
    }
    const attrs = await Promise.all(procs.map(async p => {
      const match = await attributeToAgent(p.pid).catch(() => null)
      return { ...p, agent: match?.name || null }
    }))
    const groups = new Map()
    for (const p of attrs) {
      const key = p.agent || 'system'
      if (!groups.has(key)) groups.set(key, { agent: key, totalRss: 0, processes: [] })
      const g = groups.get(key)
      g.totalRss += p.rss
      g.processes.push({ name: p.name, rss: p.rss })
    }
    const result = [...groups.values()]
    result.sort((a, b) => b.totalRss - a.totalRss)
    return result
  } catch { return [] }
}

// ─── Combined reaper sweep with status broadcast ──────────────────
let _reaperTimer = null
let _sweepCount = 0
const _recentKills = []  // last 10 kills across sweeps
const MAX_RECENT_KILLS = 10

async function reaperSweep() {
  const viteResult = await reapVites().catch(e => { console.error('[vite-reaper] sweep failed:', e.message); return { vites: [], killed: [] } })
  const pwResult = await reapPlaywright().catch(e => { console.error('[pw-reaper] sweep failed:', e.message); return { browsers: [], killed: [] } })
  const agentProcessResult = await reapOrphanAgentProcesses().catch(e => { console.error('[agent-reaper] sweep failed:', e.message); return { processes: [], killed: [], failed: [], skippedCount: 0 } })
  _sweepCount++

  const allKills = [...(viteResult.killed || []), ...(pwResult.killed || []), ...(agentProcessResult.killed || [])]
  _recentKills.push(...allKills)
  while (_recentKills.length > MAX_RECENT_KILLS) _recentKills.shift()

  const now = Date.now()
  const pressure = getMemoryPressure()

  // Attribute processes to agents (in parallel for speed)
  const viteAttrs = await Promise.all((viteResult.vites || []).map(async v => {
    const worktree = await attributeViteByCwd(v.pid)
    const agentMatch = await attributeToAgent(v.pid)
    return { pid: v.pid, agent: agentMatch?.name || worktree || null, agentId: agentMatch?.id || null }
  }))
  const browserAttrs = await Promise.all((pwResult.browsers || []).map(async b => {
    const agentMatch = await attributeToAgent(b.pid)
    return { pid: b.pid, agent: agentMatch?.name || null, agentId: agentMatch?.id || null }
  }))
  const viteAgentMap = Object.fromEntries(viteAttrs.map(a => [a.pid, { agent: a.agent, agentId: a.agentId }]))
  const browserAgentMap = Object.fromEntries(browserAttrs.map(a => [a.pid, { agent: a.agent, agentId: a.agentId }]))

  const viteSnap = (viteResult.vites || []).map(v => ({
    pid: v.pid,
    ports: v.ports,
    hasClient: _viteLastClient.has(v.pid) && (now - _viteLastClient.get(v.pid)) < 1000,
    idleMs: _viteLastClient.has(v.pid) ? now - _viteLastClient.get(v.pid) : 0,
    agent: viteAgentMap[v.pid]?.agent || null,
    agentId: viteAgentMap[v.pid]?.agentId || null,
  }))

  const memoryByAgent = await getMemoryByAgent().catch(() => [])

  sendMsg({
    type: 'reaper-status',
    data: {
      pressure,
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
      memoryByAgent,
      vites: viteSnap,
      browsers: (pwResult.browsers || []).map(b => ({
        ...b,
        agent: browserAgentMap[b.pid]?.agent || null,
        agentId: browserAgentMap[b.pid]?.agentId || null,
      })),
      agentProcesses: agentProcessResult.processes || [],
      agentProcessFailures: agentProcessResult.failed || [],
      agentProcessSkippedCount: agentProcessResult.skippedCount || 0,
      lastKills: _recentKills.slice(),
      thresholds: { viteMs: VITE_IDLE_THRESHOLD_MS, pwMs: PW_IDLE_THRESHOLD_MS, agentProcessMs: AGENT_PROCESS_ORPHAN_MS },
      scaledThresholds: { viteMs: pressureScaledTimeout(VITE_IDLE_THRESHOLD_MS), pwMs: pressureScaledTimeout(PW_IDLE_THRESHOLD_MS), agentProcessMs: AGENT_PROCESS_ORPHAN_MS },
      sweepCount: _sweepCount,
      lastSweep: now,
    },
  })
}

function startReapers() {
  if (_reaperTimer) return
  setTimeout(() => {
    reaperSweep()
    _reaperTimer = setInterval(reaperSweep, VITE_SWEEP_INTERVAL_MS)
    _reaperTimer.unref?.()
  }, 10_000)
}

// ─── Reaper RPC handlers ──────────────────────────────────────────
async function rpcReaperKill({ pid }) {
  if (!pid) throw new Error('missing pid')
  const attr = await attributeToAgent(pid).catch(() => null)
  try {
    process.kill(pid, 'SIGKILL')
    try { await execFileP('pkill', ['-9', '-P', String(pid)], { timeout: 2000 }) } catch {}
    _recentKills.push({ pid, kind: 'manual', ts: Date.now(), reason: 'manual kill', agent: attr?.name || null })
    while (_recentKills.length > MAX_RECENT_KILLS) _recentKills.shift()
    return { killed: true, pid }
  } catch (e) {
    return { killed: false, error: e.message }
  }
}

async function rpcReaperSweep() {
  await reaperSweep()
  return { ok: true, sweepCount: _sweepCount }
}

const RPC_HANDLERS = {
  'send-key': rpcSendKey,
  'send-text': rpcSendText,
  'capture-pane': rpcCapturePane,
  'interrupt': rpcInterrupt,
  'soft-interrupt': rpcSoftInterrupt,
  'check-alive': rpcCheckAlive,
  'list-sessions': rpcListSessions,
  'kick': rpcKick,
  'kill-session': rpcKillSession,
  'start-terminal-watch': rpcStartTerminalWatch,
  'stop-terminal-watch': rpcStopTerminalWatch,
  'terminal-resize': rpcTerminalResize,
  'terminal-input': rpcTerminalInput,
  'spawn': rpcSpawn,
  'spawn-availability': rpcSpawnAvailability,
  'resolve-file': rpcResolveFile,
  'rechat': rpcRechat,
  'materialize-attachment': rpcMaterializeAttachment,
  'kill-orphan-chromium': rpcKillOrphanChromium,
  'write-backing-file': rpcWriteBackingFile,
  'mirror-shadow-ref': rpcMirrorShadowRef,
  'reaper-kill': rpcReaperKill,
  'reaper-sweep': rpcReaperSweep,
}

async function handleRpc(msg) {
  const { id, op } = msg
  const handler = RPC_HANDLERS[op]
  if (!handler) {
    sendMsg({ type: 'rpc-reply', id, error: `unknown op: ${op}` })
    return
  }
  try {
    const result = await handler(msg)
    sendMsg({ type: 'rpc-reply', id, result })
  } catch (e) {
    sendMsg({ type: 'rpc-reply', id, error: e.message || String(e) })
  }
}

// ---------- WS connection ----------

const CRITICAL_MSG_TYPES = new Set(['terminal-dead', 'terminal_attention', 'spawn-startup-failed'])
let _droppedCount = 0
let _droppedWarnAt = 0
function sendMsg(obj) {
  if (_rws?.send(obj)) return true
  _droppedCount++
  if (obj?.type && CRITICAL_MSG_TYPES.has(obj.type)) {
    if (persistDeadLetter(DEAD_LETTER_FILE, obj, { log })) {
      log.warn(`WS down — persisted ${obj.type} for ${obj.agent_id || 'unknown'} to dead-letter file`)
    }
  }
  const now = Date.now()
  if (now - _droppedWarnAt > 5000) {
    log.warn(`dropping messages (ws not open); dropped ${_droppedCount} since last warn; sample type=${obj?.type}`)
    _droppedCount = 0
    _droppedWarnAt = now
  }
  return false
}

function sendMsgWithReply(obj, { timeoutMs = 15000 } = {}) {
  const id = `daemon:${process.pid}:${++_daemonRequestSeq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDaemonReplies.delete(id)
      reject(new Error(`daemon request timed out: ${obj?.type || 'unknown'}`))
    }, timeoutMs)
    pendingDaemonReplies.set(id, { resolve, reject, timer })
    if (!sendMsg({ ...obj, id })) {
      clearTimeout(timer)
      pendingDaemonReplies.delete(id)
      reject(new Error('daemon websocket is not connected'))
    }
  })
}

function teardownWatchers() {
  for (const [, pw] of pathWatchers) stopJsonlTail(pw, 'daemon watcher teardown')
  pathWatchers.clear()
  childWatchers.clear()
  agentPaths.clear()
  for (const [, entry] of jsonlDirWatchers) {
    try {
      const closed = entry.watcher.close()
      Promise.resolve(closed).catch(e => {
        // Best-effort teardown; daemon shutdown must continue after a Chokidar close rejection.
        log.warn(`chokidar teardown close failed: ${e?.message || e}`)
      })
    } catch (e) {
      // Best-effort teardown; daemon shutdown must continue after a Chokidar close throw.
      log.warn(`chokidar teardown close threw: ${e?.message || e}`)
    }
  }
  jsonlDirWatchers.clear()
  // Source watchers survive WS disconnects — they detect file changes
  // independently and queue them for the next connected window.
  for (const [, s] of terminalWatchPtys) { s.alive = false; try { s.pty.kill() } catch {} }
  terminalWatchPtys.clear()
  for (const [, entry] of backingWatchers) closeWatcher(entry.watcher, `${entry.project}:${entry.backingName}`)
  backingWatchers.clear()
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
      _missingSessionSince.clear()
      _missingRuntimeSince.clear()
      teardownWatchers()
    },
  })
  _rws.connect()
}

function handleServerMessage(msg) {
  if (msg?.id && pendingDaemonReplies.has(msg.id)) {
    const pending = pendingDaemonReplies.get(msg.id)
    pendingDaemonReplies.delete(msg.id)
    clearTimeout(pending.timer)
    if (msg.error) pending.reject(new Error(msg.error?.message || msg.error))
    else pending.resolve(msg.result)
    return
  }
  if (msg.type === 'daemon-welcome') {
    _serverReady = true
    agents = msg.agents || []
    projects = msg.projects || []
    syncSessionIdentityNamesFromAgents(agents)
    applyDaemonGrants(permissionLedger, daemonSpawnConfig)
    grantOnMintInfill('daemon-welcome')
    log.info(`welcome: ${agents.length} agents, ${projects.length} projects`)
    const replay = replayDeadLetters(DEAD_LETTER_FILE, message => _rws?.send(message), { log })
    if (replay.replayed || replay.remaining || replay.malformed) {
      log.warn(`dead-letter replay: replayed=${replay.replayed} remaining=${replay.remaining} malformed=${replay.malformed}`)
    }
    _lastSessionWatcherRosterSig = sessionWatcherRosterSignature(agents)
    void syncSessionWatchers(agents).catch(e => log.error(`syncSessionWatchers failed: ${e.stack || e.message}`))
    syncSourceWatchers(projects)
    flushPendingSourceChanges()
    // Periodic death detection — O(1) spawns per cycle (one tmux list-sessions).
    if (!_deathCheckInterval) {
      _deathCheckInterval = setInterval(checkAgentLiveness, DEATH_CHECK_MS)
      setTimeout(checkAgentLiveness, 5000)
    }
    // Fast status state machine — pulls panes only for agents armed by recent
    // activity, so it's bounded to the few agents actually working (1-3s status,
    // accurate turn edges) without a fleet-wide sweep.
    if (!_statusScanInterval) {
      _statusScanInterval = setInterval(scanArmedStatus, STATUS_SCAN_MS)
    }
    // Non-JSONL activity sources. Goose writes to sqlite instead of a Claude/Codex
    // JSONL, so its adapter polls and feeds the same bufferActivity() path.
    if (!_gooseActivityInterval) {
      _gooseActivityInterval = setInterval(() => {
        HARNESS_ADAPTERS.goose.activity.poll(agents, {
          bufferActivity, log, lastSeen: _gooseActivityLastSeen,
          isNoise: (base) => ACTIVITY_NOISE.has(base),
        })
      }, GOOSE_ACTIVITY_MS)
    }
    if (!_autoAcceptStarted) {
      _autoAcceptStarted = true
      startAutoAcceptSweep()
      startOwnerHarvester()
    }
    return
  }
  if (msg.type === 'agents-updated') {
    agents = msg.agents || []
    syncSessionIdentityNamesFromAgents(agents)
    syncSessionWatchersIfRosterChanged('agents-updated')
    return
  }
  if (msg.type === 'projects-updated') {
    projects = msg.projects || []
    syncSourceWatchers(projects)
    return
  }
  if (msg.type === 'active-viewers') {
    // Source watching is chokidar-backed per project now; active viewer updates
    // no longer promote/demote a separate fs.watch layer.
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
    syncBackingWatchers(msg.files || [])
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
  _shuttingDown = true
  saveCursors()
  teardownWatchers()
  try { _ownerHarvester?.kill() } catch { /* already gone */ }
  try { _jsonlIngester?.send?.({ type: 'shutdown' }) } catch { /* already gone */ }
  try { _jsonlIngester?.kill() } catch { /* already gone */ }
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
startReapers()
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
