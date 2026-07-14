import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import { resolveSpawnGrant } from '../server/lib/spawn-policy.mjs'
import { detectSpawnStartupFailureTranscript } from '../agent-runtime/daemon-guards.mjs'
import { ledgerSessionId } from '../agent-runtime/ledger-session-tail.mjs'
import { resolveTranscript } from '../agent-runtime/resolve-transcript.mjs'
import { probeSpawnAvailability } from './availability.mjs'
import { newFleetId } from './identity.mjs'
import { readDaemonConfigForCwd, withDaemonModelAliases } from './permission-ledger.mjs'
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

function readCodexRolloutModel(jsonlPath, maxLines = 200) {
  if (!jsonlPath) return null
  let text
  try {
    text = fs.readFileSync(jsonlPath, 'utf8')
  } catch {
    return null
  }
  let seen = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    seen += 1
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const model = entry?.payload?.model
      || entry?.model
      || entry?.message?.model
      || entry?.payload?.message?.model
      || entry?.response?.model
      || entry?.payload?.response?.model
    if (typeof model === 'string' && model.trim()) return model.trim()
    if (seen >= maxLines) break
  }
  return null
}

function codexRuntimeRe() {
  return /(?:^|\s|[/\\])codex(?:\.exe)?(?:\s|$)/
}

async function findCodexRuntimePid(tmuxSession, { tmuxArgs = [], tmuxSocket = null } = {}) {
  if (!tmuxSession) return null
  const args = tmuxSocket ? ['-S', tmuxSocket] : tmuxArgs
  let paneOut = ''
  try {
    ;({ stdout: paneOut } = await execFileP('tmux',
      [...args, 'list-panes', '-t', tmuxSession, '-F', '#{pane_pid}'],
      { timeout: 3000, encoding: 'utf8' }))
  } catch {
    return null
  }
  const panePids = paneOut.trim().split('\n').filter(Boolean)
  if (!panePids.length) return null

  let psOut = ''
  try {
    ;({ stdout: psOut } = await execFileP('ps', ['-eo', 'pid,ppid,args'], {
      timeout: 5000,
      encoding: 'utf8',
    }))
  } catch {
    return null
  }

  const childrenByPpid = new Map()
  const runtimePids = new Set()
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const [, pid, ppid, argsText] = m
    if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, [])
    childrenByPpid.get(ppid).push(pid)
    if (codexRuntimeRe().test(argsText)) runtimePids.add(pid)
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

export async function resolveLiveCodexSessionIdentity({
  agent,
  tmuxSession,
  tmuxArgs = [],
  tmuxSocket = null,
  now = Date.now,
} = {}) {
  const pid = await findCodexRuntimePid(tmuxSession, { tmuxArgs, tmuxSocket })
  if (!pid) return null
  const launchTs = Date.parse(agent?.registered_at || '') || (now() - 60_000)
  const jsonlPath = await resolveTranscript({ pid, kind: 'codex', agent, launchTs })
  const sessionId = ledgerSessionId({ harness_kind: 'codex', jsonl_path: jsonlPath })
  if (!sessionId) return null
  const model = readCodexRolloutModel(jsonlPath)
  return { sessionId, jsonlPath, model }
}

async function waitForLiveCodexSessionIdentity(resolveIdentity, args, {
  timeoutMs = Number(process.env.TLDA_SPAWN_RESUME_ID_TIMEOUT_MS || 10_000),
  intervalMs = 250,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() <= deadline) {
    last = await resolveIdentity(args)
    if (last?.sessionId && last?.model) return last
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return last
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
  liveCodexSessionIdentityResolver = resolveLiveCodexSessionIdentity,
  startupFailureProbeMs = Number(process.env.TLDA_SPAWN_STARTUP_FAILURE_PROBE_MS || 2500),
}) {
  const activeSpawns = new Map()
  const reportedStartupFailures = new Set()
  const spawnCrashLogDir = path.join(configDir, 'spawn-crashes')

  function trace(label, detail) {
    log.info(`[spawn-trace] ${label} ${JSON.stringify({ ts: new Date().toISOString(), machineId, ...detail })}`)
  }

  function spawnCrashLogPath({ agentName, agent_id, tmux_session }) {
    const base = String(agent_id || agentName || tmux_session || 'unknown').replace(/[^A-Za-z0-9_.:-]/g, '_')
    return path.join(spawnCrashLogDir, `${base}.log`)
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
    requestedPermission,
    requestedPermissions,
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
      const age = Date.now() - activeSpawns.get(agentName)
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
      activeSpawns.delete(agentName)
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
        grant = { grantedPolicy: own.spawnPolicy, grantedPermissionSet: own.permissionSet, grantPreserved: true }
      } else {
        if (!requester?.id) {
          const err = new Error('spawn refused: daemon RPC requester identity is required')
          err.code = 'SPAWN_PERMISSION_NO_REQUESTER'
          throw err
        }
        const spawnerGrant = permissionLedger.grantFor(requester)
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
          requestedPermission,
          requestedPermissions,
          requester,
          spawnerPermissionSet: spawnerGrant?.permissionSet,
          model: launchModel,
          kind: launchKind,
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
      if (permissionSetConfersNothing(grant.grantedPermissionSet)
        && !isIntentionalEmptyPermissionSet(grant.grantedPermissionSet)) {
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
      requestedPermission: requestedPermission || null,
      hasRequestedPermissions: !!requestedPermissions,
      grantedPermission: grant.grantedPermission || null,
      grantedPolicy: grant.grantedPolicy || null,
      hasGrantedPermissionSet: !!grant.grantedPermissionSet,
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
          modelSpec: launchModelSpec,
          config: spawnConfig,
          activeConfigName,
          permissionLedger,
          cwd: resolvedCwd,
          sessionId,
          enroll: !!enroll,
          effort,
          permissionMode: mode,
          spawnPolicy: grant.grantedPolicy,
          permissionSet: grant.grantedPermissionSet,
          explicitPolicy: requestedPermission != null || requestedPermissions != null,
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
      trace('launched', {
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
        if (shouldWriteLedgerRow) await permissionLedger.delete(preallocatedAgentId).catch(() => {})
        const detail = ((e.stderr || e.message || '').trim().split('\n').filter(Boolean).pop()) || 'tmux session check failed'
        return {
          ok: false,
          name: agentName,
          agent_id: launched.fleetId,
          tmux_session: launched.tmuxSession,
          error: `spawn launcher returned but tmux session is not usable: ${detail}`,
        }
      }
      if (launched.harness === 'codex' && !launched.resumeId && !launched.pending) {
        if (shouldWriteLedgerRow) await permissionLedger.delete(preallocatedAgentId).catch(() => {})
        return {
          ok: false,
          name: agentName,
          agent_id: launched.fleetId,
          tmux_session: launched.tmuxSession,
          code: 'missing-resume-handle',
          error: 'spawn launcher returned a codex session without a durable resume handle',
        }
      }
      if (launched.harness === 'codex' && !launched.resumeId) {
        const identity = await waitForLiveCodexSessionIdentity(liveCodexSessionIdentityResolver, {
          agent: {
            id: launched.fleetId,
            friendly_name: agentName,
            cwd: resolvedCwd,
            registered_at: new Date().toISOString(),
          },
          tmuxSession: launched.tmuxSession,
          tmuxArgs,
          tmuxSocket,
        })
        if (!identity?.sessionId) {
          if (shouldWriteLedgerRow) await permissionLedger.delete(preallocatedAgentId).catch(() => {})
          return {
            ok: false,
            name: agentName,
            agent_id: launched.fleetId,
            tmux_session: launched.tmuxSession,
            code: 'identity-ingestion-pending',
            reason: 'identity-ingestion-pending',
            retry_after_ms: 1000,
            error: `spawn launched ${agentName}, but the daemon could not bind its live Codex rollout yet; retry once session identity ingestion catches up`,
          }
        }
        permissionLedger.setSessionSync(launched.fleetId, {
          sessionId: identity.sessionId,
          sessionKind: 'codex',
          sessionPath: identity.jsonlPath,
          tmuxSession: launched.tmuxSession,
          model: identity.model,
          machineId,
          envName: activeConfigName,
          daemonKey: `${machineId}:${activeConfigName}`,
          cwd: resolvedCwd,
          friendlyName: agentName,
        })
        sendMsg({
          type: 'agent-seat',
          agent_id: launched.fleetId,
          session_id: identity.sessionId,
          resume_id: identity.sessionId,
          kind: 'codex',
          model: identity.model,
          cwd: resolvedCwd,
          machine_id: machineId,
          env_name: activeConfigName,
          daemon_key: `${machineId}:${activeConfigName}`,
          tmux_session: launched.tmuxSession,
          created_source: 'spawn-runtime',
        })
        launched.resumeId = identity.sessionId
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
        pending: !!launched.pending,
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
