import assert from 'node:assert/strict'
import test from 'node:test'
import { fenceSettings } from '../bin/lib/spawn/fence.mjs'
import { resolveLaunchPolicy } from '../bin/lib/spawn/permissions.mjs'
import { normalizeRequestedPermissions } from '../server/lib/spawn-policy.mjs'

test('explicit permission zones force a fenced launch even when projected policy is full', () => {
  const cwd = '/Users/skip/work/tlda'
  const permissionSet = {
    type: 'permission-set',
    name: 'app-dev',
    operations: {
      read: { allow: ['/Users/skip/work/tlda/**'], deny: ['~/.ssh/id_*'] },
      write: { allow: ['/Users/skip/work/tlda/**', '/tmp/tlda-*/**'], deny: ['~/.ssh/id_*'] },
    },
    rules: [],
  }
  const policy = resolveLaunchPolicy({
    spawnPolicy: { name: 'full', permission: 'full', policy: 'unsandboxed' },
    permissionSet,
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: { spawnPolicy: { fenceEnabled: true }, agentSandbox: { runner: { command: 'fence' } } },
  })
  assert.equal(policy.policyName, 'unsandboxed')
  assert.ok(policy.leasePolicy)
  assert.equal(policy.leasePolicy.explicit_permission_set, true)
  assert.deepEqual(policy.leasePolicy.permission_set, permissionSet)
  assert.ok(policy.leasePolicy.write_roots.includes('/Users/skip/work/tlda/**'))
  assert.ok(policy.leasePolicy.write_roots.includes('/tmp/tlda-*/**'))
  assert.deepEqual(policy.leasePolicy.deny_write_roots, ['/Users/skip/.ssh/id_*'])
  const settings = fenceSettings(policy.leasePolicy, { api: 'https://tlda-fly.example.test' })
  assert.equal(settings.filesystem.allowWrite.includes('/'), false)
  assert.ok(settings.filesystem.allowWrite.includes('/Users/skip/work/tlda/**'))
  assert.ok(settings.filesystem.allowWrite.includes('/tmp/tlda-*/**'))
  assert.ok(settings.filesystem.allowWrite.includes('/Users/skip/Library/Caches/ms-playwright'))
  assert.equal(settings.filesystem.denyRead.includes('~/.aws/**'), false)
  assert.equal(settings.filesystem.denyRead.includes('~/.config/gcloud/**'), false)
  assert.equal(settings.filesystem.denyWrite.includes('~/.aws/**'), false)
  assert.equal(settings.filesystem.denyWrite.includes('~/.config/gcloud/**'), false)
  assert.ok(settings.filesystem.denyRead.includes('~/.aws/credentials'))
  assert.ok(settings.filesystem.denyRead.includes('~/.config/gcloud/application_default_credentials.json'))
  assert.ok(settings.filesystem.denyRead.includes('~/.ssh/id_*'))
  assert.ok(settings.filesystem.denyWrite.includes('~/.ssh/id_*'))
  assert.ok(settings.filesystem.denyRead.includes('/Users/skip/.ssh/id_*'))
  assert.ok(settings.filesystem.denyWrite.includes('/Users/skip/.ssh/id_*'))
  assert.ok(settings.filesystem.denyRead.includes('**/.env'))
  assert.ok(settings.filesystem.denyRead.includes('**/.env.local'))
  assert.equal(settings.filesystem.denyRead.includes('**/.env.*'), false)
  assert.equal(settings.filesystem.denyRead.includes('**/.env.example'), false)
  assert.ok(settings.filesystem.denyRead.includes('**/*.pem'))
  assert.ok(settings.filesystem.denyWrite.includes('**/.env'))
  assert.ok(settings.filesystem.denyWrite.includes('**/.env.local'))
  assert.equal(settings.filesystem.denyWrite.includes('**/.env.*'), false)
  assert.equal(settings.filesystem.denyWrite.includes('**/.env.example'), false)
  assert.ok(settings.filesystem.denyWrite.includes('**/*.pem'))
})

test('named app-dev permissions compile to explicit cwd rules instead of broad full access', () => {
  const cwd = '/Users/skip/work/tlda'
  const request = normalizeRequestedPermissions('app-dev')
  assert.equal(request.name, 'app-dev')
  assert.equal(request.permission, 'full')
  assert.equal(request.policy, 'unsandboxed')
  assert.equal(request.permissionSet.name, 'app-dev')
  assert.deepEqual(request.permissionSet.operations.read.allow, [
    'cwd',
    '~/.config/tlda/fleet-daemon.log',
    '~/.config/tlda/fleet-daemon.pid',
    '~/.config/tlda/fleet-daemon.*.lock',
  ])
  assert.deepEqual(request.permissionSet.operations.write.allow, [
    'cwd',
    '~/.config/tlda/fleet-daemon.log',
    '~/.config/tlda/fleet-daemon.pid',
    '~/.config/tlda/fleet-daemon.*.lock',
  ])
  const policy = resolveLaunchPolicy({
    spawnPolicy: request,
    permissionSet: request.permissionSet,
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: {
      spawnPolicy: { fenceEnabled: true },
      agentSandbox: {
        runner: { command: 'fence' },
        policyOptions: { unsandboxed: { network: true, git: 'write' } },
      },
    },
  })
  const settings = fenceSettings(policy.leasePolicy, { api: 'https://tlda-fly.example.test' })
  assert.ok(settings.filesystem.allowWrite.includes('/Users/skip/work/tlda/**'))
  assert.ok(settings.filesystem.allowWrite.includes('/Users/skip/.config/tlda/fleet-daemon.log'))
  assert.ok(settings.filesystem.allowWrite.includes('/Users/skip/.config/tlda/fleet-daemon.pid'))
  assert.ok(settings.filesystem.allowWrite.includes('/Users/skip/.config/tlda/fleet-daemon.*.lock'))
  assert.equal(settings.filesystem.allowWrite.includes('/Users/skip/.config/tlda'), false)
  assert.equal(settings.filesystem.allowWrite.includes('/Users/skip/.config/tlda/**'), false)
  assert.equal(settings.filesystem.allowWrite.includes('/'), false)
})

test('named deploy permissions allow Fly state without broad machine writes', () => {
  const cwd = '/Users/skip/work/tlda'
  const request = normalizeRequestedPermissions('deploy')
  assert.equal(request.name, 'deploy')
  assert.equal(request.permission, 'write')
  assert.equal(request.policy, 'cwd')
  assert.equal(request.permissionSet.name, 'deploy')
  assert.ok(request.permissionSet.operations.read.allow.includes('~/.fly/**'))
  assert.ok(request.permissionSet.operations.write.allow.includes('~/.fly/**'))
  const policy = resolveLaunchPolicy({
    spawnPolicy: request,
    permissionSet: request.permissionSet,
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: {
      spawnPolicy: { fenceEnabled: true },
      agentSandbox: {
        runner: { command: 'fence' },
        policyOptions: { cwd: { network: true, git: 'write' } },
      },
    },
  })
  const settings = fenceSettings(policy.leasePolicy, { api: 'https://tlda-fly.example.test' })
  assert.ok(settings.filesystem.allowRead.includes('/Users/skip/.fly/**'))
  assert.ok(settings.filesystem.allowWrite.includes('/Users/skip/.fly/**'))
  assert.equal(settings.filesystem.allowWrite.includes('/'), false)
  assert.ok(settings.filesystem.denyWrite.includes('~/.config/tlda/fleet.db*'))
  assert.ok(settings.filesystem.denyRead.includes('~/.ssh/id_*'))
})

test('symbolic cwd permission zones resolve to the workspace root for fence settings', () => {
  const cwd = '/Users/skip/work/tlda'
  const permissionSet = {
    type: 'permission-set',
    name: 'write',
    operations: {
      read: { allow: ['cwd'], deny: [] },
      write: { allow: ['cwd'], deny: [] },
    },
    rules: [],
  }
  const policy = resolveLaunchPolicy({
    spawnPolicy: { name: 'write', permission: 'write', policy: 'cwd' },
    permissionSet,
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: { spawnPolicy: { fenceEnabled: true }, agentSandbox: { runner: { command: 'fence' } } },
  })
  assert.equal(policy.leasePolicy.explicit_permission_set, true)
  assert.ok(policy.leasePolicy.read_roots.includes('/Users/skip/work/tlda/**'))
  assert.ok(policy.leasePolicy.write_roots.includes('/Users/skip/work/tlda/**'))
  assert.equal(policy.leasePolicy.write_roots.includes('/Users/skip/work/tlda/cwd'), false)
  const settings = fenceSettings(policy.leasePolicy, { api: 'https://tlda-fly.example.test' })
  assert.ok(settings.filesystem.allowWrite.includes('/Users/skip/work/tlda/**'))
  assert.equal(settings.filesystem.allowWrite.includes('/Users/skip/work/tlda/cwd'), false)
})

test('explicit cwd policy honors config git write and does not deny git refs', () => {
  const cwd = '/Users/skip/work/tlda'
  const permissionSet = {
    type: 'permission-set',
    name: 'cwd',
    operations: {
      read: { allow: ['cwd'], deny: [] },
      write: { allow: ['cwd'], deny: [] },
    },
    rules: [],
  }
  const policy = resolveLaunchPolicy({
    spawnPolicy: { name: 'write', permission: 'write', policy: 'cwd' },
    permissionSet,
    explicitPolicy: true,
    harness: 'codex',
    model: 'gpt-5.5',
    cwd,
    config: {
      agentSandbox: {
        runner: { command: 'fence' },
        policyOptions: {
          cwd: { network: true, git: 'write' },
        },
      },
    },
  })
  assert.equal(policy.leasePolicy.git, 'write')
  const settings = fenceSettings(policy.leasePolicy, { api: 'https://tlda-fly.example.test' })
  assert.ok(settings.filesystem.allowWrite.includes('/Users/skip/work/tlda/**'))
  assert.equal(settings.filesystem.denyWrite.includes('**/.git/**'), false)
  assert.equal(settings.filesystem.denyWrite.includes('**/.git'), false)
  assert.equal(settings.filesystem.denyWrite.includes('**/.git/worktrees/**'), false)
  assert.ok(settings.filesystem.denyWrite.includes('~/.git-credentials'))
})
