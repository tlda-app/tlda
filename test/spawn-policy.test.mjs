#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  authorizeSpawn,
  capabilityLte,
  callerCapability,
  callerSpawnPolicy,
  isOperator,
  modelCeiling,
  modelSpawnCeiling,
  modelTrustTier,
  resolveProjectProfile,
  resolveProjectProfileName,
  spawnPolicyLte,
} from '../server/lib/spawn-policy.mjs'

describe('spawn policy', () => {
  it('orders capabilities by sandbox authority', () => {
    assert.equal(capabilityLte('read-only', 'workspace-write-no-net'), true)
    assert.equal(capabilityLte('workspace-write-no-net', 'workspace-write'), true)
    assert.equal(capabilityLte('workspace-write', 'full-access'), true)
    assert.equal(capabilityLte('full-access', 'workspace-write-no-net'), false)
  })

  it('derives caller capability from metadata.spawnPolicy', () => {
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'read-only' } } }), 'read-only')
    assert.equal(callerCapability({ id: 'fleet:a', metadata: {} }), 'workspace-write')
    assert.equal(callerCapability({ id: 'fleet:skip', human: true }), 'full-access')
  })

  it('defaults non-root model ceilings to net-enabled workspace write', () => {
    assert.equal(modelCeiling({}, { model: 'deepseek/deepseek-v4-pro' }), 'workspace-write')
    assert.equal(modelCeiling({}, { model: 'deepseek' }), 'workspace-write')
    assert.equal(modelCeiling({}, { kind: 'goose' }), 'workspace-write')
    assert.equal(modelCeiling({}, { model: 'opus46' }), 'full-access')
    assert.equal(modelCeiling({}, { kind: 'codex' }), 'full-access')
  })

  it('normalizes operator-friendly capability names', () => {
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'write' } } }), 'workspace-write')
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'full' } } }), 'full-access')
  })

  it('orders write scopes separately from network capability', () => {
    assert.equal(spawnPolicyLte('write', 'tlda-write'), true)
    assert.equal(spawnPolicyLte('tlda-write', 'write'), false)
    assert.deepEqual(callerSpawnPolicy({
      id: 'fleet:a',
      metadata: { spawnPolicy: { capability: 'workspace-write', policy: 'tlda-projects' } },
    }), {
      name: null,
      capability: 'workspace-write',
      policy: 'tlda-projects',
      category: 'write-scope',
    })
  })

  it('rejects requests above caller capability', () => {
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:a', metadata: { spawnPolicy: { capability: 'workspace-write-no-net' } } },
      requestedCapability: 'workspace-write',
      model: 'opus46',
    }), /exceeds caller capability/)
  })

  it('rejects project-scope requests above caller filesystem policy', () => {
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:a', metadata: { spawnPolicy: { name: 'write', capability: 'workspace-write', policy: 'cwd' } } },
      requestedCapability: 'tlda-write',
      model: 'opus46',
    }), /requested spawn policy tlda-projects \/ workspace-write exceeds caller capability\/policy cwd \/ workspace-write/)
  })

  it('rejects requests above model ceiling', () => {
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'full-access',
      model: 'deepseek/deepseek-v4-pro',
    }), /exceeds model ceiling/)
  })

  it('rejects project-scope requests above model filesystem ceiling', () => {
    assert.deepEqual(modelSpawnCeiling({
      spawnPolicy: { familyCeilings: { goose: 'write' } },
    }, { kind: 'goose' }), {
      name: 'write',
      capability: 'workspace-write',
      policy: 'cwd',
      category: 'write-scope',
    })
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'tlda-write',
      kind: 'goose',
      config: { spawnPolicy: { familyCeilings: { goose: 'write' } } },
    }), /requested spawn policy tlda-projects \/ workspace-write exceeds model ceiling cwd \/ workspace-write/)
  })

  it('keys the trust tier on the model, not the harness', () => {
    // goose is just a harness — the model under it decides the tier.
    assert.equal(modelTrustTier({ model: 'deepseek/deepseek-v4-pro', kind: 'goose' }), 'narrow')
    assert.equal(modelTrustTier({ model: 'minimax/minimax-m3', kind: 'goose' }), 'elevated')
    assert.equal(modelTrustTier({ model: 'opus48', kind: 'goose' }), 'full')
    assert.equal(modelTrustTier({ model: 'gpt-5.5', kind: 'goose' }), 'full')
    // An unrecognized open model fails safe to narrow.
    assert.equal(modelTrustTier({ model: 'someorg/mystery-7b' }), 'narrow')
    // No model string: only the closed harnesses get full; goose → narrow.
    assert.equal(modelTrustTier({ kind: 'codex' }), 'full')
    assert.equal(modelTrustTier({ kind: 'goose' }), 'narrow')
  })

  it('gives minimax a higher filesystem ceiling than deepseek', () => {
    // deepseek (narrow): own cwd project only.
    assert.deepEqual(modelSpawnCeiling({}, { model: 'deepseek/deepseek-v4-pro' }), {
      name: null, capability: 'workspace-write', policy: 'cwd', category: 'write-scope',
    })
    // minimax (elevated): across all tlda projects — strictly higher than deepseek.
    assert.deepEqual(modelSpawnCeiling({}, { model: 'minimax/minimax-m3' }), {
      name: null, capability: 'workspace-write', policy: 'tlda-projects', category: 'write-scope',
    })
    assert.equal(spawnPolicyLte(modelSpawnCeiling({}, { model: 'deepseek/deepseek-v4-pro' }),
                               modelSpawnCeiling({}, { model: 'minimax/minimax-m3' })), true)
    // A deepseek can't be granted machine-level even by the operator.
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'full',
      model: 'deepseek/deepseek-v4-pro',
    }), /exceeds model ceiling/)
  })

  it('lets the operator raise a model ceiling per-agent, but never an agent', () => {
    // Operator grants a trusted minimax full-access via a per-agent override.
    const result = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'full',
      model: 'minimax/minimax-m3',
      trustOverride: 'full',
    })
    assert.equal(result.requestedCapability, 'full-access')
    assert.equal(result.modelCeiling, 'full-access')
    // Without the override the same request is refused at the model ceiling.
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'full',
      model: 'minimax/minimax-m3',
    }), /exceeds model ceiling/)
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
    // A project record's own profile field wins.
    assert.equal(resolveProjectProfileName({}, { project: { profile: 'math' } }), 'math')
    // Else config.spawnPolicy.projectProfiles by name.
    assert.equal(resolveProjectProfileName(
      { spawnPolicy: { projectProfiles: { 'host-ops': 'ops' } } }, { doc: 'host-ops' }), 'ops')
    // Else the config default, else the built-in default.
    assert.equal(resolveProjectProfileName({ spawnPolicy: { defaultProfile: 'untrusted' } }, {}), 'untrusted')
    assert.equal(resolveProjectProfileName({}, {}), 'app')
    // An unknown profile name falls back to the default rather than throwing.
    assert.equal(resolveProjectProfileName({}, { project: { profile: 'bogus' } }), 'app')
    // The math profile fences to all tlda projects; ops is machine-level.
    assert.deepEqual(resolveProjectProfile({}, { project: { profile: 'math' } }), {
      name: 'math', capability: 'workspace-write', policy: 'tlda-projects', category: 'write-scope',
    })
    assert.deepEqual(resolveProjectProfile({}, { project: { profile: 'ops' } }), {
      name: 'ops', capability: 'full-access', policy: 'unsandboxed', category: 'write-scope',
    })
  })

  it('caps an inherited profile by the model ceiling — even for Claude', () => {
    // A Claude spawned into a math project inherits the math profile (fenced to
    // tlda-projects) even though its model could be trusted with full-access.
    const claudeInMath = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: resolveProjectProfile({}, { project: { profile: 'math' } }),
      model: 'opus48',
    })
    assert.equal(claudeInMath.requestedPolicy.policy, 'tlda-projects')
    assert.equal(claudeInMath.requestedCapability, 'workspace-write')
    // A deepseek spawned into the same math project: the profile asks for
    // tlda-projects, but its narrow model ceiling (cwd) caps it — the project
    // profile cannot lift an untrusted model above its ceiling.
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: resolveProjectProfile({}, { project: { profile: 'math' } }),
      model: 'deepseek/deepseek-v4-pro',
    }), /exceeds model ceiling/)
  })

  it('allows downward choice within both ceilings', () => {
    const result = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'workspace-write-no-net',
      model: 'deepseek/deepseek-v4-pro',
    })
    assert.equal(result.requestedCapability, 'workspace-write-no-net')
  })

  it('returns the full requested policy for daemon launch metadata', () => {
    const result = authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'tlda-write',
      model: 'opus46',
    })
    assert.deepEqual(result.requestedPolicy, {
      name: 'tlda-write',
      capability: 'workspace-write',
      policy: 'tlda-projects',
      category: 'write-scope',
    })
  })
})
