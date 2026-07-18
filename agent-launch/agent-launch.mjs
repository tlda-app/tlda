import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import { resolveSpawnGrant } from '../server/lib/spawn-policy.mjs'
import { detectSpawnStartupFailureTranscript } from '../agent-runtime/daemon-guards.mjs'
import { probeSpawnAvailability } from './availability.mjs'
import { newFleetId } from './identity.mjs'
import { readDaemonConfigForCwd, withDaemonModelAliases } from './permission-ledger.mjs'
import { createLocalAgentLedger } from './local-agent-ledger.mjs'
import { resolveModelSpec } from './models.mjs'
import { isIntentionalEmptyPermissionSet, permissionSetConfersNothing } from './permissions.mjs'

const execFileP = promisify(execFile)

function readFileTail(file, max = 6000) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.slice(-max)
  } catch {
    return ''
  }
}

export function createAgentLauncher({
  activeConfigName,
  configDir,
  loadConfig,
  log,
  machineId,
  permissionLedger,
  sendMsg,
  getProjects,
  tmux,
  tmuxArgs = [],
  tmuxSocket = null,
  spawnImpl = null,
  startupFailureProbeMs = Number(process.env.TLDA_SPAWN_STARTUP_FAILURE_PROBE_MS || 2500),
  liveCodexSessionIdentityResolver = null,
  liveClaudeSessionIdentityResolver = null,
  liveSessionIdentityTimeoutMs = 20_000,
  liveSessionIdentityPollMs = 500,
  liveSessionIdentityNow = Date.now,
  liveSessionIdentitySleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const activeSpawns = new Map()
  const reportedStartupFailures = new Set()
  const spawnCrashLogDir = path.join(configDir, 'spawn-crashes')

  function trace(label, detail) {
    log.info(`[spawn-trace] ${label} ${JSON.stringify({ ts: new Date().toISOString(), machineId, ...detail })}`)
  }

  async function resolveLiveSessionIdentity(resolver, args) {
    const deadline = liveSessionIdentityNow() + liveSessionIdentityTimeoutMs
    for (;;) {
      const identity = await resolver(args)
      if (identity?.sessionId) return identity
      if (liveSessionIdentityNow() >= deadline) return null
      await liveSessionIdentitySleep(liveSessionIdentityPollMs)
    }
  }

  function spawnCrashLogPath({ agentName, agent_id, tmux_session }) {
    const base = String(agent_id || agentName || tmux_session || 'unknown').replace(/[^A-Za-z0-9_.:-]/g, '_')
    return path.join(spawnCrashLogDir, `${base}.log`)
  }

  async function terminateExactLaunch(tmuxSession) {
    if (!tmuxSession) return true
    try {
      await tmux('kill-session', '-t', tmuxSession)
      return true
    } catch {
      try {
        await tmux('has-session', '-t', tmuxSession)
        return false
      } catch {
        return true
      }
    }
  }

  function emitAgentSeatBinding({
    fleetId,
    sessionId,
    resumeId = sessionId,
    harness,
    model,
    cwd,
    tmuxSession,
    agentName,
    source,
  }) {
    if (!fleetId || !sessionId || !harness || !model || !cwd || !tmuxSession) return false
    const daemonKey = `${machineId}:${activeConfigName}`
    permissionLedger.setSessionSync(fleetId, {
      sessionId,
      sessionKind: harness,
      sessionPath: null,
      tmuxSession,
      model,
      machineId,
      envName: activeConfigName,
      daemonKey,
      cwd,
      friendlyName: agentName,
    })
    const localLedger = createLocalAgentLedger(path.join(configDir, 'fleet-daemon.db'))
    try {
      const local = localLedger.get(fleetId)
      if (local) {
        localLedger.updateConversation(local.localAgentId, { sessionId, harness, model })
        localLedger.updateProcess(local.localAgentId, { tmuxName: tmuxSession, cwd })
      }
    } finally {
      localLedger.close()
    }
    sendMsg({
      type: 'agent-seat',
      agent_id: fleetId,
      session_id: sessionId,
      resume_id: resumeId || sessionId,
      kind: harness,
      model,
      cwd,
      machine_id: machineId,
      env_name: activeConfigName,
      daemon_key: daemonKey,
      tmux_session: tmuxSession,
      created_source: source,
    })
    return true
  }

  async function probeSpawnStartupFailure({ agentName, agent_id, tmux_session, harness, model, respawn, crash_log_path }) {
    if (!agent_id || !tmux_session) return null
    const dedupKey = `${agent_id}:${tmux_session}`
    if (reportedStartupFailures.has(dedupKey)) return null
    try {
      await new Promise(resolve => setTimeout(resolve, startupFailureProbeMs))
      const { stdout } = await execFileP('tmux',
        [...tmuxArgs, 'capture-pane', '-t', tmux_session, '-p', '-e', '-S', '-120'],
        { timeout: 5000, encoding: 'utf8' })
      const failure = detectSpawnStartupFailureTranscript(stdout, { harness })
      if (!failure) return null
      reportedStartupFailures.add(dedupKey)
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

  async function spawn({
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
    permissionRequest,
    acknowledgeNoSecurity,
    callerRung,
    requester,
  }) {
    const projects = getProjects()
    const sessionId = session || session_id
    const agentName = name || (sessionId ? `session-${String(sessionId).slice(0, 8)}` : `agent-${Date.now().toString(36).slice(-4)}`)
    let launchModel = model
    let launchKind = null
    let launchModelSpec = null
    if (activeSpawns.has(agentName)) {
      log.info(`spawn deduped: ${agentName} already has an in-flight launch`)
      return {
        ok: false,
        name: agentName,
        deduped: true,
        error: `${agentName} already has an in-flight launch`,
      }
    }
    let resolvedCwd = cwd
    if (!resolvedCwd && doc) {
      const project = projects.find(p => p.name === doc)
      if (!project) {
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
      const daemonConfig = readDaemonConfigForCwd(resolvedCwd)
      spawnConfig = withDaemonModelAliases(config, daemonConfig)
      if (model || (!respawn && !refresh)) {
        launchModelSpec = resolveModelSpec(model, { config: spawnConfig })
        launchModel = launchModelSpec.id
        launchKind = launchModelSpec.harness
      }
      if (respawn) {
        const own = agent_id ? permissionLedger.get(agent_id) : null
        if (!own) {
          throw new Error(`wake refused: seat ${agent_id || '(no id)'} has no ledger entry — a real agent must have a seat; refusing to resume with a fabricated grant`)
        }
        grant = {
          spawnPolicy: own.spawnPolicy,
          permissionSet: own.permissionSet,
          permissionProfile: own.permissionProfile,
          permissionIntersection: own.permissionIntersection,
          grantPreserved: true,
        }
      } else {
        if (!requester?.id) {
          const err = new Error('spawn refused: daemon RPC requester identity is required')
          err.code = 'SPAWN_PERMISSION_NO_REQUESTER'
          throw err
        }
        let spawnerGrant = permissionLedger.get(requester.id)
        if (!spawnerGrant) spawnerGrant = permissionLedger.grantFor(requester)
        // DAMNING: this is the daemon-config resolution point. `readDaemonConfigForCwd`
        // reads daemon.yaml's `profiles`/`grants`/`default`. If that config is EMPTY
        // (profiles:{} grants:{} default:null — e.g. a stray/uninitialized daemon.yaml),
        // this resolves to null, resolveSpawnGrant's intersection collapses, and the
        // agent gets an empty grant → deny-all seatbelt → alive-but-caged. That is the
        // exact 2026-07-10 failure. Empty daemon config MUST NOT silently resolve to
        // "cage everyone." The hard refuse below (SPAWN_NO_GRANT) is the backstop that
        // makes this loud instead of silent — do not remove it, and do not paper over an
        // empty daemon.yaml by defaulting a permissive grant here.
        const projectDefaultProfile = daemonConfig?.default || null
        const grantConfig = projectDefaultProfile
          ? { ...spawnConfig, spawnPolicy: { ...(spawnConfig?.spawnPolicy || {}), projectProfiles: { ...((spawnConfig?.spawnPolicy || {}).projectProfiles || {}), [resolvedCwd]: projectDefaultProfile } } }
          : spawnConfig
        grant = resolveSpawnGrant({
          permissionRequest,
          requester,
          spawnerPermissionSet: spawnerGrant?.permissionSet,
          spawnerPermissionProfile: spawnerGrant?.permissionProfile,
          model: launchModel,
          kind: launchKind,
          modelCap: launchModelSpec?.cap || null,
          config: grantConfig,
          doc,
          project: projectForGrant,
          cwd: resolvedCwd,
        })
        const permissionProfile = grant.permissionProfile
        if (permissionProfile) {
          grant.permissionProfile = permissionProfile
          grant.permissionSet.projectedPolicy = {
            policy: grant.spawnPolicy.policy,
          }
        }
      }
      // ────────────────────────────────────────────────────────────────────────
      // INVARIANT — NO AGENT MAY EVER BE SPAWNED WITHOUT A RESOLVED GRANT.
      //
      // If the grant resolution above produced a set that confers NOTHING — no
      // readable and no writable zone — and it was NOT a deliberately-requested
      // `none`, then no configuration was actually specified for this agent. We
      // MUST refuse the spawn here, before any ledger row is written and before
      // the seat is launched. Do not "default a grant"; do not proceed and let
      // the seatbelt sort it out.
      //
      // WHY THIS EXISTS, AND WHY YOU MUST NOT REMOVE OR LOOSEN IT: on 2026-07-10
      // grant-less spawns were let through. Every agent born that way inherited an
      // empty-write seatbelt (fence-seatbelt.mjs: empty allowWrite → `deny
      // file-write* (subpath "/")` = deny ALL writes). The result was a fleet of
      // agents that were ALIVE — they registered, they answered chat — but were
      // fully caged: they could not write a file, run a command, or take a single
      // recovery action. Every recovery agent that night was stillborn this way.
      // It tortured Skip for hours and looked like "the models are broken" when the
      // real cause was infra handing out empty grants. An agent that is alive but
      // cannot act is worse than no agent: it consumes a seat, answers, and does
      // nothing. Skip's rule, verbatim: "Spawning an agent without any grant at all
      // is an error." Refuse loudly. A deliberately minimal/read-only profile that
      // someone actually specified still passes — this only catches the accidental
      // empty. If you are here to weaken this because a spawn is being refused, the
      // fix is to specify a real profile/grant, NOT to delete this guard.
      // ────────────────────────────────────────────────────────────────────────
      if (permissionSetConfersNothing(grant.permissionSet)
        && !isIntentionalEmptyPermissionSet(grant.permissionSet)) {
        const err = new Error(
          `spawn refused: no grant resolved for ${agentName}${agent_id ? ` (${agent_id})` : ''} — `
          + `the spawn policy produced an empty grant (no readable or writable zone) and none was deliberately requested. `
          + `Refusing to create an alive-but-caged agent. Specify a real profile/grant for this spawn.`)
        err.code = 'SPAWN_NO_GRANT'
        throw err
      }
    } catch (e) {
      return { ok: false, name: agentName, error: `spawn policy resolution failed: ${e.message}` }
    }
    trace('grant', {
      agentName,
      agent_id: agent_id || null,
      requestedKind: kind || null,
      launchKind: launchKind || null,
      requestedModel: model || null,
      launchModel: launchModel || null,
      permissionRequest: permissionRequest || null,
      permissionProfile: grant.permissionProfile || null,
      permissionIntersection: grant.permissionIntersection || null,
      spawnPolicy: grant.spawnPolicy || null,
      hasPermissionSet: !!grant.permissionSet,
      cwd: resolvedCwd || null,
      doc: doc || null,
      requester: requester ? { id: requester.id || null, name: requester.name || null, human: !!requester.human, spawnPolicy: requester.spawnPolicy || null } : null,
    })
    activeSpawns.set(agentName, Date.now())
    try {
      const nodeSpawn = spawnImpl || (await import('./index.mjs')).spawn
      const spawnMode = sessionId ? 'session' : (refresh ? 'refresh' : (respawn ? 'respawn' : 'fresh'))
      const preallocatedAgentId = agent_id || ((spawnMode === 'fresh' || spawnMode === 'session') ? newFleetId() : undefined)
      const shouldWriteLedgerRow = !!preallocatedAgentId && (spawnMode === 'fresh' || spawnMode === 'session')
      const crashLogPath = spawnCrashLogPath({ agentName, agent_id: preallocatedAgentId || agent_id, tmux_session: null })
      if (shouldWriteLedgerRow) {
        await permissionLedger.set(preallocatedAgentId, {
          spawnPolicy: grant.spawnPolicy,
          permissionProfile: grant.permissionProfile,
          permissionIntersection: grant.permissionIntersection,
          permissionSet: grant.permissionSet,
          source: 'spawn',
        })
      }
      let launched
      const launchStartedAt = new Date().toISOString()
      try {
        launched = await nodeSpawn({
          spawnMode,
          agentId: preallocatedAgentId,
          name: agentName,
          model: launchModel,
          kind: launchKind,
          modelSpec: launchModelSpec,
          config: spawnConfig,
          activeConfigName,
          permissionLedger,
          cwd: resolvedCwd,
          sessionId,
          enroll: !!enroll,
          effort,
          permissionMode: mode,
          spawnPolicy: grant.spawnPolicy,
          permissionProfile: grant.permissionProfile,
          permissionIntersection: grant.permissionIntersection,
          permissionSet: grant.permissionSet,
          explicitPolicy: permissionRequest != null,
          acknowledgeNoSecurity: !!acknowledgeNoSecurity,
          machineId,
          tmuxSocket,
          crashLogPath,
          identityConfigDir: configDir,
        })
      } catch (e) {
        if (shouldWriteLedgerRow) await permissionLedger.delete(preallocatedAgentId).catch(() => {})
        throw e
      }
      trace(launched.alreadyAlive ? 'already-alive' : 'launched', {
        agentName,
        agent_id: launched.fleetId,
        tmux_session: launched.tmuxSession,
        crash_log_path: crashLogPath,
        harness: launched.harness,
        model: launched.model,
        spawnPolicy: grant.spawnPolicy || null,
        permissionProfile: grant.permissionProfile || null,
        permissionIntersection: grant.permissionIntersection || null,
      })
      try {
        await tmux('has-session', '-t', launched.tmuxSession)
      } catch (e) {
        const terminated = await terminateExactLaunch(launched.tmuxSession)
        if (terminated && shouldWriteLedgerRow) await permissionLedger.delete(preallocatedAgentId).catch(() => {})
        const detail = ((e.stderr || e.message || '').trim().split('\n').filter(Boolean).pop()) || 'tmux session check failed'
        return {
          ok: false,
          name: agentName,
          agent_id: launched.fleetId,
          tmux_session: launched.tmuxSession,
          error: terminated
            ? `spawn launcher returned but tmux session is not usable: ${detail}`
            : `spawn launcher returned but tmux session could not be verified; ownership retained because ${launched.tmuxSession} is still live: ${detail}`,
          ownership_retained: !terminated,
        }
      }
      const launchedLedgerRow = launched.fleetId ? permissionLedger.get(launched.fleetId) : null
      if (launched.harness === 'codex' && !launched.resumeId && !launched.pending && !launchedLedgerRow?.sessionId) {
        const terminated = await terminateExactLaunch(launched.tmuxSession)
        if (terminated && shouldWriteLedgerRow) await permissionLedger.delete(preallocatedAgentId).catch(() => {})
        return {
          ok: false,
          name: agentName,
          agent_id: launched.fleetId,
          tmux_session: launched.tmuxSession,
          code: 'missing-resume-handle',
          error: terminated
            ? 'spawn launcher returned a codex session without a durable resume handle; exact process terminated'
            : 'spawn launcher returned a codex session without a durable resume handle; ownership retained because exact process could not be terminated',
          ownership_retained: !terminated,
        }
      }
      // A launch without a durable resume identity leaves the ledger row
      // sessionId-less: every later wake fails with "missing daemon-ledger
      // resume identity", and no JSONL watcher arms (no activity cards).
      // Resolve the live session identity now — per harness, transparently
      // parallel (the resolvers differ ONLY in where each harness records its
      // session; everything else here is shared) — and persist it before the
      // spawn returns.
      const liveIdentityResolvers = {
        codex: liveCodexSessionIdentityResolver,
        claude: liveClaudeSessionIdentityResolver,
      }
      const liveIdentityResolver = liveIdentityResolvers[launched.harness] || null
      let liveIdentity = null
      if (
        liveIdentityResolver &&
        !launched.resumeId &&
        !permissionLedger.get(launched.fleetId)?.sessionId
      ) {
        try {
          liveIdentity = await resolveLiveSessionIdentity(liveIdentityResolver, {
            fleetId: launched.fleetId,
            agentName,
            tmuxSession: launched.tmuxSession,
            cwd: resolvedCwd,
            model: launched.model,
            launchStartedAt,
          })
        } catch (e) {
          log.warn(`live ${launched.harness} session identity resolution failed for ${agentName}: ${e.message}`)
        }
        if (!liveIdentity?.sessionId) {
          log.warn(`${launched.harness} spawn ${agentName} (${launched.fleetId}) has no resolved session identity yet; ledger row left pending for ingestion`)
        }
      }
      const ledgerRow = launched.fleetId ? permissionLedger.get(launched.fleetId) : null
      const durableSessionId = launched.resumeId || liveIdentity?.sessionId || ledgerRow?.sessionId || sessionId || null
      emitAgentSeatBinding({
        fleetId: launched.fleetId,
        sessionId: durableSessionId,
        resumeId: durableSessionId,
        harness: launched.harness || ledgerRow?.sessionKind || launchKind,
        model: launched.model || liveIdentity?.model || ledgerRow?.model || launchModel,
        cwd: resolvedCwd || ledgerRow?.cwd || null,
        tmuxSession: launched.tmuxSession || ledgerRow?.tmuxSession || null,
        agentName,
        source: launched.alreadyAlive ? 'spawn-runtime-already-live' : 'spawn-runtime',
      })
      if (!preallocatedAgentId || launched.fleetId !== preallocatedAgentId) {
        await permissionLedger.set(launched.fleetId, {
          spawnPolicy: grant.spawnPolicy,
          permissionProfile: grant.permissionProfile,
          permissionIntersection: grant.permissionIntersection,
          permissionSet: grant.permissionSet,
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
        resume_id: launched.resumeId || liveIdentity?.sessionId || null,
        pending: !!launched.pending,
        enrolled: launched.enrolled,
        spawnerPermission: grant.spawnerPermission,
        projectPermission: grant.projectPermission,
        modelPermission: grant.modelPermission,
        permissionSet: grant.permissionSet,
        spawnPolicy: grant.spawnPolicy,
        permissionProfile: grant.permissionProfile,
        permissionIntersection: grant.permissionIntersection,
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
      activeSpawns.delete(agentName)
    }
  }

  return {
    handlers: {
      spawn,
      'spawn-availability': (params = {}) => probeSpawnAvailability({ cwd: params?.cwd || null }),
    },
    probeSpawnStartupFailure,
  }
}
