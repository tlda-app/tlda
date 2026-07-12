import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { fenceSettings } from '../agent-launch/fence.mjs'
import { resolveLeasePolicy } from '../agent-launch/permissions.mjs'
import { buildSeatbeltProfile } from '../bin/fence-seatbelt.mjs'

function permissionSet({ readAllow = ['cwd'], writeAllow = [] } = {}) {
  return {
    type: 'permission-set',
    name: 'cwd',
    operations: {
      read: { allow: readAllow, deny: [] },
      write: { allow: writeAllow, deny: [] },
    },
  }
}

function testEnv(tmp) {
  return {
    CODEX_HOME: path.join(tmp, 'codex-home'),
    CLAUDE_HOME: path.join(tmp, 'claude-home'),
    CLAUDE_CODE_SCRATCHPAD: path.join(tmp, 'claude-501', 'session-uuid', 'scratchpad'),
    TMPDIR: path.join(tmp, 'tmpdir'),
  }
}

function withContents(root) {
  return [root, path.join(root, '**')]
}

function resolveCwdLease({ harness, cwd, env, writeAllow = [] }) {
  return resolveLeasePolicy({
    spawnPolicy: { name: 'cwd', policy: 'cwd' },
    permissionSet: permissionSet({ writeAllow }),
    harness,
    model: harness === 'codex' ? 'gpt-5' : 'sonnet',
    cwd,
    config: {},
    env,
  }).leasePolicy
}

test('codex cwd lease includes harness state dirs even when grant has no repo write', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fence-codex-'))
  try {
    const cwd = path.join(tmp, 'repo')
    fs.mkdirSync(cwd)
    const env = testEnv(tmp)
    const lease = resolveCwdLease({ harness: 'codex', cwd, env })

    assert.ok(lease.explicit_permission_set, 'test exercises explicit cwd grants without broad write fallback')
    assert.equal(lease.policy, 'cwd')
    assert.equal(lease.empty, false)
    assert.equal(lease.write_roots.includes(cwd), false, 'read-only cwd grant must not gain repo write')

    for (const root of [
      ...withContents(env.CODEX_HOME),
      ...withContents(env.CLAUDE_HOME),
      ...withContents(path.dirname(env.CLAUDE_CODE_SCRATCHPAD)),
      ...withContents(env.CLAUDE_CODE_SCRATCHPAD),
      ...withContents(env.TMPDIR),
    ]) {
      assert.ok(lease.write_roots.includes(root), `missing write root ${root}`)
    }

    const settings = fenceSettings(lease, { env })
    const profile = buildSeatbeltProfile(settings)
    assert.ok(profile.includes(`(subpath ${JSON.stringify(env.CODEX_HOME)})`), 'seatbelt profile allows codex home writes')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('lease policy requires daemon-resolved region objects', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fence-policy-map-'))
  try {
    const cwd = path.join(tmp, 'repo')
    fs.mkdirSync(cwd)
    const env = testEnv(tmp)
    assert.throws(
      () => resolveLeasePolicy({
        spawnPolicy: 'full',
        harness: 'codex',
        model: 'gpt-5',
        cwd,
        config: {},
        env,
      }),
      /resolved daemon spawn policy is required/,
    )

    const full = resolveLeasePolicy({
      spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
      harness: 'codex',
      model: 'gpt-5',
      cwd,
      config: {},
      env,
    })
    assert.equal(full.policyName, 'unsandboxed')
    assert.equal(full.leasePolicy, null, 'unsandboxed region does not manufacture a cwd lease')

    assert.throws(
      () => resolveLeasePolicy({
        spawnPolicy: { name: 'app-dev', policy: 'app-dev' },
        harness: 'codex',
        model: 'gpt-5',
        cwd,
        config: {},
        env,
      }),
      /unknown sandbox policy "app-dev"/,
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('malformed explicit permission sets fail visibly instead of becoming no-write leases', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fence-empty-set-'))
  try {
    const cwd = path.join(tmp, 'repo')
    fs.mkdirSync(cwd)
    const env = testEnv(tmp)

    assert.throws(
      () => resolveLeasePolicy({
        spawnPolicy: { name: 'app-dev', policy: 'cwd' },
        permissionSet: { name: 'app-dev', operations: { read: { allow: [], deny: [] }, write: { allow: [], deny: [] } } },
        harness: 'claude',
        model: 'sonnet',
        cwd,
        config: {},
        env,
      }),
      /explicit permissionSet "app-dev" grants no read\/write zones/,
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('app-dev style machine permission set produces non-empty unsandboxed write roots', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fence-app-dev-'))
  try {
    const cwd = path.join(tmp, 'repo')
    fs.mkdirSync(cwd)
    const env = testEnv(tmp)
    const lease = resolveLeasePolicy({
      spawnPolicy: { name: 'app-dev', policy: 'unsandboxed' },
      permissionSet: permissionSet({ readAllow: ['**'], writeAllow: ['**'] }),
      harness: 'codex',
      model: 'gpt-5',
      cwd,
      config: {},
      env,
    }).leasePolicy
    const settings = fenceSettings(lease, { env })

    assert.equal(lease.policy, 'unsandboxed')
    assert.ok(lease.write_roots.includes('**'), 'machine write region survives explicit app-dev grant')
    assert.notEqual(settings.filesystem.allowWrite.length, 0, 'allowWrite must not be empty')
    assert.ok(settings.filesystem.allowWrite.includes('**'))
    assert.ok(settings.filesystem.allowWrite.includes(env.CODEX_HOME))

    const profile = buildSeatbeltProfile(settings)
    assert.doesNotMatch(profile, /\(deny file-write\* \(subpath "\/"\)\)/, 'broad write should not use the scoped-write default deny')
    assert.match(profile, /\\\.ssh\/id_/, 'ssh private-key deny remains present under broad write')
    assert.match(profile, /\\\.config\/tlda\/fleet\\\.db/, 'fleet.db deny remains present under broad write')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('intentional none grants still allow harness state but not repo writes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fence-none-set-'))
  try {
    const cwd = path.join(tmp, 'repo')
    fs.mkdirSync(cwd)
    const env = testEnv(tmp)
    const lease = resolveLeasePolicy({
      spawnPolicy: { name: 'none', policy: 'cwd' },
      permissionSet: {
        type: 'permission-set',
        name: 'none',
        operations: {
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          spawn: { allow: [], deny: [] },
        },
        rules: [],
        projectedPolicy: { name: 'none', permission: 'none', policy: 'cwd' },
        compiledFrom: 'empty-permission-set',
      },
      harness: 'codex',
      model: 'gpt-5',
      cwd,
      config: {},
      env,
    }).leasePolicy
    const settings = fenceSettings(lease, { env })

    assert.equal(lease.empty, true)
    assert.ok(settings.filesystem.allowWrite.includes(env.CODEX_HOME))
    assert.ok(settings.filesystem.allowWrite.includes(path.join(env.CODEX_HOME, '**')))
    assert.ok(settings.filesystem.allowWrite.includes(env.CLAUDE_HOME))
    assert.ok(settings.filesystem.allowWrite.includes(env.TMPDIR))
    assert.equal(settings.filesystem.allowWrite.includes(cwd), false)
    assert.equal(settings.filesystem.allowWrite.includes(path.join(cwd, '**')), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('claude cwd lease can create session state and per-session scratchpad', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fence-claude-'))
  try {
    const cwd = path.join(tmp, 'repo')
    fs.mkdirSync(cwd)
    const env = testEnv(tmp)
    const lease = resolveCwdLease({ harness: 'claude', cwd, env, writeAllow: ['cwd'] })

    assert.ok(lease.write_roots.includes(path.join(cwd, '**')), 'cwd write grant is preserved')
    assert.ok(lease.write_roots.includes(env.CLAUDE_HOME), 'claude home is writable for fleet-identity.sqlite and session-env')
    assert.ok(lease.write_roots.includes(path.join(env.CLAUDE_HOME, '**')))
    assert.ok(lease.write_roots.includes(path.dirname(env.CLAUDE_CODE_SCRATCHPAD)), 'scratchpad mkdir parent is writable')
    assert.ok(lease.write_roots.includes(env.CLAUDE_CODE_SCRATCHPAD), 'scratchpad root is writable')
    assert.ok(lease.write_roots.includes(path.join(env.CLAUDE_CODE_SCRATCHPAD, '**')))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('cwd seatbelt stays scoped and keeps secret/database denies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fence-scope-'))
  try {
    const cwd = path.join(tmp, 'repo')
    fs.mkdirSync(cwd)
    const env = testEnv(tmp)
    const lease = resolveCwdLease({ harness: 'codex', cwd, env, writeAllow: ['cwd'] })
    const settings = fenceSettings(lease, { env })
    const allowWrite = settings.filesystem.allowWrite

    assert.equal(allowWrite.includes('/'), false, 'explicit cwd grant must not become broad machine write')
    assert.equal(allowWrite.includes('/**'), false, 'explicit cwd grant must not become broad machine write')
    assert.equal(allowWrite.includes(path.join(tmp, 'other-repo')), false, 'unrelated repo root is not writable')

    const profile = buildSeatbeltProfile(settings)
    assert.match(profile, /\(deny file-write\* \(subpath "\/"\)\)/, 'profile default-denies writes outside allow roots')
    assert.match(profile, /\\\.ssh\/id_/, 'ssh private-key deny remains present')
    assert.match(profile, /\\\.config\/tlda\/fleet\\\.db/, 'fleet.db deny remains present')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
