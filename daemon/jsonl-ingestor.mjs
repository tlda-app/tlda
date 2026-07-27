import chokidar from 'chokidar'
import { fork } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { ledgerSessionId, tailLedgerSessionInput } from '../agent-runtime/ledger-session-tail.mjs'
import { codexKnownRolloutIds } from '../agent-runtime/daemon-guards.mjs'
import { codexRolloutIsTopLevel } from '../agent-runtime/resolve-transcript.mjs'
import {
  ACTIVITY_HEALTH_BOUNDARIES,
  ACTIVITY_HEALTH_OK,
  ACTIVITY_HEALTH_UNAVAILABLE,
  ACTIVITY_HEALTH_UNKNOWN,
} from '../shared/activity-health.mjs'

const DEFAULT_DISPLAY_REPLAY_MAX_BYTES = 256 * 1024
const CODEX_SEARCH_BACKFILL_VERSION = 'codex-normalized-text-v1'
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
  jsonlTranscriptRoots = null,
  permissionLedger,
  bufferActivity,
  extractActivityEvents,
  activityDeliveryCounters = null,
  recordMintMarker = null,
  resolveMintFacts = null,
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
    } catch (e) {
      log.error(`daemon ledger session identity write failed for ${fleetId}: ${e.message}`)
      sendMsg({
        type: 'daemon-warning',
        warning: 'daemon-ledger-session-identity-write-failed',
        fleet_id: fleetId,
        session_id: sessionId,
        error: e?.message || String(e),
      })
    }
    if (event) sendMsg(event)
  }

  function cleanString(value) {
    const text = String(value || '').trim()
    return text || null
  }

  function modelFromMintFacts(facts) {
    return cleanString(facts?.processState?.model)
      || cleanString(facts?.launchRecipe?.modelSpec?.id)
      || cleanString(facts?.launchRecipe?.model)
      || null
  }

  function markerIdentityFromMintFacts(marker, facts, { sessionId, jsonlPath, harnessKind } = {}) {
    return {
      fleet_id: marker.fleet_id,
      session_id: marker.session_id || sessionId,
      harness_kind: marker.harness_kind || harnessKind,
      jsonl_path: jsonlPath,
      tmux_session: marker.tmux_session,
      model: marker.model || modelFromMintFacts(facts),
      cwd: marker.cwd,
      friendly_name: marker.friendly_name,
      machine_id: marker.machine_id,
      env_name: marker.env_name,
      daemon_key: marker.daemon_key,
    }
  }

  function persistLocalMarkerBinding(marker, { sessionId, jsonlPath, harnessKind } = {}) {
    if (!marker?.mint_id) return
    let bindingError = null
    try {
      recordMintMarker?.({
        ...marker,
        session_id: marker.session_id || sessionId,
        session_path: jsonlPath,
        harness_kind: marker.harness_kind || harnessKind,
      })
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
    }
    if (marker.fleet_id) {
      let facts = null
      try {
        facts = resolveMintFacts?.(marker) || null
      } catch (e) {
        sendMsg({
          type: 'daemon-warning',
          warning: 'daemon-mint-facts-lookup-failed',
          mint_id: marker.mint_id,
          fleet_id: marker.fleet_id,
          error: e?.message || String(e),
        })
      }
      recordSessionIdentity(markerIdentityFromMintFacts(marker, facts, { sessionId, jsonlPath, harnessKind }))
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
      if (marker.fleet_id) {
        pw.primaryAgentId = marker.fleet_id
        agentPaths.set(marker.fleet_id, pw.jsonlPath)
        try {
          sendJsonlIngesterMessage({
            type: 'update',
            watchId: pw.watchId,
            agentId: pw.primaryAgentId,
            harnessKind: pw.harnessKind,
            terminalChat: !!pw.terminalChat,
            backfillSearch: !!pw.backfillSearch,
          })
        } catch (e) {
          // Best-effort child IPC: ownership is persisted and stale children respawn.
          log.warn(`JSONL ingester ownership update failed for ${path.basename(pw.jsonlPath)}: ${e?.message || e}`)
        }
      }
      const bindingError = persistLocalMarkerBinding(marker, {
        sessionId: pw.sessionId,
        jsonlPath: pw.jsonlPath,
        harnessKind: pw.harnessKind,
      })
      if (bindingError) entry.owner.binding_error = bindingError
      if (prev !== 'mine' && isConnected() && pw.primaryAgentId) {
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
    if (state === 'mine') startOwnedJsonlBackfill(pw)
    if (state === 'ignore') stopJsonlTail(pw, `foreign login marker for ${path.basename(pw.jsonlPath)}`)
    scheduleCursorSave()
  }

  function startOwnedJsonlBackfill(pw) {
    if (!pw?.backfillSearch || pw.ownershipState !== 'mine') return
    backfillSearchEntries(pw.primaryAgentId, pw.jsonlPath, pw.sessionId, pw.harnessKind)
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
    if (searchBackfillJobs.size > 0) return false
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

  let _jsonlIngester = null
  let _jsonlIngesterRestartTimer = null
  let _jsonlIngesterRestartPending = false
  let _shuttingDown = false
  const pathWatchers = new Map()    // jsonlPath -> child-backed watcher state
  const agentPaths = new Map()      // agentId -> jsonlPath
  const jsonlDirWatchers = new Map() // dir -> { watcher, refs }
  const jsonlRootWatchers = new Map() // transcript root -> watcher
  const childWatchers = new Map() // watchId -> path watcher state
  const searchBackfillJobs = new Map() // jobId -> { sessionId, jsonlPath }
  const searchBackfillPendingBySession = new Set()
  const sessionWatcherSyncRunner = createCoalescedSyncRunner(syncSessionWatchersOnce)

  function startJsonlIngester() {
    if (_jsonlIngester) {
      if (_jsonlIngester.connected !== false && !_jsonlIngester.killed) return _jsonlIngester
      log.warn('JSONL ingester stale child handle found; resyncing live session tails')
      _jsonlIngester = null
      handleJsonlIngesterExit('stale-ipc', null)
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

  async function syncSessionWatchers(agentList) {
    await sessionWatcherSyncRunner.sync(agentList)
  }

  function transcriptRoots() {
    if (Array.isArray(jsonlTranscriptRoots) && jsonlTranscriptRoots.length) {
      return [...new Set(jsonlTranscriptRoots.filter(Boolean).map(p => path.resolve(p)))]
    }
    return [...new Set([
      projectsDir,
      process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions'),
    ].filter(Boolean).map(p => path.resolve(p)))]
  }

  function listJsonlFilesUnder(root) {
    const out = []
    const stack = [root]
    while (stack.length) {
      const current = stack.pop()
      let entries
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          out.push(full)
        }
      }
    }
    return out
  }

  function discoverLocalJsonlFiles() {
    return [...new Set(transcriptRoots().flatMap(listJsonlFilesUnder))].sort()
  }

  function inferHarnessKindForJsonlPath(jsonlPath, agent = null) {
    const hinted = agent?.runtimeKind || agent?.metadata?.kind
    if (hinted && harnessAdapters[hinted]) return hinted
    const base = path.basename(jsonlPath)
    if (base.startsWith('rollout-') || jsonlPath.includes(`${path.sep}.codex${path.sep}sessions${path.sep}`)) return 'codex'
    return 'claude'
  }

  async function harnessForJsonlPath(jsonlPath, agent = null) {
    if (agent) {
      try {
        const selected = await selectAgentKind(agent)
        if (harnessAdapters[selected]) return harnessAdapters[selected].activity
      } catch {
        // A ledger row can provide a hint, but it is not the authority for
        // whether this local transcript should be tailed.
      }
    }
    const kind = inferHarnessKindForJsonlPath(jsonlPath, agent)
    const adapter = harnessAdapters[kind]
    if (!adapter) throw new Error(`unknown harness kind "${kind}" for ${jsonlPath}`)
    return adapter.activity
  }

  function agentBySessionPath(agentList = []) {
    const byPath = new Map()
    for (const agent of agentList || []) {
      if (!agent?.session_path || agent.dead || agent.human) continue
      if (agent.daemon_key && daemonKey && agent.daemon_key !== daemonKey) continue
      byPath.set(path.resolve(agent.session_path), agent)
    }
    return byPath
  }

  async function syncSessionWatchersOnce(agentList) {
    const activePaths = new Set()
    const agentsByPath = agentBySessionPath(agentList)

    retainJsonlRootWatchers()

    for (const jsonlPath of discoverLocalJsonlFiles()) {
      const resolvedPath = path.resolve(jsonlPath)
      activePaths.add(resolvedPath)
      const agent = agentsByPath.get(resolvedPath) || null
      let harness
      try {
        harness = await harnessForJsonlPath(resolvedPath, agent)
      } catch (e) {
        log.error(`activity harness selection failed: ${e.message}`)
        continue
      }

      if (pathWatchers.has(resolvedPath)) {
        const pw = pathWatchers.get(resolvedPath)
        if (pw.stopped) {
          pathWatchers.delete(resolvedPath)
          releaseJsonlDirWatcher(resolvedPath)
        } else {
          const fileSessionId = path.basename(resolvedPath, '.jsonl')
          pw.harnessKind = harness.kind
          pw.terminalChat = !!harness.terminalChat
          pw.backfillSearch = !!harness.backfillSearch
          try {
            sendJsonlIngesterMessage({
              type: 'update',
              watchId: pw.watchId,
              agentId: pw.primaryAgentId,
              harnessKind: harness.kind,
              terminalChat: !!harness.terminalChat,
              backfillSearch: !!harness.backfillSearch,
            })
            if (pw.ownershipState === 'mine' && pw.primaryAgentId) {
              sendActivityHealth(pw.primaryAgentId, {
                state: ACTIVITY_HEALTH_OK,
                boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED,
                reason: `${harness.kind} watcher updated`,
                lastKnownGoodAt: new Date().toISOString(),
                sessionId: fileSessionId,
                jsonlPath: resolvedPath,
              })
            }
          } catch (e) {
            // Retire this broken tail; other JSONL watchers must keep flowing.
            log.warn(`JSONL ingester update failed for ${path.basename(resolvedPath)}: ${e?.message || e}`)
            retireJsonlTail(pw, `ingester update failed for ${path.basename(jsonlPath)}`)
            sendActivityHealth(pw.primaryAgentId, {
              state: ACTIVITY_HEALTH_UNAVAILABLE,
              boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_UPDATE_FAILED,
              reason: e?.message || String(e),
              sessionId: fileSessionId,
              jsonlPath: resolvedPath,
            })
          }
          continue
        }
      }

      // First time watching this JSONL — initialize cursor.
      const sessionId = path.basename(resolvedPath, '.jsonl')
      let stat
      try { stat = fs.statSync(resolvedPath) } catch (e) {
        if (e?.code !== 'ENOENT') {
          sendActivityHealth(agent?.id, {
            state: ACTIVITY_HEALTH_UNAVAILABLE,
            boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_STAT_FAILED,
            reason: e?.message || String(e),
            sessionId,
            jsonlPath: resolvedPath,
          })
        }
        continue
      }
      if (jsonlOwnershipState(cursors[sessionId], daemonKey) === 'ignore') continue
      const inode = stat.ino
      const stored = cursors[sessionId]
      let offset
      const storedOwnership = jsonlOwnershipState(stored, daemonKey)
      if (storedOwnership === 'unknown') {
        offset = 0
      } else if (stored && stored.inode === inode) {
        offset = Math.min(stored.offset, stat.size)
      } else {
        // New file (or rotated): start at EOF for activity cards, but backfill
        // all historical content to the search index.
        offset = stat.size
        // Owner classification may have been written immediately before this
        // first watcher attach. Preserve it so the next daemon restart does not
        // turn the same live session back into an unclassified JSONL.
        cursors[sessionId] = { ...(stored || {}), inode, offset }
        scheduleCursorSave()
      }

      try {
        const initialOwnership = jsonlOwnershipState(cursors[sessionId], daemonKey)
        const pwState = startJsonlTail({
          agent,
          jsonlPath: resolvedPath,
          sessionId,
          harness,
          startOffset: offset,
          liveOffset: stat.size,
          ownershipState: initialOwnership,
        })
        if (initialOwnership === 'mine') startOwnedJsonlBackfill(pwState)
        pathWatchers.set(resolvedPath, pwState)
        retainJsonlDirWatcher(resolvedPath)
        if (pwState.ownershipState === 'mine' && pwState.primaryAgentId) {
          sendActivityHealth(pwState.primaryAgentId, {
            state: ACTIVITY_HEALTH_OK,
            boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED,
            reason: `${harness.kind} watcher attached`,
            lastKnownGoodAt: new Date().toISOString(),
            sessionId,
            jsonlPath: resolvedPath,
          })
        }

        log.info(`watching ${harness.kind} JSONL ${path.basename(resolvedPath)} @ offset=${offset}`)
      } catch (e) {
        // One failed watcher should not prevent other agents from being watched.
        log.error(`watcher creation failed for ${resolvedPath}: ${e.message}`)
        sendActivityHealth(agent?.id, {
          state: ACTIVITY_HEALTH_UNAVAILABLE,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_CREATE_FAILED,
          reason: e?.message || String(e),
          sessionId,
          jsonlPath: resolvedPath,
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
      if (!pathWatchers.has(agentPaths.get(aid))) agentPaths.delete(aid)
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

  function retainJsonlRootWatchers() {
    const roots = new Set(transcriptRoots())
    for (const root of roots) {
      if (jsonlRootWatchers.has(root)) continue
      const watcher = watchDir(root, {
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: false,
      })
      watcher.on?.('add', p => {
        if (String(p).endsWith('.jsonl')) scheduleJsonlDirSync(`add ${path.basename(p)}`)
      })
      watcher.on?.('unlink', p => {
        if (String(p).endsWith('.jsonl')) scheduleJsonlDirSync(`unlink ${path.basename(p)}`)
      })
      watcher.on?.('addDir', p => scheduleJsonlDirSync(`addDir ${path.basename(p)}`))
      watcher.on?.('error', e => log.warn(`chokidar JSONL root watcher failed for ${root}: ${e?.message || e}`))
      jsonlRootWatchers.set(root, watcher)
    }
    for (const [root, watcher] of jsonlRootWatchers) {
      if (roots.has(root)) continue
      jsonlRootWatchers.delete(root)
      Promise.resolve(watcher.close()).catch(e => log.warn(`chokidar close failed for ${root}: ${e?.message || e}`))
    }
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

  function startJsonlTail({
    agent = null,
    jsonlPath,
    sessionId,
    harness,
    startOffset,
    liveOffset,
    ownershipState = 'unknown',
  }) {
    startJsonlIngester()
    const initialAgentId = cursors[sessionId]?.owner?.fleet_id || null
    const watchId = `${sessionId}:${initialAgentId || 'unowned'}:${nowMs()}:${random().toString(36).slice(2)}`
    const replayThresholdBytes = Number(process.env.TLDA_JSONL_DISPLAY_REPLAY_MAX_BYTES || DEFAULT_DISPLAY_REPLAY_MAX_BYTES)
    const catchupUntilOffset = catchupReplayBoundary({ startOffset, liveOffset, thresholdBytes: replayThresholdBytes })
    const pw = {
      watchId,
      jsonlPath,
      primaryAgentId: initialAgentId,
      sessionId,
      harnessKind: harness.kind,
      stopped: false,
      lastDeliveryOk: true,
      lastSavedOffset: startOffset,
      pendingDeliveries: 0,
      pendingFlushOffset: null,
      ownershipState,
      terminalChat: !!harness.terminalChat,
      backfillSearch: !!harness.backfillSearch,
      catchupUntilOffset,
      catchupSuppressed: {},
    }
    if (catchupUntilOffset != null) {
      log.warn(`JSONL display catch-up for ${initialAgentId || path.basename(jsonlPath)}: suppressing backlog display events from offset ${startOffset} to ${catchupUntilOffset}`)
    }
    childWatchers.set(watchId, pw)
    try {
      sendJsonlIngesterMessage({
        type: 'watch',
        watchId,
        jsonlPath,
        sessionId,
        agentId: initialAgentId,
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
    const job = msg.jobId ? searchBackfillJobs.get(msg.jobId) : null
    cursors[msg.sessionId] = markSearchBackfilled(cursors[msg.sessionId], job?.harnessKind)
    scheduleCursorSave()
    refreshIngestionCaughtUp()
  }

  function handleJsonlBackfillJobDone(msg) {
    const job = searchBackfillJobs.get(msg.jobId)
    if (msg.type === 'job-complete') {
      searchBackfillJobs.delete(msg.jobId)
      if (job?.sessionId) searchBackfillPendingBySession.delete(job.sessionId)
      for (const identity of msg.result?.identities || []) recordSessionIdentity(identity)
      if (job?.sessionId) {
        cursors[job.sessionId] = markSearchBackfilled(cursors[job.sessionId], job.harnessKind)
        scheduleCursorSave()
      }
      log.info(`JSONL ${job?.kind || 'backfill'} job complete: ${msg.jobId}`)
    } else {
      log.warn(`JSONL ${job?.kind || 'backfill'} job failed: ${msg.jobId}: ${msg.error || 'unknown error'}`)
      if (job && (job.attempts || 0) < 3 && !_shuttingDown) {
        setTimeout(() => {
          if (searchBackfillJobs.has(msg.jobId)) {
            startJsonlBackfillJob(job)
          }
        }, 1000)
      } else {
        searchBackfillJobs.delete(msg.jobId)
        if (job?.sessionId) searchBackfillPendingBySession.delete(job.sessionId)
      }
    }
    refreshIngestionCaughtUp()
  }

  function processJsonlChildOutputs(pw, outputs) {
    const connected = isConnected()
    let delivered = true
    for (const output of outputs) {
      if (output.type === 'identity' && output.identity?.marker) {
        applyLoginMarkerOwnership(pw, output.identity.marker)
      }
      const agentId = pw.primaryAgentId
      if (!connected) continue
      if (pw.ownershipState !== 'mine') continue
      if (!agentId) continue
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
    if (harness.backfillSearch && !sendSearchIndexFromRecord(pw, agentId, pw.sessionId, record)) delivered = false
    return delivered
  }

  function processQualificationEvent(agentId, ev) {
    if (!ev.blocks) return
    for (const block of ev.blocks) {
      if (block.type !== 'tool_use') continue
      const input = block.input || {}
      const filePath = input.file_path || input.path || ''
      if ((block.name === 'Edit' || block.name === 'Write' || block.name === 'MultiEdit') && filePath) {
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
        /^Call (?:login|register)\([^)]*\) with the (?:tlda|fleet) MCP server\b/.test(text)) return true
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

  function sendSearchIndexFromRecord(pw, agentId, sessionId, parsed) {
    const harness = harnessAdapters[pw?.harnessKind]?.activity
    const ev = harness?.parseRecord ? harness.parseRecord(parsed) : null
    const source = ev || parsed
    if (source.type !== 'user' && source.type !== 'assistant') return true
    const ts = source.timestamp || source.message?.timestamp || source.snapshot?.timestamp || null
    if (!ts) return true
    const blocks = Array.isArray(source.blocks) ? source.blocks : []
    let text = blocks
      .filter(block => block?.type === 'text' || block?.type === 'tool_result')
      .map(block => block.text || '')
      .filter(Boolean)
      .join('\n')
    if (!text) {
      const content = source.message?.content
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) text = content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
    }
    if (!text || text.length < 3) return true
    return sendMsg({ type: 'jsonl-index', entries: [{ agent_id: agentId, session_id: sessionId, role: source.type, timestamp: ts, text }] })
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
  function markSearchBackfilled(entry = {}, harnessKind = null) {
    return {
      ...(entry || {}),
      searchBackfilled: true,
      ...(harnessKind === 'codex' ? { searchBackfillVersion: CODEX_SEARCH_BACKFILL_VERSION } : {}),
    }
  }

  function searchBackfillCurrent(entry = {}, harnessKind = null) {
    if (!entry?.searchBackfilled) return false
    if (harnessKind === 'codex') return entry.searchBackfillVersion === CODEX_SEARCH_BACKFILL_VERSION
    return true
  }

  function backfillSearchEntries(agentId, jsonlPath, sessionId, harnessKind = null) {
    if (searchBackfillCurrent(cursors[sessionId], harnessKind)) return
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

  function syncIfRosterChanged({ agents, signature, reason, onChanged }) {
    const nextSignature = sessionWatcherRosterSignature(agents)
    if (nextSignature === signature) return signature
    log.info(`session watcher roster changed (${reason}); syncing live session tails`)
    onChanged?.()
    void syncSessionWatchers(agents).catch(e => log.error(`syncSessionWatchers failed: ${e.stack || e.message}`))
    return nextSignature
  }

  function hasWatcherForAgent(agent, matchedKind) {
    const watchedPath = agentPaths.get(agent.id)
    const watcher = watchedPath ? pathWatchers.get(watchedPath) : null
    return !!watchedPath && !!watcher && (!matchedKind || watcher.harnessKind === matchedKind)
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
    for (const [, watcher] of jsonlRootWatchers) {
      try {
        const closed = watcher.close()
        Promise.resolve(closed).catch(e => {
          log.warn(`chokidar root teardown close failed: ${e?.message || e}`)
        })
      } catch (e) {
        // Root watcher shutdown is cleanup-only; keep closing remaining watchers.
        log.warn(`chokidar root teardown close threw: ${e?.message || e}`)
      }
    }
    jsonlRootWatchers.clear()
  }

  function shutdown() {
    _shuttingDown = true
    saveCursors()
    teardown()
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
    resumeAfterServerReady: resumeJsonlIngesterAfterServerReady,
    resolveEditor,
    hasWatcherForAgent,
    teardown,
    shutdown,
    saveCursors,
  }
}
