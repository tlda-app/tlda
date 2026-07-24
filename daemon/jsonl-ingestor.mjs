import chokidar from 'chokidar'
import { fork } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { recordPartialSkillReads } from '../shared/partial-skill-reads.mjs'
import { ledgerSessionId, tailLedgerSessionInput } from '../agent-runtime/ledger-session-tail.mjs'
import { scanFileIdentitySync } from '../agent-runtime/daemon-jsonl-hot-path.mjs'
import { createLocalAgentLedger } from '../agent-launch/local-agent-ledger.mjs'
import {
  codexKnownRolloutIds,
  shouldClaimClaudeWatcher,
  shouldClaimCodexWatcher,
} from '../agent-runtime/daemon-guards.mjs'
import { codexRolloutBelongsToAgent, codexRolloutHasOwnerEvidence, codexRolloutIsTopLevel } from '../agent-runtime/resolve-transcript.mjs'
import { acquireSingletonLock, sessionReaderLockPath } from '../agent-runtime/singleton-lock.mjs'
import {
  ACTIVITY_HEALTH_BOUNDARIES,
  ACTIVITY_HEALTH_OK,
  ACTIVITY_HEALTH_UNAVAILABLE,
  ACTIVITY_HEALTH_UNKNOWN,
} from '../shared/activity-health.mjs'

const DEFAULT_DISPLAY_REPLAY_MAX_BYTES = 256 * 1024
const CATCHUP_DISPLAY_OUTPUT_TYPES = new Set(['activity', 'context', 'qualification', 'terminalChat', 'nativeTask'])
const JSONL_RUNTIME_FAILURE_BOUNDARIES = {
  'start-failed': ACTIVITY_HEALTH_BOUNDARIES.WATCH_START_FAILED,
  error: ACTIVITY_HEALTH_BOUNDARIES.WATCH_RUNTIME_ERROR,
  'ack-failed': ACTIVITY_HEALTH_BOUNDARIES.WATCH_ACK_FAILED,
  'delivery-failed': ACTIVITY_HEALTH_BOUNDARIES.WATCH_DELIVERY_FAILED,
}
const CLOSED_IPC_ERROR_CODES = new Set(['EPIPE', 'ERR_IPC_CHANNEL_CLOSED'])

function isClosedIpcError(e) {
  if (CLOSED_IPC_ERROR_CODES.has(e?.code)) return true
  return /EPIPE|IPC channel closed|channel closed/i.test(String(e?.message || e || ''))
}

export function catchupReplayBoundary({ startOffset = 0, liveOffset = 0, thresholdBytes = DEFAULT_DISPLAY_REPLAY_MAX_BYTES } = {}) {
  if (!Number.isFinite(startOffset) || !Number.isFinite(liveOffset)) return null
  if (!Number.isFinite(thresholdBytes) || thresholdBytes < 0) return null
  return liveOffset - startOffset > thresholdBytes ? liveOffset : null
}

export function shouldSuppressCatchupOutput(output) {
  return CATCHUP_DISPLAY_OUTPUT_TYPES.has(output?.type)
}

export function createCoalescedSyncRunner(run) {
  let running = false
  let pending = null
  let pendingResolvers = []

  async function sync(value) {
    if (running) {
      pending = value
      return new Promise((resolve, reject) => {
        pendingResolvers.push({ resolve, reject })
      })
    }
    running = true
    try {
      await run(value)
    } finally {
      running = false
      if (pending) {
        const next = pending
        const resolvers = pendingResolvers
        pending = null
        pendingResolvers = []
        try {
          await sync(next)
          for (const item of resolvers) item.resolve()
        } catch (e) {
          for (const item of resolvers) item.reject(e)
          throw e
        }
      }
    }
  }

  return { sync }
}

// Historical owner classification answers "which fleet ids appear in this
// file?" It is not a claim that every historical file is the owner's current
// immutable session. Only live/current identity observations may write through
// to the permission ledger.
export function recordSessionOwnersInCache({
  cursors,
  sessionId,
  owners,
  persistIdentity = true,
  recordIdentity = () => {},
  identityInput = owner => ({ fleet_id: owner }),
}) {
  if (!sessionId) return false
  const entry = cursors[sessionId] || (cursors[sessionId] = {})
  const prev = entry.owners || []
  const merged = owners && owners.length ? [...new Set([...prev, ...owners])] : prev
  const changed = !entry.classified || merged.length !== prev.length
  entry.owners = merged
  entry.classified = true
  if (persistIdentity) {
    for (const owner of merged) recordIdentity(identityInput(owner))
  }
  return changed
}

export function jsonlRuntimeFailureActivityHealth(pw, kind, detail = {}) {
  const boundary = JSONL_RUNTIME_FAILURE_BOUNDARIES[kind]
  if (!boundary) throw new Error(`unknown JSONL runtime failure kind: ${kind}`)
  const fallbackReason = detail.error || detail.reason || `${kind} for ${pw?.jsonlPath ? path.basename(pw.jsonlPath) : 'unknown jsonl'}`
  return {
    state: ACTIVITY_HEALTH_UNAVAILABLE,
    boundary,
    reason: detail.error || fallbackReason,
    sessionId: pw?.sessionId || null,
    jsonlPath: pw?.jsonlPath || null,
  }
}

export function sessionIdentitySeatEvent(input = {}, {
  machineId = null,
  envName = null,
  daemonKey = null,
} = {}) {
  const fleetId = input?.fleet_id
  const sessionId = ledgerSessionId(input)
  const effectiveMachineId = input.machine_id || machineId
  const effectiveEnvName = input.env_name || envName
  const effectiveDaemonKey = input.daemon_key || daemonKey || (effectiveMachineId && effectiveEnvName ? `${effectiveMachineId}:${effectiveEnvName}` : null)
  if (!fleetId || !sessionId || !input.harness_kind || !input.model || !input.cwd || !effectiveMachineId || !effectiveEnvName || !effectiveDaemonKey) {
    return null
  }
  const event = {
    type: 'agent-seat',
    agent_id: fleetId,
    session_id: sessionId,
    resume_id: input.resume_id || sessionId,
    kind: input.harness_kind,
    model: input.model,
    cwd: input.cwd,
    machine_id: effectiveMachineId,
    env_name: effectiveEnvName,
    daemon_key: effectiveDaemonKey,
    created_source: input.created_source || 'daemon-session-observed',
  }
  if (input.tmux_session) event.tmux_session = input.tmux_session
  return event
}

export function jsonlWatchEligibility(agent, {
  machineId = null,
  envName = null,
  daemonKey = null,
} = {}) {
  if (!agent?.id) return { ok: false, reason: 'missing agent identity' }
  if (agent.dead) return { ok: false, reason: 'agent is dead' }
  if (agent.human) return { ok: false, reason: 'human rows do not have activity JSONL' }
  if (!daemonKey || !machineId || !envName) return { ok: false, reason: 'daemon identity incomplete' }
  if (agent.daemon_key !== daemonKey || agent.machine_id !== machineId || agent.env_name !== envName) {
    return { ok: false, reason: 'agent current seat belongs to another daemon environment' }
  }
  if (codexKnownRolloutIds(agent).length === 0) {
    return { ok: false, reason: 'agent has no durable session identity' }
  }
  return { ok: true }
}

export function jsonlOwnershipState(entry = {}, daemonKey = null) {
  const owner = entry?.owner || {}
  if (owner.state === 'ignore') return 'ignore'
  if (owner.state === 'mine' && (!owner.daemon_key || owner.daemon_key === daemonKey)) return 'mine'
  return 'unknown'
}

export function classifyLoginMarkerOwner(marker = {}, daemonKey = null) {
  if (!marker?.daemon_key) return 'unknown'
  return marker.daemon_key === daemonKey ? 'mine' : 'ignore'
}

export function createJsonlIngesterMessageHandler({
  log,
  childWatchers,
  cursors,
  scheduleCursorSave,
  refreshIngestionCaughtUp,
  handleJsonlBackfillBatch,
  handleJsonlBackfillSessionComplete,
  handleJsonlBackfillJobDone,
  retireJsonlTail,
  processJsonlChildOutputs,
  sendJsonlIngesterMessage,
  maybeCompleteDisplayCatchup,
  updateJsonlCursorFromTail,
}) {
  return function handleJsonlIngesterMessage(msg) {
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
        retireJsonlTail(pw, `start failed for ${path.basename(pw.jsonlPath)}`, {
          healthKind: 'start-failed',
          healthDetail: { error: msg.error || 'unknown error' },
        })
      }
      return
    }
    if (msg.type === 'error') {
      log.warn(`JSONL ingester error for ${path.basename(pw.jsonlPath)}: ${msg.error || 'unknown error'}`)
      retireJsonlTail(pw, `ingester error for ${path.basename(pw.jsonlPath)}`, {
        healthKind: 'error',
        healthDetail: { error: msg.error || 'unknown error' },
      })
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
        sendJsonlIngesterMessage({ type: 'ack', watchId: pw.watchId, seq: msg.seq, ok: delivered })
      } catch (e) {
        // Child IPC failed; retire this watcher so a later sync can recreate it.
        log.warn(`JSONL ingester ack failed for ${path.basename(pw.jsonlPath)}: ${e?.message || e}`)
        retireJsonlTail(pw, `ack failed for ${path.basename(pw.jsonlPath)}`, {
          healthKind: 'ack-failed',
          healthDetail: { error: e?.message || String(e) },
        })
        return
      }
      if (!delivered) {
        retireJsonlTail(pw, `delivery failed for ${path.basename(pw.jsonlPath)}`, {
          healthKind: 'delivery-failed',
          healthDetail: { reason: 'activity delivery failed' },
        })
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
      maybeCompleteDisplayCatchup(pw, msg.offset)
      updateJsonlCursorFromTail(pw, msg.offset)
    }
  }
}

export function createJsonlIngestor({
  configDir,
  cursorsFile,
  projectsDir,
  daemonDir,
  log,
  sendMsg,
  sendMsgWithReply,
  isConnected,
  isServerReady,
  getAgents,
  listSessions,
  selectAgentKind,
  harnessAdapters,
  permissionLedger,
  bufferActivity,
  extractActivityEvents,
  activityDeliveryCounters = null,
  machineId = null,
  envName = null,
  daemonKey = null,
  forkProcess = fork,
  watchDir = (...args) => chokidar.watch(...args),
  nowMs = () => Date.now(),
  random = Math.random,
}) {
  // ---------- cursor persistence ----------

  function loadCursors() {
    if (!fs.existsSync(cursorsFile)) return {}
    try { return JSON.parse(fs.readFileSync(cursorsFile, 'utf8')) }
    catch (e) { log.warn(`corrupt cursors file, resetting: ${e.message}`); return {} }
  }
  function saveCursors() {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true })
    try { fs.writeFileSync(cursorsFile, JSON.stringify(cursors, null, 2)) }
    catch (e) {
      // Cursor persistence failure is surfaced in logs; ingestion continues from memory.
      log.error(`cursor save failed: ${e.message}`)
    }
  }
  let cursors = loadCursors() // { sessionId: { inode, offset } }

  // Throttle saveCursors — flush at most once per 2s.
  let _cursorSaveTimer = null
  function scheduleCursorSave() {
    if (_cursorSaveTimer) return
    _cursorSaveTimer = setTimeout(() => { _cursorSaveTimer = null; saveCursors() }, 2000)
  }

  function recordSessionIdentity(input) {
    const fleetId = input?.fleet_id
    const sessionId = ledgerSessionId(input)
    if (!fleetId || !sessionId || !permissionLedger?.setSessionSync) return
    // Collaboration subagent rollouts inherit the parent fleet login but are
    // not independently resumable fleet seats. Watching their activity is
    // valid; replacing the parent's durable resume identity with them is not.
    if (input.harness_kind === 'codex' && !codexRolloutIsTopLevel(input.jsonl_path)) return
    const event = sessionIdentitySeatEvent(input, { machineId, envName, daemonKey })
    try {
      permissionLedger.setSessionSync(fleetId, {
        sessionId,
        sessionKind: input.harness_kind,
        sessionPath: input.jsonl_path,
        tmuxSession: input.tmux_session,
        model: input.model,
        machineId: event?.machine_id || input.machine_id || machineId,
        envName: event?.env_name || input.env_name || envName,
        daemonKey: event?.daemon_key || input.daemon_key || daemonKey,
        cwd: input.cwd,
        friendlyName: input.friendly_name,
      })
      if (event) sendMsg(event)
    } catch (e) {
      log.error(`daemon ledger session identity write failed for ${fleetId}: ${e.message}`)
      throw e
    }
  }

  function persistLocalMarkerBinding(marker, { sessionId, jsonlPath, harnessKind } = {}) {
    if (!marker?.mint_id) return
    const localLedger = createLocalAgentLedger(path.join(configDir, 'fleet-daemon.db'))
    let bindingError = null
    try {
      if (!localLedger.get(marker.mint_id)) {
        localLedger.create({
          localAgentId: marker.mint_id,
          serverAgentId: marker.fleet_id || null,
          friendlyName: marker.friendly_name || null,
          sessionId,
          harness: marker.harness_kind || harnessKind,
          model: marker.model || null,
          tmuxName: marker.tmux_session || null,
          cwd: marker.cwd || null,
        })
      } else {
        if (marker.fleet_id) localLedger.bind(marker.mint_id, marker.fleet_id, { friendlyName: marker.friendly_name || null })
        localLedger.updateConversation(marker.mint_id, {
          sessionId,
          harness: marker.harness_kind || harnessKind,
          model: marker.model || null,
        })
        localLedger.updateProcess(marker.mint_id, {
          tmuxName: marker.tmux_session || null,
          cwd: marker.cwd || null,
        })
      }
    } catch (e) {
      bindingError = e?.message || String(e)
      sendMsg({
        type: 'daemon-warning',
        warning: 'local-login-marker-binding-failed',
        mint_id: marker.mint_id,
        fleet_id: marker.fleet_id || null,
        session_id: marker.session_id || sessionId || null,
        error: bindingError,
      })
    } finally {
      localLedger.close()
    }
    if (marker.fleet_id) {
      recordSessionIdentity({
        fleet_id: marker.fleet_id,
        session_id: marker.session_id || sessionId,
        harness_kind: marker.harness_kind || harnessKind,
        jsonl_path: jsonlPath,
        tmux_session: marker.tmux_session,
        model: marker.model,
        cwd: marker.cwd,
        friendly_name: marker.friendly_name,
        machine_id: marker.machine_id,
        env_name: marker.env_name,
        daemon_key: marker.daemon_key,
      })
    }
    return bindingError
  }

  function setJsonlOwnership(pw, state, marker = null) {
    const entry = cursors[pw.sessionId] || (cursors[pw.sessionId] = {})
    const prev = jsonlOwnershipState(entry, daemonKey)
    entry.owner = {
      state,
      daemon_key: marker?.daemon_key || entry.owner?.daemon_key || daemonKey || null,
      mint_id: marker?.mint_id || entry.owner?.mint_id || null,
      fleet_id: marker?.fleet_id || entry.owner?.fleet_id || null,
      decided_at: new Date().toISOString(),
    }
    pw.ownershipState = state
    if (state === 'mine' && marker) {
      const bindingError = persistLocalMarkerBinding(marker, {
        sessionId: pw.sessionId,
        jsonlPath: pw.jsonlPath,
        harnessKind: pw.harnessKind,
      })
      if (bindingError) entry.owner.binding_error = bindingError
      if (prev !== 'mine' && isConnected()) {
        sendActivityHealth(pw.primaryAgentId, {
          state: ACTIVITY_HEALTH_OK,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED,
          reason: `${pw.harnessKind} watcher ownership confirmed`,
          lastKnownGoodAt: new Date().toISOString(),
          sessionId: pw.sessionId,
          jsonlPath: pw.jsonlPath,
        })
      }
    }
    if (state === 'ignore') stopJsonlTail(pw, `foreign login marker for ${path.basename(pw.jsonlPath)}`)
    scheduleCursorSave()
  }

  function applyLoginMarkerOwnership(pw, marker) {
    if (!marker) return jsonlOwnershipState(cursors[pw.sessionId], daemonKey)
    const state = classifyLoginMarkerOwner(marker, daemonKey)
    if (state !== 'unknown') setJsonlOwnership(pw, state, marker)
    return state
  }

  function syncSessionIdentityNamesFromAgents(agentList = getAgents()) {
    for (const agent of agentList || []) {
      if (!agent?.id || !agent?.friendly_name) continue
      try {
        permissionLedger?.setSessionSync?.(agent.id, { friendlyName: agent.friendly_name })
      } catch (e) {
        // Friendly-name sync is display-only; session identity writes fail loudly elsewhere.
        log.warn(`daemon ledger friendly-name sync failed for ${agent.id}: ${e.message}`)
      }
    }
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
    // Session identity now lives in the daemon ledger. Liveness checks that need
    // "caught up" should use the daemon's runtime state, not a sidecar file.
  }

  // ---------- session-owner cache ----------
  // Each cursor entry gains `owners: [fleetId,...]` — which agent(s) registered in
  // that session file. Populated the one time we read the file. Once a session is
  // classified, "which sessions does agent X own?" is a cache lookup, never a re-scan
  // of every JSONL. This is the daemon's single writer of cursor state.
  function recordSessionOwners(sessionId, owners, { jsonlPath = null, harnessKind = 'claude', identity = null, persistIdentity = true } = {}) {
    // classified=true means we've fully read the file and `owners` is authoritative
    // (empty owners on a fully-read file is a valid answer: "nobody registered here").
    const changed = recordSessionOwnersInCache({
      cursors,
      sessionId,
      owners,
      persistIdentity,
      recordIdentity: recordSessionIdentity,
      identityInput: owner => ({
        session_id: sessionId,
        harness_kind: harnessKind,
        jsonl_path: jsonlPath,
        fleet_id: owner,
        ...(identity?.fleet_id === owner ? identity : {}),
        classified: true,
      }),
    })
    if (changed) scheduleCursorSave()
  }

  function claudeOwnersForSessionFile(sessionId, jsonlPath) {
    const entry = cursors[sessionId]
    if (entry?.classified) return entry.owners || []
    // Never byte-scan an unclassified rollout on the daemon's event loop. A
    // restart can expose thousands of files; doing this here starves the fleet
    // WebSocket heartbeat and makes the live UI disappear. The niced harvester
    // performs classification off-process and schedules one resync afterward.
    return []
  }

  function indexClaudeJsonlsByOwner() {
    const byOwner = new Map()
    try {
      for (const dir of fs.readdirSync(projectsDir)) {
        const dirPath = path.join(projectsDir, dir)
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
  const _targetedOwnerHarvesters = new Map()
  const _targetedOwnerRetryTimers = new Map()

  function startTargetedOwnerHarvester(jsonlPath) {
    if (!jsonlPath || _targetedOwnerHarvesters.has(jsonlPath)) return
    const script = path.join(daemonDir, 'fleet-owner-harvester.mjs')
    if (!fs.existsSync(script)) return
    let child
    try {
      child = forkProcess(script, [jsonlPath], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      _targetedOwnerHarvesters.set(jsonlPath, child)
    } catch (e) {
      log.warn(`targeted owner harvester failed to start for ${path.basename(jsonlPath)}: ${e.message}`)
      if (!_targetedOwnerRetryTimers.has(jsonlPath)) {
        const timer = setTimeout(() => {
          _targetedOwnerRetryTimers.delete(jsonlPath)
          startTargetedOwnerHarvester(jsonlPath)
        }, 1000)
        _targetedOwnerRetryTimers.set(jsonlPath, timer)
      }
      return
    }
    child.stderr?.on?.('data', chunk => {
      const text = String(chunk || '').trim()
      if (text) log.warn(`targeted owner harvester stderr: ${text}`)
    })
    child.on('message', msg => {
      if (msg?.type !== 'owners') return
      recordSessionOwners(msg.sessionId, msg.owners, {
        jsonlPath: msg.jsonlPath,
        harnessKind: msg.harnessKind || 'claude',
        identity: msg.identity,
        persistIdentity: false,
      })
      const retryTimer = _targetedOwnerRetryTimers.get(jsonlPath)
      if (retryTimer) clearTimeout(retryTimer)
      _targetedOwnerRetryTimers.delete(jsonlPath)
      scheduleJsonlDirSync(`owner classified ${path.basename(jsonlPath)}`)
    })
    const clear = () => {
      if (_targetedOwnerHarvesters.get(jsonlPath) === child) _targetedOwnerHarvesters.delete(jsonlPath)
    }
    child.on('exit', clear)
    child.on('close', clear)
    child.on('disconnect', clear)
    child.on('error', e => {
      clear()
      log.warn(`targeted owner harvester failed for ${path.basename(jsonlPath)}: ${e.message}`)
    })
  }

  function startOwnerHarvester() {
    if (_ownerHarvester) return
    const script = path.join(daemonDir, 'fleet-owner-harvester.mjs')
    if (!fs.existsSync(script)) return
    try {
      // execArgv:[] so the child doesn't inherit --import tsx etc.; it's plain ESM.
      _ownerHarvester = forkProcess(script, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    } catch (e) {
      log.warn(`owner harvester failed to start: ${e.message}`)
      _ownerHarvester = null
      return
    }
    const child = _ownerHarvester
    child.stderr?.on?.('data', chunk => {
      const text = String(chunk || '').trim()
      if (text) log.warn(`owner harvester stderr: ${text}`)
    })
    child.on('message', (msg) => {
      if (msg?.type === 'owners') {
        recordSessionOwners(msg.sessionId, msg.owners, {
          jsonlPath: msg.jsonlPath,
          harnessKind: msg.harnessKind || 'claude',
          identity: msg.identity,
          persistIdentity: false,
        })
      } else if (msg?.type === 'harvest-complete') {
        log.info(`owner harvest complete: ${msg.count} session(s) classified`)
        scheduleJsonlDirSync('owner harvest complete')
      }
    })
    const noteOwnerDown = (reason) => {
      if (_ownerHarvester === child) _ownerHarvester = null
      if (reason) log.warn(`owner harvester down: ${reason}`)
    }
    child.on('exit', (code, signal) => noteOwnerDown(`exit code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    child.on('close', (code, signal) => noteOwnerDown(`close code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    child.on('disconnect', () => noteOwnerDown('ipc disconnect'))
    child.on('error', (e) => noteOwnerDown(`error: ${e.message}`))
  }

  let _jsonlIngester = null
  let _jsonlIngesterRestartTimer = null
  let _jsonlIngesterRestartPending = false
  let _shuttingDown = false
  let _sessionReaderLock = null
  const pathWatchers = new Map()    // jsonlPath -> child-backed watcher state
  const agentPaths = new Map()      // agentId -> jsonlPath
  const jsonlDirWatchers = new Map() // dir -> { watcher, refs }
  const childWatchers = new Map() // watchId -> path watcher state
  const searchBackfillJobs = new Map() // jobId -> { sessionId, jsonlPath }
  const searchBackfillPendingBySession = new Set()
  const priorSessionBackfillPending = new Set()
  const priorSessionBackfillComplete = new Set()
  const sessionWatcherSyncRunner = createCoalescedSyncRunner(syncSessionWatchersOnce)

  function startJsonlIngester() {
    if (_jsonlIngester) {
      if (_jsonlIngester.connected !== false && !_jsonlIngester.killed) return _jsonlIngester
      log.warn('JSONL ingester stale child handle found; resyncing live session tails')
      _jsonlIngester = null
      handleJsonlIngesterExit('stale-ipc', null)
    }
    if (!_sessionReaderLock) {
      const lockPath = sessionReaderLockPath({ configDir })
      const lock = acquireSingletonLock({
        lockPath,
        installPath: daemonDir,
        origin: null,
      })
      if (!lock.ok) {
        const holder = lock.holder?.pid ? ` pid=${lock.holder.pid}` : ''
        throw new Error(`session JSONL reader already running for ${configDir}${holder}`)
      }
      _sessionReaderLock = { ...lock, lockPath }
    }
    const script = path.join(daemonDir, 'fleet-jsonl-ingester.mjs')
    if (!fs.existsSync(script)) throw new Error(`JSONL ingester child missing: ${script}`)
    let child
    try {
      child = forkProcess(script, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      _jsonlIngester = child
    } catch (e) {
      _jsonlIngester = null
      throw e
    }
    let downHandled = false
    const noteDown = (code, signal) => {
      if (downHandled) return
      downHandled = true
      if (_jsonlIngester === child) _jsonlIngester = null
      handleJsonlIngesterExit(code, signal)
    }
    child.stderr?.on?.('data', chunk => {
      const text = String(chunk || '').trim()
      if (text) log.warn(`JSONL ingester stderr: ${text}`)
    })
    child.on('message', handleJsonlIngesterMessage)
    child.on('exit', (code, signal) => {
      noteDown(code, signal)
    })
    child.on('close', (code, signal) => {
      noteDown(code ?? 'close', signal)
    })
    child.on('disconnect', () => {
      noteDown('disconnect', null)
    })
    child.on('error', (e) => {
      if (isClosedIpcError(e)) {
        if (!downHandled) log.warn(`JSONL ingester child IPC closed: ${e.message}`)
        noteDown(e.code || 'ipc-closed', null)
        return
      }
      log.warn(`JSONL ingester child error: ${e.message}`)
    })
    return child
  }

  function handleJsonlIngesterExit(code, signal) {
    if (_shuttingDown) return
    _jsonlIngesterRestartPending = true
    activityDeliveryCounters?.record?.('jsonlIngesterDown', { type: 'jsonl-ingester' }, 1, {
      error: `code=${code ?? 'null'} signal=${signal ?? 'null'}`,
    })
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
        if (isServerReady()) {
          resumeJsonlIngesterAfterServerReady()
        }
      }, 1000)
    }
  }

  function sendJsonlIngesterMessage(msg) {
    const child = _jsonlIngester
    if (!child || child.connected === false || child.killed) {
      const error = new Error('JSONL ingester IPC is not open')
      error.code = 'ERR_IPC_CHANNEL_CLOSED'
      if (child && _jsonlIngester === child) {
        _jsonlIngester = null
        handleJsonlIngesterExit('ipc-closed', null)
      }
      throw error
    }
    try {
      return child.send?.(msg)
    } catch (e) {
      if (isClosedIpcError(e) && _jsonlIngester === child) {
        _jsonlIngester = null
        try { child.kill?.() } catch {
          // Best-effort cleanup of a stale child handle.
        }
        handleJsonlIngesterExit(e.code || 'ipc-closed', null)
      }
      throw e
    }
  }

  function resumeJsonlIngesterAfterServerReady() {
    if (!_jsonlIngesterRestartPending || _shuttingDown || !isServerReady()) return false
    _jsonlIngesterRestartPending = false
    retryPendingJsonlBackfillJobs()
    void syncSessionWatchers(getAgents()).catch(e => {
      _jsonlIngesterRestartPending = true
      log.error(`syncSessionWatchers after ingester exit failed: ${e.stack || e.message}`)
    })
    return true
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

  function sendActivityHealth(agent, patch) {
    const agentId = typeof agent === 'string' ? agent : agent?.id
    if (!agentId) return
    sendMsg({
      type: 'activity-health',
      agent_id: agentId,
      state: patch.state,
      boundary: patch.boundary,
      reason: patch.reason || null,
      ts: patch.ts || new Date().toISOString(),
      last_known_good_at: patch.lastKnownGoodAt || null,
      last_activity_at: patch.lastActivityAt || null,
      session_id: patch.sessionId || null,
      jsonl_path: patch.jsonlPath || null,
    })
  }

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
      // Qualification rules are advisory gates; failed loads leave no rules active.
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


  async function syncSessionWatchers(agentList) {
    await sessionWatcherSyncRunner.sync(agentList)
  }

  async function syncSessionWatchersOnce(agentList) {
    const activePaths = new Set()
    const claudeJsonlsByOwner = indexClaudeJsonlsByOwner()

    for (const agent of agentList) {
      if (agent.dead) continue
      const eligibility = jsonlWatchEligibility(agent, { machineId, envName, daemonKey })
      if (!eligibility.ok) {
        sendActivityHealth(agent, {
          state: ACTIVITY_HEALTH_UNAVAILABLE,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.RESOLVE_JSONL_NULL,
          reason: eligibility.reason,
        })
        continue
      }
      let harness
      try {
        const kind = await selectAgentKind(agent)
        const adapter = harnessAdapters[kind]
        if (!adapter) throw new Error(`unknown harness kind "${kind}" for ${agent?.friendly_name || agent?.id}`)
        harness = adapter.activity
      } catch (e) {
        sendActivityHealth(agent, {
          state: ACTIVITY_HEALTH_UNKNOWN,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_HARNESS_KIND,
          reason: e.message,
        })
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
        if (!jsonlPath) {
          sendActivityHealth(agent, {
            state: ACTIVITY_HEALTH_UNAVAILABLE,
            boundary: ACTIVITY_HEALTH_BOUNDARIES.RESOLVE_JSONL_NULL,
            reason: `${harness.kind} JSONL resolver returned no path`,
          })
          continue
        }
      } else {
        if (!harness.usesClaudeSessionIds) continue
        for (const sid of candidateIds) {
          let p = path.join(projectsDir, projectHash, sid + '.jsonl')
          let foundStat = null
          try {
            foundStat = fs.statSync(p)
          } catch {
            // Not in cwd-derived dir — global search across all project dirs.
            // Needed when agent's JSONL is in a worktree-specific project dir
            // that doesn't match the stripped canonical cwd.
            try {
              for (const dir of fs.readdirSync(projectsDir)) {
                const candidate = path.join(projectsDir, dir, sid + '.jsonl')
                try { foundStat = fs.statSync(candidate); p = candidate; break } catch {
                  // Global session search probes many project dirs; misses are expected.
                }
              }
            } catch {
              // If project-dir enumeration fails, this candidate simply remains unresolved.
            }
          }
          if (foundStat) {
            const owners = claudeOwnersForSessionFile(sid, p)
            if (!cursors[sid]?.classified) startTargetedOwnerHarvester(p)
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
      if (!jsonlPath) {
        sendActivityHealth(agent, {
          state: ACTIVITY_HEALTH_UNAVAILABLE,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.RESOLVE_JSONL_NULL,
          reason: `${harness.kind} JSONL path not found for registered sessions`,
        })
        continue
      }

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
            sendJsonlIngesterMessage({
              type: 'update',
              watchId: pw.watchId,
              agentId: pw.primaryAgentId,
              harnessKind: harness.kind,
              terminalChat: !!harness.terminalChat,
              backfillSearch: !!harness.backfillSearch,
            })
            if (pw.ownershipState === 'mine') {
              sendActivityHealth(agent, {
                state: ACTIVITY_HEALTH_OK,
                boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED,
                reason: `${harness.kind} watcher updated`,
                lastKnownGoodAt: new Date().toISOString(),
                sessionId: fileSessionId,
                jsonlPath,
              })
            }
          } catch (e) {
            // Retire this broken tail; other JSONL watchers must keep flowing.
            log.warn(`JSONL ingester update failed for ${path.basename(jsonlPath)}: ${e?.message || e}`)
            retireJsonlTail(pw, `ingester update failed for ${path.basename(jsonlPath)}`)
            sendActivityHealth(agent, {
              state: ACTIVITY_HEALTH_UNAVAILABLE,
              boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_UPDATE_FAILED,
              reason: e?.message || String(e),
              sessionId: fileSessionId,
              jsonlPath,
            })
          }
          continue
        }
      }

      // First time watching this JSONL — initialize cursor.
      const sessionId = path.basename(jsonlPath, '.jsonl')
      let stat
      try { stat = fs.statSync(jsonlPath) } catch (e) {
        sendActivityHealth(agent, {
          state: ACTIVITY_HEALTH_UNAVAILABLE,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_STAT_FAILED,
          reason: e?.message || String(e),
          sessionId,
          jsonlPath,
        })
        continue
      }
      if (jsonlOwnershipState(cursors[sessionId], daemonKey) === 'ignore') continue
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
        // Owner classification may have been written immediately before this
        // first watcher attach. Preserve it so the next daemon restart does not
        // turn the same live session back into an unclassified JSONL.
        cursors[sessionId] = { ...(stored || {}), inode, offset }
        scheduleCursorSave()
        if (harness.backfillSearch) backfillSearchEntries(agent.id, jsonlPath, sessionId, harness.kind)
        // Also backfill all prior sessions for this agent (other JSONLs that
        // contain a registration line for this fleet ID).
        if (harness.backfillSearch) backfillAllPriorSessions(agent.id, agent.id)
      }

      try {
        let initialMarker = null
        try {
          const { identity, owners, endOffset } = scanFileIdentitySync(jsonlPath)
          initialMarker = identity?.marker || null
          if (harness.kind === 'codex') {
            const claimedOwners = owners.length ? owners : [agent.id]
            recordSessionOwners(sessionId, claimedOwners, {
              jsonlPath,
              harnessKind: harness.kind,
              identity,
            })
            if (endOffset > 0) {
              const entry = cursors[sessionId] || (cursors[sessionId] = {})
              if (!entry.identityScanned) {
                entry.identityScanned = true
                scheduleCursorSave()
              }
            }
          }
        } catch (e) {
          // Identity recovery is opportunistic; the JSONL watcher must still start.
          log.warn(`identity scan failed for ${path.basename(jsonlPath)}: ${e.message}`)
        }
        const initialOwnership = initialMarker
          ? classifyLoginMarkerOwner(initialMarker, daemonKey)
          : jsonlOwnershipState(cursors[sessionId], daemonKey)
        if (initialOwnership === 'ignore') {
          cursors[sessionId] = {
            ...(cursors[sessionId] || {}),
            owner: {
              state: 'ignore',
              daemon_key: initialMarker?.daemon_key || null,
              mint_id: initialMarker?.mint_id || null,
              fleet_id: initialMarker?.fleet_id || null,
              decided_at: new Date().toISOString(),
            },
          }
          scheduleCursorSave()
          continue
        }
        const pwState = startJsonlTail({ agent, jsonlPath, sessionId, harness, startOffset: offset, liveOffset: stat.size, ownershipState: initialOwnership })
        if (initialOwnership === 'mine' && initialMarker) setJsonlOwnership(pwState, 'mine', initialMarker)
        pathWatchers.set(jsonlPath, pwState)
        retainJsonlDirWatcher(jsonlPath)
        if (pwState.ownershipState === 'mine') {
          sendActivityHealth(agent, {
            state: ACTIVITY_HEALTH_OK,
            boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED,
            reason: `${harness.kind} watcher attached`,
            lastKnownGoodAt: new Date().toISOString(),
            sessionId,
            jsonlPath,
          })
        }

        log.info(`watching ${harness.kind} JSONL for ${agent.friendly_name || agent.id}: ${path.basename(jsonlPath)} @ offset=${offset}`)
      } catch (e) {
        // One failed watcher should not prevent other agents from being watched.
        log.error(`watcher creation failed for ${jsonlPath}: ${e.message}`)
        sendActivityHealth(agent, {
          state: ACTIVITY_HEALTH_UNAVAILABLE,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_CREATE_FAILED,
          reason: e?.message || String(e),
          sessionId,
          jsonlPath,
        })
      }
    }

    // Close watchers for paths no longer needed.
    for (const [p, pw] of pathWatchers) {
      if (!activePaths.has(p)) {
        stopJsonlTail(pw, `no longer active: ${path.basename(p)}`)
        pathWatchers.delete(p)
        releaseJsonlDirWatcher(p)
        for (const [aid, watchedPath] of agentPaths) {
          if (watchedPath === p) {
            agentPaths.delete(aid)
          }
        }
      }
    }
    for (const aid of [...agentPaths.keys()]) {
      if (!agentList.some(a => a.id === aid && jsonlWatchEligibility(a, { machineId, envName, daemonKey }).ok)) agentPaths.delete(aid)
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


  let _jsonlDirSyncTimer = null
  function scheduleJsonlDirSync(reason) {
    if (_jsonlDirSyncTimer) return
    _jsonlDirSyncTimer = setTimeout(() => {
      _jsonlDirSyncTimer = null
      log.info(`JSONL directory change detected (${reason}); syncing live session tails`)
      void syncSessionWatchers(getAgents()).catch(e => log.error(`syncSessionWatchers failed: ${e.stack || e.message}`))
    }, 500)
  }

  function retainJsonlDirWatcher(jsonlPath) {
    const dir = path.dirname(jsonlPath)
    const existing = jsonlDirWatchers.get(dir)
    if (existing) {
      existing.refs += 1
      return
    }
    const watcher = watchDir(dir, {
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

  function startJsonlTail({ agent, jsonlPath, sessionId, harness, startOffset, liveOffset, ownershipState = 'unknown' }) {
    startJsonlIngester()
    const watchId = `${sessionId}:${agent.id}:${nowMs()}:${random().toString(36).slice(2)}`
    const replayThresholdBytes = Number(process.env.TLDA_JSONL_DISPLAY_REPLAY_MAX_BYTES || DEFAULT_DISPLAY_REPLAY_MAX_BYTES)
    const catchupUntilOffset = catchupReplayBoundary({ startOffset, liveOffset, thresholdBytes: replayThresholdBytes })
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
      ownershipState,
      catchupUntilOffset,
      catchupSuppressed: {},
    }
    if (catchupUntilOffset != null) {
      log.warn(`JSONL display catch-up for ${agent.friendly_name || agent.id}: suppressing backlog display events from offset ${startOffset} to ${catchupUntilOffset}`)
    }
    childWatchers.set(watchId, pw)
    try {
      sendJsonlIngesterMessage({
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
    } catch (e) {
      childWatchers.delete(watchId)
      throw e
    }
    refreshIngestionCaughtUp()
    return pw
  }

  const handleJsonlIngesterMessage = createJsonlIngesterMessageHandler({
    log,
    childWatchers,
    cursors,
    scheduleCursorSave,
    refreshIngestionCaughtUp,
    handleJsonlBackfillBatch,
    handleJsonlBackfillSessionComplete,
    handleJsonlBackfillJobDone,
    retireJsonlTail,
    processJsonlChildOutputs,
    sendJsonlIngesterMessage,
    maybeCompleteDisplayCatchup,
    updateJsonlCursorFromTail,
  })

  function countCatchupSuppressed(pw, output) {
    const n = output?.type === 'activity' ? (output.events?.length || 0)
      : output?.type === 'nativeTask' ? (output.events?.length || 0)
        : 1
    pw.catchupSuppressed[output.type] = (pw.catchupSuppressed[output.type] || 0) + n
  }

  function maybeCompleteDisplayCatchup(pw, offset) {
    if (pw.catchupUntilOffset == null || offset < pw.catchupUntilOffset) return
    const summary = Object.entries(pw.catchupSuppressed || {})
      .filter(([, n]) => n > 0)
      .map(([type, n]) => `${type}=${n}`)
      .join(', ')
    log.warn(`JSONL display catch-up complete for ${path.basename(pw.jsonlPath)} at offset ${offset}${summary ? `; suppressed ${summary}` : ''}`)
    pw.catchupUntilOffset = null
    pw.catchupSuppressed = {}
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
      sendJsonlIngesterMessage({ type: 'job-ack', jobId: msg.jobId, seq: msg.seq, ok: delivered })
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
      for (const identity of msg.result?.identities || []) recordSessionIdentity(identity)
      if (job?.sessionId) {
        cursors[job.sessionId] = { ...(cursors[job.sessionId] || {}), searchBackfilled: true }
        scheduleCursorSave()
      }
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
    const agentId = pw.primaryAgentId
    const connected = isConnected()
    let delivered = true
    for (const output of outputs) {
      if (output.type === 'identity' && output.identity?.marker) {
        applyLoginMarkerOwnership(pw, output.identity.marker)
      }
      if (!connected) continue
      if (pw.ownershipState !== 'mine') continue
      if (pw.catchupUntilOffset != null && shouldSuppressCatchupOutput(output)) {
        countCatchupSuppressed(pw, output)
        continue
      }
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
        recordSessionIdentity(tailLedgerSessionInput({
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

  function retireJsonlTail(pw, reason, options = {}) {
    if (!pw) return
    if (options.healthKind) {
      sendActivityHealth(pw.primaryAgentId, jsonlRuntimeFailureActivityHealth(pw, options.healthKind, options.healthDetail))
    }
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
    try { sendJsonlIngesterMessage({ type: 'stop', watchId: pw.watchId, reason }) } catch (e) {
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
    if (!isConnected()) return false
    const harness = harnessAdapters[pw.harnessKind]?.activity
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
        /^Call (?:login|register)\([^)]*\) with the fleet MCP server\b/.test(text)) return true
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
    startJsonlIngester()
    const nextJob = { ...job, attempts: (job.attempts || 0) + 1 }
    searchBackfillJobs.set(nextJob.jobId, nextJob)
    sendJsonlIngesterMessage({ type: 'job', ...nextJob })
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
      projectsDir: projectsDir,
      cursors,
    })
  }



  function syncIfRosterChanged({ agents, signature, reason, onChanged }) {
    const nextSignature = sessionWatcherRosterSignature(agents)
    if (nextSignature === signature) return signature
    log.info(`session watcher roster changed (${reason}); syncing live session tails`)
    onChanged?.()
    void syncSessionWatchers(agents).catch(e => log.error(`syncSessionWatchers failed: ${e.stack || e.message}`))
    return nextSignature
  }

  function hasWatcherForAgent(agent, matchedKind) {
    if (!matchedKind || matchedKind === 'claude') return true
    const watchedPath = agentPaths.get(agent.id)
    const watcher = watchedPath ? pathWatchers.get(watchedPath) : null
    return !!watchedPath && !!watcher && watcher.harnessKind === matchedKind
  }

  function teardown() {
    for (const [, pw] of pathWatchers) stopJsonlTail(pw, 'daemon watcher teardown')
    pathWatchers.clear()
    childWatchers.clear()
    agentPaths.clear()
    for (const [, entry] of jsonlDirWatchers) {
      try {
        const closed = entry.watcher.close()
        Promise.resolve(closed).catch(e => {
          log.warn(`chokidar teardown close failed: ${e?.message || e}`)
        })
      } catch (e) {
        // Watcher shutdown is cleanup-only; log and continue closing peers.
        log.warn(`chokidar teardown close threw: ${e?.message || e}`)
      }
    }
    jsonlDirWatchers.clear()
  }

  function shutdown() {
    _shuttingDown = true
    saveCursors()
    teardown()
    try { _ownerHarvester?.kill() } catch {
      // Shutdown must keep progressing even if the helper has already exited.
    }
    for (const child of _targetedOwnerHarvesters.values()) {
      try { child.kill() } catch { /* cleanup continues */ }
    }
    _targetedOwnerHarvesters.clear()
    for (const timer of _targetedOwnerRetryTimers.values()) clearTimeout(timer)
    _targetedOwnerRetryTimers.clear()
    try { _jsonlIngester?.send?.({ type: 'shutdown' }) } catch {
      // IPC may already be closed during shutdown; killing below is the fallback.
    }
    try { _jsonlIngester?.kill() } catch {
      // Shutdown must keep progressing even if the helper has already exited.
    }
  }

  return {
    sync: syncSessionWatchers,
    syncIdentityNames: syncSessionIdentityNamesFromAgents,
    syncIfRosterChanged,
    rosterSignature: sessionWatcherRosterSignature,
    scheduleJsonlDirSync,
    startOwnerHarvester,
    resumeAfterServerReady: resumeJsonlIngesterAfterServerReady,
    resolveEditor,
    hasWatcherForAgent,
    teardown,
    shutdown,
    saveCursors,
  }
}
