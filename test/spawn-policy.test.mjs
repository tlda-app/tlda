#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  authorizeSpawn,
  capabilityLte,
  callerCapability,
  modelCeiling,
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
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'offline' } } }), 'workspace-write-no-net')
    assert.equal(callerCapability({ id: 'fleet:a', metadata: { spawnPolicy: { capability: 'full' } } }), 'full-access')
  })

  it('rejects requests above caller capability', () => {
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:a', metadata: { spawnPolicy: { capability: 'workspace-write-no-net' } } },
      requestedCapability: 'workspace-write+net',
      model: 'opus46',
    }), /exceeds caller capability/)
  })

  it('rejects requests above model ceiling', () => {
    assert.throws(() => authorizeSpawn({
      caller: { id: 'fleet:skip', human: true },
      requestedCapability: 'full-access',
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
})
