#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  callerPermission,
  callerSpawnPolicy,
  compilePermissionProfiles,
  emptyPermissionSet,
  intersectPermissionSets,
  isOperator,
  modelCeiling,
  modelSpawnCeiling,
  modelTrustTier,
  normalizePermission,
  normalizeSpawnPolicy,
  projectPermissionToMode,
  permissionSetLte,
  resolveSpawnGrant,
  normalizeRequestedPermissions,
  resolveProjectProfile,
  resolveProjectProfileName,
} from '../server/lib/spawn-policy.mjs'

const CWD = '/Users/skip/work/tlda'

describe('spawn policy', () => {
  it('names a coarse policy with its region derived from the name', () => {
    // The coarse names are a LABEL over a region set, not a rank ladder — the
    // region follows the name via the flat REGION_FOR_PERMISSION dictionary.
    assert.equal(normalizeSpawnPolicy('read').policy, 'cwd')
    assert.equal(normalizeSpawnPolicy('write').policy, 'cwd')
    assert.equal(normalizeSpawnPolicy('tlda-write').policy, 'tlda-projects')
    assert.equal(normalizeSpawnPolicy('full').policy, 'unsandboxed')
  })

  it('rejects machine vocabulary as a typed permission', () => {
    // The user surface accepts only the coarse names; the old machine words are
    // tolerated ONLY as persisted-metadata reads, never as a normalized name.
    for (const name of ['none', 'read', 'write', 'tlda-write', 'full']) {
      assert.equal(normalizePermission(name), name)
    }
  })

  it('repairs stored rungs without inflating the stored operation set', () => {
    assert.equal(callerPermission({ id: 'fleet:a', metadata: { spawnPolicy: { permission: 'read-only', policy: 'cwd' } } }), 'read')
    assert.equal(callerPermission({ id: 'fleet:m', metadata: { spawnPolicy: { permission: 'read-only', policy: 'unsandboxed' } } }), 'read')
    // a fence-off-corrupted write row {workspace-write, unsandboxed}: honor write,
    // repair region to cwd → NOT demoted to read.
    assert.equal(callerPermission({ id: 'fleet:w', metadata: { spawnPolicy: { permission: 'workspace-write', policy: 'unsandboxed' } } }), 'write')
    // legacy tlda scope preserved
    assert.equal(callerPermission({ id: 'fleet:t', metadata: { spawnPolicy: { permission: 'workspace-write', policy: 'tlda-projects' } } }), 'tlda-write')
    // never-assigned agent keeps the historical write default
    assert.equal(callerPermission({ id: 'fleet:n', metadata: {} }), 'write')
    // operator is root
    assert.equal(callerPermission({ id: 'fleet:skip', human: true }), 'full')
  })

  it('migrates legacy net spellings to net-on rungs (net is always on)', () => {
    assert.equal(callerPermission({ id: 'fleet:a', metadata: { spawnPolicy: { permission: 'workspace-write+net', policy: 'cwd' } } }), 'write')
    assert.equal(callerPermission({ id: 'fleet:a', metadata: { spawnPolicy: { permission: 'workspace-write-no-net', policy: 'cwd' } } }), 'write')
  })

  it('defaults non-root model ceilings to net-enabled write', () => {
    assert.equal(modelCeiling({}, { model: 'deepseek/deepseek-v4-pro' }), 'write')
    assert.equal(modelCeiling({}, { model: 'deepseek' }), 'write')
    assert.equal(modelCeiling({}, { kind: 'goose' }), 'write')
    assert.equal(modelCeiling({}, { model: 'opus46' }), 'full')
    assert.equal(modelCeiling({}, { kind: 'codex' }), 'full')
  })

  it('reports the normalized caller policy', () => {
    assert.deepEqual(callerSpawnPolicy({
      id: 'fleet:a',
      metadata: { spawnPolicy: { permission: 'tlda-write', policy: 'tlda-projects' } },
    }), {
      name: 'tlda-write',
      permission: 'tlda-write',
      policy: 'tlda-projects',
      category: 'write-scope',
    })
  })

  it('projects trusted full launches to Claude classifier bypass', () => {
    assert.equal(projectPermissionToMode('read'), 'default')
    assert.equal(projectPermissionToMode('write'), 'default')
    assert.equal(projectPermissionToMode('tlda-write'), 'default')
    assert.equal(projectPermissionToMode('full'), 'bypassPermissions')
    assert.equal(projectPermissionToMode('full', 'auto'), 'auto')
  })

  it('lets a write agent always confer write to a trusted-model child', () => {
    // The thing that hurt Skip: a write-capable agent must be able to hand a
    // child write — never down-clamped to read, never refused. The region
    // intersection of write/cwd ∩ full-model ∩ write-spawner is the cwd tree.
    const r = resolveSpawnGrant({
      requestedPermission: 'write',
      requester: { id: 'fleet:a', spawnPolicy: { permission: 'write', policy: 'cwd' } },
      model: 'opus48',
      cwd: CWD,
    })
    assert.equal(r.grantedPolicy.permission, 'write')
    assert.equal(r.grantedPolicy.policy, 'cwd')
    assert.deepEqual(r.grantedPermissionSet.operations.write.allow.includes(`${CWD}/**`), true)
  })

  it('clamps a request above the spawner authority by region intersection', () => {
    // Request tlda-write (write across ~/work) but the spawner may only confer
    // its own cwd; the intersection is the cwd tree — clamp, never refuse.
    const r = resolveSpawnGrant({
      requestedPermission: 'tlda-write',
      requester: { id: 'fleet:a', spawnPolicy: { permission: 'write', policy: 'cwd' } },
      model: 'opus46',
      cwd: CWD,
    })
    assert.equal(r.grantedPolicy.permission, 'write')
    assert.equal(r.grantedPolicy.policy, 'cwd')
    assert.deepEqual(r.grantedPermissionSet.operations.write.allow, [`${CWD}/**`])
  })

  it('clamps a request above the model ceiling by region intersection', () => {
    // Operator (root) spawning a deepseek asks for full; the deepseek-narrow
    // model ceiling (write/cwd) clamps the child's write region to the cwd tree —
    // "lock down dangerous agents" as a clamp, never a refusal.
    const r = resolveSpawnGrant({
      requestedPermission: 'full',
      requester: { id: 'fleet:skip', human: true },
      model: 'deepseek/deepseek-v4-pro',
      cwd: CWD,
    })
    assert.equal(r.grantedPolicy.permission, 'write')
    assert.equal(r.grantedPolicy.policy, 'cwd')
    assert.equal(r.grantedPermissionSet.operations.write.allow.includes('**'), false)
  })

  it('clamps a configured family ceiling too', () => {
    assert.deepEqual(modelSpawnCeiling({
      spawnPolicy: { familyCeilings: { goose: 'write' } },
    }, { kind: 'goose' }), {
      name: 'write',
      permission: 'write',
      policy: 'cwd',
      category: 'write-scope',
    })
    const r = resolveSpawnGrant({
      requestedPermission: 'tlda-write',
      requester: { id: 'fleet:skip', human: true },
      kind: 'goose',
      config: { spawnPolicy: { familyCeilings: { goose: 'write' } } },
      cwd: CWD,
    })
    assert.equal(r.grantedPolicy.permission, 'write')
    assert.equal(r.grantedPolicy.policy, 'cwd')
  })

  it('keys the trust tier on the model, not the harness', () => {
    assert.equal(modelTrustTier({ model: 'deepseek/deepseek-v4-pro', kind: 'goose' }), 'narrow')
    assert.equal(modelTrustTier({ model: 'minimax/minimax-m3', kind: 'goose' }), 'elevated')
    assert.equal(modelTrustTier({ model: 'opus48', kind: 'goose' }), 'full')
    assert.equal(modelTrustTier({ model: 'gpt-5.5', kind: 'goose' }), 'full')
    assert.equal(modelTrustTier({ model: 'someorg/mystery-7b' }), 'narrow')
    assert.equal(modelTrustTier({ kind: 'codex' }), 'full')
    assert.equal(modelTrustTier({ kind: 'goose' }), 'narrow')
  })

  it('gives minimax a higher ceiling than deepseek, clamps both (never refuses)', () => {
    assert.deepEqual(modelSpawnCeiling({}, { model: 'deepseek/deepseek-v4-pro' }), {
      name: 'write', permission: 'write', policy: 'cwd', category: 'write-scope',
    })
    assert.deepEqual(modelSpawnCeiling({}, { model: 'minimax/minimax-m3' }), {
      name: 'tlda-write', permission: 'tlda-write', policy: 'tlda-projects', category: 'write-scope',
    })
    // A deepseek can't be granted machine-level even by the operator: clamped to
    // write/cwd, never refused.
    const r = resolveSpawnGrant({
      requestedPermission: 'full',
      requester: { id: 'fleet:skip', human: true },
      model: 'deepseek/deepseek-v4-pro',
      cwd: CWD,
    })
    assert.equal(r.grantedPolicy.permission, 'write')
    assert.equal(r.grantedPolicy.policy, 'cwd')
  })

  it('lets the operator raise a model ceiling per-agent via trustOverride', () => {
    assert.equal(modelSpawnCeiling({}, { model: 'minimax/minimax-m3', trustOverride: 'full' }).permission, 'full')
    // Without the override minimax's own ceiling is elevated (tlda-write).
    assert.equal(modelSpawnCeiling({}, { model: 'minimax/minimax-m3' }).permission, 'tlda-write')
    assert.equal(isOperator({ id: 'fleet:skip', human: true }), true)
    assert.equal(isOperator({ id: 'fleet:a', metadata: { spawnPolicy: { permission: 'full' } } }), false)
  })

  it('selects spawn profiles from configuration only', () => {
    assert.equal(resolveProjectProfileName(
      { spawnPolicy: { projectProfiles: { 'host-ops': 'ops' } } }, { doc: 'host-ops' }), 'ops')
    assert.equal(resolveProjectProfileName(
      { spawnPolicy: { projectProfiles: { '/Users/skip/work/custom-work': 'math-projects' } } },
      { cwd: '/Users/skip/work/custom-work' }
    ), 'math-projects')
    // A config defaultProfile of the permission word `full` aliases to the `ops`
    // profile (whole machine, secrets fenced off) — PERMISSION_PROFILE_ALIAS.
    assert.equal(resolveProjectProfileName({ spawnPolicy: { defaultProfile: 'full' } }, {}), 'ops')
    assert.equal(resolveProjectProfileName({}, {}), 'cwd')
    assert.equal(resolveProjectProfileName({}, { project: { profile: 'math' }, cwd: '/Users/skip/work/math' }), 'math')
    assert.deepEqual(resolveProjectProfile(
      { spawnPolicy: { projectProfiles: { mathdoc: 'math-projects' } } },
      { doc: 'mathdoc' },
    ), {
      name: 'math-projects', permission: 'tlda-write', policy: 'tlda-projects', category: 'write-scope',
    })
    assert.deepEqual(resolveProjectProfile(
      { spawnPolicy: { projectProfiles: { opsdoc: 'ops' } } },
      { doc: 'opsdoc' },
    ), {
      name: 'ops', permission: 'full', policy: 'unsandboxed', category: 'write-scope',
    })
  })

  it('caps an inherited profile by the model ceiling — even for Claude', () => {
    const config = { spawnPolicy: { projectProfiles: { mathdoc: 'math-projects' } } }
    const mathProfile = resolveProjectProfile(config, { doc: 'mathdoc' })
    const claudeInMath = resolveSpawnGrant({
      requestedPermission: mathProfile,
      requester: { id: 'fleet:skip', human: true },
      model: 'opus48',
      cwd: CWD,
    })
    assert.equal(claudeInMath.requestedPolicy.policy, 'tlda-projects')
    assert.equal(claudeInMath.requestedPermission, 'tlda-write')
    // A deepseek in the same math project: the profile asks for tlda-write, but
    // its narrow ceiling clamps its write region to the cwd tree — never refused.
    const deepseekInMath = resolveSpawnGrant({
      requestedPermission: mathProfile,
      requester: { id: 'fleet:skip', human: true },
      model: 'deepseek/deepseek-v4-pro',
      cwd: CWD,
    })
    assert.equal(deepseekInMath.grantedPolicy.permission, 'write')
    assert.equal(deepseekInMath.grantedPolicy.policy, 'cwd')
  })

  it('preserves an explicit read request as the requested operation set', () => {
    const result = resolveSpawnGrant({
      requestedPermission: 'read',
      requester: { id: 'fleet:skip', human: true },
      model: 'deepseek/deepseek-v4-pro',
      cwd: CWD,
    })
    assert.equal(result.requestedPermission, 'read')
    assert.equal(result.grantedPolicy.permission, 'read')
    assert.equal(result.grantedPolicy.policy, 'cwd')
    assert.deepEqual(result.grantedPermissionSet.operations.write.allow, [])
  })

  it('daemon grant is the region intersection of requested, spawner row, and model cap', () => {
    const grant = resolveSpawnGrant({
      requestedPermission: 'full',
      callerRung: 'tlda-write',
      model: 'deepseek/deepseek-v4-pro',
      config: {},
      cwd: CWD,
    })
    assert.equal(grant.requestedPermission, 'full')
    assert.equal(grant.callerPermission, 'tlda-write')
    // full ∩ tlda-write-spawner ∩ deepseek-narrow → the cwd tree.
    assert.equal(grant.grantedPolicy.permission, 'write')
    assert.equal(grant.grantedPolicy.policy, 'cwd')
    assert.deepEqual(grant.grantedPermissionSet.operations.write.allow.includes(`${CWD}/**`), true)
    assert.equal(grant.grantedPermissionSet.operations.write.allow.includes('**'), false)
  })

  it('daemon derives the project default as request, not authority', () => {
    const grant = resolveSpawnGrant({
      callerRung: 'full',
      model: 'opus48',
      config: { spawnPolicy: { projectProfiles: { mathdoc: 'math-projects' }, machineGrant: 'tlda-write' } },
      doc: 'mathdoc',
      project: { name: 'mathdoc', sourceDir: '/Users/skip/work/mathdoc' },
      cwd: '/Users/skip/work/mathdoc',
    })
    assert.equal(grant.requestedPermission, 'tlda-write')
    assert.equal(grant.projectPermission, 'tlda-write')
    assert.equal(grant.modelPermission, 'full')
    // The tlda-write project default materializes to the project's own tree
    // (/Users/skip/work/mathdoc/**), so the granted region is that tree and its
    // derived coarse label is write/cwd — the fence uses the region set, not the
    // label. It is a real write scope, never machine-wide.
    assert.deepEqual(grant.grantedPermissionSet.operations.write.allow.includes('/Users/skip/work/mathdoc/**'), true)
    assert.equal(grant.grantedPermissionSet.operations.write.allow.includes('**'), false)
  })

  it('daemon derives the project default from cwd when no doc is supplied', () => {
    const ops = resolveSpawnGrant({
      callerRung: 'full',
      model: 'gpt-5.5',
      kind: 'codex',
      config: { spawnPolicy: { projectProfiles: { '/Users/skip/work/ops': 'ops' }, machineGrant: 'full' } },
      cwd: '/Users/skip/work/ops',
    })
    assert.equal(ops.requestedPermission, 'full')
    assert.deepEqual(ops.grantedPolicy, {
      name: 'full',
      permission: 'full',
      policy: 'unsandboxed',
      category: 'write-scope',
    })
    assert.deepEqual(ops.grantedPermissionSet.operations.write.allow, ['**'])

    const cwdDefault = resolveSpawnGrant({
      callerRung: 'full',
      model: 'gpt-5.5',
      kind: 'codex',
      config: {},
      cwd: '/Users/skip/work/tlda',
    })
    assert.equal(cwdDefault.requestedPermission, 'write')
    assert.equal(cwdDefault.grantedPolicy.permission, 'write')
    assert.equal(cwdDefault.grantedPolicy.policy, 'cwd')
  })

  it('machineGrant/local ACL no longer act as authority clamps', () => {
    const grant = resolveSpawnGrant({
      requestedPermission: 'full',
      requester: { id: 'fleet:skip', human: true },
      model: 'gpt-5.5',
      kind: 'codex',
      config: { spawnPolicy: { machineGrant: 'read', localSpawnAcl: { '*': { '*': 'read' } } } },
      cwd: '/Users/skip/work/tlda',
    })
    assert.equal(grant.grantedPermission, 'full')
  })

  it('none spawners clamp children to none', () => {
    const grant = resolveSpawnGrant({
      requestedPermission: 'write',
      requester: { id: 'fleet:unknown' },
      spawnerPolicy: 'none',
      spawnerPermissionSet: emptyPermissionSet(),
      model: 'gpt-5.5',
      kind: 'codex',
      cwd: '/Users/skip/work/tlda',
    })
    assert.equal(grant.grantedPermission, 'none')
    assert.deepEqual(grant.grantedPermissionSet.operations.write.allow, [])
  })

  it('normalizes requested permission profiles from names, objects, and profile source text', () => {
    // The built-in `app-dev`/`math-project` profile NAMES carry their own
    // coarse projectedPolicy (full / tlda-write).
    assert.equal(normalizeRequestedPermissions('app-dev').permission, 'full')
    assert.equal(normalizeRequestedPermissions({ profile: 'math-project' }).permission, 'tlda-write')
    // A compiled-from-source profile has no builtin projectedPolicy, so its
    // coarse label is DERIVED from its own regions: a /Users/skip/work/tlda/**
    // write scope is not machine-wide, so it derives `write`, not `full`.
    const compiled = normalizeRequestedPermissions({
      source: `profile app-dev:
  read  + /Users/skip/work/tlda/**
  write + /Users/skip/work/tlda/**
`,
    })
    assert.equal(compiled.permission, 'write')
    assert.deepEqual(compiled.permissionSet.operations.write.allow, ['/Users/skip/work/tlda/**'])
    // A machine-wide write source DOES derive full.
    assert.equal(normalizeRequestedPermissions({
      source: `profile wide:
  read  + **
  write + **
`,
    }).permission, 'full')
  })

  it('compiles app-dev permission profiles into explicit operation zones', () => {
    const compiled = compilePermissionProfiles(`profile app-dev:
  read  + /Users/skip/work/tlda/**
  write + /Users/skip/work/tlda/**
  write + /tmp/tlda-*/**
  read  - ~/.ssh/**
  write - ~/.ssh/**
`)
    const profile = compiled.profiles['app-dev']
    assert.equal(profile.type, 'permission-set')
    assert.equal(profile.name, 'app-dev')
    assert.deepEqual(profile.operations.read.allow, ['/Users/skip/work/tlda/**'])
    assert.deepEqual(profile.operations.write.allow, ['/Users/skip/work/tlda/**', '/tmp/tlda-*/**'])
    assert.deepEqual(profile.operations.read.deny, ['~/.ssh/**'])
    assert.deepEqual(profile.operations.write.deny, ['~/.ssh/**'])
    assert.deepEqual(profile.rules.map(({ operation, effect, zone }) => ({ operation, effect, zone })), [
      { operation: 'read', effect: 'allow', zone: '/Users/skip/work/tlda/**' },
      { operation: 'write', effect: 'allow', zone: '/Users/skip/work/tlda/**' },
      { operation: 'write', effect: 'allow', zone: '/tmp/tlda-*/**' },
      { operation: 'read', effect: 'deny', zone: '~/.ssh/**' },
      { operation: 'write', effect: 'deny', zone: '~/.ssh/**' },
    ])
  })

  it('daemon resolver accepts compiled requestedPermissions structures', () => {
    const compiled = compilePermissionProfiles(`profile app-dev:
  read  + /Users/skip/work/tlda/**
  write + /Users/skip/work/tlda/**
  write + /tmp/tlda-*/**
  read  - ~/.ssh/**
  write - ~/.ssh/**
`)
    const requestedPermissions = compiled.profiles['app-dev']
    const grant = resolveSpawnGrant({
      requestedPermissions,
      requester: { id: 'fleet:skip', human: true },
      model: 'gpt-5.5',
      kind: 'codex',
      config: {
        spawnPolicy: {
          machineGrant: 'full',
          projectProfiles: { '/Users/skip/work/tlda': 'app-dev' },
        },
      },
      cwd: '/Users/skip/work/tlda',
    })
    // The compiled profile's write scope is /Users/skip/work/tlda/** + a tmp
    // glob — not machine-wide — so the coarse label derives `write`, while the
    // real fence is the full region set below.
    assert.equal(grant.requestedPermission, 'write')
    assert.equal(grant.grantedPermission, 'write')
    assert.deepEqual(grant.requestedPermissionSet.operations.write.allow, [
      '/Users/skip/work/tlda/**',
      '/tmp/tlda-*/**',
    ])
    assert.deepEqual(grant.requestedPermissionSet.operations.read.deny, ['~/.ssh/**'])
    assert.deepEqual(grant.grantedPermissionSet.operations.write.allow, [
      '/Users/skip/work/tlda/**',
      '/tmp/tlda-*/**',
    ])
    assert.deepEqual(grant.grantedPermissionSet.operations.write.deny, ['/Users/skip/.ssh/**'])
  })

  it('daemon project defaults use named permission profile zones', () => {
    const grant = resolveSpawnGrant({
      requester: { id: 'fleet:skip', human: true },
      model: 'gpt-5.5',
      kind: 'codex',
      config: {
        spawnPolicy: {
          machineGrant: 'full',
          projectProfiles: { '/Users/skip/work/tlda': 'app-dev' },
        },
      },
      cwd: '/Users/skip/work/tlda',
      project: { name: 'tlda', sourceDir: '/Users/skip/work/tlda' },
    })
    assert.equal(grant.projectPolicy.name, 'app-dev')
    assert.deepEqual(grant.requestedPermissionSet.operations.write.allow, [
      'cwd',
      '~/.config/tlda/fleet-daemon.log',
      '~/.config/tlda/fleet-daemon.pid',
      '~/.config/tlda/fleet-daemon.*.lock',
    ])
    assert.deepEqual(grant.grantedPermissionSet.operations.write.allow, [
      '/Users/skip/work/tlda/**',
      '/Users/skip/.config/tlda/fleet-daemon.log',
      '/Users/skip/.config/tlda/fleet-daemon.pid',
      '/Users/skip/.config/tlda/fleet-daemon.*.lock',
    ])
    assert.equal(grant.grantedPermissionSet.operations.write.allow.includes('**'), false)
  })

  it('daemon grant narrows wider requested zones by spawner row', () => {
    const compiled = compilePermissionProfiles(`profile app-dev:
  read  + /Users/skip/work/**
  write + /Users/skip/work/**
  write + /tmp/tlda-*/**
  read  - ~/.ssh/**
  write - ~/.ssh/**
`)
    const grant = resolveSpawnGrant({
      requestedPermissions: compiled.profiles['app-dev'],
      requester: { id: 'fleet:writer', spawnPolicy: { permission: 'write', policy: 'cwd' } },
      model: 'gpt-5.5',
      kind: 'codex',
      config: { spawnPolicy: { machineGrant: 'full' } },
      cwd: '/Users/skip/work/tlda',
    })
    // Requested write scope is /Users/skip/work/** (broad but not machine-wide)
    // ⇒ coarse label `write`; the spawner row narrows the granted region to the
    // cwd tree.
    assert.equal(grant.requestedPermission, 'write')
    assert.equal(grant.grantedPermission, 'write')
    assert.deepEqual(grant.grantedPermissionSet.operations.read.allow, ['/Users/skip/work/tlda/**'])
    assert.deepEqual(grant.grantedPermissionSet.operations.write.allow, ['/Users/skip/work/tlda/**'])
    assert.equal(grant.grantedPermissionSet.operations.write.allow.includes('/tmp/tlda-*/**'), false)
    assert.deepEqual(grant.grantedPermissionSet.operations.read.deny, ['/Users/skip/.ssh/**'])
    assert.deepEqual(grant.grantedPermissionSet.operations.write.deny, ['/Users/skip/.ssh/**'])
  })

  it('permission-set subset follows narrowed allows and accumulated denies', () => {
    const wide = compilePermissionProfiles(`profile wide:
  read  + /Users/skip/work/**
  write + /Users/skip/work/**
  write - ~/.ssh/**
`).profiles.wide
    const narrow = compilePermissionProfiles(`profile narrow:
  read  + /Users/skip/work/tlda/**
  write + /Users/skip/work/tlda/**
  write - ~/.ssh/**
`).profiles.narrow
    const grant = intersectPermissionSets([wide, narrow], { name: 'grant' })
    assert.deepEqual(grant.operations.write.allow, ['/Users/skip/work/tlda/**'])
    assert.deepEqual(grant.operations.write.deny, ['~/.ssh/**'])
    assert.equal(permissionSetLte(grant, wide), true)
    assert.equal(permissionSetLte(wide, grant), false)
  })

  it('daemon full override grants full when request, model, and spawner terms allow it', () => {
    const config = {
      spawnPolicy: {
        machineGrant: 'full',
        projectProfiles: { '/Users/skip/work/tlda': 'app-dev' },
      },
    }
    const grant = resolveSpawnGrant({
      requestedPermission: 'full',
      requester: { id: 'fleet:skip', human: true },
      model: 'gpt-5.5',
      kind: 'codex',
      config,
      cwd: '/Users/skip/work/tlda',
    })
    assert.equal(grant.requestedPermission, 'full')
    assert.equal(grant.spawnerPermission, 'full')
    assert.equal(grant.modelPermission, 'full')
    assert.deepEqual(grant.grantedPolicy, {
      name: 'full',
      permission: 'full',
      policy: 'unsandboxed',
      category: 'write-scope',
    })

    const clampedBySpawner = resolveSpawnGrant({
      requestedPermission: 'full',
      requester: { id: 'fleet:writer', spawnPolicy: { permission: 'write', policy: 'cwd' } },
      model: 'gpt-5.5',
      kind: 'codex',
      config,
      cwd: '/Users/skip/work/tlda',
    })
    assert.equal(clampedBySpawner.spawnerPermission, 'write')
    assert.equal(clampedBySpawner.grantedPermission, 'write')
  })
})
