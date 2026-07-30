import fs from 'fs'
import path from 'path'
import { compilePermissionGrant, permissionGrantProfileName, resolveSpawnGrant } from '../server/lib/permission-grants.mjs'
import { detectSpawnStartupFailureTranscript } from '../agent-runtime/daemon-guards.mjs'
import { probeSpawnAvailability } from './availability.mjs'
import { newFleetId } from './identity.mjs'
import { readDaemonConfigForCwd, withDaemonModelAliases } from './permission-ledger.mjs'
import { resolveModelSpec } from './models.mjs'
import { isIntentionalEmptyPermissionSet, permissionSetConfersNothing } from './permissions.mjs'
import { bindAgentRoute } from './route-binding.mjs'
import { wsReserveShell } from './register.mjs'
import { exactTmuxTarget, exactTmuxWindowTarget } from '../shared/tmux-target.mjs'

function readFileTail(file, max = 6000) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.slice(-max)
  } catch {
    return ''
  }
}

export function createAgentLauncher({
  activeEnvName,
  configDir,
  loadDaemonLaunchConfig,
  loadDaemonConfigForCwd = readDaemonConfigForCwd,
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
  bindAgentRouteImpl = bindAgentRoute,
  liveSessionIdentityTimeoutMs = 20_000,
  liveSessionIdentityPollMs = 500,
  liveSessionIdentityNow = Date.now,
  liveSessionIdentitySleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  reserveShellImpl = wsReserveShell,
}) {
  const activeSpawns = new Map()
  const reportedStartupFailures = new Set()
  const spawnCrashLogDir = path.join(configDir, 'spawn-crashes')

  function trace(label, detail) {
    log.info(`[spawn-trace] ${label} ${JSON.stringify({ ts: new Date().toISOString(), machineId, ...detail })}`)
  }

  async function emitLifecycle(onLifecycleEvent, event, data = {}) {
    try {
      await onLifecycleEvent?.(event, data)
    } catch (error) {
      await sendMsg({
        type: 'daemon-warning',
        warning: 'spawn-lifecycle-delivery-failed',
        event,
        error: error?.message || String(error),
        data,
      })
    }
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

  function reservationTimeoutMs() {
    const raw = Number(process.env.TLDA_SHELL_RESERVATION_TIMEOUT_MS || 30_000)
    return Number.isFinite(raw) && raw > 0 ? raw : 30_000
  }

  function defaultModelAliasForHarness(config = {}, harness = '') {
    const target = String(harness || '').trim().toLowerCase()
    if (!target) return null
    const values = config?.modelCatalog?.values && typeof config.modelCatalog.values === 'object'
      ? config.modelCatalog.values
      : config?.modelSpecs
    if (!values || typeof values !== 'object') return null
    const found = Object.values(values).find(spec => String(spec?.harness || spec?.kind || '').trim().toLowerCase() === target)
    return found?.alias || found?.name || null
  }

  function resolveSessionLaunchSpec({ model, kind, config }) {
    const sessionKind = String(kind || '').trim().toLowerCase()
    if (sessionKind !== 'codex' && sessionKind !== 'claude') {
      throw new Error('session spawn requires kind <codex|claude>; session ids are not unique across harnesses')
    }
    const requestedModel = model || defaultModelAliasForHarness(config, sessionKind)
    if (!requestedModel) {
      throw new Error(`no configured model alias for ${sessionKind} session enrollment; pass --model`)
    }
    const spec = resolveModelSpec(requestedModel, { config })
    if (spec.harness !== sessionKind) {
      throw new Error(`daemon model "${requestedModel}" is configured for harness "${spec.harness}", not "${sessionKind}"`)
    }
    return spec
  }

  async function terminateExactLaunch(tmuxSession) {
    if (!tmuxSession) return true
    try {
      await tmux('kill-session', '-t', exactTmuxTarget(tmuxSession))
      return true
    } catch {
      try {
        await tmux('has-session', '-t', exactTmuxTarget(tmuxSession))
        return false
      } catch {
        return true
      }
    }
  }

  async function emitAgentRoute({
    fleetId,
  }) {
    if (!fleetId) return false
    const daemonKey = `${machineId}:${activeEnvName}`
    const binding = await bindAgentRouteImpl({
      agentId: fleetId,
      daemonKey,
      submit: async payload => sendMsg({ type: 'agent-route', ...payload }),
    })
    return binding?.bound === true
  }

  async function reserveAlreadyLiveShell({ launched, agentName, cwd, grant, sessionId }) {
    if (!launched?.alreadyAlive) return
    if (!launched?.fleetId || !launched?.tmuxSession || !launched?.harness || !launched?.model || !sessionId) {
      throw new Error(`already-live session enrollment for ${agentName} returned without a complete shell identity`)
    }
    if (!launched.localAgentId) {
      throw new Error(`already-live session enrollment for ${agentName} has no local mint id for existing login resolution`)
    }
    await reserveShellImpl({
      fleetId: launched.fleetId,
      localAgentId: launched.localAgentId,
      name: agentName,
      tmuxSession: launched.tmuxSession,
      cwd,
      model: launched.model,
      kind: launched.harness,
      sessionId,
      permissionGrant: grant.permissionGrant,
      machineId,
      envName: activeEnvName,
    })
  }

  async function probeSpawnStartupFailure({ agentName, agent_id, tmux_session, harness, model, respawn, crash_log_path }) {
    if (!agent_id || !tmux_session) return null
    const dedupKey = `${agent_id}:${tmux_session}`
    if (reportedStartupFailures.has(dedupKey)) return null
    try {
      await new Promise(resolve => setTimeout(resolve, startupFailureProbeMs))
      const { stdout } = await tmux('capture-pane', '-t', exactTmuxWindowTarget(tmux_session), '-p', '-e', '-S', '-120')
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

  async function diagnoseSpawnStartupFailure({ agentName, agent_id, tmux_session, harness, model, respawn, crash_log_path }) {
    const failure = await probeSpawnStartupFailure({
      agentName,
      agent_id,
      tmux_session,
      harness,
      model,
      respawn,
      crash_log_path,
    })
    if (failure) return failure
    const crashTail = crash_log_path ? readFileTail(crash_log_path) : ''
    return {
      code: 'prompt-delivery-unverified',
      reason: `prompt delivery was unverified for ${tmux_session}`,
      snippet: crashTail,
    }
  }

  async function spawn({
    agent_id,
    agentId,
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
    onLifecycleEvent,
  }) {
    const projects = getProjects()
    const sessionId = session || session_id
    const requestedAgentId = agent_id || agentId || null
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
      const config = loadDaemonLaunchConfig()
      const daemonConfig = loadDaemonConfigForCwd(resolvedCwd)
      spawnConfig = withDaemonModelAliases(config, daemonConfig)
      if (model || (!respawn && !refresh)) {
        launchModelSpec = sessionId
          ? resolveSessionLaunchSpec({ model, kind, config: spawnConfig })
          : resolveModelSpec(model, { config: spawnConfig })
        launchModel = launchModelSpec.id
        launchKind = launchModelSpec.harness
      }
      if (respawn) {
        const own = requestedAgentId ? permissionLedger.get(requestedAgentId) : null
        if (!own) {
          throw new Error(`wake refused: seat ${requestedAgentId || '(no id)'} has no ledger entry — a real agent must have a seat; refusing to resume with a fabricated grant`)
        }
        grant = {
          permissionGrant: own.permissionGrant,
          permissionSet: compilePermissionGrant(spawnConfig, own.permissionGrant, { cwd: resolvedCwd, project: projectForGrant }),
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
          ? { ...spawnConfig, projectPermissionProfiles: { ...(spawnConfig.projectPermissionProfiles || {}), [resolvedCwd]: projectDefaultProfile } }
          : spawnConfig
        grant = resolveSpawnGrant({
          permissionRequest,
          requester,
          spawnerPermissionSet: compilePermissionGrant(grantConfig, spawnerGrant.permissionGrant, { cwd: resolvedCwd, project: projectForGrant }),
          spawnerPermissionProfile: permissionGrantProfileName(spawnerGrant.permissionGrant),
          model: launchModel,
          kind: sessionId ? kind : launchKind,
          modelCap: launchModelSpec?.cap || null,
          config: grantConfig,
          doc,
          project: projectForGrant,
          cwd: resolvedCwd,
        })
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
          `spawn refused: no grant resolved for ${agentName}${requestedAgentId ? ` (${requestedAgentId})` : ''} — `
          + `the permission grant produced an empty grant (no readable or writable zone) and none was deliberately requested. `
          + `Refusing to create an alive-but-caged agent. Specify a real profile/grant for this spawn.`)
        err.code = 'SPAWN_NO_GRANT'
        throw err
      }
    } catch (e) {
      return { ok: false, name: agentName, error: `permission grant resolution failed: ${e.message}` }
    }
    trace('grant', {
      agentName,
      agent_id: requestedAgentId || null,
      requestedKind: kind || null,
      launchKind: launchKind || null,
      requestedModel: model || null,
      launchModel: launchModel || null,
      permissionRequest: permissionRequest || null,
      permissionGrant: grant.permissionGrant || null,
      hasPermissionSet: !!grant.permissionSet,
      cwd: resolvedCwd || null,
      doc: doc || null,
      requester: requester ? { id: requester.id || null, name: requester.name || null, human: !!requester.human, permissionGrant: requester.permissionGrant || null } : null,
    })
    activeSpawns.set(agentName, Date.now())
    try {
      const nodeSpawn = spawnImpl || (await import('./index.mjs')).spawn
      const spawnMode = sessionId ? 'session' : (refresh ? 'refresh' : (respawn ? 'respawn' : 'fresh'))
      const preallocatedAgentId = requestedAgentId || ((spawnMode === 'fresh' || spawnMode === 'session') ? newFleetId() : undefined)
      const shouldWriteLedgerRow = !!preallocatedAgentId && (spawnMode === 'fresh' || spawnMode === 'session')
      const crashLogPath = spawnCrashLogPath({ agentName, agent_id: preallocatedAgentId || requestedAgentId, tmux_session: null })
      if (shouldWriteLedgerRow) {
        await permissionLedger.set(preallocatedAgentId, {
          permissionGrant: grant.permissionGrant,
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
          activeEnvName,
          permissionLedger,
          cwd: resolvedCwd,
          sessionId,
          enroll: !!enroll,
          effort,
          permissionMode: mode,
          permissionGrant: grant.permissionGrant,
          permissionSet: grant.permissionSet,
          explicitPermissionRequest: permissionRequest != null,
          acknowledgeNoSecurity: !!acknowledgeNoSecurity,
          machineId,
          tmuxSocket,
          crashLogPath,
          identityConfigDir: configDir,
          shellReservationTimeoutMs: reservationTimeoutMs(),
          onLifecycleEvent,
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
        permissionGrant: grant.permissionGrant || null,
      })
      if (spawnMode === 'session') {
        await reserveAlreadyLiveShell({
          launched,
          agentName,
          cwd: resolvedCwd,
          grant,
          sessionId,
        })
      }
      const promptDeliveryFailed = launched?.promptDelivery?.ok === false
      if (promptDeliveryFailed && spawnMode === 'fresh' && launched.harness === 'codex') {
        const failure = await diagnoseSpawnStartupFailure({
          agentName,
          agent_id: launched.fleetId,
          tmux_session: launched.tmuxSession,
          crash_log_path: crashLogPath,
          harness: launched.harness,
          model: launched.model,
          respawn,
        })
        return {
          ok: false,
          name: agentName,
          agent_id: launched.fleetId,
          tmux_session: launched.tmuxSession,
          code: failure.code,
          reason: failure.code,
          error: failure.reason || 'fresh Codex prompt delivery was blocked before login',
          snippet: failure.snippet || null,
          ownership_retained: true,
        }
      }
      try {
        await tmux('has-session', '-t', exactTmuxTarget(launched.tmuxSession))
      } catch (e) {
        const terminated = spawnMode === 'respawn'
          ? false
          : await terminateExactLaunch(launched.tmuxSession)
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
      const preResolutionLedgerRow = launched.fleetId ? permissionLedger.get(launched.fleetId) : null
      const existingDurableSessionId = launched.resumeId || preResolutionLedgerRow?.sessionId || sessionId || null
      if (
        liveIdentityResolver &&
        (!existingDurableSessionId || !preResolutionLedgerRow?.sessionPath)
      ) {
        try {
          liveIdentity = await resolveLiveSessionIdentity(liveIdentityResolver, {
            fleetId: launched.fleetId,
            sessionId: existingDurableSessionId,
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
      if (launched.registrationDeferred && !launched.fleetId) {
        let ledgerCleanupError = null
        if (shouldWriteLedgerRow && preallocatedAgentId) {
          try {
            await permissionLedger.delete(preallocatedAgentId)
          } catch (e) {
            // Local runtime ownership is retained; later server reconciliation creates the real binding.
            ledgerCleanupError = `could not remove unbound server ledger row for local-only mint ${agentName}: ${e.message}`
          }
        }
        await emitLifecycle(onLifecycleEvent, 'terminal-local-only', {
          ok: true,
          local_agent_id: launched.localAgentId || null,
          tmux_session: launched.tmuxSession,
          harness: launched.harness || launchKind,
          model: launched.model || launchModel,
          cwd: resolvedCwd || null,
          name: launched.name || agentName,
          reason: 'server-registration-deferred',
        })
        return {
          ok: true,
          name: launched.name || agentName,
          agent_id: null,
          local_agent_id: launched.localAgentId || null,
          tmux_session: launched.tmuxSession,
          resume_id: launched.resumeId || liveIdentity?.sessionId || null,
          registrationDeferred: true,
          pending: !!launched.pending,
          harness: launched.harness || launchKind,
          model: launched.model || launchModel,
          spawnerPermission: grant.spawnerPermission,
          projectPermission: grant.projectPermission,
          modelPermission: grant.modelPermission,
          permissionSet: grant.permissionSet,
          permissionGrant: grant.permissionGrant,
          ...(ledgerCleanupError ? { cleanup_error: ledgerCleanupError } : {}),
        }
      }
      const bindingWritten = await emitAgentRoute({
        fleetId: launched.fleetId,
      })
      if (!bindingWritten) {
        return {
          ok: false,
          name: agentName,
          agent_id: launched.fleetId,
          tmux_session: launched.tmuxSession,
          code: 'route-publication-failed',
          reason: 'route-publication-failed',
          error: 'spawn launcher could not publish its daemon route',
          ownership_retained: true,
        }
      }
      await emitLifecycle(onLifecycleEvent, 'server-binding-joined', {
        agent_id: launched.fleetId,
        fleet_id: launched.fleetId,
        tmux_session: launched.tmuxSession,
        harness: launched.harness || ledgerRow?.sessionKind || launchKind,
        model: launched.model || liveIdentity?.model || ledgerRow?.model || launchModel,
        cwd: resolvedCwd || ledgerRow?.cwd || null,
        name: launched.name || agentName,
      })
      if (!preallocatedAgentId || launched.fleetId !== preallocatedAgentId) {
        await permissionLedger.set(launched.fleetId, {
          permissionGrant: grant.permissionGrant,
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
        already: !!launched.alreadyAlive,
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
        permissionGrant: grant.permissionGrant,
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

  async function wake(params = {}) {
    const fleetId = params.fleet_id
    if (!fleetId || !String(fleetId).startsWith('fleet:')) {
      return { ok: false, error: 'wake requires literal fleet_id', code: 'missing-fleet-id', reason: 'missing-fleet-id' }
    }
    if (params.agent_id || params.agentId || params.name) {
      return { ok: false, error: 'wake accepts only fleet_id; resolve aliases before calling daemon wake', code: 'wake-alias-refused', reason: 'wake-alias-refused' }
    }
    return spawn({
      ...params,
      name: fleetId,
      agent_id: fleetId,
      respawn: true,
      refresh: false,
    })
  }

  return {
    handlers: {
      spawn,
      wake,
      'spawn-availability': (params = {}) => probeSpawnAvailability({ cwd: params?.cwd || null }),
    },
    probeSpawnStartupFailure,
  }
}
