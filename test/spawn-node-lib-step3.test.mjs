import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fenceSettings, wrapSandboxCmd } from '../bin/lib/spawn/fence.mjs'
import { codexSandboxProjection, resolveLaunchPolicy, resolveLeasePolicy } from '../bin/lib/spawn/permissions.mjs'
import * as claude from '../bin/lib/spawn/harness/claude.mjs'
import * as codex from '../bin/lib/spawn/harness/codex.mjs'
import { spawn } from '../bin/lib/spawn/index.mjs'
import { findClaudeSession, findCodexRollout, scanClaudeSessionIdentity, stripSyntheticTail } from '../bin/lib/spawn/resume.mjs'
import { claudeStartupDialogAction } from '../bin/lib/spawn/tmux.mjs'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-node-step3-'))
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => `${typeof row === 'string' ? row : JSON.stringify(row)}\n`).join(''))
}

function freshSpawnDeps({ ensureServer }) {
  const calls = []
  return {
    calls,
    deps: {
      resolveApi: () => 'http://127.0.0.1:5176',
      ensureServer,
      uniqueSessionName: async () => 'fleet-breakglass',
      resolveDnsAlias: async () => null,
      checkFreshNameAvailable: async () => { calls.push('checkFreshNameAvailable') },
      wsRegister: async () => { calls.push('wsRegister') },
      spawnTmux: async (_session, _cwd, cmd) => {
        calls.push('spawnTmux')
        calls.push(cmd)
        return true
      },
      waitForAwakeRegistration: async () => {
        calls.push('waitForAwakeRegistration')
        return { ok: true }
      },
      markAgentDead: async () => { calls.push('markAgentDead') },
      createLibrarian: () => ({
        observeLiveness: () => { calls.push('observeLiveness') },
        failPending: () => { calls.push('failPending') },
      }),
    },
  }
}

test('Claude resume scan uses the first own Registered fleet result and strips synthetic tail', () => {
  const root = tmpdir()
  const projectsBase = path.join(root, 'projects')
  const sid = '11111111-1111-4111-8111-111111111111'
  const fpath = path.join(projectsBase, '-tmp-step3', `${sid}.jsonl`)
  writeJsonl(fpath, [
    { type: 'user', message: { content: 'boot' } },
    { toolUseResult: [{ text: 'Registered fleet:aaa11111. Your name: "alpha"' }] },
    { toolUseResult: [{ text: 'Registered fleet:bbb22222. Your name: "child"' }] },
    { type: 'assistant', message: { id: '22222222-2222-4222-8222-222222222222', model: 'claude-<synthetic>' } },
    '',
  ])
  const found = findClaudeSession({ id: 'fleet:aaa11111' }, { projectsBase })
  assert.equal(found.sessionId, sid)
  const stripped = stripSyntheticTail(sid, { projectsBase })
  assert.equal(stripped.stripped, 2)
  assert.match(fs.readFileSync(fpath, 'utf8'), /fleet:bbb22222/)
  assert.doesNotMatch(fs.readFileSync(fpath, 'utf8'), /<synthetic>/)
})

test('Claude session scan prefers JSONL cwd over ambiguous project directory decoding', () => {
  const root = tmpdir()
  const projectsBase = path.join(root, 'projects')
  const cwd = tmpdir()
  const sid = '55555555-5555-4555-8555-555555555555'
  const fpath = path.join(projectsBase, '-Users-skip-work-tlda--worktrees-spawn-node-lib', `${sid}.jsonl`)
  writeJsonl(fpath, [
    { type: 'user', cwd, message: { content: 'boot' } },
    { toolUseResult: [{ text: 'Registered fleet:cwd55555. Your name: "cwd-agent"' }] },
  ])
  const identity = scanClaudeSessionIdentity(sid, { projectsBase })
  assert.equal(identity.cwd, cwd)
  const found = findClaudeSession({ id: 'fleet:cwd55555' }, { projectsBase })
  assert.equal(found.cwd, cwd)
})

test('Claude startup dialog classifier covers unattended resume gates', () => {
  assert.equal(claudeStartupDialogAction('WARNING: Loading development channels\nEnter to confirm'), 'devchannels')
  assert.equal(claudeStartupDialogAction('Resume from summary (recommended)\nEnter to confirm'), 'resume-full')
  assert.equal(claudeStartupDialogAction('Allow external CLAUDE.md file imports?\nEnter to confirm'), 'allow-external-imports')
  assert.equal(claudeStartupDialogAction('normal prompt\n❯'), null)
})

test('Codex rollout scan uses first own registration and newest matching rollout', () => {
  const root = tmpdir()
  const sessionsBase = path.join(root, 'codex-sessions')
  const oldId = '33333333-3333-4333-8333-333333333333'
  const newId = '44444444-4444-4444-8444-444444444444'
  const oldPath = path.join(sessionsBase, '2026', '06', '27', `rollout-2026-06-27T00-00-00-${oldId}.jsonl`)
  const newPath = path.join(sessionsBase, '2026', '06', '28', `rollout-2026-06-28T00-00-00-${newId}.jsonl`)
  writeJsonl(oldPath, [
    { type: 'session_meta', payload: { id: oldId, cwd: '/tmp/old' } },
    'Registered fleet:codexaaa. Your name: "codex-a"',
  ])
  writeJsonl(newPath, [
    { type: 'session_meta', payload: { id: newId, cwd: '/tmp/new' } },
    'Registered fleet:codexaaa. Your name: "codex-a"',
    'Registered fleet:otherone. Your name: "child"',
  ])
  fs.utimesSync(oldPath, new Date('2026-06-27T00:00:00Z'), new Date('2026-06-27T00:00:00Z'))
  fs.utimesSync(newPath, new Date('2026-06-28T00:00:00Z'), new Date('2026-06-28T00:00:00Z'))
  const found = findCodexRollout({ id: 'fleet:codexaaa' }, { sessionsBase })
  assert.equal(found.rolloutId, newId)
  assert.equal(found.cwd, '/tmp/new')
})

test('lease policy and fence wrapper stay outside harness adapters', () => {
  const cwd = tmpdir()
  const { leasePolicy } = resolveLeasePolicy({
    spawnPolicy: { capability: 'write', policy: 'cwd' },
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: { agentSandbox: { runner: { command: 'fence' } } },
  })
  assert.equal(leasePolicy.policy, 'cwd')
  assert.equal(leasePolicy.network, true)
  assert.ok(leasePolicy.write_roots.includes(path.join(cwd, '.git')))
  const settings = fenceSettings(leasePolicy, { api: 'https://tlda-fly.example.test', dnsAlias: { host: 'tlda-fly.example.test', address: '100.80.1.2' } })
  assert.equal(settings.filesystem.defaultDenyRead, true)
  assert.ok(settings.filesystem.allowWrite.some((p) => p.endsWith('/.git')))
  assert.equal(settings.filesystem.allowWrite.includes('/tmp'), false)
  assert.equal(settings.network.allowLocalOutbound, true)
  const wrapped = wrapSandboxCmd('echo hi', leasePolicy, { api: 'https://tlda-fly.example.test' })
  assert.match(wrapped, /TLDA_SANDBOX_LEASE=/)
  assert.match(wrapped, /'?fence'? '?--settings'?/)
})

test('fenced codex uses Codex danger-full-access under the outer fence', () => {
  const projection = codexSandboxProjection(
    { capability: 'write', policy: 'cwd' },
    tmpdir(),
    { fenced: true },
  )
  assert.equal(projection.sandboxMode, 'danger-full-access')
  assert.deepEqual(projection.workspaceWriteConfigArgs, [])
})

test('unfenced codex no-net projects explicit workspace-write network false', () => {
  const projection = codexSandboxProjection(
    { capability: 'write', policy: 'cwd', network: false },
    tmpdir(),
    { fenced: false },
  )
  assert.equal(projection.sandboxMode, 'workspace-write')
  assert.equal(projection.networkAccess, false)
  const args = codex.buildWorkspaceWriteConfigArgs({
    writableRoots: projection.writableRoots,
    networkAccess: projection.networkAccess,
  })
  assert.ok(args.some((arg) => arg.includes('sandbox_workspace_write.network_access=false')))
  assert.equal(args.some((arg) => arg.includes('sandbox_workspace_write.network_access=true')), false)
})

test('codex default launch is externally fenced even while global fence is off', () => {
  const cwd = tmpdir()
  const policy = resolveLaunchPolicy({
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    env: {},
  })
  assert.equal(policy.fenceGloballyDisabled, true)
  assert.equal(policy.spawnPolicy.capability, 'write')
  assert.equal(policy.spawnPolicy.policy, 'cwd')
  assert.equal(policy.policyName, 'cwd')
  assert.equal(policy.leasePolicy.policy, 'cwd')
  assert.equal(policy.permissionMode, 'bypassPermissions')
  const projection = codexSandboxProjection(policy.spawnPolicy, cwd, { fenced: !!policy.leasePolicy })
  const cmd = codex.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    model: 'gpt-5.5',
    name: 'codex-fenced',
    cwd,
    api: 'http://127.0.0.1:5176',
    sandboxMode: projection.sandboxMode,
    workspaceWriteConfigArgs: projection.sandboxMode === 'workspace-write'
      ? codex.buildWorkspaceWriteConfigArgs({
          writableRoots: projection.writableRoots || [],
          networkAccess: projection.networkAccess !== false,
        })
      : [],
    config: {},
    env: {},
  })
  const wrapped = wrapSandboxCmd(cmd, policy.leasePolicy, { api: 'http://127.0.0.1:5176' })
  assert.match(wrapped, /(?:^|['\s/])fence'? '?--settings'?/)
  assert.match(wrapped, /-s.*danger-full-access/)
  assert.doesNotMatch(wrapped, /sandbox_workspace_write\.writable_roots/)
  assert.doesNotMatch(wrapped, /sandbox_workspace_write\.network_access/)
})

test('codex no-net external fence preserves network-off in the lease', () => {
  const cwd = tmpdir()
  const policy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'write', policy: 'cwd', network: false },
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    env: {},
  })
  assert.equal(policy.policyName, 'cwd')
  assert.equal(policy.leasePolicy.policy, 'cwd')
  assert.equal(policy.leasePolicy.network, false)
  const settings = fenceSettings(policy.leasePolicy, { api: 'http://127.0.0.1:5176' })
  assert.notDeepEqual(settings.network.allowedDomains, ['*'])
})

test('claude built-in write stays on the global-off classifier path', () => {
  const policy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'write', policy: 'cwd' },
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
  })
  assert.equal(policy.fenceGloballyDisabled, true)
  assert.equal(policy.policyName, 'unsandboxed')
  assert.equal(policy.leasePolicy, null)
  assert.equal(policy.permissionMode, 'default')
  const cmd = claude.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    model: 'claude-opus-4-8',
    mode: policy.permissionMode,
    includePrompt: false,
    config: {},
  })
  assert.doesNotMatch(cmd, /--dangerously-skip-permissions/)
  assert.match(cmd, /--permission-mode 'default'/)
})

test('launch policy maps built-in full to Claude permission bypass', () => {
  const policy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'full', policy: 'unsandboxed' },
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
  })
  assert.equal(policy.fenceGloballyDisabled, true)
  assert.equal(policy.policyName, 'unsandboxed')
  assert.equal(policy.leasePolicy, null)
  assert.equal(policy.permissionMode, 'bypassPermissions')
  const cmd = claude.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    model: 'claude-opus-4-8',
    mode: policy.permissionMode,
    includePrompt: false,
    config: {},
  })
  assert.match(cmd, /--dangerously-skip-permissions/)
  assert.doesNotMatch(cmd, /--permission-mode/)
})

test('explicit fenced claude launch bypasses the native permission classifier', () => {
  const policy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'write', policy: 'cwd' },
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
    explicitPolicy: true,
  })
  assert.equal(policy.policyName, 'cwd')
  assert.equal(policy.leasePolicy.policy, 'cwd')
  assert.equal(policy.permissionMode, 'bypassPermissions')
  const cmd = claude.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    model: 'claude-opus-4-8',
    mode: policy.permissionMode,
    includePrompt: false,
    config: {},
  })
  assert.match(cmd, /--dangerously-skip-permissions/)
  assert.doesNotMatch(cmd, /--permission-mode/)
})

test('permission-classifier off-switch forces claude bypass at spawn time', () => {
  const envPolicy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'full', policy: 'unsandboxed' },
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
    env: { TLDA_DISABLE_PERMISSION_CLASSIFIER: '1' },
  })
  assert.equal(envPolicy.leasePolicy, null)
  assert.equal(envPolicy.permissionMode, 'bypassPermissions')

  const configPolicy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'full', policy: 'unsandboxed' },
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
    config: { agentSandbox: { disablePermissionsClassifier: true } },
    env: {},
  })
  assert.equal(configPolicy.leasePolicy, null)
  assert.equal(configPolicy.permissionMode, 'bypassPermissions')
})

test('direct requested capability lands in the shared launch-policy helper', () => {
  const policy = resolveLaunchPolicy({
    requestedCapability: 'write',
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
  })
  assert.equal(policy.spawnPolicy.capability, 'write')
  assert.equal(policy.spawnPolicy.policy, 'cwd')
  assert.equal(policy.permissionMode, 'default')
})

test('fresh local spawn defers registration when localhost server probe fails', async () => {
  const { calls, deps } = freshSpawnDeps({
    ensureServer: async () => { throw new Error('server unreachable at http://127.0.0.1:5176') },
  })
  const result = await spawn({
    spawnMode: 'fresh',
    kind: 'claude',
    model: 'opus48',
    name: 'breakglass-local',
    cwd: tmpdir(),
    agentId: 'fleet:testoff',
    _deps: deps,
  })
  assert.equal(result.ok, true)
  assert.equal(result.registrationDeferred, true)
  assert.equal(result.fleetId, 'fleet:testoff')
  assert.equal(result.tmuxSession, 'fleet-breakglass')
  assert.ok(calls.includes('spawnTmux'))
  assert.ok(calls.some((value) => typeof value === 'string' && value.includes('FLEET_ID=') && value.includes('fleet:testoff')))
  assert.equal(calls.includes('checkFreshNameAvailable'), false)
  assert.equal(calls.includes('wsRegister'), false)
  assert.equal(calls.includes('observeLiveness'), false)
  assert.equal(calls.includes('waitForAwakeRegistration'), false)
  assert.equal(calls.includes('markAgentDead'), false)
})

test('fresh local spawn keeps server-up pre-register and registration wait semantics', async () => {
  const { calls, deps } = freshSpawnDeps({ ensureServer: async () => true })
  const result = await spawn({
    spawnMode: 'fresh',
    kind: 'claude',
    model: 'opus48',
    name: 'server-up-local',
    cwd: tmpdir(),
    agentId: 'fleet:teston',
    _deps: deps,
  })
  assert.equal(result.ok, true)
  assert.equal(result.registrationDeferred, undefined)
  assert.deepEqual(calls.filter((value) => [
    'checkFreshNameAvailable',
    'wsRegister',
    'observeLiveness',
    'spawnTmux',
    'waitForAwakeRegistration',
  ].includes(value)), [
    'checkFreshNameAvailable',
    'wsRegister',
    'observeLiveness',
    'spawnTmux',
    'waitForAwakeRegistration',
  ])
  assert.equal(calls.includes('markAgentDead'), false)
})
