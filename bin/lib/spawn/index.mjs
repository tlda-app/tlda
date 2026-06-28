import { SpawnLibrarian } from '../../../shared/spawn-librarian.ts'
import { newFleetId, resolveDnsAlias, resolveSpawnCwd, sanitizeSessionName } from './identity.mjs'
import { inferHarnessKind } from './models.mjs'
import { checkFreshNameAvailable, ensureServer, findAgent, markAgentDead, resolveApi, waitForAwakeRegistration, wsRegister } from './register.mjs'
import { injectClaudePrompt, injectCodexPrompt, sessionHasRuntime, spawnTmux, uniqueSessionName } from './tmux.mjs'
import { wrapSandboxCmd } from './fence.mjs'
import { codexSandboxProjection, resolveLeasePolicy, sandboxMetadata } from './permissions.mjs'
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

async function buildCommand({ requestedKind, adapter, fleetId, tmuxSession, model, name, cwd, effort, permissionMode, spawnPolicy, api, dnsAlias, resumeId = null, includePrompt = true, leasePolicy = null }) {
  let cmd
  let sendKeys = false
  if (requestedKind === 'codex') {
    codex.ensureProjectTrusted(cwd)
    const projection = codexSandboxProjection(spawnPolicy, cwd, { fenced: !!leasePolicy })
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
      workspaceWriteConfigArgs: codex.buildWorkspaceWriteConfigArgs({
        writableRoots: projection.writableRoots || [],
        networkAccess: projection.networkAccess !== false,
      }),
    })
    sendKeys = true
  } else {
    cmd = adapter.buildCmd({
      fleetId,
      tmuxSession,
      model,
      effort,
      mode: permissionMode,
      name,
      api,
      dnsAlias,
      resumeId,
      includePrompt,
    })
  }
  if (leasePolicy) cmd = wrapSandboxCmd(cmd, leasePolicy, { api, dnsAlias })
  return { cmd, sendKeys }
}

async function spawnFresh(params) {
  const { requestedKind, adapter } = params
  const api = resolveApi()
  const librarian = new SpawnLibrarian({ registerDeadlineMs: params.registerDeadlineMs || 60_000 })
  const name = params.name || `agent-${Date.now().toString(36).slice(-4)}`
  const fleetId = params.agentId || params.agent_id || newFleetId()
  const cwd = resolveSpawnCwd(params.cwd)
  let tmuxSession = null
  let model = null
  let shellRegistered = false
  try {
    const serverUp = await ensureServer({ api })
    tmuxSession = await uniqueSessionName(`fleet-${sanitizeSessionName(name)}`, { tmuxSocket: params.tmuxSocket })
    model = adapter.resolveModel(params.model)
    const dnsAlias = await resolveDnsAlias(api)
    const { policyName, devTools, leasePolicy } = resolveLeasePolicy({
      spawnPolicy: params.spawnPolicy,
      harness: requestedKind,
      model,
      cwd,
      config: params.config,
    })
    if (!devTools && (requestedKind === 'claude' || requestedKind === 'codex')) {
      throw new SpawnError('launch-failed', `${requestedKind} cannot satisfy sandbox policy "${policyName}" without native developer tools`, { policyName })
    }
    await checkFreshNameAvailable(name, { api, serverUp })
    await wsRegister({
      fleetId,
      name,
      tmuxSession,
      cwd,
      model,
      effort: params.effort,
      refresh: true,
      shell: true,
      kind: requestedKind,
      spawnCapability: params.spawnPolicy?.capability || params.requestedCapability,
      metadata: sandboxMetadata(params.spawnPolicy, leasePolicy),
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
    const { cmd, sendKeys } = await buildCommand({
      requestedKind,
      adapter,
      fleetId,
      tmuxSession,
      model,
      name,
      cwd,
      effort: params.effort,
      permissionMode: params.permissionMode ?? params.mode,
      spawnPolicy: params.spawnPolicy,
      api,
      dnsAlias,
      leasePolicy,
    })
    const launched = await spawnTmux(tmuxSession, cwd, cmd, { autoDismiss: requestedKind === 'claude', sendKeys, tmuxSocket: params.tmuxSocket })
    if (!launched) {
      librarian.failPending(fleetId, 'launch-failed')
      throw new SpawnError('launch-failed', `tmux session ${tmuxSession} already has a live harness runtime`, { tmuxSession })
    }
    if (requestedKind === 'codex') {
      await injectCodexPrompt(tmuxSession, codex.kickoffPrompt(name), { tmuxSocket: params.tmuxSocket })
    }
    const registered = await waitForAwakeRegistration(fleetId, { api, librarian, timeoutMs: params.registerDeadlineMs || 60_000 })
    if (!registered.ok) {
      throw new SpawnError(registered.reason, `spawn ${fleetId} did not register before deadline`, { fleetId, tmuxSession })
    }
    return { ok: true, fleetId, tmuxSession, harness: requestedKind, model }
  } catch (e) {
    const err = toSpawnError(e, e?.message?.includes('not available') ? 'name-bounced' : 'launch-failed', { fleetId, tmuxSession, model })
    librarian.failPending(fleetId, err.reason || 'launch-failed')
    if (shellRegistered) {
      try {
        await markAgentDead(fleetId, { api })
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
  const model = adapter.resolveModel(rawModel)
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
  const { policyName, devTools, leasePolicy } = resolveLeasePolicy({
    spawnPolicy: params.spawnPolicy || meta.spawnPolicy,
    harness: requestedKind,
    model,
    cwd,
    config: params.config,
  })
  if (!devTools && (requestedKind === 'claude' || requestedKind === 'codex')) {
    throw new SpawnError('launch-failed', `${requestedKind} cannot satisfy sandbox policy "${policyName}" without native developer tools`, { policyName })
  }
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
      metadata: sandboxMetadata(params.spawnPolicy || meta.spawnPolicy, leasePolicy),
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
    name: friendlyName,
    cwd,
    effort: params.effort || meta.effort,
    permissionMode: params.permissionMode ?? params.mode,
    spawnPolicy: params.spawnPolicy || meta.spawnPolicy,
    api,
    dnsAlias,
    resumeId,
    includePrompt: !(requestedKind === 'claude' && resumeId),
    leasePolicy,
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
  const model = adapter.resolveModel(rawModel)
  const tmuxSession = agent.tmux_session || `fleet-${sanitizeSessionName(friendlyName)}`
  const dnsAlias = await resolveDnsAlias(api)
  const { policyName, devTools, leasePolicy } = resolveLeasePolicy({
    spawnPolicy: params.spawnPolicy || meta.spawnPolicy,
    harness: requestedKind,
    model,
    cwd,
    config: params.config,
  })
  if (!devTools && (requestedKind === 'claude' || requestedKind === 'codex')) {
    throw new SpawnError('launch-failed', `${requestedKind} cannot satisfy sandbox policy "${policyName}" without native developer tools`, { policyName })
  }
  await wsRegister({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort || meta.effort,
    refresh: true,
    kind: requestedKind,
    spawnCapability: (params.spawnPolicy || meta.spawnPolicy)?.capability || params.requestedCapability,
    metadata: sandboxMetadata(params.spawnPolicy || meta.spawnPolicy, leasePolicy),
    machineId: params.machineId,
    api,
  })
  const { cmd, sendKeys } = await buildCommand({
    requestedKind,
    adapter,
    fleetId,
    tmuxSession,
    model,
    name: friendlyName,
    cwd,
    effort: params.effort || meta.effort,
    permissionMode: params.permissionMode ?? params.mode,
    spawnPolicy: params.spawnPolicy || meta.spawnPolicy,
    api,
    dnsAlias,
    includePrompt: true,
    leasePolicy,
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
  const model = codex.resolveModel(params.model)
  const tmuxSession = params.tmuxSession || `fleet-${sanitizeSessionName(friendlyName)}`
  if (await sessionHasRuntime(tmuxSession, { tmuxSocket: params.tmuxSocket })) {
    return { ok: true, fleetId, tmuxSession, harness: 'codex', model, resumeId: sessionId, alreadyAlive: true }
  }
  if (params.enroll) await checkFreshNameAvailable(friendlyName, { api, serverUp: true })
  const dnsAlias = await resolveDnsAlias(api)
  const { policyName, devTools, leasePolicy } = resolveLeasePolicy({
    spawnPolicy: params.spawnPolicy,
    harness: 'codex',
    model,
    cwd,
    config: params.config,
  })
  if (!devTools) {
    throw new SpawnError('launch-failed', `codex cannot satisfy sandbox policy "${policyName}" without native developer tools`, { policyName })
  }
  await wsRegister({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort,
    kind: 'codex',
    sessionId,
    spawnCapability: params.spawnPolicy?.capability || params.requestedCapability,
    metadata: sandboxMetadata(params.spawnPolicy, leasePolicy),
    machineId: params.machineId,
    api,
  })
  const { cmd, sendKeys } = await buildCommand({
    requestedKind: 'codex',
    adapter: codex,
    fleetId,
    tmuxSession,
    model,
    name: friendlyName,
    cwd,
    effort: params.effort,
    permissionMode: params.permissionMode ?? params.mode,
    spawnPolicy: params.spawnPolicy,
    api,
    dnsAlias,
    resumeId: sessionId,
    leasePolicy,
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
  const model = claude.resolveModel(params.model)
  const tmuxSession = params.tmuxSession || `fleet-${sanitizeSessionName(friendlyName)}`
  if (await sessionHasRuntime(tmuxSession, { tmuxSocket: params.tmuxSocket })) {
    return { ok: true, fleetId, tmuxSession, harness: 'claude', model, resumeId: sessionId, alreadyAlive: true }
  }
  if (params.enroll) await checkFreshNameAvailable(friendlyName, { api, serverUp: true })
  stripSyntheticTail(sessionId)
  const dnsAlias = await resolveDnsAlias(api)
  const { policyName, devTools, leasePolicy } = resolveLeasePolicy({
    spawnPolicy: params.spawnPolicy,
    harness: 'claude',
    model,
    cwd,
    config: params.config,
  })
  if (!devTools) {
    throw new SpawnError('launch-failed', `claude cannot satisfy sandbox policy "${policyName}" without native developer tools`, { policyName })
  }
  await wsRegister({
    fleetId,
    name: friendlyName,
    tmuxSession,
    cwd,
    model,
    effort: params.effort,
    kind: 'claude',
    sessionId,
    spawnCapability: params.spawnPolicy?.capability || params.requestedCapability,
    metadata: sandboxMetadata(params.spawnPolicy, leasePolicy),
    machineId: params.machineId,
    api,
  })
  const { cmd, sendKeys } = await buildCommand({
    requestedKind: 'claude',
    adapter: claude,
    fleetId,
    tmuxSession,
    model,
    name: friendlyName,
    cwd,
    effort: params.effort,
    permissionMode: params.permissionMode ?? params.mode,
    spawnPolicy: params.spawnPolicy,
    api,
    dnsAlias,
    resumeId: sessionId,
    includePrompt: false,
    leasePolicy,
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
