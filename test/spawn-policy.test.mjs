#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  authorizeSpawn,
  capabilityLte,
  callerCapability,
  callerSpawnPolicy,
  modelCeiling,
  modelSpawnCeiling,
  spawnPolicyLte,
} from '../server/lib/spawn-policy.mjs'

describe('spawn policy', () => {
  it('orders capabilities by sandbox authority', () => {
    assert.equal(capabilityLte('read-only', 'workspace-write-no-net'), true)
    assert.equal(capabilityLte('workspace-write-no-net', 'workspace-write+net'), true)
    assert.equal(capabilityLte('workspace-write+net', 'full-access'), true)
    assert.equal(capabilityLte('full-access', 'workspace-write-no-net'), false)
  })

  it('derives caller capability from metadata.spawnPolicy', () => {
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'read-only' } } }), 'read-only')
    assert.equal(callerCapability({ id: 'fleet:a', metadata: {} }), 'workspace-write+net')
    assert.equal(callerCapability({ id: 'fleet:skip', human: true }), 'full-access')
  })

  it('defaults non-root model ceilings to net-enabled workspace write', () => {
    assert.equal(modelCeiling({}, { model: 'deepseek/deepseek-v4-pro' }), 'workspace-write+net')
    assert.equal(modelCeiling({}, { model: 'deepseek' }), 'workspace-write+net')
    assert.equal(modelCeiling({}, { kind: 'goose' }), 'workspace-write+net')
    assert.equal(modelCeiling({}, { model: 'opus46' }), 'full-access')
    assert.equal(modelCeiling({}, { kind: 'codex' }), 'full-access')
  })

  it('normalizes operator-friendly capability names', () => {
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'write' } } }), 'workspace-write+net')
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'full' } } }), 'full-access')
  })

  it('orders write scopes separately from network capability', () => {
    assert.equal(spawnPolicyLte('write', 'tlda-write'), true)
    assert.equal(spawnPolicyLte('tlda-write', 'write'), false)
    assert.deepEqual(callerSpawnPolicy({
      id: 'fleet:a',
      metadata: { spawnPolicy: { capability: 'workspace-write+net', policy: 'tlda-projects' } },
    }), {
      name: null,
      capability: 'workspace-write+net',
      policy: 'tlda-projects',
      category: 'write-scope',
    })
  })

  it('rejects requests above caller capability', () => {
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:a', metadata: { spawnPolicy: { capability: 'workspace-write-no-net' } } },
      requestedCapability: 'workspace-write+net',
      model: 'opus46',
    }), /exceeds caller capability/)
  })

  it('rejects project-scope requests above caller filesystem policy', () => {
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:a', metadata: { spawnPolicy: { name: 'write', capability: 'workspace-write+net', policy: 'cwd' } } },
      requestedCapability: 'tlda-write',
      model: 'opus46',
    }), /requested spawn policy tlda-projects \/ workspace-write\+net exceeds caller capability\/policy cwd \/ workspace-write\+net/)
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
      capability: 'workspace-write+net',
      policy: 'cwd',
      category: 'write-scope',
    })
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'tlda-write',
      kind: 'goose',
      config: { spawnPolicy: { familyCeilings: { goose: 'write' } } },
    }), /requested spawn policy tlda-projects \/ workspace-write\+net exceeds model ceiling cwd \/ workspace-write\+net/)
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
      capability: 'workspace-write+net',
      policy: 'tlda-projects',
      category: 'write-scope',
    })
  })
})
