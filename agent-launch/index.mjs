import { SpawnLibrarian } from '../shared/spawn-librarian.ts'
import { newLocalAgentId, resolveDnsAlias, resolveSpawnCwd, sanitizeSessionName } from './identity.mjs'
import { readDaemonConfigForCwd, withDaemonModelAliases } from './permission-ledger.mjs'
import { createLocalAgentLedger } from './local-agent-ledger.mjs'
import { normalizeSpawnModelKwargs } from './models.mjs'
import { checkFreshNameAvailable, ensureServer, findAgent, markAgentDead, resolveApi, wsMintShell, wsReserveShell } from './register.mjs'
import { injectClaudePrompt, injectCodexPrompt, sessionHasRuntime, sessionRuntimeState, spawnTmux, terminateTmuxSession, uniqueSessionName } from './tmux.mjs'
import { wrapSandboxCmd } from './fence.mjs'
import { resolveLaunchPolicy, permissionMetadata } from './permissions.mjs'
import { resolveCodexResumeHandle } from '../agent-runtime/codex-resume-resolver.mjs'
import {
  codexRolloutPath,
  findClaudeSession,
  isRespawnIdentityCaughtUp,
  scanClaudeSessionIdentity,
  scanCodexRolloutIdentity,
  stripSyntheticTail,
} from './resume.mjs'
import * as claude from './harness/claude.mjs'
import * as codex from './harness/codex.mjs'
import * as goose from './harness/goose.mjs'
import * as bot from './harness/bot.mjs'
import { randomUUID } from 'node:crypto'

export class SpawnError extends Error {
  constructor(reason, message, detail = {}) {
    super(message)
    this.name = 'SpawnError'
    this.reason = reason
    this.code = reason
    this.detail = detail
  }
}

function toSpawnError(e, reason = 'launch-failed', detail = {}) {
  if (e instanceof SpawnError) return e
  const message = typeof e?.message === 'string'
    ? e.message
    : (e?.message ? JSON.stringify(e.message) : String(e))
  return new SpawnError(reason, message, detail)
}

function emitLifecycle(params, event, data = {}) {
  try {
    params.onLifecycleEvent?.(event, data)
  } catch (error) {
    params.lifecycleErrors ||= []
    params.lifecycleErrors.push({
      event,
      error: error?.message || String(error),
    })
  }
}

function lifecycleOutcome(params) {
  return params.lifecycleErrors?.length
    ? { lifecycle_errors: [...params.lifecycleErrors] }
    : {}
}

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

const ADAPTERS = { claude, codex, goose, bot }

function metadataOf(agent) {
  const meta = agent?.metadata || {}
  if (typeof meta === 'string') {
    try {
      return JSON.parse(meta)
    } catch {
      return {}
    }
  }
  return meta && typeof meta === 'object' ? meta : {}
}

function modelKwargs(params = {}, extra = {}) {
  return {
    ...(params.modelOptions && typeof params.modelOptions === 'object' && !Array.isArray(params.modelOptions) ? params.modelOptions : {}),
    ...(params.effort ? { effort: params.effort } : {}),
    ...extra,
  }
}

function applyNormalizedOptions(params = {}, modelSpec = {}) {
  if (!params.effort && modelSpec.normalizedOptions?.effort) params.effort = modelSpec.normalizedOptions.effort
  params.modelOptions = {
    ...(params.modelOptions && typeof params.modelOptions === 'object' && !Array.isArray(params.modelOptions) ? params.modelOptions : {}),
    ...(modelSpec.normalizedOptions || {}),
  }
}

function spawnOptionMetadata(params = {}) {
  const options = params.modelOptions && typeof params.modelOptions === 'object' && !Array.isArray(params.modelOptions)
    ? params.modelOptions
    : {}
  const clean = {}
  for (const [key, value] of Object.entries(options)) {
    if (value != null && value !== '') clean[key] = String(value)
  }
  return Object.keys(clean).length ? { modelOptions: clean } : {}
}

function resolveLaunchSpec(rawModel, config, kwargs = {}) {
  const normalized = normalizeSpawnModelKwargs({ ...kwargs, model: rawModel }, { config })
  return {
    ...normalized.spec,
    normalizedOptions: normalized.options,
    normalizedModelRequest: normalized,
  }
}

function defaultModelForHarness(config = {}, harness = '') {
  const target = String(harness || '').trim().toLowerCase()
  if (!target) return null
  const values = config?.modelCatalog?.values && typeof config.modelCatalog.values === 'object'
    ? config.modelCatalog.values
    : config?.modelSpecs
  if (!values || typeof values !== 'object') return null
  const found = Object.values(values).find(spec => String(spec?.harness || spec?.kind || '').trim().toLowerCase() === target)
  return found?.alias || found?.name || null
}

function modelForRespawn(params, meta, config) {
  if (params.model) return params.model
  if (meta.kind && meta.model) {
    const recorded = resolveLaunchSpec(meta.model, config)
    if (recorded.harness === meta.kind) return meta.model
  }
  if (!meta.kind) return null
  const model = defaultModelForHarness(config, meta.kind)
  if (!model) {
    throw new SpawnError('launch-failed', `no configured model alias for recorded ${meta.kind} wake; repair daemon model config or pass --model`, { kind: meta.kind })
  }
  return model
}

function traceSpawnDecision(label, detail) {
  const payload = {
    ts: new Date().toISOString(),
    ...detail,
  }
  process.stderr.write(`[spawn-trace] ${label} ${JSON.stringify(payload)}\n`)
}

function resolveAdapterModel(adapter, rawModel, config, modelSpec = null) {
  const spec = modelSpec || resolveLaunchSpec(rawModel, config)
  if (adapter.resolveModelSelection) {
    const selection = adapter.resolveModelSelection(spec.alias, { config })
    return { model: selection.model, provider: selection.provider, selection, spec }
  }
  return { model: spec.id, provider: spec.provider || null, selection: null, spec }
}

function directModelConfig(kind, model) {
  const harness = String(kind || '').trim().toLowerCase()
  const id = String(model || '').trim()
  if (!harness) throw new SpawnError('launch-failed', 'doctor yolo requires a harness kind', {})
  if (!id) throw new SpawnError('launch-failed', 'doctor yolo requires --model', {})
  const spec = {
    alias: id,
    id,
    model: id,
    provider: harness,
    harness,
    kind: harness,
    group: harness,
    level: null,
    description: 'doctor-yolo direct model',
    options: {},
    tags: [],
    available: true,
    verified: true,
  }
  return {
    modelSpecs: { [id]: spec },
    modelCatalog: { default: id, values: { [id]: spec } },
    harnessOptions: {},
    permissionProfiles: {},
    defaultPermissionProfile: null,
  }
}

function spawnEnv(params = {}) {
  const env = { ...process.env }
  if (params.activeEnvName) env.TLDA_ENV = params.activeEnvName
  if (params.machineId) env.TLDA_MACHINE_ID = params.machineId
  return env
}

function shellReservationOptions(params = {}) {
  return params.shellReservationTimeoutMs ? { timeoutMs: params.shellReservationTimeoutMs } : {}
}

async function buildCommand({ requestedKind, adapter, fleetId, localAgentId, tmuxSession, model, modelProvider = null, name, cwd, effort, permissionMode, permissionGrant, api, dnsAlias, resumeId = null, freshSessionId = null, includePrompt = true, leasePolicy = null, enforceFence = false, harnessOptions = {}, config = undefined, env = process.env, botScript = null, botName = null, botIdFile = null, botPidFile = null, botHeartbeatFile = null, botWaitChannel = null }) {
  let cmd
  let sendKeys = false
  if (requestedKind === 'codex') {
    codex.ensureProjectTrusted(cwd)
    // Permissions come from the daemon config, not from computed harness logic:
    // codex launches with its own sandbox off and the fence (from the grant)
    // does the containment. The code just passes args + harness config + fence.
    cmd = codex.buildCmd({
      fleetId,
      localAgentId,
      tmuxSession,
      model,
      modelProvider,
      name,
      cwd,
      api,
      dnsAlias,
      resumeId,
      config,
      env,
      harnessOptions,
    })
    sendKeys = true
  } else {
    cmd = adapter.buildCmd({
      fleetId,
      localAgentId,
      tmuxSession,
      model,
      modelProvider,
      effort,
      mode: permissionMode,
      name,
      api,
      dnsAlias,
      resumeId,
      freshSessionId,
      config,
      env,
      includePrompt,
      harnessOptions,
      botScript,
      botName,
      botIdFile,
      botPidFile,
      botHeartbeatFile,
      botWaitChannel,
    })
  }
  const commandBeforeFence = cmd
  // Enforce the seatbelt whenever the lease declares secret denies. With the
  // permissive seatbelt runner (allow-all except secrets + scoped writes) this is
  // fence-but-don't-trap: ps/reads/writes work, only secrets are blocked. Deny-free
  // leases stay unwrapped, so the wide-open (no-fence) case is unchanged.
  const leaseHasDenies = !!(leasePolicy && ((leasePolicy.deny_read_roots || []).length || (leasePolicy.deny_write_roots || []).length))
  const effectiveEnforce = enforceFence || leaseHasDenies
  if (leasePolicy) cmd = wrapSandboxCmd(cmd, leasePolicy, { api, dnsAlias, enforce: effectiveEnforce })
  return {
    cmd,
    sendKeys,
    commandTrace: {
      hasLeasePolicy: !!leasePolicy,
      wrappedByFence: !!leasePolicy && !!effectiveEnforce,
      commandContainsFence: /(?:^|['"\s/])fence(?:['"\s]|$)/.test(cmd),
      commandContainsCodexYolo: cmd.includes('--dangerously-bypass-approvals-and-sandbox') || cmd.includes('--yolo'),
      commandContainsDangerSandbox: cmd.includes('danger-full-access'),
      harnessOptions,
      commandBeforeFence,
    },
  }
}

// Low-level executor for the daemon mint core. It launches one fresh harness
// process and reports only process facts. It does not create/request a Fleet
// seat, join identities, poll server state, or write either identity ledger.
export async function launchMintProcess(params) {
  const api = (params._deps?.resolveApi || resolveApi)()
  const name = params.name || `agent-${Date.now().toString(36).slice(-4)}`
  const mintId = params.mintId || params.mint_id || newLocalAgentId()
  const fleetId = params.fleetId || params.fleet_id || null
  const cwd = resolveSpawnCwd(params.cwd)
  const config = params.config ?? withDaemonModelAliases({}, readDaemonConfigForCwd(cwd))
  const explicitKind = String(params.requestedKind || params.kind || '').trim().toLowerCase()
  const modelSpec = params.modelSpec || (explicitKind === 'bot'
    ? BOT_MODEL_SPEC
    : resolveLaunchSpec(params.model, config, modelKwargs(params)))
  const requestedKind = explicitKind || modelSpec.harness
  const adapter = ADAPTERS[requestedKind]
  if (!adapter) throw new SpawnError('launch-failed', `unsupported harness: ${requestedKind}`)
  applyNormalizedOptions(params, modelSpec)
  const modelResolved = resolveAdapterModel(adapter, params.model, config, modelSpec)
  const model = modelResolved.model
  const tmuxSession = await (params._deps?.uniqueSessionName || uniqueSessionName)(
    `fleet-${sanitizeSessionName(name)}`,
    { tmuxSocket: params.tmuxSocket },
  )
  const dnsAlias = await (params._deps?.resolveDnsAlias || resolveDnsAlias)(api)
  const launchPolicy = resolveLaunchPolicy({
    permissionGrant: params.permissionGrant,
    permissionSet: params.permissionSet,
    harness: requestedKind,
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPermissionRequest: params.explicitPermissionRequest,
    acknowledgeNoSecurity: !!params.acknowledgeNoSecurity,
    harnessOptions: modelResolved.spec?.harnessOptions || null,
  })
  const resumeId = params.resumeId || params.sessionId || params.session_id || null
  const freshSessionId = requestedKind === 'claude' && !resumeId
    ? (params._deps?.randomUUID || randomUUID)()
    : null
  const { cmd, sendKeys } = await buildCommand({
    requestedKind,
    adapter,
    fleetId,
    localAgentId: mintId,
    tmuxSession,
    model,
    modelProvider: modelResolved.provider,
    name,
    cwd,
    effort: params.effort,
    permissionMode: launchPolicy.permissionMode,
    permissionGrant: launchPolicy.permissionGrant,
    api,
    dnsAlias,
    resumeId,
    freshSessionId,
    leasePolicy: launchPolicy.leasePolicy,
    enforceFence: !!params.enforceFence,
    harnessOptions: launchPolicy.harnessOptions,
    config,
    env: spawnEnv(params),
    botScript: params.botScript || params.bot_script || params.script || null,
    botName: params.botName || params.bot_name || null,
    botIdFile: params.botIdFile || params.bot_id_file || null,
    botPidFile: params.botPidFile || params.bot_pid_file || null,
    botHeartbeatFile: params.botHeartbeatFile || params.bot_heartbeat_file || null,
    botWaitChannel: params.botWaitChannel || params.bot_wait_channel || null,
  })
  const launched = await (params._deps?.spawnTmux || spawnTmux)(
    tmuxSession,
    cwd,
    cmd,
    {
      autoDismiss: requestedKind === 'claude',
      sendKeys,
      tmuxSocket: params.tmuxSocket,
      crashLogPath: params.crashLogPath,
    },
  )
  if (!launched) {
    throw new SpawnError(
      'launch-failed',
      `tmux session ${tmuxSession} already has a live harness runtime`,
      { tmuxSession },
    )
  }
  if (requestedKind === 'codex') {
    await (params._deps?.injectCodexPrompt || injectCodexPrompt)(
      tmuxSession,
      codex.kickoffPrompt(name),
      { tmuxSocket: params.tmuxSocket },
    )
  }
  return {
    mint_id: mintId,
    fleet_id: fleetId,
    name,
    tmux_session: tmuxSession,
    cwd,
    harness: requestedKind,
    model,
    session_id: requestedKind === 'bot' ? (resumeId || mintId) : (resumeId || freshSessionId),
    permission_grant: launchPolicy.permissionGrant,
    permission_set: launchPolicy.permissionSet,
    machine_id: params.machineId || null,
    env_name: params.activeEnvName || null,
    daemon_key: params.machineId && params.activeEnvName
      ? `${params.machineId}:${params.activeEnvName}`
      : null,
    alive: true,
  }
}

async function spawnFresh(params) {
  const { requestedKind, adapter, modelSpec } = params
  const deps = params._deps || {}
  const api = (deps.resolveApi || resolveApi)()
  const librarian = deps.createLibrarian
    ? deps.createLibrarian({ loginDeadlineMs: params.loginDeadlineMs || 60_000 })
    : new SpawnLibrarian({ loginDeadlineMs: params.loginDeadlineMs || 60_000 })
  const name = params.name || `agent-${Date.now().toString(36).slice(-4)}`
  let fleetId = params.agentId || params.agent_id || null
  const ownedLocalLedger = params.localAgentLedger ? null : createLocalAgentLedger(params.localAgentLedgerPath)
  const localAgentLedger = params.localAgentLedger || ownedLocalLedger
  const existingBoundLocal = fleetId ? localAgentLedger.get(fleetId) : null
  const localAgentId = params.localAgentId || params.local_agent_id || existingBoundLocal?.localAgentId || newLocalAgentId()
  const cwd = resolveSpawnCwd(params.cwd)
  let tmuxSession = null
  let model = null
  let shellRegistered = false
  let registrationDeferred = false
  let runtimeLaunched = false
  try {
    const config = params.config ?? withDaemonModelAliases({}, readDaemonConfigForCwd(cwd))
    tmuxSession = await (deps.uniqueSessionName || uniqueSessionName)(`fleet-${sanitizeSessionName(name)}`, { tmuxSocket: params.tmuxSocket })
    const modelResolved = resolveAdapterModel(adapter, params.model, config, modelSpec)
    model = modelResolved.model
    const dnsAlias = await (deps.resolveDnsAlias || resolveDnsAlias)(api)
    const configuredHarnessOptions = modelResolved.spec?.harnessOptions || null
    const launchPolicy = resolveLaunchPolicy({
      permissionGrant: params.permissionGrant,
      permissionSet: params.permissionSet,
      harness: requestedKind,
      model,
      cwd,
      config,
      permissionMode: params.permissionMode,
      mode: params.mode,
      explicitPermissionRequest: params.explicitPermissionRequest,
      acknowledgeNoSecurity: !!params.acknowledgeNoSecurity,
      harnessOptions: configuredHarnessOptions,
    })
    traceSpawnDecision('policy', {
      name,
      fleetId,
      requestedKind,
      model,
      modelProvider: modelResolved.provider,
      cwd,
      permissionRequest: params.permissionRequest || null,
      permissionGrant: params.permissionGrant || null,
      explicitPermissionRequest: !!params.explicitPermissionRequest,
      permissionMode: launchPolicy.permissionMode,
      hasLeasePolicy: !!launchPolicy.leasePolicy,
      hasHarnessControls: !!launchPolicy.launchSecurity?.hasHarnessControls,
      acknowledgedNoSecurity: !!launchPolicy.launchSecurity?.acknowledgedNoSecurity,
      harnessRequiredFlags: launchPolicy.harnessOptions?.required || [],
      harnessPreferenceFlags: launchPolicy.harnessOptions?.preferences || [],
      leaseWriteRoots: launchPolicy.leasePolicy?.write_roots || [],
      permissionGrant: launchPolicy.permissionGrant || null,
    })
    localAgentLedger.create({
      localAgentId,
      serverAgentId: fleetId,
      friendlyName: name,
      harness: requestedKind,
      model,
      tmuxName: tmuxSession,
      cwd,
      permissionGrant: params.permissionGrant,
    })
    emitLifecycle(params, 'local-mint', {
      local_agent_id: localAgentId,
      fleet_id: fleetId || null,
      name,
      tmux_session: tmuxSession,
      cwd,
      harness: requestedKind,
      model,
    })
    const serverRegistrationPromise = (async () => {
          const serverUp = await (deps.ensureServer || ensureServer)({ api })
          await (deps.checkFreshNameAvailable || checkFreshNameAvailable)(name, { api, serverUp, excludeId: fleetId })
          const reserve = fleetId
            ? await (deps.wsReserveShell || wsReserveShell)({
                fleetId,
                localAgentId,
                name,
                tmuxSession,
                cwd,
                model,
                effort: params.effort,
                kind: requestedKind,
                metadata: { ...permissionMetadata(launchPolicy.permissionGrant, launchPolicy.leasePolicy), ...spawnOptionMetadata(params) },
                machineId: params.machineId,
                api,
                ...shellReservationOptions(params),
              })
            : await (deps.wsMintShell || wsMintShell)({
                localAgentId,
                name,
                tmuxSession,
                cwd,
                model,
                effort: params.effort,
                kind: requestedKind,
                metadata: { ...permissionMetadata(launchPolicy.permissionGrant, launchPolicy.leasePolicy), ...spawnOptionMetadata(params) },
                machineId: params.machineId,
                api,
                ...shellReservationOptions(params),
              })
          return { reserve, serverUp }
        })()
          .then(registration => registration)
          .catch(error => ({ error: error?.message || String(error) }))
    const freshSessionId = requestedKind === 'claude' ? (deps.randomUUID || randomUUID)() : null
    const { cmd, sendKeys, commandTrace } = await buildCommand({
      requestedKind,
      adapter,
      fleetId,
      localAgentId,
      tmuxSession,
      model,
      modelProvider: modelResolved.provider,
      name,
      cwd,
      effort: params.effort,
      permissionMode: launchPolicy.permissionMode,
      permissionGrant: launchPolicy.permissionGrant,
      api,
      dnsAlias,
      freshSessionId,
      leasePolicy: launchPolicy.leasePolicy,
      enforceFence: !!params.enforceFence,
      harnessOptions: launchPolicy.harnessOptions,
      config,
      env: spawnEnv(params),
    })
    traceSpawnDecision('command', {
      name,
      fleetId,
      requestedKind,
      model,
      modelProvider: modelResolved.provider,
      cwd,
      tmuxSession,
      hasLeasePolicy: commandTrace.hasLeasePolicy,
      wrappedByFence: commandTrace.wrappedByFence,
      commandContainsFence: commandTrace.commandContainsFence,
      commandContainsCodexYolo: commandTrace.commandContainsCodexYolo,
      commandContainsDangerSandbox: commandTrace.commandContainsDangerSandbox,
      harnessOptions: commandTrace.harnessOptions,
      projection: commandTrace.projection,
      cmd,
    })
    const launched = await (deps.spawnTmux || spawnTmux)(tmuxSession, cwd, cmd, { autoDismiss: requestedKind === 'claude', sendKeys, tmuxSocket: params.tmuxSocket, crashLogPath: params.crashLogPath })
    if (!launched) {
      librarian.failPending(fleetId, 'launch-failed')
      throw new SpawnError('launch-failed', `tmux session ${tmuxSession} already has a live harness runtime`, { tmuxSession })
    }
    runtimeLaunched = true
    emitLifecycle(params, 'local-launch', {
      local_agent_id: localAgentId,
      fleet_id: fleetId || null,
      name,
      tmux_session: tmuxSession,
      cwd,
      harness: requestedKind,
      model,
    })
    const registration = await serverRegistrationPromise
    if (registration?.error) {
      registrationDeferred = true
      emitLifecycle(params, 'server-registration-deferred', {
        local_agent_id: localAgentId,
        fleet_id: fleetId || null,
        name,
        tmux_session: tmuxSession,
        cwd,
        harness: requestedKind,
        model,
        reason: registration.error,
      })
      traceSpawnDecision('registration-deferred', {
        name,
        localAgentId,
        tmuxSession,
        requestedKind,
        model,
        reason: registration.error,
      })
    } else if (registration?.reserve) {
      const reserve = registration.reserve
      fleetId = fleetId || reserve?.server_agent_id || reserve?.agent?.id || null
      if (!fleetId) throw new Error('server mint returned no server agent id')
      localAgentLedger.bind(localAgentId, fleetId, { friendlyName: reserve?.assigned_name || name })
      shellRegistered = true
      emitLifecycle(params, 'server-registration-joined', {
        local_agent_id: localAgentId,
        fleet_id: fleetId,
        name: reserve?.assigned_name || name,
        tmux_session: tmuxSession,
        cwd,
        harness: requestedKind,
        model,
      })
      librarian.observeLiveness({
        type: 'agent-liveness',
        agent_id: fleetId,
        tmux_session: tmuxSession,
        state: 'spawning',
        ts: new Date().toISOString(),
      })
    }
    const launchedRoute = { localAgentId, fleetId, tmuxSession, harness: requestedKind, model, resumeId: freshSessionId }
    let identityResolutionPromise
    try {
      identityResolutionPromise = requestedKind === 'codex' && registration?.serverUp && params.startFreshIdentityPolling
        ? Promise.resolve(params.startFreshIdentityPolling(launchedRoute))
        : Promise.resolve(null)
    } catch (error) {
      identityResolutionPromise = Promise.reject(error)
    }
    let promptDeliveryPromise
    try {
      promptDeliveryPromise = requestedKind === 'codex'
        ? Promise.resolve((deps.injectCodexPrompt || injectCodexPrompt)(tmuxSession, codex.kickoffPrompt(name), { tmuxSocket: params.tmuxSocket }))
        : Promise.resolve(true)
    } catch (error) {
      promptDeliveryPromise = Promise.reject(error)
    }
    const [identityOutcome, promptOutcome] = await Promise.allSettled([identityResolutionPromise, promptDeliveryPromise])
    const identityResolution = identityOutcome.status === 'fulfilled'
      ? identityOutcome.value
      : { identity: null, diagnostics: { failureStage: 'poll-error' } }
    const promptDelivery = promptOutcome.status === 'fulfilled' && promptOutcome.value
      ? null
      : { ok: false, reason: 'unverified' }
    emitLifecycle(params, 'terminal-command', {
      ok: !promptDelivery,
      local_agent_id: localAgentId,
      fleet_id: fleetId || null,
      name,
      tmux_session: tmuxSession,
      cwd,
      harness: requestedKind,
      model,
      reason: promptDelivery?.reason || null,
    })
    if (registrationDeferred) {
      traceSpawnDecision('registration-skipped', {
        name,
        localAgentId,
        tmuxSession,
        requestedKind,
        model,
        reason: 'server registration branch failed after local launch',
      })
      return { ok: true, localAgentId, fleetId: fleetId || null, tmuxSession, harness: requestedKind, model, registrationDeferred: true, ...(promptDelivery ? { promptDelivery } : {}), ...lifecycleOutcome(params) }
    }
    return { ok: true, pending: true, ...launchedRoute, ...(identityResolution ? { identityResolution } : {}), ...(promptDelivery ? { promptDelivery } : {}), ...lifecycleOutcome(params) }
  } catch (e) {
    const err = toSpawnError(e, e?.message?.includes('not available') ? 'name-bounced' : 'launch-failed', { fleetId, tmuxSession, model })
    librarian.failPending(fleetId || localAgentId, err.reason || 'launch-failed')
    let terminated = !runtimeLaunched
    if (runtimeLaunched) {
      try {
        terminated = await (deps.terminateTmuxSession || terminateTmuxSession)(tmuxSession, { tmuxSocket: params.tmuxSocket })
      } catch {
        terminated = false
      }
    }
    if (terminated) localAgentLedger.delete(localAgentId)
    else err.detail = { ...(err.detail || {}), ownershipRetained: true, fleetId, tmuxSession }
    if (terminated && shellRegistered) {
      try {
        await (deps.markAgentDead || markAgentDead)(fleetId, { api })
      } catch (markErr) {
        err.detail = { ...(err.detail || {}), markDeadError: markErr?.message || String(markErr) }
      }
    }
    throw err
  } finally {
    ownedLocalLedger?.close()
  }
}

async function spawnRespawn(params) {
  const deps = params._deps || {}
  const api = (deps.resolveApi || resolveApi)()
  const name = params.name || params.agentId || params.agent_id
  const fleetId = params.agentId || params.agent_id || (String(name || '').startsWith('fleet:') ? name : null)
  if (!fleetId) throw new SpawnError('launch-failed', 'wake requires literal fleet_id', { name })
  const ownedLocalLedger = params.localAgentLedger ? null : createLocalAgentLedger(params.localAgentLedgerPath)
  const localAgentLedger = params.localAgentLedger || ownedLocalLedger
  let localRecord
  try {
    localRecord = localAgentLedger.get(fleetId)
  } finally {
    ownedLocalLedger?.close()
  }
  if (!localRecord) {
    throw new SpawnError('launch-failed', `Cannot wake ${fleetId}: daemon-local ledger has no bound mint record`, { fleetId })
  }
  const localProcess = localRecord.process || {}
  const localConversation = localRecord.conversation || {}
  if (!localProcess.cwd) {
    throw new SpawnError('launch-failed', `Cannot wake ${fleetId}: daemon-local recipe has no cwd`, { fleetId, localAgentId: localRecord.localAgentId })
  }
  const permissionRow = params.permissionLedger?.get?.(fleetId) || null
  const friendlyName = localRecord.friendlyName || fleetId
  const cwd = resolveSpawnCwd(localProcess.cwd)
  const meta = {
    kind: localConversation.harness || permissionRow?.sessionKind || null,
    model: localConversation.model || permissionRow?.model || null,
    permissionGrant: params.permissionGrant || localProcess.permissionGrant || permissionRow?.permissionGrant || null,
    permissionSet: params.permissionSet || permissionRow?.permissionSet || null,
    effort: params.effort || null,
  }
  const config = params.config ?? withDaemonModelAliases({}, readDaemonConfigForCwd(cwd))
  const rawModel = modelForRespawn(params, meta, config)
  const modelSpec = resolveLaunchSpec(rawModel, config, modelKwargs(params, meta.effort ? { effort: params.effort || meta.effort } : {}))
  applyNormalizedOptions(params, modelSpec)
  const requestedKind = modelSpec.harness
  const adapter = ADAPTERS[requestedKind]
  if (!adapter) throw new SpawnError('launch-failed', `unknown spawn harness: ${requestedKind}`, { kind: requestedKind })
  const modelResolved = resolveAdapterModel(adapter, rawModel, config, modelSpec)
  const model = modelResolved.model
  const tmuxSession = localProcess.tmuxName || `fleet-${sanitizeSessionName(friendlyName)}`
  const agent = {
    id: fleetId,
    friendly_name: friendlyName,
    name: friendlyName,
    cwd,
    tmux_session: tmuxSession,
    session_id: localConversation.sessionId || permissionRow?.sessionId || params.sessionId || params.session_id || null,
    session_kind: requestedKind,
    metadata: {
      kind: requestedKind,
      model: rawModel,
      permissionGrant: meta.permissionGrant,
    },
  }
  // Wake is non-destructive. Permission changes do not authorize replacing a
  // live runtime: callers must use a separately named destructive operation
  // for that. A wake either keeps the live runtime or starts the exact durable
  // session in an empty tmux seat; generic launch has no replacement capability.
  const explicitRelaunch = !!(
    params.explicitPermissionRequest ||
    params.permissionRequest
  )
  const runtimeState = deps.sessionRuntimeState
    ? await deps.sessionRuntimeState(tmuxSession, { tmuxSocket: params.tmuxSocket })
    : deps.sessionHasRuntime
      ? { runtime: await deps.sessionHasRuntime(tmuxSession, { tmuxSocket: params.tmuxSocket }), mcp: true }
      : await sessionRuntimeState(tmuxSession, { tmuxSocket: params.tmuxSocket })
  if (runtimeState.runtime) {
    if (explicitRelaunch) {
      throw new SpawnError(
        'launch-failed',
        `Wake refused for ${friendlyName} (${fleetId}): permission changes cannot replace a live agent.`,
        { fleetId, tmuxSession },
      )
    }
    if (requestedKind === 'codex' && !runtimeState.mcp) {
      return {
        ok: true,
        pending: true,
        runtimePresent: true,
        reason: 'mcp-not-ready',
        fleetId,
        tmuxSession,
        harness: requestedKind,
        model,
      }
    }
    return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, alreadyAlive: true }
  }
  let handle = null
  const identityOptions = {
    identityConfigDir: params.identityConfigDir,
    identityFilePath: params.identityFilePath,
    projectsBase: params.claudeProjectsBase,
    sessionsBase: params.codexSessionsBase,
  }
  if (requestedKind === 'claude') {
    handle = findClaudeSession(agent, {
      ...identityOptions,
      sessionOverride: params.sessionId || params.session_id,
    })
  } else if (requestedKind === 'codex') {
    const resolved = await (deps.resolveCodexResumeHandle || resolveCodexResumeHandle)(agent, {
      ...identityOptions,
      permissionLedger: params.permissionLedger,
      permissionLedgerPath: params.permissionLedgerPath,
    })
    if (resolved?.ok) {
      handle = {
        kind: 'codex',
        rolloutId: resolved.resumeId,
        jsonlPath: resolved.jsonlPath,
        cwd: resolved.cwd,
        source: resolved.source,
      }
    } else if (resolved?.code === 'identity-ingestion-pending') {
      throw new SpawnError(
        'identity-ingestion-pending',
        `Cannot respawn ${friendlyName} (${fleetId}) yet: Codex session identity ingestion has not reached the daemon index. Retry once ingestion is caught up.`,
        { fleetId, kind: requestedKind, retry_after_ms: resolved.retry_after_ms || 1000, resolution: resolved },
      )
    } else {
      const message = resolved?.message || resolved?.detail?.message
      throw new SpawnError(
        'launch-failed',
        message || `Session resolution failed for ${friendlyName} (${fleetId}): could not locate the existing codex rollout. This is a session-tracking fault in the resolver, not a lost session.`,
        { fleetId, kind: requestedKind, resolution: resolved || null },
      )
    }
  }
  if (!handle && (requestedKind === 'claude' || requestedKind === 'codex')) {
    if (!isRespawnIdentityCaughtUp(identityOptions)) {
      throw new SpawnError(
        'identity-ingestion-pending',
        `Cannot respawn ${friendlyName} (${fleetId}) yet: JSONL identity ingestion has not reached EOF. Retry once ingestion is caught up.`,
        { fleetId, kind: requestedKind, retry_after_ms: 1000 },
      )
    }
    throw new SpawnError('launch-failed', `Session resolution failed for ${friendlyName} (${fleetId}): could not locate the existing ${requestedKind} rollout. This is a session-tracking fault in the resolver, not a lost session.`, { fleetId })
  }
  const resumeId = adapter.resumeId?.(handle)
  if (requestedKind === 'claude' && resumeId) stripSyntheticTail(resumeId)
  const launchPolicy = resolveLaunchPolicy({
    permissionGrant: params.permissionGrant || meta.permissionGrant,
    permissionSet: params.permissionSet || meta.permissionSet,
    harness: requestedKind,
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPermissionRequest: params.explicitPermissionRequest,
    acknowledgeNoSecurity: !!params.acknowledgeNoSecurity,
    harnessOptions: modelResolved.spec?.harnessOptions || null,
  })
  const { cmd, sendKeys } = await buildCommand({
    requestedKind,
    adapter,
    fleetId,
    tmuxSession,
    model,
    modelProvider: modelResolved.provider,
    name: friendlyName,
    cwd,
    effort: params.effort || meta.effort,
    permissionMode: launchPolicy.permissionMode,
    permissionGrant: launchPolicy.permissionGrant,
    api,
    dnsAlias: null,
    resumeId,
    includePrompt: !(requestedKind === 'claude' && resumeId),
    leasePolicy: launchPolicy.leasePolicy,
    enforceFence: !!params.enforceFence,
    harnessOptions: launchPolicy.harnessOptions,
    config,
    env: spawnEnv(params),
  })
  const launched = await (deps.spawnTmux || spawnTmux)(tmuxSession, cwd, cmd, { autoDismiss: requestedKind === 'claude', sendKeys, tmuxSocket: params.tmuxSocket, crashLogPath: params.crashLogPath })
  if (!launched) return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, alreadyAlive: true }
  if (requestedKind === 'codex') {
    const injected = await (deps.injectCodexPrompt || injectCodexPrompt)(tmuxSession, codex.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
    if (!injected) {
      throw new SpawnError('launch-failed', `codex prompt injection did not reach ${tmuxSession}`, { fleetId, tmuxSession })
    }
  } else if (requestedKind === 'claude' && resumeId) {
    await injectClaudePrompt(tmuxSession, claude.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
  }
  let reconciliation = null
  if (requestedKind === 'codex' && resumeId) {
    try {
      await (deps.ensureServer || ensureServer)({ api })
      await (deps.wsReserveShell || wsReserveShell)({
        fleetId,
        name: friendlyName,
        tmuxSession,
        cwd,
        model,
        effort: params.effort || meta.effort,
        kind: requestedKind,
        sessionId: resumeId,
        metadata: permissionMetadata(launchPolicy.permissionGrant, launchPolicy.leasePolicy),
        machineId: params.machineId,
        api,
        ...shellReservationOptions(params),
      })
      reconciliation = { ok: true }
    } catch (e) {
      reconciliation = { ok: false, deferred: true, error: e?.message || String(e) }
      traceSpawnDecision('wake-server-reconciliation-deferred', {
        fleetId,
        tmuxSession,
        reason: reconciliation.error,
      })
      emitLifecycle(params, 'server-reconciliation-deferred', {
        fleet_id: fleetId,
        tmux_session: tmuxSession,
        reason: reconciliation.error,
      })
    }
  }
  return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, resumeId, ...(reconciliation ? { reconciliation } : {}), ...lifecycleOutcome(params) }
}

async function spawnRefresh(params) {
  const deps = params._deps || {}
  const api = resolveApi()
  await ensureServer({ api })
  const name = params.name || params.agentId || params.agent_id
  const agent = await findAgent(name, { api })
  if (!agent) throw new SpawnError('launch-failed', `No agent '${name}'. Use --fresh to create.`, { name })
  const meta = metadataOf(agent)
  const rawModel = params.model || meta.model
  const config = params.config ?? withDaemonModelAliases({}, readDaemonConfigForCwd(cwd))
  const modelSpec = resolveLaunchSpec(rawModel, config, modelKwargs(params, meta.effort ? { effort: params.effort || meta.effort } : {}))
  applyNormalizedOptions(params, modelSpec)
  const requestedKind = modelSpec.harness
  const adapter = ADAPTERS[requestedKind]
  if (!adapter) throw new SpawnError('launch-failed', `unknown spawn harness: ${requestedKind}`, { kind: requestedKind })
  const fleetId = agent.id
  const friendlyName = params.name && !params.name.startsWith('fleet:') ? params.name : (agent.friendly_name || agent.name || fleetId)
  const cwd = resolveSpawnCwd(params.cwd || agent.cwd || process.cwd())
  const modelResolved = resolveAdapterModel(adapter, rawModel, config, modelSpec)
  const model = modelResolved.model
  const tmuxSession = agent.tmux_session || `fleet-${sanitizeSessionName(friendlyName)}`
  const dnsAlias = await (deps.resolveDnsAlias || resolveDnsAlias)(api)
  const launchPolicy = resolveLaunchPolicy({
    permissionGrant: params.permissionGrant || meta.permissionGrant,
    permissionSet: params.permissionSet || meta.permissionSet,
    harness: requestedKind,
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPermissionRequest: params.explicitPermissionRequest,
    acknowledgeNoSecurity: !!params.acknowledgeNoSecurity,
    harnessOptions: modelResolved.spec?.harnessOptions || null,
  })
  await wsReserveShell({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort || meta.effort,
    kind: requestedKind,
    permissionGrant: params.permissionGrant,
    metadata: permissionMetadata(launchPolicy.permissionGrant),
    machineId: params.machineId,
    api,
    ...shellReservationOptions(params),
  })
  const { cmd, sendKeys } = await buildCommand({
    requestedKind,
    adapter,
    fleetId,
    tmuxSession,
    model,
    modelProvider: modelResolved.provider,
    name: friendlyName,
    cwd,
    effort: params.effort || meta.effort,
    permissionMode: launchPolicy.permissionMode,
    permissionGrant: launchPolicy.permissionGrant,
    api,
    dnsAlias,
    includePrompt: true,
    leasePolicy: launchPolicy.leasePolicy,
    enforceFence: !!params.enforceFence,
    harnessOptions: launchPolicy.harnessOptions,
    config,
    env: spawnEnv(params),
  })
  const terminated = await (deps.terminateTmuxSession || terminateTmuxSession)(tmuxSession, { tmuxSocket: params.tmuxSocket })
  if (!terminated) {
    throw new SpawnError('launch-failed', `Refresh could not terminate ${tmuxSession}; refusing to launch a replacement.`, { fleetId, tmuxSession })
  }
  const launched = await (deps.spawnTmux || spawnTmux)(tmuxSession, cwd, cmd, { autoDismiss: requestedKind === 'claude', sendKeys, tmuxSocket: params.tmuxSocket, crashLogPath: params.crashLogPath })
  if (!launched) return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, alreadyAlive: true }
  if (requestedKind === 'codex') {
    const injected = await (deps.injectCodexPrompt || injectCodexPrompt)(tmuxSession, codex.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
    if (!injected) {
      throw new SpawnError('launch-failed', `codex prompt injection did not reach ${tmuxSession}`, { fleetId, tmuxSession })
    }
  }
  return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, refreshed: true }
}

function sessionIdOf(params) {
  return params.sessionId || params.session_id || params.session
}

function defaultEnrolledName(params, sessionId) {
  if (params.name && !String(params.name).startsWith('fleet:')) return params.name
  return `agent-${String(sessionId).slice(0, 8)}`
}

// Enroll requires the harness KIND explicitly. Session ids are not unique across
// harnesses, so we never guess by which file happens to exist on disk (Skip: "you
// pass it a session id but not a model… you just have to hope it guesses").
function normalizeSessionKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase()
  return k === 'codex' || k === 'claude' ? k : null
}

export async function launchDoctorYolo(params = {}) {
  const deps = params._deps || {}
  const requestedKind = String(params.kind || params.harness || 'codex').trim().toLowerCase()
  const adapter = ADAPTERS[requestedKind]
  if (!adapter) throw new SpawnError('launch-failed', `unknown doctor yolo harness: ${requestedKind}`, { kind: requestedKind })
  const name = params.name || `yolo-${Date.now().toString(36).slice(-4)}`
  const cwd = resolveSpawnCwd(params.cwd)
  const rawModel = params.model
  const config = directModelConfig(requestedKind, rawModel)
  const localAgentId = params.localAgentId || params.local_agent_id || newLocalAgentId()
  const tmuxSession = await (deps.uniqueSessionName || uniqueSessionName)(`fleet-${sanitizeSessionName(name)}`, { tmuxSocket: params.tmuxSocket })
  const modelSpec = resolveLaunchSpec(rawModel, config)
  const modelResolved = resolveAdapterModel(adapter, rawModel, config, modelSpec)
  const { cmd, sendKeys, commandTrace } = await buildCommand({
    requestedKind,
    adapter,
    fleetId: null,
    localAgentId,
    tmuxSession,
    model: modelResolved.model,
    modelProvider: modelResolved.provider,
    name,
    cwd,
    effort: params.effort,
    permissionMode: 'bypass',
    permissionGrant: 'doctor-yolo',
    api: null,
    dnsAlias: null,
    includePrompt: true,
    leasePolicy: null,
    enforceFence: false,
    harnessOptions: requestedKind === 'codex'
      ? { required: ['--dangerously-bypass-approvals-and-sandbox'], preferences: [] }
      : {},
    config,
    env: spawnEnv(params),
  })
  traceSpawnDecision('doctor-yolo-command', {
    name,
    localAgentId,
    requestedKind,
    model: modelResolved.model,
    cwd,
    tmuxSession,
    commandContainsFence: commandTrace.commandContainsFence,
    commandContainsCodexYolo: commandTrace.commandContainsCodexYolo,
    commandContainsDangerSandbox: commandTrace.commandContainsDangerSandbox,
  })
  const launched = await (deps.spawnTmux || spawnTmux)(tmuxSession, cwd, cmd, {
    autoDismiss: requestedKind === 'claude',
    sendKeys,
    tmuxSocket: params.tmuxSocket,
    crashLogPath: params.crashLogPath,
  })
  if (!launched) throw new SpawnError('launch-failed', `tmux session ${tmuxSession} already has a live harness runtime`, { tmuxSession })
  if (requestedKind === 'codex') {
    const injected = await (deps.injectCodexPrompt || injectCodexPrompt)(tmuxSession, codex.kickoffPrompt(name), { tmuxSocket: params.tmuxSocket })
    if (!injected) {
      return {
        ok: true,
        localAgentId,
        fleetId: null,
        tmuxSession,
        harness: requestedKind,
        model: modelResolved.model,
        registrationDeferred: true,
        promptDelivery: { ok: false, reason: 'unverified' },
      }
    }
  }
  return {
    ok: true,
    localAgentId,
    fleetId: null,
    tmuxSession,
    harness: requestedKind,
    model: modelResolved.model,
    registrationDeferred: true,
  }
}

async function spawnSession(params) {
  const deps = params._deps || {}
  const api = (deps.resolveApi || resolveApi)()
  await (deps.ensureServer || ensureServer)({ api })
  const sessionId = sessionIdOf(params)
  if (!sessionId) throw new SpawnError('launch-failed', 'session spawn requires --session <uuid>')
  const kind = normalizeSessionKind(params.kind)
  if (!kind) {
    throw new SpawnError('launch-failed', 'enlist requires --kind <codex|claude>: session ids are not unique across harnesses', { sessionId })
  }
  if (kind === 'codex') {
    const codexPath = codexRolloutPath(sessionId, { sessionsBase: params.codexSessionsBase })
    if (!codexPath) throw new SpawnError('launch-failed', `No Codex rollout found for session ${sessionId}`, { sessionId })
    return await spawnCodexSession(params, { api, sessionId, codexPath, deps })
  }
  const claudeIdentity = scanClaudeSessionIdentity(sessionId, { projectsBase: params.claudeProjectsBase })
  if (!claudeIdentity) throw new SpawnError('launch-failed', `No Claude JSONL found for session ${sessionId}`, { sessionId })
  return await spawnClaudeSession(params, { api, sessionId, identity: claudeIdentity, deps })
}

async function spawnCodexSession(params, { api, sessionId, codexPath, deps = {} }) {
  const { ownId, localAgentId, agentName, sessionMeta } = scanCodexRolloutIdentity(codexPath)
  if (params.enroll && ownId) {
    throw new SpawnError('launch-failed', `Codex session ${sessionId} is already enrolled as ${ownId}`, { sessionId, fleetId: ownId })
  }
  if (!ownId && !params.enroll) {
    throw new SpawnError('launch-failed', `Codex session ${sessionId} has no fleet registration; use --enroll`, { sessionId })
  }
  // Ids are minted ONLY on create (spawnFresh). A session/enroll spawn must arrive
  // with a resolved seat id — the embedded rollout ownId, or a preallocated agentId
  // from the create path. No `|| newFleetId()` here: an unresolved id is a bug to
  // surface, not a fresh mint that would orphan the seat.
  const fleetId = ownId || params.agentId || params.agent_id
  if (!fleetId) {
    throw new SpawnError('launch-failed', `Cannot resume codex session ${sessionId}: no embedded fleet id and no preallocated seat id. Ids are minted only on create.`, { sessionId })
  }
  const friendlyName = params.name && !String(params.name).startsWith('fleet:')
    ? params.name
    : (agentName || defaultEnrolledName(params, sessionId))
  const cwd = resolveSpawnCwd(params.cwd || sessionMeta.cwd || process.cwd())
  const config = params.config ?? withDaemonModelAliases({}, readDaemonConfigForCwd(cwd))
  const modelResolved = resolveAdapterModel(codex, params.model, config)
  const model = modelResolved.model
  const tmuxSession = params.tmuxSession || `fleet-${sanitizeSessionName(friendlyName)}`
  if (await (deps.sessionHasRuntime || sessionHasRuntime)(tmuxSession, { tmuxSocket: params.tmuxSocket })) {
    return { ok: true, fleetId, localAgentId, tmuxSession, harness: 'codex', model, resumeId: sessionId, alreadyAlive: true }
  }
  if (params.enroll) await (deps.checkFreshNameAvailable || checkFreshNameAvailable)(friendlyName, { api, serverUp: true })
  const dnsAlias = await (deps.resolveDnsAlias || resolveDnsAlias)(api)
  const launchPolicy = resolveLaunchPolicy({
    permissionGrant: params.permissionGrant,
    permissionSet: params.permissionSet,
    harness: 'codex',
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPermissionRequest: params.explicitPermissionRequest,
    acknowledgeNoSecurity: !!params.acknowledgeNoSecurity,
    harnessOptions: modelResolved.spec?.harnessOptions || null,
  })
  await (deps.wsReserveShell || wsReserveShell)({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort,
    kind: 'codex',
    sessionId,
    permissionGrant: params.permissionGrant,
    metadata: permissionMetadata(launchPolicy.permissionGrant),
    machineId: params.machineId,
    api,
    ...shellReservationOptions(params),
  })
  const { cmd, sendKeys } = await buildCommand({
    requestedKind: 'codex',
    adapter: codex,
    fleetId,
    tmuxSession,
    model,
    modelProvider: modelResolved.provider,
    name: friendlyName,
    cwd,
    effort: params.effort,
    permissionMode: launchPolicy.permissionMode,
    permissionGrant: launchPolicy.permissionGrant,
    api,
    dnsAlias,
    resumeId: sessionId,
    leasePolicy: launchPolicy.leasePolicy,
    enforceFence: !!params.enforceFence,
    harnessOptions: launchPolicy.harnessOptions,
    config,
    env: spawnEnv(params),
  })
  const launched = await (deps.spawnTmux || spawnTmux)(tmuxSession, cwd, cmd, { sendKeys, tmuxSocket: params.tmuxSocket, crashLogPath: params.crashLogPath })
  if (!launched) return { ok: true, fleetId, tmuxSession, harness: 'codex', model, resumeId: sessionId, alreadyAlive: true }
  await (deps.injectCodexPrompt || injectCodexPrompt)(tmuxSession, codex.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
  return { ok: true, fleetId, tmuxSession, harness: 'codex', model, resumeId: sessionId, enrolled: !!params.enroll }
}

async function spawnClaudeSession(params, { api, sessionId, identity, deps = {} }) {
  if (params.enroll && identity.fleetId) {
    throw new SpawnError('launch-failed', `Claude session ${sessionId} is already enrolled as ${identity.fleetId}`, { sessionId, fleetId: identity.fleetId })
  }
  if (!identity.fleetId && !params.enroll) {
    throw new SpawnError('launch-failed', `Claude session ${sessionId} has no fleet registration; use --enroll`, { sessionId })
  }
  // Ids are minted ONLY on create (spawnFresh). Resolve the seat id from the JSONL
  // identity or a preallocated agentId; no `|| newFleetId()` fallback — an unresolved
  // id surfaces as an error, it does not silently mint and orphan the seat.
  const fleetId = identity.fleetId || params.agentId || params.agent_id
  if (!fleetId) {
    throw new SpawnError('launch-failed', `Cannot resume claude session ${sessionId}: no embedded fleet id and no preallocated seat id. Ids are minted only on create.`, { sessionId })
  }
  const friendlyName = params.name && !String(params.name).startsWith('fleet:')
    ? params.name
    : (identity.agentName || defaultEnrolledName(params, sessionId))
  const cwd = resolveSpawnCwd(params.cwd || identity.cwd || process.cwd())
  const config = params.config ?? withDaemonModelAliases({}, readDaemonConfigForCwd(cwd))
  const modelResolved = resolveAdapterModel(claude, params.model, config)
  const model = modelResolved.model
  const tmuxSession = params.tmuxSession || `fleet-${sanitizeSessionName(friendlyName)}`
  if (await (deps.sessionHasRuntime || sessionHasRuntime)(tmuxSession, { tmuxSocket: params.tmuxSocket })) {
    return { ok: true, fleetId, localAgentId: identity.localAgentId || null, tmuxSession, harness: 'claude', model, resumeId: sessionId, alreadyAlive: true }
  }
  if (params.enroll) await (deps.checkFreshNameAvailable || checkFreshNameAvailable)(friendlyName, { api, serverUp: true })
  stripSyntheticTail(sessionId, { projectsBase: params.claudeProjectsBase })
  const dnsAlias = await (deps.resolveDnsAlias || resolveDnsAlias)(api)
  const launchPolicy = resolveLaunchPolicy({
    permissionGrant: params.permissionGrant,
    permissionSet: params.permissionSet,
    harness: 'claude',
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPermissionRequest: params.explicitPermissionRequest,
    acknowledgeNoSecurity: !!params.acknowledgeNoSecurity,
    harnessOptions: modelResolved.spec?.harnessOptions || null,
  })
  await (deps.wsReserveShell || wsReserveShell)({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort,
    kind: 'claude',
    sessionId,
    permissionGrant: params.permissionGrant,
    metadata: permissionMetadata(launchPolicy.permissionGrant),
    machineId: params.machineId,
    api,
    ...shellReservationOptions(params),
  })
  const { cmd, sendKeys } = await buildCommand({
    requestedKind: 'claude',
    adapter: claude,
    fleetId,
    tmuxSession,
    model,
    modelProvider: modelResolved.provider,
    name: friendlyName,
    cwd,
    effort: params.effort,
    permissionMode: launchPolicy.permissionMode,
    permissionGrant: launchPolicy.permissionGrant,
    api,
    dnsAlias,
    resumeId: sessionId,
    includePrompt: false,
    leasePolicy: launchPolicy.leasePolicy,
    enforceFence: !!params.enforceFence,
    harnessOptions: launchPolicy.harnessOptions,
    config,
    env: spawnEnv(params),
  })
  const launched = await (deps.spawnTmux || spawnTmux)(tmuxSession, cwd, cmd, { autoDismiss: true, sendKeys, tmuxSocket: params.tmuxSocket, crashLogPath: params.crashLogPath })
  if (!launched) return { ok: true, fleetId, tmuxSession, harness: 'claude', model, resumeId: sessionId, alreadyAlive: true }
  await (deps.injectClaudePrompt || injectClaudePrompt)(tmuxSession, claude.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
  return { ok: true, fleetId, tmuxSession, harness: 'claude', model, resumeId: sessionId, enrolled: !!params.enroll }
}

export async function spawn(params = {}) {
  const mode = params.spawnMode || (params.refresh ? 'refresh' : params.respawn ? 'respawn' : (sessionIdOf(params) ? 'session' : 'fresh'))
  if (mode === 'refresh') return await spawnRefresh(params)
  if (mode === 'respawn') return await spawnRespawn(params)
  if (mode === 'session') return await spawnSession(params)
  if (mode === 'fresh') {
    const config = params.config ?? withDaemonModelAliases({}, readDaemonConfigForCwd(params.cwd || process.cwd()))
    const modelSpec = resolveLaunchSpec(params.model, config, modelKwargs(params))
    applyNormalizedOptions(params, modelSpec)
    const requestedKind = modelSpec.harness
    const adapter = ADAPTERS[requestedKind]
    if (!adapter) throw new SpawnError('launch-failed', `unknown spawn harness: ${requestedKind}`, { kind: requestedKind })
    return await spawnFresh({ ...params, requestedKind, adapter, modelSpec, config })
  }
  throw new SpawnError('launch-failed', `node spawn supports fresh/refresh/respawn/session, got ${mode}`, { mode })
}
