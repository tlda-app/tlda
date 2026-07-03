import { SpawnLibrarian } from '../../../shared/spawn-librarian.ts'
import { newFleetId, readConfig, resolveDnsAlias, resolveSpawnCwd, sanitizeSessionName } from './identity.mjs'
import { inferHarnessKind } from './models.mjs'
import { checkFreshNameAvailable, ensureServer, findAgent, markAgentDead, resolveApi, waitForAwakeRegistration, wsRegister } from './register.mjs'
import { injectClaudePrompt, injectCodexPrompt, sessionHasRuntime, spawnTmux, uniqueSessionName } from './tmux.mjs'
import { wrapSandboxCmd } from './fence.mjs'
import { codexSandboxProjection, resolveLaunchPolicy, sandboxMetadata } from './permissions.mjs'
import {
  codexRolloutPath,
  findClaudeSession,
  findCodexRollout,
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

async function buildCommand({ requestedKind, adapter, fleetId, tmuxSession, model, modelProvider = null, name, cwd, effort, permissionMode, spawnPolicy, api, dnsAlias, resumeId = null, includePrompt = true, leasePolicy = null }) {
  let cmd
  let sendKeys = false
  let projection = null
  if (requestedKind === 'codex') {
    codex.ensureProjectTrusted(cwd)
    projection = codexSandboxProjection(spawnPolicy, cwd, { fenced: !!leasePolicy })
    cmd = codex.buildCmd({
      fleetId,
      tmuxSession,
      model,
      name,
      cwd,
      api,
      dnsAlias,
      resumeId,
      sandboxMode: projection.sandboxMode,
      workspaceWriteConfigArgs: projection.sandboxMode === 'workspace-write'
        ? codex.buildWorkspaceWriteConfigArgs({
            writableRoots: projection.writableRoots || [],
            networkAccess: projection.networkAccess !== false,
          })
        : [],
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
      includePrompt,
    })
  }
  const commandBeforeFence = cmd
  if (leasePolicy) cmd = wrapSandboxCmd(cmd, leasePolicy, { api, dnsAlias })
  return {
    cmd,
    sendKeys,
    commandTrace: {
      projection,
      hasLeasePolicy: !!leasePolicy,
      wrappedByFence: !!leasePolicy,
      commandContainsFence: /(?:^|['"\s/])fence(?:['"\s]|$)/.test(cmd),
      commandContainsCodexYolo: cmd.includes('--dangerously-bypass-approvals-and-sandbox') || cmd.includes('--yolo'),
      commandContainsDangerSandbox: cmd.includes('danger-full-access'),
      commandBeforeFence,
    },
  }
}

async function spawnFresh(params) {
  const { requestedKind, adapter } = params
  const deps = params._deps || {}
  const api = (deps.resolveApi || resolveApi)()
  const librarian = deps.createLibrarian
    ? deps.createLibrarian({ registerDeadlineMs: params.registerDeadlineMs || 60_000 })
    : new SpawnLibrarian({ registerDeadlineMs: params.registerDeadlineMs || 60_000 })
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
      privilegeSet: params.privilegeSet,
      requestedCapability: params.requestedCapability,
      harness: requestedKind,
      model,
      cwd,
      config,
      permissionMode: params.permissionMode,
      mode: params.mode,
      explicitPolicy: params.explicitPolicy,
    })
    assertNativeTools(launchPolicy, requestedKind)
    traceSpawnDecision('policy', {
      name,
      fleetId,
      requestedKind,
      model,
      modelProvider: modelResolved.provider,
      cwd,
      requestedCapability: params.requestedCapability || null,
      requestedSpawnPolicy: params.spawnPolicy || null,
      explicitPolicy: !!params.explicitPolicy,
      policyName: launchPolicy.policyName,
      permissionMode: launchPolicy.permissionMode,
      fenceTemporarilyDisabled: !!launchPolicy.fenceTemporarilyDisabled,
      hasLeasePolicy: !!launchPolicy.leasePolicy,
      leasePolicyName: launchPolicy.leasePolicy?.policy || null,
      leaseWriteRoots: launchPolicy.leasePolicy?.write_roots || [],
      spawnPolicy: launchPolicy.spawnPolicy || null,
    })
    if (serverUp) {
      await (deps.checkFreshNameAvailable || checkFreshNameAvailable)(name, { api, serverUp })
      await (deps.wsRegister || wsRegister)({
        fleetId,
        name,
        tmuxSession,
        cwd,
        model,
        effort: params.effort,
        refresh: true,
        shell: true,
        kind: requestedKind,
        spawnCapability: launchPolicy.spawnPolicy?.capability || params.requestedCapability,
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
      name,
      cwd,
      effort: params.effort,
      permissionMode: launchPolicy.permissionMode,
      spawnPolicy: launchPolicy.spawnPolicy,
      api,
      dnsAlias,
      leasePolicy: launchPolicy.leasePolicy,
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
      projection: commandTrace.projection,
      cmd,
    })
    const launched = await (deps.spawnTmux || spawnTmux)(tmuxSession, cwd, cmd, { autoDismiss: requestedKind === 'claude', sendKeys, tmuxSocket: params.tmuxSocket })
    if (!launched) {
      librarian.failPending(fleetId, 'launch-failed')
      throw new SpawnError('launch-failed', `tmux session ${tmuxSession} already has a live harness runtime`, { tmuxSession })
    }
    if (requestedKind === 'codex') {
      await (deps.injectCodexPrompt || injectCodexPrompt)(tmuxSession, codex.kickoffPrompt(name), { tmuxSocket: params.tmuxSocket })
    }
    if (!serverUp) {
      return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, registrationDeferred: true }
    }
    const registered = await (deps.waitForAwakeRegistration || waitForAwakeRegistration)(fleetId, { api, librarian, timeoutMs: params.registerDeadlineMs || 60_000 })
    if (!registered.ok) {
      throw new SpawnError(registered.reason, `spawn ${fleetId} did not register before deadline`, { fleetId, tmuxSession })
    }
    return { ok: true, fleetId, tmuxSession, harness: requestedKind, model }
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
  let cwd = resolveSpawnCwd(params.cwd || agent.cwd || process.cwd())
  const config = params.config ?? readConfig()
  const modelResolved = resolveAdapterModel(adapter, rawModel, config)
  const model = modelResolved.model
  const tmuxSession = agent.tmux_session || `fleet-${sanitizeSessionName(friendlyName)}`
  if (await sessionHasRuntime(tmuxSession, { tmuxSocket: params.tmuxSocket })) {
    return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, alreadyAlive: true }
  }
  let handle = null
  if (requestedKind === 'claude') handle = findClaudeSession(agent, { sessionOverride: params.sessionId || params.session_id })
  else if (requestedKind === 'codex') handle = findCodexRollout(agent, { sessionOverride: params.sessionId || params.session_id })
  if (!handle && (requestedKind === 'claude' || requestedKind === 'codex')) {
    throw new SpawnError('launch-failed', `No ${requestedKind} resume handle for ${friendlyName} (${fleetId}). Use refresh to start fresh.`, { fleetId })
  }
  const resumeId = adapter.resumeId?.(handle)
  if (handle?.cwd) cwd = resolveSpawnCwd(handle.cwd)
  if (requestedKind === 'claude' && resumeId) stripSyntheticTail(resumeId)
  const dnsAlias = await resolveDnsAlias(api)
  const launchPolicy = resolveLaunchPolicy({
    spawnPolicy: params.spawnPolicy || meta.spawnPolicy,
    privilegeSet: params.privilegeSet || meta.privilegeSet,
    requestedCapability: params.requestedCapability,
    harness: requestedKind,
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPolicy: params.explicitPolicy,
  })
  assertNativeTools(launchPolicy, requestedKind)
  if (requestedKind === 'codex' && resumeId) {
    await wsRegister({
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
  })
  const launched = await spawnTmux(tmuxSession, cwd, cmd, { autoDismiss: requestedKind === 'claude', sendKeys, tmuxSocket: params.tmuxSocket })
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
    privilegeSet: params.privilegeSet || meta.privilegeSet,
    requestedCapability: params.requestedCapability,
    harness: requestedKind,
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPolicy: params.explicitPolicy,
  })
  assertNativeTools(launchPolicy, requestedKind)
  await wsRegister({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort || meta.effort,
    refresh: true,
    kind: requestedKind,
    spawnCapability: launchPolicy.spawnPolicy?.capability || params.requestedCapability,
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
  })
  const launched = await spawnTmux(tmuxSession, cwd, cmd, { autoDismiss: requestedKind === 'claude', sendKeys, tmuxSocket: params.tmuxSocket })
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

async function spawnSession(params) {
  const api = resolveApi()
  await ensureServer({ api })
  const sessionId = sessionIdOf(params)
  if (!sessionId) throw new SpawnError('launch-failed', 'session spawn requires --session <uuid>')
  const codexPath = codexRolloutPath(sessionId)
  if (codexPath) return await spawnCodexSession(params, { api, sessionId, codexPath })
  const claudeIdentity = scanClaudeSessionIdentity(sessionId)
  if (claudeIdentity) return await spawnClaudeSession(params, { api, sessionId, identity: claudeIdentity })
  throw new SpawnError('launch-failed', `No Claude JSONL or Codex rollout found for session ${sessionId}`, { sessionId })
}

async function spawnCodexSession(params, { api, sessionId, codexPath }) {
  const { ownId, agentName, sessionMeta } = scanCodexRolloutIdentity(codexPath)
  if (params.enroll && ownId) {
    throw new SpawnError('launch-failed', `Codex session ${sessionId} is already enrolled as ${ownId}`, { sessionId, fleetId: ownId })
  }
  if (!ownId && !params.enroll) {
    throw new SpawnError('launch-failed', `Codex session ${sessionId} has no fleet registration; use --enroll`, { sessionId })
  }
  const fleetId = ownId || params.agentId || params.agent_id || newFleetId()
  const friendlyName = params.name && !String(params.name).startsWith('fleet:')
    ? params.name
    : (agentName || defaultEnrolledName(params, sessionId))
  const cwd = resolveSpawnCwd(params.cwd || sessionMeta.cwd || process.cwd())
  const config = params.config ?? readConfig()
  const modelResolved = resolveAdapterModel(codex, params.model, config)
  const model = modelResolved.model
  const tmuxSession = params.tmuxSession || `fleet-${sanitizeSessionName(friendlyName)}`
  if (await sessionHasRuntime(tmuxSession, { tmuxSocket: params.tmuxSocket })) {
    return { ok: true, fleetId, tmuxSession, harness: 'codex', model, resumeId: sessionId, alreadyAlive: true }
  }
  if (params.enroll) await checkFreshNameAvailable(friendlyName, { api, serverUp: true })
  const dnsAlias = await resolveDnsAlias(api)
  const launchPolicy = resolveLaunchPolicy({
    spawnPolicy: params.spawnPolicy,
    privilegeSet: params.privilegeSet,
    requestedCapability: params.requestedCapability,
    harness: 'codex',
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPolicy: params.explicitPolicy,
  })
  assertNativeTools(launchPolicy, 'codex')
  await wsRegister({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort,
    kind: 'codex',
    sessionId,
    spawnCapability: launchPolicy.spawnPolicy?.capability || params.requestedCapability,
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
  })
  const launched = await spawnTmux(tmuxSession, cwd, cmd, { sendKeys, tmuxSocket: params.tmuxSocket })
  if (!launched) return { ok: true, fleetId, tmuxSession, harness: 'codex', model, resumeId: sessionId, alreadyAlive: true }
  await injectCodexPrompt(tmuxSession, codex.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
  return { ok: true, fleetId, tmuxSession, harness: 'codex', model, resumeId: sessionId, enrolled: !!params.enroll }
}

async function spawnClaudeSession(params, { api, sessionId, identity }) {
  if (params.enroll && identity.fleetId) {
    throw new SpawnError('launch-failed', `Claude session ${sessionId} is already enrolled as ${identity.fleetId}`, { sessionId, fleetId: identity.fleetId })
  }
  if (!identity.fleetId && !params.enroll) {
    throw new SpawnError('launch-failed', `Claude session ${sessionId} has no fleet registration; use --enroll`, { sessionId })
  }
  const fleetId = identity.fleetId || params.agentId || params.agent_id || newFleetId()
  const friendlyName = params.name && !String(params.name).startsWith('fleet:')
    ? params.name
    : (identity.agentName || defaultEnrolledName(params, sessionId))
  const cwd = resolveSpawnCwd(params.cwd || identity.cwd || process.cwd())
  const config = params.config ?? readConfig()
  const modelResolved = resolveAdapterModel(claude, params.model, config)
  const model = modelResolved.model
  const tmuxSession = params.tmuxSession || `fleet-${sanitizeSessionName(friendlyName)}`
  if (await sessionHasRuntime(tmuxSession, { tmuxSocket: params.tmuxSocket })) {
    return { ok: true, fleetId, tmuxSession, harness: 'claude', model, resumeId: sessionId, alreadyAlive: true }
  }
  if (params.enroll) await checkFreshNameAvailable(friendlyName, { api, serverUp: true })
  stripSyntheticTail(sessionId)
  const dnsAlias = await resolveDnsAlias(api)
  const launchPolicy = resolveLaunchPolicy({
    spawnPolicy: params.spawnPolicy,
    requestedCapability: params.requestedCapability,
    harness: 'claude',
    model,
    cwd,
    config,
    permissionMode: params.permissionMode,
    mode: params.mode,
    explicitPolicy: params.explicitPolicy,
  })
  assertNativeTools(launchPolicy, 'claude')
  await wsRegister({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort,
    kind: 'claude',
    sessionId,
    spawnCapability: launchPolicy.spawnPolicy?.capability || params.requestedCapability,
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
  })
  const launched = await spawnTmux(tmuxSession, cwd, cmd, { autoDismiss: true, sendKeys, tmuxSocket: params.tmuxSocket })
  if (!launched) return { ok: true, fleetId, tmuxSession, harness: 'claude', model, resumeId: sessionId, alreadyAlive: true }
  await injectClaudePrompt(tmuxSession, claude.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
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
