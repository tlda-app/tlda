import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fenceSettings, wrapSandboxCmd } from '../bin/lib/spawn/fence.mjs'
import { activeConfigName } from '../bin/lib/spawn/identity.mjs'
import { codexSandboxProjection, resolveHarnessLaunchOptions, resolveLaunchPolicy, resolveLeasePolicy } from '../bin/lib/spawn/permissions.mjs'
import * as claude from '../bin/lib/spawn/harness/claude.mjs'
import * as codex from '../bin/lib/spawn/harness/codex.mjs'
import { spawn } from '../bin/lib/spawn/index.mjs'
import { findClaudeSession, findCodexRollout, isRespawnIdentityCaughtUp, scanClaudeSessionIdentity, stripSyntheticTail } from '../bin/lib/spawn/resume.mjs'
import { saveSessionIdentityStore, sessionIdentityPath } from '../bin/lib/session-identity-store.mjs'
import { claudeStartupDialogAction } from '../bin/lib/spawn/tmux.mjs'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-node-step3-'))
}

function privateTmpdir(prefix) {
  const base = fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir()
  return fs.mkdtempSync(path.join(base, prefix))
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function makeGitRepo() {
  const dir = tmpdir()
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'TLDA Test'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-m', 'init'])
  return dir
}

function privilegeSet(name, operations) {
  return {
    type: 'privilege-set',
    name,
    operations: {
      read: { allow: operations.read || [], deny: [] },
      write: { allow: operations.write || [], deny: [] },
      spawn: { allow: operations.spawn || [], deny: [] },
      command: { allow: [], deny: [] },
      network: { allow: [], deny: [] },
    },
  }
}

function cwdPrivilegeSet(cwd, name = 'cwd-grant') {
  return privilegeSet(name, {
    read: [path.join(cwd, '**')],
    write: [path.join(cwd, '**')],
    spawn: ['**'],
  })
}

function fullPrivilegeSet(name = 'full-grant') {
  return privilegeSet(name, {
    read: ['**'],
    write: ['**'],
    spawn: ['**'],
  })
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => `${typeof row === 'string' ? row : JSON.stringify(row)}\n`).join(''))
}

function writeSessionIdentity(configDir, store) {
  saveSessionIdentityStore(sessionIdentityPath(configDir), {
    version: 1,
    sessions: {},
    by_fleet_id: {},
    ingestion: { caught_up: true, active_tails: 0, pending_jobs: 0, updated_at: null },
    ...store,
  })
}

function codexRegisterRows(fleetId, name, callId) {
  return [
    { type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__tlda', name: 'register', call_id: callId, arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: `Registered ${fleetId}. Your name: "${name}"` } },
  ]
}

function codexEventRegisterRow(fleetId, name, callId) {
  return {
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: callId,
      invocation: {
        server: 'tlda',
        tool: 'register',
        arguments: { name },
      },
      result: {
        Ok: {
          content: [
            { type: 'text', text: `Registered ${fleetId}. 1 agent(s) registered.\nIdentity: $FLEET_ID\nYour name: "${name}"` },
          ],
        },
      },
    },
  }
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
    ...codexRegisterRows('fleet:codexaaa', 'codex-a', 'call-old'),
  ])
  writeJsonl(newPath, [
    { type: 'session_meta', payload: { id: newId, cwd: '/tmp/new' } },
    ...codexRegisterRows('fleet:codexaaa', 'codex-a', 'call-new'),
    'test fixture text mentions Registered fleet:otherone but is not MCP register output',
  ])
  fs.utimesSync(oldPath, new Date('2026-06-27T00:00:00Z'), new Date('2026-06-27T00:00:00Z'))
  fs.utimesSync(newPath, new Date('2026-06-28T00:00:00Z'), new Date('2026-06-28T00:00:00Z'))
  const found = findCodexRollout({ id: 'fleet:codexaaa' }, { sessionsBase })
  assert.equal(found.rolloutId, newId)
  assert.equal(found.cwd, '/tmp/new')
})

test('Codex rollout scan recognizes event_msg register tool results', () => {
  const root = tmpdir()
  const sessionsBase = path.join(root, 'codex-sessions')
  const sid = '55555555-5555-4555-8555-555555555555'
  const fpath = path.join(sessionsBase, '2026', '06', '29', `rollout-2026-06-29T00-00-00-${sid}.jsonl`)
  writeJsonl(fpath, [
    { type: 'session_meta', payload: { id: sid, cwd: '/tmp/event-register' } },
    codexEventRegisterRow('fleet:event1', 'event-agent', 'call-event'),
  ])
  const found = findCodexRollout({ id: 'fleet:event1' }, { sessionsBase })
  assert.equal(found.rolloutId, sid)
  assert.equal(found.cwd, '/tmp/event-register')
})

test('Codex respawn lookup can bind an ownerless launch-window rollout by cwd', () => {
  const root = tmpdir()
  const sessionsBase = path.join(root, 'codex-sessions')
  const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const late = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const fpath = path.join(sessionsBase, '2026', '06', '29', `rollout-2026-06-29T12-00-03-${sid}.jsonl`)
  const latePath = path.join(sessionsBase, '2026', '06', '29', `rollout-2026-06-29T12-05-00-${late}.jsonl`)
  writeJsonl(fpath, [
    { type: 'session_meta', payload: { id: sid, timestamp: '2026-06-29T12:00:03.000Z', cwd: '/tmp/codex-cwd' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'boot' } },
  ])
  writeJsonl(latePath, [
    { type: 'session_meta', payload: { id: late, timestamp: '2026-06-29T12:05:00.000Z', cwd: '/tmp/codex-cwd' } },
  ])
  fs.utimesSync(fpath, new Date('2026-06-29T12:00:03Z'), new Date('2026-06-29T12:00:03Z'))
  fs.utimesSync(latePath, new Date('2026-06-29T12:05:00Z'), new Date('2026-06-29T12:05:00Z'))
  const found = findCodexRollout({
    id: 'fleet:ownerless',
    cwd: '/tmp/codex-cwd',
    registered_at: '2026-06-29T12:00:00.000Z',
  }, { sessionsBase })
  assert.equal(found.rolloutId, sid)
  assert.equal(found.cwd, '/tmp/codex-cwd')
})

test('Codex respawn lookup uses stored rollout id without requiring in-rollout MCP registration', () => {
  const root = tmpdir()
  const sessionsBase = path.join(root, 'codex-sessions')
  const sid = '66666666-6666-4666-8666-666666666666'
  const fpath = path.join(sessionsBase, '2026', '06', '29', `rollout-2026-06-29T00-00-00-${sid}.jsonl`)
  writeJsonl(fpath, [
    { type: 'session_meta', payload: { id: sid, cwd: '/tmp/codex-live' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'prior context' } },
  ])
  const found = findCodexRollout(
    { id: 'fleet:stored1', session_id: sid, session_ids: [] },
    { sessionsBase },
  )
  assert.equal(found.rolloutId, sid)
  assert.equal(found.cwd, '/tmp/codex-live')
})

test('Codex respawn lookup rejects a stored rollout with conflicting owner evidence', () => {
  const root = tmpdir()
  const sessionsBase = path.join(root, 'codex-sessions')
  const sid = '77777777-7777-4777-8777-777777777777'
  const fpath = path.join(sessionsBase, '2026', '06', '29', `rollout-2026-06-29T00-00-00-${sid}.jsonl`)
  writeJsonl(fpath, [
    { type: 'session_meta', payload: { id: sid, cwd: '/tmp/wrong-owner' } },
    ...codexRegisterRows('fleet:otherowner', 'not-yours', 'call-other'),
  ])
  const found = findCodexRollout(
    { id: 'fleet:stored2', session_id: sid, session_ids: [] },
    { sessionsBase },
  )
  assert.equal(found, null)
})

test('Codex respawn lookup checks historical stored rollout ids after primary misses', () => {
  const root = tmpdir()
  const sessionsBase = path.join(root, 'codex-sessions')
  const missing = '88888888-8888-4888-8888-888888888888'
  const sid = '99999999-9999-4999-8999-999999999999'
  const fpath = path.join(sessionsBase, '2026', '06', '29', `rollout-2026-06-29T00-00-00-${sid}.jsonl`)
  writeJsonl(fpath, [
    { type: 'session_meta', payload: { id: sid, cwd: '/tmp/historical' } },
  ])
  const found = findCodexRollout(
    { id: 'fleet:stored3', session_id: missing, session_ids: [sid] },
    { sessionsBase },
  )
  assert.equal(found.rolloutId, sid)
  assert.equal(found.cwd, '/tmp/historical')
})

test('respawn lookup uses session-identity store before scanning JSONLs', () => {
  const root = tmpdir()
  const projectsBase = path.join(root, 'claude-projects')
  const configDir = path.join(root, 'config')
  const sid = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
  const jsonl = path.join(projectsBase, '-tmp-owned', `${sid}.jsonl`)
  writeJsonl(jsonl, [
    { cwd: '/tmp/identity-store-cwd' },
    { toolUseResult: [{ text: 'Registered fleet:other. Your name: "wrong"' }] },
  ])
  writeSessionIdentity(configDir, {
    sessions: {
      [sid]: {
        session_id: sid,
        harness_kind: 'claude',
        fleet_id: 'fleet:store-owner',
        friendly_name: 'store-owner',
        cwd: '/tmp/store-cwd',
        jsonl_path: jsonl,
        classified: true,
      },
    },
    ingestion: { caught_up: false, active_tails: 1, pending_jobs: 1, updated_at: '2026-07-04T00:00:00.000Z' },
  })
  const found = findClaudeSession(
    { id: 'fleet:store-owner', session_id: null, session_ids: [] },
    { projectsBase, identityConfigDir: configDir },
  )
  assert.equal(found.sessionId, sid)
  assert.equal(found.cwd, '/tmp/store-cwd')
})

test('respawn lookup blocks broad scan fallback until identity ingestion reaches EOF', () => {
  const root = tmpdir()
  const projectsBase = path.join(root, 'claude-projects')
  const configDir = path.join(root, 'config')
  const sid = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  writeJsonl(path.join(projectsBase, '-tmp-impostor', `${sid}.jsonl`), [
    { cwd: '/tmp/impostor-cwd' },
    { toolUseResult: [{ text: 'Registered fleet:block-owner. Your name: "block-owner"' }] },
  ])
  writeSessionIdentity(configDir, {
    ingestion: { caught_up: false, active_tails: 1, pending_jobs: 0, updated_at: '2026-07-04T00:00:00.000Z' },
  })
  const found = findClaudeSession(
    { id: 'fleet:block-owner', session_id: null, session_ids: [] },
    { projectsBase, identityConfigDir: configDir },
  )
  assert.equal(found, null)
  assert.equal(isRespawnIdentityCaughtUp({ identityConfigDir: configDir }), false)
})

test('explicit session override still works while identity ingestion is pending', () => {
  const root = tmpdir()
  const projectsBase = path.join(root, 'claude-projects')
  const configDir = path.join(root, 'config')
  const sid = 'cccccccc-3333-4333-8333-cccccccccccc'
  fs.mkdirSync('/tmp/explicit-cwd', { recursive: true })
  writeJsonl(path.join(projectsBase, '-tmp-explicit', `${sid}.jsonl`), [
    { cwd: '/tmp/explicit-cwd' },
  ])
  writeSessionIdentity(configDir, {
    ingestion: { caught_up: false, active_tails: 1, pending_jobs: 0, updated_at: '2026-07-04T00:00:00.000Z' },
  })
  const found = findClaudeSession(
    { id: 'fleet:explicit-owner', session_id: null, session_ids: [] },
    { projectsBase, identityConfigDir: configDir, sessionOverride: sid },
  )
  assert.equal(found.sessionId, sid)
  assert.equal(found.cwd, '/tmp/explicit-cwd')
})

test('caught-up identity ingestion preserves broad scan fallback', () => {
  const root = tmpdir()
  const projectsBase = path.join(root, 'claude-projects')
  const configDir = path.join(root, 'config')
  const sid = 'dddddddd-4444-4444-8444-dddddddddddd'
  fs.mkdirSync('/tmp/fallback-cwd', { recursive: true })
  writeJsonl(path.join(projectsBase, '-tmp-fallback', `${sid}.jsonl`), [
    { cwd: '/tmp/fallback-cwd' },
    { toolUseResult: [{ text: 'Registered fleet:fallbackowner. Your name: "fallback-owner"' }] },
  ])
  writeSessionIdentity(configDir, {
    ingestion: { caught_up: true, active_tails: 0, pending_jobs: 0, updated_at: '2026-07-04T00:00:00.000Z' },
  })
  const found = findClaudeSession(
    { id: 'fleet:fallbackowner', session_id: null, session_ids: [] },
    { projectsBase, identityConfigDir: configDir },
  )
  assert.equal(found.sessionId, sid)
  assert.equal(found.cwd, '/tmp/fallback-cwd')
})

test('lease policy and fence wrapper stay outside harness adapters', () => {
  const cwd = tmpdir()
  const { leasePolicy } = resolveLeasePolicy({
    spawnPolicy: { capability: 'write', policy: 'cwd' },
    privilegeSet: cwdPrivilegeSet(cwd),
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: { agentSandbox: { runner: { command: 'fence' } } },
  })
  assert.equal(leasePolicy.policy, 'cwd')
  assert.equal(leasePolicy.network, true)
  assert.equal(leasePolicy.broad_write, false)
  assert.ok(leasePolicy.write_roots.includes(path.join(cwd, '**')))
  const settings = fenceSettings(leasePolicy, { api: 'https://tlda-fly.example.test', dnsAlias: { host: 'tlda-fly.example.test', address: '100.80.1.2' } })
  assert.equal(settings.filesystem.defaultDenyRead, false)
  assert.equal(settings.filesystem.allowWrite.includes('/'), false)
  assert.ok(settings.filesystem.denyWrite.includes('~/.config/tlda/fleet.db*'))
  assert.ok(settings.filesystem.denyWrite.includes('~/.ssh/id_*'))
  assert.equal(settings.filesystem.allowRead.includes(path.join(os.homedir(), 'Library/Keychains')), false)
  assert.ok(settings.filesystem.allowWrite.includes(path.join(cwd, '**')))
  assert.equal(settings.filesystem.allowWrite.includes('/tmp'), true)
  assert.ok(settings.filesystem.allowWrite.includes('/private/var/folders/*/*/T/xcrun_db*'))
  assert.ok(settings.filesystem.allowWrite.includes('/var/folders/*/*/T/xcrun_db*'))
  assert.equal(settings.network.allowLocalOutbound, true)
  const chromeMachServices = [
    'com.google.chrome.for.testing.MachPortRendezvousServer.*',
    'com.google.ChromeForTesting.MachPortRendezvousServer.*',
    'org.chromium.crashpad.child_port_handshake.*',
    'org.chromium.Chromium.MachPortRendezvousServer.*',
  ]
  assert.deepEqual(settings.macos.mach.lookup, chromeMachServices)
  assert.deepEqual(settings.macos.mach.register, chromeMachServices)
  const wrapped = wrapSandboxCmd('echo hi', leasePolicy, { api: 'https://tlda-fly.example.test' })
  assert.equal(wrapped, 'echo hi')
  const enforced = wrapSandboxCmd('echo hi', leasePolicy, { api: 'https://tlda-fly.example.test', enforce: true })
  assert.match(enforced, /(?:^|['"\s/])fence(?:['"\s]|$)/)
  assert.match(enforced, /--settings/)
  assert.match(enforced, /echo hi/)
})

test('default cwd lease writes cwd plus tool-support roots with unrestricted git', () => {
  const cwd = tmpdir()
  const { leasePolicy } = resolveLeasePolicy({
    spawnPolicy: { capability: 'write', policy: 'cwd' },
    privilegeSet: cwdPrivilegeSet(cwd),
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: {
      agentSandbox: {
        runner: { command: 'fence' },
      },
    },
  })
  assert.equal(leasePolicy.policy, 'cwd')
  assert.equal(leasePolicy.machine_write, false)
  assert.equal(leasePolicy.git, 'read')
  assert.ok(leasePolicy.write_roots.includes(path.join(cwd, '**')))
  assert.equal(leasePolicy.write_roots.includes(path.join(os.homedir(), 'work')), false)
  const settings = fenceSettings(leasePolicy, { api: 'https://tlda-fly.example.test' })
  assert.equal(settings.filesystem.allowWrite.includes('/'), false)
  assert.ok(settings.filesystem.allowWrite.includes(path.join(cwd, '**')))
  assert.ok(settings.filesystem.allowWrite.includes(path.join(os.homedir(), 'Library/Caches/ms-playwright')))
  assert.ok(settings.filesystem.denyWrite.includes('~/.config/tlda/fleet.db*'))
  assert.ok(settings.filesystem.denyWrite.includes('~/.ssh/id_*'))
  assert.equal(settings.filesystem.allowWrite.includes(path.join(os.homedir(), 'Library/Keychains')), false)
  assert.deepEqual(settings.command.deny, [])
  assert.equal(settings.command.useDefaults, true)
})

test('none lease and fence settings are truly empty', () => {
  const cwd = tmpdir()
  const { leasePolicy } = resolveLeasePolicy({
    spawnPolicy: { capability: 'none', policy: 'cwd' },
    privilegeSet: privilegeSet('none', {}),
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: { agentSandbox: { runner: { command: 'fence' } } },
  })
  assert.equal(leasePolicy.capability, 'none')
  assert.deepEqual(leasePolicy.read_roots, [])
  assert.deepEqual(leasePolicy.write_roots, [])
  assert.equal(leasePolicy.network, false)

  const settings = fenceSettings(leasePolicy, { api: 'https://tlda-fly.example.test' })
  assert.deepEqual(settings.filesystem.allowRead, [])
  assert.deepEqual(settings.filesystem.allowWrite, [])
  assert.deepEqual(settings.network.allowUnixSockets, [])
  assert.equal(settings.network.allowLocalOutbound, false)
  assert.equal(settings.network.allowLocalBinding, false)
  assert.deepEqual(settings.macos.mach.lookup, [])
  assert.deepEqual(settings.macos.mach.register, [])
})

test('worktree cwd lease includes external gitdir and commondir metadata roots', () => {
  const repo = makeGitRepo()
  const worktreeParent = privateTmpdir('spawn-node-step3-worktree-parent-')
  const worktree = path.join(worktreeParent, 'linked-worktree')
  try {
    git(repo, ['worktree', 'add', '-b', 'linked-test', worktree])
    const dotGitText = fs.readFileSync(path.join(worktree, '.git'), 'utf8')
    const gitDirMatch = dotGitText.match(/^gitdir:\s*(.+)\s*$/m)
    assert.ok(gitDirMatch, 'linked worktree .git file should point at external gitdir')
    const gitDir = path.resolve(worktree, gitDirMatch[1].trim())
    const commonDirText = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()
    const commonDir = path.resolve(gitDir, commonDirText)

    const { leasePolicy } = resolveLeasePolicy({
      spawnPolicy: { capability: 'write', policy: 'cwd' },
      privilegeSet: cwdPrivilegeSet(worktree),
      harness: 'codex',
      model: 'gpt-5.5',
      cwd: worktree,
      config: { agentSandbox: { runner: { command: 'fence' } } },
    })
    for (const root of [gitDir, path.join(gitDir, '**'), commonDir, path.join(commonDir, '**')]) {
      assert.ok(leasePolicy.write_roots.includes(root), `lease should allow git metadata root ${root}`)
    }
    assert.ok(leasePolicy.write_roots.includes(path.join(worktree, '**')))

    const settings = fenceSettings(leasePolicy, { api: 'https://tlda-fly.example.test' })
    for (const root of [gitDir, path.join(gitDir, '**'), commonDir, path.join(commonDir, '**')]) {
      assert.ok(settings.filesystem.allowWrite.includes(root), `fence settings should allow git metadata root ${root}`)
    }
    assert.ok(settings.filesystem.allowWrite.includes(path.join(worktree, '**')))
  } finally {
    fs.rmSync(worktreeParent, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('project root cwd default allows creating and committing in a private tmp worktree', () => {
  const repo = makeGitRepo()
  const worktreeParent = privateTmpdir('spawn-node-step3-project-root-worktree-')
  const worktree = path.join(worktreeParent, 'tmp-worktree')
  try {
    const { leasePolicy } = resolveLeasePolicy({
      spawnPolicy: { capability: 'write', policy: 'cwd' },
      privilegeSet: cwdPrivilegeSet(repo),
      harness: 'codex',
      model: 'gpt-5.5',
      cwd: repo,
      config: { agentSandbox: { runner: { command: 'fence' } } },
    })
    const repoGit = path.join(repo, '.git')
    assert.ok(leasePolicy.write_roots.includes(path.join(repo, '**')))
    assert.ok(leasePolicy.write_roots.includes(repoGit))
    assert.ok(leasePolicy.write_roots.includes(path.join(repoGit, '**')))

    const settings = fenceSettings(leasePolicy, { api: 'https://tlda-fly.example.test' })
    assert.ok(settings.filesystem.allowWrite.includes('/private/tmp'))
    assert.ok(settings.filesystem.allowWrite.includes('/private/tmp/**'))
    assert.ok(settings.filesystem.allowWrite.includes(path.join(repo, '**')))
    assert.ok(settings.filesystem.allowWrite.includes(repoGit))
    assert.ok(settings.filesystem.allowWrite.includes(path.join(repoGit, '**')))

    git(repo, ['worktree', 'add', '-b', 'tmp-worktree-test', worktree])
    fs.writeFileSync(path.join(worktree, 'worktree.txt'), 'worktree change\n')
    git(worktree, ['add', 'worktree.txt'])
    git(worktree, ['commit', '-m', 'worktree change'])
    assert.equal(git(worktree, ['log', '--format=%s', '-1']), 'worktree change')
  } finally {
    fs.rmSync(worktreeParent, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('math lease writes tlda project roots plus shared guidance, not the app repo', () => {
  const mathRoot = tmpdir()
  const cwd = path.join(mathRoot, 'paper')
  fs.mkdirSync(cwd, { recursive: true })
  const { leasePolicy } = resolveLeasePolicy({
    spawnPolicy: { capability: 'tlda-write', policy: 'tlda-projects' },
    privilegeSet: privilegeSet('math-grant', {
      read: [path.join(mathRoot, '**')],
      write: [path.join(mathRoot, '**')],
    }),
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: {
      agentSandbox: {
        runner: { command: 'fence' },
        extraProjectWriteRoots: [mathRoot],
      },
    },
  })
  assert.equal(leasePolicy.policy, 'tlda-projects')
  assert.equal(leasePolicy.machine_write, false)
  assert.ok(leasePolicy.write_roots.includes(path.join(mathRoot, '**')))
  assert.equal(leasePolicy.write_roots.includes(path.join(os.homedir(), 'work', 'dot-claude')), false)
  assert.equal(leasePolicy.write_roots.includes(path.join(os.homedir(), 'work', 'tlda')), false)
})

test('explicit full lease is machine-write with secret/chat denies still active', () => {
  const { leasePolicy } = resolveLeasePolicy({
    spawnPolicy: { capability: 'full', policy: 'unsandboxed' },
    privilegeSet: fullPrivilegeSet(),
    harness: 'codex',
    model: 'gpt-5.5',
    cwd: tmpdir(),
    config: { agentSandbox: { runner: { command: 'fence' } } },
  })
  assert.equal(leasePolicy.policy, 'unsandboxed')
  assert.equal(leasePolicy.machine_write, true)
  assert.equal(leasePolicy.git, 'read')
  const settings = fenceSettings(leasePolicy, { api: 'https://tlda-fly.example.test' })
  assert.ok(settings.filesystem.allowWrite.includes('**'))
  assert.ok(settings.filesystem.denyWrite.includes('~/.config/tlda/fleet.db*'))
  assert.ok(settings.filesystem.denyWrite.includes('~/.ssh/id_*'))
  assert.deepEqual(settings.command.deny, [])
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

test('unfenced codex uses native workspace-write sandbox as harness security', () => {
  const projection = codexSandboxProjection(
    { capability: 'read', policy: 'cwd' },
    tmpdir(),
    { fenced: false },
  )
  assert.equal(projection.sandboxMode, 'workspace-write')
  assert.equal(projection.networkAccess, true)
})

test('unfenced codex no-net keeps network off in native sandbox args', () => {
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
})

test('spawn harness commands preserve explicit TLDA_CONFIG even when TLDA_SERVER pins the sandbox URL', () => {
  const env = {
    TLDA_CONFIG: 'dev-preview/mailbox',
    TLDA_SERVER: 'https://sandbox.example.test:5192',
  }
  assert.equal(activeConfigName({ defaultConfig: 'live' }, env), 'dev-preview/mailbox')

  const claudeCmd = claude.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    name: 'sandbox-agent',
    api: env.TLDA_SERVER,
    includePrompt: false,
    config: { defaultConfig: 'live' },
    env,
  })
  assert.match(claudeCmd, /TLDA_CONFIG='dev-preview\/mailbox'/)
  assert.match(claudeCmd, /TLDA_SERVER='https:\/\/sandbox\.example\.test:5192'/)

  const codexCmd = codex.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    name: 'sandbox-agent',
    api: env.TLDA_SERVER,
    config: { defaultConfig: 'live' },
    env,
  })
  assert.match(codexCmd, /mcp_servers\.tlda\.env\.TLDA_CONFIG=dev-preview\/mailbox/)
  assert.match(codexCmd, /mcp_servers\.tlda\.env\.TLDA_SERVER=https:\/\/sandbox\.example\.test:5192/)
})

test('hand-pinned TLDA_SERVER without explicit TLDA_CONFIG does not forward defaultConfig', () => {
  const env = { TLDA_SERVER: 'https://sandbox.example.test:5192' }
  assert.equal(activeConfigName({ defaultConfig: 'live' }, env), null)

  const cmd = claude.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    name: 'sandbox-agent',
    api: env.TLDA_SERVER,
    includePrompt: false,
    config: { defaultConfig: 'live' },
    env,
  })
  assert.doesNotMatch(cmd, /TLDA_CONFIG=/)
})

test('codex explicit daemon grant is externally fenced even while global fence is off', () => {
  const cwd = tmpdir()
  const policy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'write', policy: 'cwd' },
    privilegeSet: cwdPrivilegeSet(cwd),
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: { spawnPolicy: { fenceEnabled: true }, agentSandbox: { runner: { command: 'fence' } } },
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
  assert.doesNotMatch(wrapped, /(?:^|['\s/])fence'? '?--settings'?/)
  assert.match(wrapped, /--dangerously-bypass-approvals-and-sandbox/)
  assert.doesNotMatch(wrapped, /sandbox_workspace_write\.writable_roots/)
  assert.doesNotMatch(wrapped, /sandbox_workspace_write\.network_access/)
  const enforced = wrapSandboxCmd(cmd, policy.leasePolicy, { api: 'http://127.0.0.1:5176', enforce: true })
  assert.match(enforced, /(?:^|['\s/])fence'? '?--monitor'?/)
  assert.match(enforced, /--settings/)
})

test('codex explicit no-net external fence preserves network-off in the lease', () => {
  const cwd = tmpdir()
  const policy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'write', policy: 'cwd', network: false },
    privilegeSet: cwdPrivilegeSet(cwd),
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: { spawnPolicy: { fenceEnabled: true }, agentSandbox: { runner: { command: 'fence' } } },
    env: {},
  })
  assert.equal(policy.policyName, 'cwd')
  assert.equal(policy.leasePolicy.policy, 'cwd')
  assert.equal(policy.leasePolicy.network, false)
  const settings = fenceSettings(policy.leasePolicy, { api: 'http://127.0.0.1:5176' })
  assert.equal(settings.network.allowLocalOutbound, false)
  assert.equal(settings.network.allowLocalBinding, false)
})

test('claude explicit write uses the app-development outer fence lease', () => {
  const cwd = tmpdir()
  const policy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'write', policy: 'cwd' },
    privilegeSet: cwdPrivilegeSet(cwd),
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd,
    config: { spawnPolicy: { fenceEnabled: true }, agentSandbox: { runner: { command: 'fence' } } },
  })
  assert.equal(policy.fenceGloballyDisabled, true)
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

test('launch policy maps explicit full to a machine-write fence lease', () => {
  const policy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'full', policy: 'unsandboxed' },
    privilegeSet: fullPrivilegeSet(),
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
    config: { spawnPolicy: { fenceEnabled: true }, agentSandbox: { runner: { command: 'fence' } } },
  })
  assert.equal(policy.fenceGloballyDisabled, true)
  assert.equal(policy.policyName, 'unsandboxed')
  assert.equal(policy.leasePolicy.policy, 'unsandboxed')
  assert.equal(policy.leasePolicy.machine_write, true)
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
    privilegeSet: fullPrivilegeSet('env-full-grant'),
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
    env: { TLDA_DISABLE_PERMISSION_CLASSIFIER: '1' },
    config: { spawnPolicy: { fenceEnabled: true }, agentSandbox: { runner: { command: 'fence' } } },
  })
  assert.equal(envPolicy.leasePolicy.policy, 'unsandboxed')
  assert.equal(envPolicy.permissionMode, 'bypassPermissions')

  const configPolicy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'full', policy: 'unsandboxed' },
    privilegeSet: fullPrivilegeSet('config-full-grant'),
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
    config: { spawnPolicy: { fenceEnabled: true }, agentSandbox: { disablePermissionsClassifier: true, runner: { command: 'fence' } } },
    env: {},
  })
  assert.equal(configPolicy.leasePolicy.policy, 'unsandboxed')
  assert.equal(configPolicy.permissionMode, 'bypassPermissions')
})

test('direct requested capability lands in the shared launch-policy helper', () => {
  const policy = resolveLaunchPolicy({
    requestedCapability: 'write',
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
    config: { agentSandbox: { runner: { command: 'fence' } } },
    explicitPolicy: true,
  })
  assert.equal(policy.spawnPolicy.capability, 'write')
  assert.equal(policy.spawnPolicy.policy, 'cwd')
  assert.equal(policy.permissionMode, 'bypassPermissions')
})

test('unfenced launch with harness permissions disabled is refused unless acknowledged', () => {
  assert.throws(
    () => resolveLaunchPolicy({
      spawnPolicy: { capability: 'full', policy: 'unsandboxed' },
      harness: 'claude',
      model: 'claude-opus-4-8',
      cwd: tmpdir(),
      config: { harnessOptions: { claude: { '*': { required: ['--dangerously-load-development-channels server:tlda'], preferences: ['--dangerously-skip-permissions'], controls: true } } } },
      env: {},
    }),
    /are you fucking sure/,
  )

  const acknowledged = resolveLaunchPolicy({
    spawnPolicy: { capability: 'full', policy: 'unsandboxed' },
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
    config: { harnessOptions: { claude: { '*': { required: ['--dangerously-load-development-channels server:tlda'], preferences: ['--dangerously-skip-permissions'], controls: true } } } },
    acknowledgeNoSecurity: true,
    env: {},
  })
  assert.equal(acknowledged.leasePolicy, null)
  assert.equal(acknowledged.launchSecurity.acknowledgedNoSecurity, true)
  assert.equal(acknowledged.launchSecurity.hasHarnessControls, false)
})

test('unfenced claude launch is allowed when harness permissions stay on', () => {
  const policy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'write', policy: 'cwd' },
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd: tmpdir(),
    config: {
      harnessOptions: {
        claude: {
          '*': {
            required: ['--dangerously-load-development-channels server:tlda'],
            preferences: [],
            controls: true,
          },
        },
      },
    },
    env: {},
  })
  assert.equal(policy.leasePolicy, null)
  assert.equal(policy.launchSecurity.hasHarnessControls, true)
  assert.deepEqual(policy.harnessOptions.required, ['--dangerously-load-development-channels server:tlda'])
  assert.deepEqual(policy.harnessOptions.preferences, [])
})

test('fenced claude launch is trusted even when harness permissions are skipped', () => {
  const cwd = tmpdir()
  const policy = resolveLaunchPolicy({
    spawnPolicy: { capability: 'write', policy: 'cwd' },
    privilegeSet: cwdPrivilegeSet(cwd),
    harness: 'claude',
    model: 'claude-opus-4-8',
    cwd,
    config: {
      harnessOptions: {
        claude: {
          '*': {
            required: ['--dangerously-load-development-channels server:tlda'],
            preferences: ['--dangerously-skip-permissions'],
            controls: true,
          },
        },
      },
      spawnPolicy: { fenceEnabled: true },
      agentSandbox: { runner: { command: 'fence' } },
    },
    env: {},
  })
  assert.equal(policy.leasePolicy.policy, 'cwd')
  assert.equal(policy.launchSecurity.hasFence, true)
  assert.equal(policy.launchSecurity.hasHarnessControls, false)
})

test('configured harness flags are injected into launch commands', () => {
  const options = resolveHarnessLaunchOptions({
    harness: 'claude',
    model: 'claude-opus-4-8',
    config: {
      harnessOptions: {
        claude: {
          '*': {
            required: ['--dangerously-load-development-channels server:tlda'],
            preferences: [],
            controls: true,
          },
        },
      },
    },
  })
  const cmd = claude.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    model: 'claude-opus-4-8',
    name: 'flag-order-proof',
    includePrompt: true,
    harnessOptions: options,
    config: {},
  })
  assert.match(cmd, /--dangerously-load-development-channels server:tlda/)
  assert.doesNotMatch(cmd, /--dangerously-skip-permissions/)
  assert.match(cmd, /claude --dangerously-load-development-channels server:tlda --model/)
  assert.match(cmd, /--model 'claude-opus-4-8' 'Call register\(name="flag-order-proof"\)/)
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
    config: {},
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

test('fresh local spawn forwards explicit active config name into launch command', async () => {
  const { calls, deps } = freshSpawnDeps({ ensureServer: async () => true })
  const result = await spawn({
    spawnMode: 'fresh',
    kind: 'claude',
    model: 'opus48',
    name: 'sandbox-config-local',
    cwd: tmpdir(),
    agentId: 'fleet:testcfg',
    config: {
      defaultConfig: 'dev-preview/mailbox',
      configs: {
        'dev-preview/mailbox': {
          database: 'http://127.0.0.1:5176',
          store: 'http://127.0.0.1:5176',
          licenseKey: '',
        },
      },
    },
    activeConfigName: 'dev-preview/mailbox',
    _deps: deps,
  })
  assert.equal(result.ok, true)
  const cmd = calls.find((value) => typeof value === 'string' && value.includes('FLEET_ID='))
  assert.match(cmd, /TLDA_CONFIG='dev-preview\/mailbox'/)
  assert.match(cmd, /TLDA_SERVER='http:\/\/127\.0\.0\.1:5176'/)
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
    config: {},
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
