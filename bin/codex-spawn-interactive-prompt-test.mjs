#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectSpawnStartupFailureTranscript } from '../agent-runtime/daemon-guards.mjs'
import { buildCmd, resolveOwnedCodexTranscript } from '../agent-launch/harness/codex.mjs'
import { buildCmd as buildClaudeCmd, resolveLiveSessionIdentity as resolveLiveClaudeSessionIdentity } from '../agent-launch/harness/claude.mjs'
import { createAgentLauncher } from '../agent-launch/agent-launch.mjs'
import { bindLifecycleCodexResumeIdentity, bindSpawnRuntimeIfNeeded, persistAssignedAgentGrant } from '../cli/tlda.mjs'
import { recordAgentBindingEvent } from '../server/lib/agent-binding-events.mjs'

function permissionSet(name = 'test') {
  return {
    type: 'permission-set',
    name,
    operations: {
      read: { allow: ['**'], deny: [] },
      write: { allow: ['**'], deny: [] },
      spawn: { allow: ['**'], deny: [] },
    },
    rules: [],
  }
}

function configFor(cwd) {
  return {
    modelCatalog: { default: 'codex-test' },
    profiles: {
      test: {
        read: { allow: ['**'], deny: [] },
        write: { allow: ['**'], deny: [] },
        spawn: { allow: ['**'], deny: [] },
      },
    },
    spawnPolicy: { projectProfiles: { [cwd]: 'test' } },
  }
}

function memoryLedger() {
  const rows = new Map()
  return {
    get(id) { return rows.get(id) || null },
    async set(id, row) { rows.set(id, { ...(rows.get(id) || {}), ...row }) },
    setSessionSync(id, session) { rows.set(id, { ...(rows.get(id) || {}), ...session }) },
    rotateTerminalCapabilitySync(id) {
      const capability = `termcap:${id}`
      rows.set(id, { ...(rows.get(id) || {}), terminalCapability: capability })
      return capability
    },
    async delete(id) { rows.delete(id) },
    rows,
  }
}

function testCodexInteractivePromptClassifier() {
  const update = detectSpawnStartupFailureTranscript(
    'Update available 0.144.5 -> 0.145.0\nPress Enter to continue',
    { harness: 'codex' },
  )
  assert.equal(update.code, 'codex-interactive-prompt')
  assert.match(update.reason, /Press Enter to continue|Update available/i)

  const approval = detectSpawnStartupFailureTranscript(
    'Approval required\nPress Enter to confirm',
    { harness: 'codex' },
  )
  assert.equal(approval.code, 'codex-interactive-prompt')
}

function testCodexLaunchForcesCiEnv() {
  const cmd = buildCmd({
    fleetId: 'fleet:test',
    localAgentId: 'local:test',
    tmuxSession: 'fleet-test',
    model: 'gpt-test',
    name: 'test',
    cwd: '/tmp',
    api: 'https://example.invalid',
    config: { defaultConfig: 'prod' },
    env: {},
  })
  assert.match(cmd, /(?:^|\s)CODEX_CI=1(?:\s|$)/)
  assert.match(cmd, /mcp_servers\.tlda\.env\.CODEX_CI=.*"1"/)
}

function testFreshClaudeLaunchPinsItsOwnSessionId() {
  const cmd = buildClaudeCmd({
    fleetId: 'fleet:claude-fresh',
    localAgentId: 'local:claude-fresh',
    tmuxSession: 'fleet-claude-fresh',
    model: 'opus',
    name: 'claude-fresh',
    api: 'https://example.test',
    freshSessionId: '11111111-2222-4333-8444-555555555555',
    config: {},
    harnessOptions: { required: [], preferences: [] },
  })
  assert.match(cmd, /--session-id '11111111-2222-4333-8444-555555555555'/)
  assert.doesNotMatch(cmd, /--resume/)
}

async function testClaudeResolverRejectsAnotherSessionsJsonl() {
  const expected = '11111111-2222-4333-8444-555555555555'
  const identity = await resolveLiveClaudeSessionIdentity({
    agent: { session_id: expected, cwd: '/tmp/project' },
    tmuxSession: 'fleet-claude-fresh',
    _deps: {
      execFile: async (command) => command === 'tmux'
        ? { stdout: '100\n' }
        : { stdout: '100 1 claude\n' },
      resolveTranscript: async options => {
        assert.equal(options.acceptTranscript(`/tmp/.claude/projects/x/${expected}.jsonl`), true)
        assert.equal(options.acceptTranscript('/tmp/.claude/projects/x/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'), false)
        return `/tmp/.claude/projects/x/${expected}.jsonl`
      },
      readFileSync: () => `${JSON.stringify({ model: 'opus', cwd: '/tmp/project' })}\n`,
    },
  })
  assert.equal(identity.sessionId, expected)
}

async function testFreshCodexPromptFailureFailsLoud() {
  const cwd = mkdtempSync(join(tmpdir(), 'tlda-codex-prompt-'))
  const ledger = memoryLedger()
  await ledger.set('fleet:requester', {
    permissionSet: permissionSet('requester'),
    permissionProfile: 'test',
    spawnPolicy: { policy: 'unsandboxed' },
  })
  const sent = []
  const launcher = createAgentLauncher({
    activeConfigName: 'prod',
    configDir: cwd,
    loadConfig: () => configFor(cwd),
    log: { info() {}, warn() {} },
    machineId: 'mini',
    permissionLedger: ledger,
    sendMsg: msg => { sent.push(msg) },
    getProjects: () => [{ name: 'test-doc', sourceDir: cwd }],
    tmux: async (cmd, ...args) => {
      if (cmd === 'has-session') return { stdout: '' }
      if (cmd === 'capture-pane') {
        assert.deepEqual(args.slice(0, 2), ['-t', 'fleet-blocked'])
        return { stdout: 'Update available 0.144.5 -> 0.145.0\nPress Enter to continue' }
      }
      throw new Error(`unexpected tmux command ${cmd}`)
    },
    spawnImpl: async () => ({
      ok: true,
      pending: true,
      localAgentId: 'local:blocked',
      fleetId: 'fleet:blocked',
      tmuxSession: 'fleet-blocked',
      harness: 'codex',
      model: 'gpt-5.5',
      resumeId: null,
      promptDelivery: { ok: false },
    }),
    liveSessionIdentityTimeoutMs: 0,
  })

  try {
    const result = await launcher.handlers.spawn({
      name: 'blocked',
      model: 'gpt',
      cwd,
      requester: { id: 'fleet:requester', name: 'requester' },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'codex-interactive-prompt')
    assert.match(result.error, /Press Enter to continue|Update available/i)
    assert.equal(result.ownership_retained, true)
    assert.equal(sent.some(msg => msg.type === 'spawn-startup-failed' && msg.code === 'codex-interactive-prompt'), true)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function testLifecycleBindingRepollsIncompleteEarlyIdentity() {
  const posted = []
  const ledger = memoryLedger()
  const result = {
    ok: true,
    pending: true,
    fleetId: 'fleet:repoll',
    tmuxSession: 'fleet-repoll',
    harness: 'codex',
    model: 'gpt-5.5',
    identityResolution: {
      identity: { sessionId: null, model: null },
      diagnostics: { failureStage: 'open-writable-rollout' },
    },
  }
  const bound = await bindLifecycleCodexResumeIdentity(result, {
    ledger,
    cwd: '/tmp/repoll',
    name: 'repoll',
    api: async (method, path, payload) => {
      if (method === 'POST') {
        posted.push({ path, payload })
        return { ok: true, bound: true, seat: payload }
      }
      if (method === 'GET') {
        return { seat: posted[0]?.payload || null }
      }
      throw new Error(`unexpected api call ${method} ${path}`)
    },
    requireReadback: true,
    resolveIdentity: async () => ({
      sessionId: '00000000-0000-0000-0000-000000000001',
      jsonlPath: '/tmp/repoll.jsonl',
      model: 'gpt-5.5',
    }),
    timeoutMs: 1,
    intervalMs: 1,
  })
  assert.equal(bound.bound, true)
  assert.equal(result.resumeId, '00000000-0000-0000-0000-000000000001')
  assert.equal(posted.length, 1)
  assert.equal(posted[0].payload.agent_id, 'fleet:repoll')
}

async function testLocalMintPersistsGrantBeforeBinding() {
  const ledger = memoryLedger()
  const result = { fleetId: 'fleet:server-assigned' }
  const grant = {
    spawnPolicy: { policy: 'sandboxed' },
    permissionIntersection: { profiles: ['local', 'project'] },
    permissionSet: { operations: {} },
  }
  assert.equal(await persistAssignedAgentGrant({
    ledger,
    result,
    grant,
    grantedProfile: 'app-dev',
    preallocatedAgentId: undefined,
    params: { spawnMode: 'fresh', explicitPolicy: false },
  }), true)
  assert.deepEqual(ledger.get(result.fleetId), {
    ...grant,
    permissionProfile: 'app-dev',
    source: 'agent-lifecycle-cli',
  })
}

async function testClaudeWakeReusesExistingBinding() {
  let bindCalls = 0
  const result = {
    fleetId: 'fleet:claude-wake',
    resumeId: '6c722cd2-e207-4680-960b-ab40e1a77d0c',
    harness: 'claude',
  }
  const binding = await bindSpawnRuntimeIfNeeded({
    spawnMode: 'respawn',
    result,
    bindLifecycleImpl: async () => { bindCalls += 1; throw new Error('wake must not rotate the current terminal capability') },
  })
  assert.deepEqual(binding, { bound: true, reused: true, existing: true })
  assert.equal(bindCalls, 0)
}

async function testExistingResumeBindingUsesLedgerTerminalCapability() {
  const posted = []
  const ledger = memoryLedger()
  await ledger.set('fleet:existing-resume', {})
  const result = {
    ok: true,
    pending: true,
    fleetId: 'fleet:existing-resume',
    tmuxSession: 'fleet-existing-resume',
    harness: 'codex',
    model: 'gpt-5.5',
    resumeId: '019f8802-99e3-7561-ae4c-7b64efd9f030',
  }
  const bound = await bindLifecycleCodexResumeIdentity(result, {
    ledger,
    cwd: '/tmp/existing-resume',
    name: 'existing-resume',
    api: async (method, path, payload) => {
      if (method === 'POST') {
        posted.push({ path, payload })
        return { ok: true, seat: payload }
      }
      throw new Error(`unexpected api call ${method} ${path}`)
    },
  })
  assert.equal(bound.bound, true)
  assert.equal(posted.length, 1)
  assert.equal(posted[0].payload.agent_id, 'fleet:existing-resume')
  assert.equal(posted[0].payload.terminal_capability, 'termcap:fleet:existing-resume')
}

async function testFreshCodexOpenRolloutAcceptsLaunchMatchedOwnerlessFile() {
  const cwd = mkdtempSync(join(tmpdir(), 'tlda-codex-owned-rollout-'))
  try {
    const launchTs = Date.now()
    const rolloutPath = join(cwd, 'rollout-ownerless.jsonl')
    writeFileSync(rolloutPath, `${JSON.stringify({
      type: 'session_meta',
      payload: {
        cwd,
        timestamp: new Date(launchTs + 1000).toISOString(),
      },
    })}\n`)

    const resolved = await resolveOwnedCodexTranscript({
      runtimePids: [123],
      agent: { id: 'fleet:fresh', friendly_name: 'fresh', cwd },
      launchTs,
      resolveTranscriptImpl: async ({ acceptTranscript }) => acceptTranscript(rolloutPath) ? rolloutPath : null,
    })
    assert.equal(resolved, rolloutPath)

    const conflictingPath = join(cwd, 'rollout-conflict.jsonl')
    writeFileSync(conflictingPath, `${JSON.stringify({
      type: 'session_meta',
      payload: {
        cwd,
        timestamp: new Date(launchTs + 1000).toISOString(),
      },
    })}\nRegistered fleet:aaaaaaaa\n`)
    const rejected = await resolveOwnedCodexTranscript({
      runtimePids: [123],
      agent: { id: 'fleet:fresh', friendly_name: 'fresh', cwd },
      launchTs,
      resolveTranscriptImpl: async ({ acceptTranscript }) => acceptTranscript(conflictingPath) ? conflictingPath : null,
    })
    assert.equal(rejected, null)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function testAgentSeatBindingMirrorsRouteIdentityToRosterFields() {
  const calls = []
  const fleetStore = {
    insertAgentSeat(seat) {
      calls.push({ type: 'insert', seat })
    },
    activateAgentSeat({ agentId, sessionId, machineId, envName, daemonKey, terminalCapability }) {
      calls.push({ type: 'activate', agentId, sessionId, machineId, envName, daemonKey, terminalCapability })
      return {
        agent_id: agentId,
        session_id: sessionId,
        resume_id: sessionId,
        kind: 'codex',
        model: 'gpt-5.5',
        cwd: '/tmp/bound',
        machine_id: machineId,
        env_name: envName,
        daemon_key: daemonKey,
        terminal_capability: terminalCapability,
      }
    },
    mirrorAgentSeatIdentity(update) {
      calls.push({ type: 'mirror', update })
    },
  }

  recordAgentBindingEvent(fleetStore, {
    agent_id: 'fleet:bound',
    session_id: '019f8802-99e3-7561-ae4c-7b64efd9f030',
    kind: 'codex',
    model: 'gpt-5.5',
    cwd: '/tmp/bound',
    machine_id: 'mini',
    env_name: 'default',
    daemon_key: 'mini:default',
    terminal_capability: 'termcap:test',
  })

  const mirror = calls.find(call => call.type === 'mirror')?.update
  assert.equal(mirror.agentId, 'fleet:bound')
  assert.equal(mirror.session_id, '019f8802-99e3-7561-ae4c-7b64efd9f030')
  assert.deepEqual(mirror.session_ids, ['019f8802-99e3-7561-ae4c-7b64efd9f030'])
  assert.equal(mirror.cwd, '/tmp/bound')
  assert.equal(mirror.machine_id, 'mini')
  assert.equal(mirror.env_name, 'default')
  assert.equal(mirror.daemon_key, 'mini:default')
}

testCodexInteractivePromptClassifier()
testCodexLaunchForcesCiEnv()
testFreshClaudeLaunchPinsItsOwnSessionId()
await testClaudeResolverRejectsAnotherSessionsJsonl()
await testFreshCodexPromptFailureFailsLoud()
await testLifecycleBindingRepollsIncompleteEarlyIdentity()
await testLocalMintPersistsGrantBeforeBinding()
await testClaudeWakeReusesExistingBinding()
await testExistingResumeBindingUsesLedgerTerminalCapability()
await testFreshCodexOpenRolloutAcceptsLaunchMatchedOwnerlessFile()
testAgentSeatBindingMirrorsRouteIdentityToRosterFields()
console.log('codex spawn interactive prompt tests passed')
