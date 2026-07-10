import chokidar from 'chokidar'
import { fork } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { recordPartialSkillReads } from '../shared/partial-skill-reads.mjs'
import {
  loadSessionIdentityStore,
  saveSessionIdentityStore,
  updateFleetFriendlyName,
  updateIngestionStatus,
  upsertSessionIdentity,
} from '../agent-runtime/session-identity-store.mjs'
import { tailSessionIdentityInput } from '../agent-runtime/session-identity-tail.mjs'
import { scanFileIdentitySync, scanFileOwnersSync } from '../agent-runtime/daemon-jsonl-hot-path.mjs'
import {
  shouldClaimClaudeWatcher,
  shouldClaimCodexWatcher,
} from '../agent-runtime/daemon-guards.mjs'
import { codexRolloutBelongsToAgent, codexRolloutHasOwnerEvidence } from '../agent-runtime/resolve-transcript.mjs'
import { acquireSingletonLock, sessionReaderLockPath } from '../agent-runtime/singleton-lock.mjs'

const DEFAULT_DISPLAY_REPLAY_MAX_BYTES = 256 * 1024
const CATCHUP_DISPLAY_OUTPUT_TYPES = new Set(['activity', 'context', 'qualification', 'terminalChat', 'nativeTask'])

export function catchupReplayBoundary({ startOffset = 0, liveOffset = 0, thresholdBytes = DEFAULT_DISPLAY_REPLAY_MAX_BYTES } = {}) {
  if (!Number.isFinite(startOffset) || !Number.isFinite(liveOffset)) return null
  if (!Number.isFinite(thresholdBytes) || thresholdBytes < 0) return null
  return liveOffset - startOffset > thresholdBytes ? liveOffset : null
}

export function shouldSuppressCatchupOutput(output) {
  return CATCHUP_DISPLAY_OUTPUT_TYPES.has(output?.type)
}

export function createJsonlIngestor({
  configDir,
  cursorsFile,
  sessionIdentityFile,
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
  bufferActivity,
  extractActivityEvents,
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
  let sessionIdentityStore = loadSessionIdentityStore(sessionIdentityFile)

  // Throttle saveCursors — flush at most once per 2s.
  let _cursorSaveTimer = null
  function scheduleCursorSave() {
    if (_cursorSaveTimer) return
    _cursorSaveTimer = setTimeout(() => { _cursorSaveTimer = null; saveCursors() }, 2000)
  }

  function saveSessionIdentityStoreNow() {
    try { saveSessionIdentityStore(sessionIdentityFile, sessionIdentityStore) }
    catch (e) {
      log.error(`session identity save failed: ${e.message}`)
      throw e
    }
  }

  function recordSessionIdentity(input, { save = true } = {}) {
    if (!input?.session_id) return
    if (upsertSessionIdentity(sessionIdentityStore, input) && save) saveSessionIdentityStoreNow()
  }

  function syncSessionIdentityNamesFromAgents(agentList = getAgents()) {
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
  function startOwnerHarvester() {
    if (_ownerHarvester) return
    const script = path.join(daemonDir, 'fleet-owner-harvester.mjs')
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
  const pathWatchers = new Map()    // jsonlPath -> child-backed watcher state
  const agentPaths = new Map()      // agentId -> jsonlPath
  const jsonlDirWatchers = new Map() // dir -> { watcher, refs }
  const childWatchers = new Map() // watchId -> path watcher state
  const searchBackfillJobs = new Map() // jobId -> { sessionId, jsonlPath }
  const searchBackfillPendingBySession = new Set()
  const priorSessionBackfillPending = new Set()
  const priorSessionBackfillComplete = new Set()

  function startJsonlIngester() {
    if (_jsonlIngester) return _jsonlIngester
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
        if (isServerReady()) {
          retryPendingJsonlBackfillJobs()
          void syncSessionWatchers(getAgents()).catch(e => log.error(`syncSessionWatchers after ingester exit failed: ${e.stack || e.message}`))
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
    let liveSessions = new Set()
    try {
      const r = await listSessions()
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
        const kind = await selectAgentKind(agent)
        const adapter = harnessAdapters[kind]
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
            // Retire this broken tail; other JSONL watchers must keep flowing.
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
        if (harness.kind === 'codex') {
          try {
            const { identity, owners, endOffset } = scanFileIdentitySync(jsonlPath)
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
        } catch (e) {
          // Identity recovery is opportunistic; the JSONL watcher must still start.
          log.warn(`codex identity scan failed for ${path.basename(jsonlPath)}: ${e.message}`)
        }
      }
        const pwState = startJsonlTail({ agent, jsonlPath, sessionId, harness, startOffset: offset, liveOffset: stat.size })
        pathWatchers.set(jsonlPath, pwState)
        retainJsonlDirWatcher(jsonlPath)

        log.info(`watching ${harness.kind} JSONL for ${agent.friendly_name || agent.id}: ${path.basename(jsonlPath)} @ offset=${offset}`)
      } catch (e) {
        // One failed watcher should not prevent other agents from being watched.
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

  function startJsonlTail({ agent, jsonlPath, sessionId, harness, startOffset, liveOffset }) {
    const child = startJsonlIngester()
    const watchId = `${sessionId}:${agent.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`
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
      catchupUntilOffset,
      catchupSuppressed: {},
    }
    if (catchupUntilOffset != null) {
      log.warn(`JSONL display catch-up for ${agent.friendly_name || agent.id}: suppressing backlog display events from offset ${startOffset} to ${catchupUntilOffset}`)
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
      maybeCompleteDisplayCatchup(pw, msg.offset)
      updateJsonlCursorFromTail(pw, msg.offset)
    }
  }

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
    if (!isConnected()) return false
    const agentId = pw.primaryAgentId
    let delivered = true
    for (const output of outputs) {
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
    resolveEditor,
    hasWatcherForAgent,
    teardown,
    shutdown,
    saveCursors,
  }
}
