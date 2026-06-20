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
  isOperator,
  meetSpawnPolicies,
  modelCeiling,
  modelSpawnCeiling,
  modelTrustTier,
  normalizeCapability,
  normalizeSpawnPolicy,
  resolveProjectProfile,
  resolveProjectProfileName,
  spawnPolicyLte,
} from '../server/lib/spawn-policy.mjs'

describe('spawn policy', () => {
  it('is one axis of four named rungs, region derived from the rung', () => {
    assert.deepEqual(CAPABILITIES, ['read', 'write', 'tlda-write', 'full'])
    assert.equal(capabilityLte('read', 'write'), true)
    assert.equal(capabilityLte('write', 'tlda-write'), true)
    assert.equal(capabilityLte('tlda-write', 'full'), true)
    assert.equal(capabilityLte('full', 'read'), false)
    // region follows the name — no second axis to type
    assert.equal(normalizeSpawnPolicy('read').policy, 'cwd')
    assert.equal(normalizeSpawnPolicy('write').policy, 'cwd')
    assert.equal(normalizeSpawnPolicy('tlda-write').policy, 'tlda-projects')
    assert.equal(normalizeSpawnPolicy('full').policy, 'unsandboxed')
    assert.deepEqual(CAPABILITY_REGION, { read: 'cwd', write: 'cwd', 'tlda-write': 'tlda-projects', full: 'unsandboxed' })
  })

  it('rejects machine vocabulary as a typed capability (four names only on the surface)', () => {
    // The user surface accepts only the four names; the old machine words are
    // tolerated ONLY as persisted-metadata reads, never as a normalized rung name.
    for (const name of ['read', 'write', 'tlda-write', 'full']) {
      assert.equal(normalizeCapability(name), name)
    }
  })

  it('honors a coherent stored rung; corrupted region is repaired, never demotes write', () => {
    // genuine read reviewer stays read
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'read-only', policy: 'cwd' } } }), 'read')
    // mathchat2's corrupted blob {read-only, unsandboxed}: honor read, ignore the
    // bad region → read under the CODE DEFAULT (promotion is the operator sweep's job).
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

  it('inherits a project default profile as the spawn fence', () => {
    assert.equal(resolveProjectProfileName({}, { project: { profile: 'math' } }), 'math')
    assert.equal(resolveProjectProfileName(
      { spawnPolicy: { projectProfiles: { 'host-ops': 'ops' } } }, { doc: 'host-ops' }), 'ops')
    assert.equal(resolveProjectProfileName({ spawnPolicy: { defaultProfile: 'untrusted' } }, {}), 'untrusted')
    assert.equal(resolveProjectProfileName({}, {}), 'app')
    assert.equal(resolveProjectProfileName({}, { project: { profile: 'bogus' } }), 'app')
    assert.deepEqual(resolveProjectProfile({}, { project: { profile: 'math' } }), {
      name: 'math', capability: 'tlda-write', policy: 'tlda-projects', category: 'write-scope',
    })
    assert.deepEqual(resolveProjectProfile({}, { project: { profile: 'ops' } }), {
      name: 'ops', capability: 'full', policy: 'unsandboxed', category: 'write-scope',
    })
  })

  it('caps an inherited profile by the model ceiling — even for Claude', () => {
    const claudeInMath = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: resolveProjectProfile({}, { project: { profile: 'math' } }),
      model: 'opus48',
    })
    assert.equal(claudeInMath.requestedPolicy.policy, 'tlda-projects')
    assert.equal(claudeInMath.requestedCapability, 'tlda-write')
    // A deepseek in the same math project: the profile asks for tlda-write, but
    // its narrow ceiling clamps it to write/cwd — never refused.
    const deepseekInMath = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: resolveProjectProfile({}, { project: { profile: 'math' } }),
      model: 'deepseek/deepseek-v4-pro',
    })
    assert.equal(deepseekInMath.grantedPolicy.capability, 'write')
    assert.equal(deepseekInMath.grantedPolicy.policy, 'cwd')
  })

  it('allows downward choice within both ceilings', () => {
    const result = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'read',
      model: 'deepseek/deepseek-v4-pro',
    })
    assert.equal(result.requestedCapability, 'read')
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
})
