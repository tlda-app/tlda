import { SpawnLibrarian } from '../shared/spawn-librarian.ts'
import { newFleetId, readConfig, resolveDnsAlias, resolveSpawnCwd, sanitizeSessionName } from './identity.mjs'
import { inferHarnessKind } from './models.mjs'
import { checkFreshNameAvailable, ensureServer, findAgent, markAgentDead, resolveApi, wsReserveShell } from './register.mjs'
import { injectClaudePrompt, injectCodexPrompt, sessionHasRuntime, spawnTmux, uniqueSessionName } from './tmux.mjs'
import { wrapSandboxCmd } from './fence.mjs'
import { resolveLaunchPolicy, sandboxMetadata } from './permissions.mjs'
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

const ADAPTERS = { claude, codex, goose }

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

function resolveAgentKind(agent, rawModel, requestedKind) {
  const meta = metadataOf(agent)
  return requestedKind || agent?.kind || meta.kind || inferHarnessKind(null, rawModel)
}

function assertNativeTools(policy, requestedKind) {
  if (!policy.devTools && (requestedKind === 'claude' || requestedKind === 'codex')) {
    throw new SpawnError('launch-failed', `${requestedKind} cannot satisfy sandbox policy "${policy.policyName}" without native developer tools`, { policyName: policy.policyName })
  }
}

function traceSpawnDecision(label, detail) {
  const payload = {
    ts: new Date().toISOString(),
    ...detail,
  }
  process.stderr.write(`[spawn-trace] ${label} ${JSON.stringify(payload)}\n`)
}

function resolveAdapterModel(adapter, rawModel, config) {
  if (adapter.resolveModelSelection) {
    const selection = adapter.resolveModelSelection(rawModel, { config })
    return { model: selection.model, provider: selection.provider, selection }
  }
  return { model: adapter.resolveModel(rawModel, { config }), provider: null, selection: null }
}

function spawnEnv(params = {}) {
  const env = { ...process.env }
  if (params.activeConfigName) env.TLDA_CONFIG = params.activeConfigName
  if (params.machineId) env.TLDA_MACHINE_ID = params.machineId
  return env
}

async function buildCommand({ requestedKind, adapter, fleetId, tmuxSession, model, modelProvider = null, name, cwd, effort, permissionMode, spawnPolicy, api, dnsAlias, resumeId = null, includePrompt = true, leasePolicy = null, enforceFence = false, harnessOptions = {}, config = undefined, env = process.env }) {
  let cmd
  let sendKeys = false
  if (requestedKind === 'codex') {
    codex.ensureProjectTrusted(cwd)
    // Permissions come from the daemon config, not from computed harness logic:
    // codex launches with its own sandbox off and the fence (from the grant)
    // does the containment. The code just passes args + harness config + fence.
    cmd = codex.buildCmd({
      fleetId,
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
      tmuxSession,
      model,
      modelProvider,
      effort,
      mode: permissionMode,
      name,
      api,
      dnsAlias,
      resumeId,
      config,
      env,
      includePrompt,
      harnessOptions,
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

async function spawnFresh(params) {
  const { requestedKind, adapter } = params
  const deps = params._deps || {}
  const api = (deps.resolveApi || resolveApi)()
  const librarian = deps.createLibrarian
    ? deps.createLibrarian({ loginDeadlineMs: params.loginDeadlineMs || 60_000 })
    : new SpawnLibrarian({ loginDeadlineMs: params.loginDeadlineMs || 60_000 })
  const name = params.name || `agent-${Date.now().toString(36).slice(-4)}`
  const fleetId = params.agentId || params.agent_id || newFleetId()
  const cwd = resolveSpawnCwd(params.cwd)
  let tmuxSession = null
  let model = null
  let shellRegistered = false
  let serverUp = false
  try {
    try {
      serverUp = await (deps.ensureServer || ensureServer)({ api })
    } catch {
      serverUp = false
    }
    const config = params.config ?? readConfig()
    tmuxSession = await (deps.uniqueSessionName || uniqueSessionName)(`fleet-${sanitizeSessionName(name)}`, { tmuxSocket: params.tmuxSocket })
    const modelResolved = resolveAdapterModel(adapter, params.model, config)
    model = modelResolved.model
    const dnsAlias = await (deps.resolveDnsAlias || resolveDnsAlias)(api)
    const launchPolicy = resolveLaunchPolicy({
      spawnPolicy: params.spawnPolicy,
      permissionSet: params.permissionSet,
      requestedPermission: params.requestedPermission,
      harness: requestedKind,
      model,
      cwd,
      config,
      permissionMode: params.permissionMode,
      mode: params.mode,
      explicitPolicy: params.explicitPolicy,
      acknowledgeNoSecurity: !!params.acknowledgeNoSecurity,
    })
    assertNativeTools(launchPolicy, requestedKind)
    traceSpawnDecision('policy', {
      name,
      fleetId,
      requestedKind,
      model,
      modelProvider: modelResolved.provider,
      cwd,
      requestedPermission: params.requestedPermission || null,
      requestedSpawnPolicy: params.spawnPolicy || null,
      explicitPolicy: !!params.explicitPolicy,
      policyName: launchPolicy.policyName,
      permissionMode: launchPolicy.permissionMode,
      hasLeasePolicy: !!launchPolicy.leasePolicy,
      hasHarnessControls: !!launchPolicy.launchSecurity?.hasHarnessControls,
      acknowledgedNoSecurity: !!launchPolicy.launchSecurity?.acknowledgedNoSecurity,
      harnessRequiredFlags: launchPolicy.harnessOptions?.required || [],
      harnessPreferenceFlags: launchPolicy.harnessOptions?.preferences || [],
      leasePolicyName: launchPolicy.leasePolicy?.policy || null,
      leaseWriteRoots: launchPolicy.leasePolicy?.write_roots || [],
      spawnPolicy: launchPolicy.spawnPolicy || null,
    })
    if (serverUp) {
      await (deps.checkFreshNameAvailable || checkFreshNameAvailable)(name, { api, serverUp })
      await (deps.wsReserveShell || wsReserveShell)({
        fleetId,
        name,
        tmuxSession,
        cwd,
        model,
        effort: params.effort,
        kind: requestedKind,
        spawnPermission: launchPolicy.spawnPolicy?.permission || params.requestedPermission,
        metadata: sandboxMetadata(launchPolicy.spawnPolicy, launchPolicy.leasePolicy),
        machineId: params.machineId,
        api,
      })
      shellRegistered = true
      librarian.observeLiveness({
        type: 'agent-liveness',
        agent_id: fleetId,
        tmux_session: tmuxSession,
        state: 'spawning',
        ts: new Date().toISOString(),
      })
    }
    const { cmd, sendKeys, commandTrace } = await buildCommand({
      requestedKind,
      adapter,
      fleetId,
      tmuxSession,
      model,
      modelProvider: modelResolved.provider,
      name,
      cwd,
      effort: params.effort,
      permissionMode: launchPolicy.permissionMode,
      spawnPolicy: launchPolicy.spawnPolicy,
      api,
      dnsAlias,
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
    if (requestedKind === 'codex') {
      const injected = await (deps.injectCodexPrompt || injectCodexPrompt)(tmuxSession, codex.kickoffPrompt(name), { tmuxSocket: params.tmuxSocket })
      if (!injected) {
        throw new SpawnError('launch-failed', `codex prompt injection did not reach ${tmuxSession}`, { fleetId, tmuxSession })
      }
    }
    if (!serverUp) {
      return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, registrationDeferred: true }
    }
    let resumeId = null
    return { ok: true, pending: true, fleetId, tmuxSession, harness: requestedKind, model, resumeId }
  } catch (e) {
    const err = toSpawnError(e, e?.message?.includes('not available') ? 'name-bounced' : 'launch-failed', { fleetId, tmuxSession, model })
    librarian.failPending(fleetId, err.reason || 'launch-failed')
    if (serverUp && shellRegistered) {
      try {
        await (deps.markAgentDead || markAgentDead)(fleetId, { api })
      } catch (markErr) {
        err.detail = { ...(err.detail || {}), markDeadError: markErr?.message || String(markErr) }
      }
    }
    throw err
  }
}

async function spawnRespawn(params) {
  const deps = params._deps || {}
  const api = (deps.resolveApi || resolveApi)()
  await (deps.ensureServer || ensureServer)({ api })
  const name = params.name || params.agentId || params.agent_id
  const agent = await (deps.findAgent || findAgent)(name, { api })
  if (!agent) throw new SpawnError('launch-failed', `No agent '${name}'. Use --fresh to create.`, { name })
  const meta = metadataOf(agent)
  const rawModel = params.model || meta.model
  const requestedKind = resolveAgentKind(agent, rawModel, params.kind)
  const adapter = ADAPTERS[requestedKind]
  if (!adapter) throw new SpawnError('launch-failed', `unknown spawn harness: ${requestedKind}`, { kind: requestedKind })
  const fleetId = agent.id
  const friendlyName = params.name && !params.name.startsWith('fleet:') ? params.name : (agent.friendly_name || agent.name || fleetId)
  let cwd = resolveSpawnCwd(params.cwd || agent.cwd || process.cwd())
  const config = params.config ?? readConfig()
  const modelResolved = resolveAdapterModel(adapter, rawModel, config)
  const model = modelResolved.model
  const tmuxSession = agent.tmux_session || `fleet-${sanitizeSessionName(friendlyName)}`
  if (await (deps.sessionHasRuntime || sessionHasRuntime)(tmuxSession, { tmuxSocket: params.tmuxSocket })) {
    return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, alreadyAlive: true }
  }
  let handle = null
  const identityOptions = {
    identityConfigDir: params.identityConfigDir,
    identityFilePath: params.identityFilePath,
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
  if (handle?.cwd) cwd = resolveSpawnCwd(handle.cwd)
  if (requestedKind === 'claude' && resumeId) stripSyntheticTail(resumeId)
  const dnsAlias = await resolveDnsAlias(api)
  const launchPolicy = resolveLaunchPolicy({
    spawnPolicy: params.spawnPolicy || meta.spawnPolicy,
    permissionSet: params.permissionSet || meta.permissionSet,
    requestedPermission: params.requestedPermission,
    harness: requestedKind,
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPolicy: params.explicitPolicy,
    acknowledgeNoSecurity: !!params.acknowledgeNoSecurity,
  })
  assertNativeTools(launchPolicy, requestedKind)
  if (requestedKind === 'codex' && resumeId) {
    await wsReserveShell({
      fleetId,
      name: friendlyName,
      tmuxSession,
      cwd,
      model,
      effort: params.effort || meta.effort,
      kind: requestedKind,
      sessionId: resumeId,
      metadata: sandboxMetadata(launchPolicy.spawnPolicy, launchPolicy.leasePolicy),
      machineId: params.machineId,
      api,
    })
  }
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
    spawnPolicy: launchPolicy.spawnPolicy,
    api,
    dnsAlias,
    resumeId,
    includePrompt: !(requestedKind === 'claude' && resumeId),
    leasePolicy: launchPolicy.leasePolicy,
    enforceFence: !!params.enforceFence,
    harnessOptions: launchPolicy.harnessOptions,
    config,
    env: spawnEnv(params),
  })
  const launched = await spawnTmux(tmuxSession, cwd, cmd, { autoDismiss: requestedKind === 'claude', sendKeys, tmuxSocket: params.tmuxSocket, crashLogPath: params.crashLogPath })
  if (!launched) return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, alreadyAlive: true }
  if (requestedKind === 'codex') {
    await injectCodexPrompt(tmuxSession, codex.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
  } else if (requestedKind === 'claude' && resumeId) {
    await injectClaudePrompt(tmuxSession, claude.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
  }
  return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, resumeId }
}

async function spawnRefresh(params) {
  const api = resolveApi()
  await ensureServer({ api })
  const name = params.name || params.agentId || params.agent_id
  const agent = await findAgent(name, { api })
  if (!agent) throw new SpawnError('launch-failed', `No agent '${name}'. Use --fresh to create.`, { name })
  const meta = metadataOf(agent)
  const rawModel = params.model || meta.model
  const requestedKind = resolveAgentKind(agent, rawModel, params.kind)
  const adapter = ADAPTERS[requestedKind]
  if (!adapter) throw new SpawnError('launch-failed', `unknown spawn harness: ${requestedKind}`, { kind: requestedKind })
  const fleetId = agent.id
  const friendlyName = params.name && !params.name.startsWith('fleet:') ? params.name : (agent.friendly_name || agent.name || fleetId)
  const cwd = resolveSpawnCwd(params.cwd || agent.cwd || process.cwd())
  const config = params.config ?? readConfig()
  const modelResolved = resolveAdapterModel(adapter, rawModel, config)
  const model = modelResolved.model
  const tmuxSession = agent.tmux_session || `fleet-${sanitizeSessionName(friendlyName)}`
  const dnsAlias = await resolveDnsAlias(api)
  const launchPolicy = resolveLaunchPolicy({
    spawnPolicy: params.spawnPolicy || meta.spawnPolicy,
    permissionSet: params.permissionSet || meta.permissionSet,
    requestedPermission: params.requestedPermission,
    harness: requestedKind,
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPolicy: params.explicitPolicy,
    acknowledgeNoSecurity: !!params.acknowledgeNoSecurity,
  })
  assertNativeTools(launchPolicy, requestedKind)
  await wsReserveShell({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort || meta.effort,
    kind: requestedKind,
    spawnPermission: launchPolicy.spawnPolicy?.permission || params.requestedPermission,
    metadata: sandboxMetadata(launchPolicy.spawnPolicy, launchPolicy.leasePolicy),
    machineId: params.machineId,
    api,
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
    spawnPolicy: launchPolicy.spawnPolicy,
    api,
    dnsAlias,
    includePrompt: true,
    leasePolicy: launchPolicy.leasePolicy,
    enforceFence: !!params.enforceFence,
    harnessOptions: launchPolicy.harnessOptions,
    config,
    env: spawnEnv(params),
  })
  const launched = await spawnTmux(tmuxSession, cwd, cmd, { autoDismiss: requestedKind === 'claude', sendKeys, tmuxSocket: params.tmuxSocket, crashLogPath: params.crashLogPath })
  if (!launched) return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, alreadyAlive: true }
  if (requestedKind === 'codex') {
    await injectCodexPrompt(tmuxSession, codex.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
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

async function spawnSession(params) {
  const deps = params._deps || {}
  const api = (deps.resolveApi || resolveApi)()
  await (deps.ensureServer || ensureServer)({ api })
  const sessionId = sessionIdOf(params)
  if (!sessionId) throw new SpawnError('launch-failed', 'session spawn requires --session <uuid>')
  const kind = normalizeSessionKind(params.kind)
  if (!kind) {
    throw new SpawnError('launch-failed', 'enroll requires --kind <codex|claude>: session ids are not unique across harnesses', { sessionId })
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
  const { ownId, agentName, sessionMeta } = scanCodexRolloutIdentity(codexPath)
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
  const config = params.config ?? readConfig()
  const modelResolved = resolveAdapterModel(codex, params.model, config)
  const model = modelResolved.model
  const tmuxSession = params.tmuxSession || `fleet-${sanitizeSessionName(friendlyName)}`
  if (await (deps.sessionHasRuntime || sessionHasRuntime)(tmuxSession, { tmuxSocket: params.tmuxSocket })) {
    return { ok: true, fleetId, tmuxSession, harness: 'codex', model, resumeId: sessionId, alreadyAlive: true }
  }
  if (params.enroll) await (deps.checkFreshNameAvailable || checkFreshNameAvailable)(friendlyName, { api, serverUp: true })
  const dnsAlias = await (deps.resolveDnsAlias || resolveDnsAlias)(api)
  const launchPolicy = resolveLaunchPolicy({
    spawnPolicy: params.spawnPolicy,
    permissionSet: params.permissionSet,
    requestedPermission: params.requestedPermission,
    harness: 'codex',
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPolicy: params.explicitPolicy,
    acknowledgeNoSecurity: !!params.acknowledgeNoSecurity,
  })
  assertNativeTools(launchPolicy, 'codex')
  await (deps.wsReserveShell || wsReserveShell)({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort,
    kind: 'codex',
    sessionId,
    spawnPermission: launchPolicy.spawnPolicy?.permission || params.requestedPermission,
    metadata: sandboxMetadata(launchPolicy.spawnPolicy, launchPolicy.leasePolicy),
    machineId: params.machineId,
    api,
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
    spawnPolicy: launchPolicy.spawnPolicy,
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
  const config = params.config ?? readConfig()
  const modelResolved = resolveAdapterModel(claude, params.model, config)
  const model = modelResolved.model
  const tmuxSession = params.tmuxSession || `fleet-${sanitizeSessionName(friendlyName)}`
  if (await (deps.sessionHasRuntime || sessionHasRuntime)(tmuxSession, { tmuxSocket: params.tmuxSocket })) {
    return { ok: true, fleetId, tmuxSession, harness: 'claude', model, resumeId: sessionId, alreadyAlive: true }
  }
  if (params.enroll) await (deps.checkFreshNameAvailable || checkFreshNameAvailable)(friendlyName, { api, serverUp: true })
  stripSyntheticTail(sessionId, { projectsBase: params.claudeProjectsBase })
  const dnsAlias = await (deps.resolveDnsAlias || resolveDnsAlias)(api)
  const launchPolicy = resolveLaunchPolicy({
    spawnPolicy: params.spawnPolicy,
    permissionSet: params.permissionSet,
    requestedPermission: params.requestedPermission,
    harness: 'claude',
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPolicy: params.explicitPolicy,
    acknowledgeNoSecurity: !!params.acknowledgeNoSecurity,
  })
  assertNativeTools(launchPolicy, 'claude')
  await (deps.wsReserveShell || wsReserveShell)({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort,
    kind: 'claude',
    sessionId,
    spawnPermission: launchPolicy.spawnPolicy?.permission || params.requestedPermission,
    metadata: sandboxMetadata(launchPolicy.spawnPolicy, launchPolicy.leasePolicy),
    machineId: params.machineId,
    api,
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
    spawnPolicy: launchPolicy.spawnPolicy,
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
    const requestedKind = inferHarnessKind(params.kind, params.model)
    const adapter = ADAPTERS[requestedKind]
    if (!adapter) throw new SpawnError('launch-failed', `unknown spawn harness: ${requestedKind}`, { kind: requestedKind })
    return await spawnFresh({ ...params, requestedKind, adapter })
  }
  throw new SpawnError('launch-failed', `node spawn supports fresh/refresh/respawn/session, got ${mode}`, { mode })
}
