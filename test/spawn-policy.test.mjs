#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITIES,
  CAPABILITY_REGION,
  authorizeSpawn,
  capabilityLte,
  callerCapability,
  callerSpawnPolicy,
  compilePrivilegeProfiles,
  emptyPrivilegeSet,
  intersectPrivilegeSets,
  isOperator,
  meetSpawnPolicies,
  modelCeiling,
  modelSpawnCeiling,
  modelTrustTier,
  normalizeCapability,
  normalizeSpawnPolicy,
  projectCapabilityToMode,
  privilegeSetLte,
  resolveSpawnGrant,
  normalizeRequestedPrivileges,
  resolveProjectProfile,
  resolveProjectProfileName,
  spawnPolicyLte,
} from '../server/lib/spawn-policy.mjs'

describe('spawn policy', () => {
  it('is one axis of named rungs, region derived from the rung', () => {
    assert.deepEqual(CAPABILITIES, ['none', 'read', 'write', 'tlda-write', 'full'])
    assert.equal(capabilityLte('none', 'read'), true)
    assert.equal(capabilityLte('read', 'write'), true)
    assert.equal(capabilityLte('write', 'tlda-write'), true)
    assert.equal(capabilityLte('tlda-write', 'full'), true)
    assert.equal(capabilityLte('full', 'read'), false)
    // region follows the name — no second axis to type
    assert.equal(normalizeSpawnPolicy('read').policy, 'cwd')
    assert.equal(normalizeSpawnPolicy('write').policy, 'cwd')
    assert.equal(normalizeSpawnPolicy('tlda-write').policy, 'tlda-projects')
    assert.equal(normalizeSpawnPolicy('full').policy, 'unsandboxed')
    assert.deepEqual(CAPABILITY_REGION, { none: 'cwd', read: 'cwd', write: 'cwd', 'tlda-write': 'tlda-projects', full: 'unsandboxed' })
  })

  it('rejects machine vocabulary as a typed capability', () => {
    // The user surface accepts only the named rungs; the old machine words are
    // tolerated ONLY as persisted-metadata reads, never as a normalized rung name.
    for (const name of ['none', 'read', 'write', 'tlda-write', 'full']) {
      assert.equal(normalizeCapability(name), name)
    }
  })

  it('repairs stored rungs without inflating the stored operation set', () => {
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'read-only', policy: 'cwd' } } }), 'read')
    assert.equal(callerCapability({ id: 'fleet:m', metadata: { spawnPolicy: { capability: 'read-only', policy: 'unsandboxed' } } }), 'read')
    // a fence-off-corrupted write row {workspace-write, unsandboxed}: honor write,
    // repair region to cwd → NOT demoted to read.
    assert.equal(callerCapability({ id: 'fleet:w', metadata: { spawnPolicy: { capability: 'workspace-write', policy: 'unsandboxed' } } }), 'write')
    // legacy tlda scope preserved
    assert.equal(callerCapability({ id: 'fleet:t', metadata: { spawnPolicy: { capability: 'workspace-write', policy: 'tlda-projects' } } }), 'tlda-write')
    // never-assigned agent keeps the historical write default
    assert.equal(callerCapability({ id: 'fleet:n', metadata: {} }), 'write')
    // operator is root
    assert.equal(callerCapability({ id: 'fleet:skip', human: true }), 'full')
  })

  it('migrates legacy net spellings to net-on rungs (net is always on)', () => {
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'workspace-write+net', policy: 'cwd' } } }), 'write')
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'workspace-write-no-net', policy: 'cwd' } } }), 'write')
  })

  it('defaults non-root model ceilings to net-enabled write', () => {
    assert.equal(modelCeiling({}, { model: 'deepseek/deepseek-v4-pro' }), 'write')
    assert.equal(modelCeiling({}, { model: 'deepseek' }), 'write')
    assert.equal(modelCeiling({}, { kind: 'goose' }), 'write')
    assert.equal(modelCeiling({}, { model: 'opus46' }), 'full')
    assert.equal(modelCeiling({}, { kind: 'codex' }), 'full')
  })

  it('orders the rungs and reports the normalized caller policy', () => {
    assert.equal(spawnPolicyLte('write', 'tlda-write'), true)
    assert.equal(spawnPolicyLte('tlda-write', 'write'), false)
    assert.deepEqual(callerSpawnPolicy({
      id: 'fleet:a',
      metadata: { spawnPolicy: { capability: 'tlda-write', policy: 'tlda-projects' } },
    }), {
      name: 'tlda-write',
      capability: 'tlda-write',
      policy: 'tlda-projects',
      category: 'write-scope',
    })
  })

  it('projects trusted full launches to Claude classifier bypass', () => {
    assert.equal(projectCapabilityToMode('read'), 'default')
    assert.equal(projectCapabilityToMode('write'), 'default')
    assert.equal(projectCapabilityToMode('tlda-write'), 'default')
    assert.equal(projectCapabilityToMode('full'), 'bypassPermissions')
    assert.equal(projectCapabilityToMode('full', 'auto'), 'auto')
  })

  it('lets a write agent always confer write to a trusted-model child', () => {
    // The thing that hurt Skip: a write-capable agent must be able to hand a
    // child write — never down-clamped to read, never refused.
    const r = authorizeSpawn({
      caller: { id: 'fleet:a', metadata: { spawnPolicy: { capability: 'write', policy: 'cwd' } } },
      requestedCapability: 'write',
      model: 'opus48',
    })
    assert.equal(r.grantedPolicy.capability, 'write')
    assert.equal(r.grantedPolicy.policy, 'cwd')
    assert.equal(r.grantedPolicy.name, 'write')
  })

  it('clamps requests above caller capability instead of refusing', () => {
    const r = authorizeSpawn({
      caller: { id: 'fleet:a', metadata: { spawnPolicy: { capability: 'write', policy: 'cwd' } } },
      requestedCapability: 'tlda-write',
      model: 'opus46',
    })
    assert.equal(r.grantedPolicy.capability, 'write')
    assert.equal(r.grantedPolicy.policy, 'cwd')
    assert.equal(r.grantedPolicy.name, 'write')
  })

  it('clamps requests above the model ceiling instead of refusing', () => {
    // Operator (root) spawning a deepseek asks for full; the deepseek-narrow
    // model ceiling clamps the child to write/cwd — "lock down dangerous agents"
    // as a clamp, never a refusal.
    const r = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'full',
      model: 'deepseek/deepseek-v4-pro',
    })
    assert.equal(r.grantedPolicy.capability, 'write')
    assert.equal(r.grantedPolicy.policy, 'cwd')
  })

  it('clamps a configured family ceiling too', () => {
    assert.deepEqual(modelSpawnCeiling({
      spawnPolicy: { familyCeilings: { goose: 'write' } },
    }, { kind: 'goose' }), {
      name: 'write',
      capability: 'write',
      policy: 'cwd',
      category: 'write-scope',
    })
    const r = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'tlda-write',
      kind: 'goose',
      config: { spawnPolicy: { familyCeilings: { goose: 'write' } } },
    })
    assert.equal(r.grantedPolicy.capability, 'write')
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
      name: 'write', capability: 'write', policy: 'cwd', category: 'write-scope',
    })
    assert.deepEqual(modelSpawnCeiling({}, { model: 'minimax/minimax-m3' }), {
      name: 'tlda-write', capability: 'tlda-write', policy: 'tlda-projects', category: 'write-scope',
    })
    assert.equal(spawnPolicyLte(modelSpawnCeiling({}, { model: 'deepseek/deepseek-v4-pro' }),
                               modelSpawnCeiling({}, { model: 'minimax/minimax-m3' })), true)
    // A deepseek can't be granted machine-level even by the operator: clamped to
    // write/cwd, never refused.
    const r = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'full',
      model: 'deepseek/deepseek-v4-pro',
    })
    assert.equal(r.grantedPolicy.capability, 'write')
    assert.equal(r.grantedPolicy.policy, 'cwd')
  })

  it('lets the operator raise a model ceiling per-agent, but never an agent', () => {
    const result = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'full',
      model: 'minimax/minimax-m3',
      trustOverride: 'full',
    })
    assert.equal(result.requestedCapability, 'full')
    assert.equal(result.modelCeiling, 'full')
    // Without the override the same request clamps to minimax's elevated ceiling
    // (tlda-write), not refused.
    const noOverride = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'full',
      model: 'minimax/minimax-m3',
    })
    assert.equal(noOverride.grantedPolicy.capability, 'tlda-write')
    assert.equal(noOverride.grantedPolicy.policy, 'tlda-projects')
    // An agent presenting a trust override is refused outright — no self-escalation.
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:a', metadata: { spawnPolicy: { capability: 'full' } } },
      requestedCapability: 'full',
      model: 'minimax/minimax-m3',
      trustOverride: 'full',
    }), /operator-only/)
    assert.equal(isOperator({ id: 'fleet:skip', human: true }), true)
    assert.equal(isOperator({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'full' } } }), false)
  })

  it('selects spawn profiles from configuration only', () => {
    assert.equal(resolveProjectProfileName(
      { spawnPolicy: { projectProfiles: { 'host-ops': 'ops' } } }, { doc: 'host-ops' }), 'ops')
    assert.equal(resolveProjectProfileName(
      { spawnPolicy: { projectProfiles: { '/Users/skip/work/custom-work': 'math-projects' } } },
      { cwd: '/Users/skip/work/custom-work' }
    ), 'math-projects')
    assert.equal(resolveProjectProfileName({ spawnPolicy: { defaultProfile: 'cwd' } }, {}), 'cwd')
    assert.equal(resolveProjectProfileName({}, {}), 'cwd')
    assert.equal(resolveProjectProfileName({}, { project: { profile: 'math' }, cwd: '/Users/skip/work/math' }), 'math')
    assert.deepEqual(resolveProjectProfile(
      { spawnPolicy: { projectProfiles: { mathdoc: 'math-projects' } } },
      { doc: 'mathdoc' },
    ), {
      name: 'math-projects', capability: 'tlda-write', policy: 'tlda-projects', category: 'write-scope',
    })
    assert.deepEqual(resolveProjectProfile(
      { spawnPolicy: { projectProfiles: { opsdoc: 'ops' } } },
      { doc: 'opsdoc' },
    ), {
      name: 'ops', capability: 'full', policy: 'unsandboxed', category: 'write-scope',
    })
  })

  it('caps an inherited profile by the model ceiling — even for Claude', () => {
    const config = { spawnPolicy: { projectProfiles: { mathdoc: 'math-projects' } } }
    const mathProfile = resolveProjectProfile(config, { doc: 'mathdoc' })
    const claudeInMath = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: mathProfile,
      model: 'opus48',
    })
    assert.equal(claudeInMath.requestedPolicy.policy, 'tlda-projects')
    assert.equal(claudeInMath.requestedCapability, 'tlda-write')
    // A deepseek in the same math project: the profile asks for tlda-write, but
    // its narrow ceiling clamps it to write/cwd — never refused.
    const deepseekInMath = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: mathProfile,
      model: 'deepseek/deepseek-v4-pro',
    })
    assert.equal(deepseekInMath.grantedPolicy.capability, 'write')
    assert.equal(deepseekInMath.grantedPolicy.policy, 'cwd')
  })

  it('preserves an explicit read request as the requested operation set', () => {
    const result = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'read',
      model: 'deepseek/deepseek-v4-pro',
    })
    assert.equal(result.requestedCapability, 'read')
    assert.equal(result.grantedPolicy.capability, 'read')
    assert.equal(result.grantedPolicy.policy, 'cwd')
  })

  it('returns the granted (clamped) policy for daemon launch metadata', () => {
    const result = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'tlda-write',
      model: 'opus46',
    })
    assert.deepEqual(result.requestedPolicy, {
      name: 'tlda-write',
      capability: 'tlda-write',
      policy: 'tlda-projects',
      category: 'write-scope',
    })
  })

  it('meet is the min rung with the region derived', () => {
    assert.deepEqual(meetSpawnPolicies(['full', 'tlda-write', 'write']), {
      name: 'write', capability: 'write', policy: 'cwd', category: 'write-scope',
    })
    assert.deepEqual(meetSpawnPolicies(['full', 'tlda-write']), {
      name: 'tlda-write', capability: 'tlda-write', policy: 'tlda-projects', category: 'write-scope',
    })
  })

  it('daemon grant is meet(requested, spawner row, model cap)', () => {
    const grant = resolveSpawnGrant({
      requestedCapability: 'full',
      callerRung: 'tlda-write',
      model: 'deepseek/deepseek-v4-pro',
      config: {},
    })
    assert.equal(grant.requestedCapability, 'full')
    assert.equal(grant.callerCapability, 'tlda-write')
    assert.equal(grant.machineAllowedCapability, 'write')
    assert.deepEqual(grant.grantedPolicy, {
      name: 'write',
      capability: 'write',
      policy: 'cwd',
      category: 'write-scope',
    })
  })

  it('daemon derives the project default as request, not authority', () => {
    const grant = resolveSpawnGrant({
      callerRung: 'full',
      model: 'opus48',
      config: { spawnPolicy: { projectProfiles: { mathdoc: 'math-projects' }, machineGrant: 'tlda-write' } },
      doc: 'mathdoc',
      project: { name: 'mathdoc' },
    })
    assert.equal(grant.requestedCapability, 'tlda-write')
    assert.equal(grant.projectCapability, 'tlda-write')
    assert.equal(grant.modelCapability, 'full')
    assert.deepEqual(grant.grantedPolicy, {
      name: 'tlda-write',
      capability: 'tlda-write',
      policy: 'tlda-projects',
      category: 'write-scope',
    })
  })

  it('daemon derives the project default from cwd when no doc is supplied', () => {
    const ops = resolveSpawnGrant({
      callerRung: 'full',
      model: 'gpt-5.5',
      kind: 'codex',
      config: { spawnPolicy: { projectProfiles: { '/Users/skip/work/ops': 'ops' }, machineGrant: 'full' } },
      cwd: '/Users/skip/work/ops',
    })
    assert.equal(ops.requestedCapability, 'full')
    assert.deepEqual(ops.grantedPolicy, {
      name: 'full',
      capability: 'full',
      policy: 'unsandboxed',
      category: 'write-scope',
    })

    const cwdDefault = resolveSpawnGrant({
      callerRung: 'full',
      model: 'gpt-5.5',
      kind: 'codex',
      config: {},
      cwd: '/Users/skip/work/tlda',
    })
    assert.equal(cwdDefault.requestedCapability, 'write')
    assert.deepEqual(cwdDefault.grantedPolicy, {
      name: 'write',
      capability: 'write',
      policy: 'cwd',
      category: 'write-scope',
    })
  })

  it('machineGrant/local ACL no longer act as authority clamps', () => {
    const grant = resolveSpawnGrant({
      requestedCapability: 'full',
      requester: { id: 'fleet:skip', human: true },
      model: 'gpt-5.5',
      kind: 'codex',
      config: { spawnPolicy: { machineGrant: 'read', localSpawnAcl: { '*': { '*': 'read' } } } },
      cwd: '/Users/skip/work/tlda',
    })
    assert.equal(grant.grantedCapability, 'full')
  })

  it('none spawners cannot spawn agents', () => {
    assert.throws(() => resolveSpawnGrant({
      requestedCapability: 'write',
      requester: { id: 'fleet:unknown' },
      spawnerPolicy: 'none',
      spawnerPrivilegeSet: emptyPrivilegeSet(),
      model: 'gpt-5.5',
      kind: 'codex',
      cwd: '/Users/skip/work/tlda',
    }), /spawner lacks spawn privilege/)
  })

  it('normalizes requested privilege profiles from names, objects, and profile source text', () => {
    assert.equal(normalizeRequestedPrivileges('app-dev').capability, 'full')
    assert.equal(normalizeRequestedPrivileges({ profile: 'math-project' }).capability, 'tlda-write')
    assert.equal(normalizeRequestedPrivileges({
      source: `profile app-dev:
  read  + /Users/skip/work/tlda/**
  write + /Users/skip/work/tlda/**
`,
    }).capability, 'full')
  })

  it('compiles app-dev privilege profiles into explicit operation zones', () => {
    const compiled = compilePrivilegeProfiles(`profile app-dev:
  read  + /Users/skip/work/tlda/**
  write + /Users/skip/work/tlda/**
  write + /tmp/tlda-*/**
  read  - ~/.ssh/**
  write - ~/.ssh/**
`)
    const profile = compiled.profiles['app-dev']
    assert.equal(profile.type, 'privilege-set')
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

  it('daemon resolver accepts compiled requestedPrivileges structures', () => {
    const compiled = compilePrivilegeProfiles(`profile app-dev:
  read  + /Users/skip/work/tlda/**
  write + /Users/skip/work/tlda/**
  write + /tmp/tlda-*/**
  read  - ~/.ssh/**
  write - ~/.ssh/**
`)
    const requestedPrivileges = compiled.profiles['app-dev']
    const grant = resolveSpawnGrant({
      requestedPrivileges,
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
    assert.equal(grant.requestedCapability, 'full')
    assert.equal(grant.grantedCapability, 'full')
    assert.deepEqual(grant.requestedPrivilegeSet.operations.write.allow, [
      '/Users/skip/work/tlda/**',
      '/tmp/tlda-*/**',
    ])
    assert.deepEqual(grant.requestedPrivilegeSet.operations.read.deny, ['~/.ssh/**'])
    assert.deepEqual(grant.grantedPrivilegeSet.operations.write.allow, [
      '/Users/skip/work/tlda/**',
      '/tmp/tlda-*/**',
    ])
    assert.deepEqual(grant.grantedPrivilegeSet.operations.write.deny, ['/Users/skip/.ssh/**'])
  })

  it('daemon project defaults use named privilege profile zones', () => {
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
    assert.deepEqual(grant.requestedPrivilegeSet.operations.write.allow, [
      'cwd',
      '~/.config/tlda/fleet-daemon.log',
      '~/.config/tlda/fleet-daemon.pid',
      '~/.config/tlda/fleet-daemon.*.lock',
    ])
    assert.deepEqual(grant.grantedPrivilegeSet.operations.write.allow, [
      '/Users/skip/work/tlda/**',
      '/Users/skip/.config/tlda/fleet-daemon.log',
      '/Users/skip/.config/tlda/fleet-daemon.pid',
      '/Users/skip/.config/tlda/fleet-daemon.*.lock',
    ])
    assert.equal(grant.grantedPrivilegeSet.operations.write.allow.includes('**'), false)
  })

  it('daemon grant narrows wider requested zones by spawner row', () => {
    const compiled = compilePrivilegeProfiles(`profile app-dev:
  read  + /Users/skip/work/**
  write + /Users/skip/work/**
  write + /tmp/tlda-*/**
  read  - ~/.ssh/**
  write - ~/.ssh/**
`)
    const grant = resolveSpawnGrant({
      requestedPrivileges: compiled.profiles['app-dev'],
      requester: { id: 'fleet:writer', spawnPolicy: { capability: 'write', policy: 'cwd' } },
      model: 'gpt-5.5',
      kind: 'codex',
      config: { spawnPolicy: { machineGrant: 'full', defaultProfile: 'cwd' } },
      cwd: '/Users/skip/work/tlda',
    })
    assert.equal(grant.requestedCapability, 'full')
    assert.equal(grant.grantedCapability, 'write')
    assert.deepEqual(grant.grantedPrivilegeSet.operations.read.allow, ['/Users/skip/work/tlda/**'])
    assert.deepEqual(grant.grantedPrivilegeSet.operations.write.allow, ['/Users/skip/work/tlda/**'])
    assert.equal(grant.grantedPrivilegeSet.operations.write.allow.includes('/tmp/tlda-*/**'), false)
    assert.deepEqual(grant.grantedPrivilegeSet.operations.read.deny, ['/Users/skip/.ssh/**'])
    assert.deepEqual(grant.grantedPrivilegeSet.operations.write.deny, ['/Users/skip/.ssh/**'])
  })

  it('privilege-set subset follows narrowed allows and accumulated denies', () => {
    const wide = compilePrivilegeProfiles(`profile wide:
  read  + /Users/skip/work/**
  write + /Users/skip/work/**
  write - ~/.ssh/**
`).profiles.wide
    const narrow = compilePrivilegeProfiles(`profile narrow:
  read  + /Users/skip/work/tlda/**
  write + /Users/skip/work/tlda/**
  write - ~/.ssh/**
`).profiles.narrow
    const grant = intersectPrivilegeSets([wide, narrow], { name: 'grant' })
    assert.deepEqual(grant.operations.write.allow, ['/Users/skip/work/tlda/**'])
    assert.deepEqual(grant.operations.write.deny, ['~/.ssh/**'])
    assert.equal(privilegeSetLte(grant, wide), true)
    assert.equal(privilegeSetLte(wide, grant), false)
  })

  it('daemon full override grants full when request, model, and spawner terms allow it', () => {
    const config = {
      spawnPolicy: {
        machineGrant: 'full',
        defaultProfile: 'cwd',
        projectProfiles: { '/Users/skip/work/tlda': 'app-dev' },
      },
    }
    const grant = resolveSpawnGrant({
      requestedCapability: 'full',
      requester: { id: 'fleet:skip', human: true },
      model: 'gpt-5.5',
      kind: 'codex',
      config,
      cwd: '/Users/skip/work/tlda',
    })
    assert.equal(grant.requestedCapability, 'full')
    assert.equal(grant.spawnerCapability, 'full')
    assert.equal(grant.modelCapability, 'full')
    assert.deepEqual(grant.grantedPolicy, {
      name: 'full',
      capability: 'full',
      policy: 'unsandboxed',
      category: 'write-scope',
    })

    const clampedBySpawner = resolveSpawnGrant({
      requestedCapability: 'full',
      requester: { id: 'fleet:writer', spawnPolicy: { capability: 'write', policy: 'cwd' } },
      model: 'gpt-5.5',
      kind: 'codex',
      config,
      cwd: '/Users/skip/work/tlda',
    })
    assert.equal(clampedBySpawner.spawnerCapability, 'write')
    assert.equal(clampedBySpawner.grantedCapability, 'write')
  })
})
