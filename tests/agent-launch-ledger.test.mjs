import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAgentLauncher } from '../agent-launch/agent-launch.mjs'
import { createPermissionLedger } from '../agent-launch/permission-ledger.mjs'

function permissionSet() {
  return {
    type: 'permission-set',
    name: 'ops',
    operations: {
      read: { allow: ['**'], deny: [] },
      write: { allow: ['**'], deny: [] },
      spawn: { allow: [], deny: [] },
    },
    rules: [],
    projectedPolicy: { name: 'ops', policy: 'unsandboxed' },
  }
}

test('daemon launcher writes fresh-spawn ledger row before starting seat', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-ledger-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    ledger.setSync('fleet:requester', {
      spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
      permissionSet: permissionSet(),
      source: 'test-requester',
    })

    let observedPrelaunchGrant = null
    const launcher = createAgentLauncher({
      activeConfigName: 'test',
      configDir: tmp,
      loadConfig: () => ({
        spawnPolicy: {
          permissionProfiles: {
            ops: permissionSet(),
          },
          defaultProfile: 'ops',
        },
      }),
      log: { info() {}, warn() {}, error() {} },
      machineId: 'test-machine',
      permissionLedger: ledger,
      sendMsg: () => true,
      getProjects: () => [],
      tmux: async () => true,
      startupFailureProbeMs: 1,
      liveCodexSessionIdentityResolver: async () => ({
        sessionId: '11111111-2222-4333-8444-555555555555',
        jsonlPath: path.join(tmp, 'rollout-11111111-2222-4333-8444-555555555555.jsonl'),
      }),
      spawnImpl: async (params) => {
        observedPrelaunchGrant = ledger.get(params.agentId)
        return {
          ok: true,
          fleetId: params.agentId,
          tmuxSession: 'fleet-fresh-ledger',
          harness: 'codex',
          model: params.model,
          pending: true,
        }
      },
    })

    const result = await launcher.handlers.spawn({
      name: 'fresh-ledger',
      model: 'gpt-5.5',
      kind: 'codex',
      cwd: tmp,
      requester: { id: 'fleet:requester', name: 'requester' },
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.agent_id?.startsWith('fleet:'), 'fresh spawn should preallocate a fleet id')
    assert.equal(observedPrelaunchGrant?.id, result.agent_id)
    assert.equal(observedPrelaunchGrant?.source, 'spawn')
    assert.deepEqual(observedPrelaunchGrant?.spawnPolicy, { name: 'unsandboxed', policy: 'unsandboxed' })
    const row = ledger.get(result.agent_id)
    assert.deepEqual(row?.spawnPolicy, { name: 'unsandboxed', policy: 'unsandboxed' })
    assert.equal(row?.sessionId, '11111111-2222-4333-8444-555555555555')
    assert.equal(row?.sessionKind, 'codex')
    assert.equal(result.resume_id, '11111111-2222-4333-8444-555555555555')
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('daemon launcher writes a supplied fresh agent id before starting seat', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-preallocated-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    ledger.setSync('fleet:requester', {
      spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
      permissionSet: permissionSet(),
      source: 'test-requester',
    })

    const suppliedAgentId = 'fleet:preallocated-fresh'
    let observedPrelaunchGrant = null
    const launcher = createAgentLauncher({
      activeConfigName: 'test',
      configDir: tmp,
      loadConfig: () => ({
        spawnPolicy: { permissionProfiles: { ops: permissionSet() }, defaultProfile: 'ops' },
      }),
      log: { info() {}, warn() {}, error() {} },
      machineId: 'test-machine',
      permissionLedger: ledger,
      sendMsg: () => true,
      getProjects: () => [],
      tmux: async () => true,
      startupFailureProbeMs: 1,
      liveCodexSessionIdentityResolver: async () => ({
        sessionId: '22222222-2222-4333-8444-555555555555',
        jsonlPath: path.join(tmp, 'rollout-22222222-2222-4333-8444-555555555555.jsonl'),
      }),
      spawnImpl: async (params) => {
        observedPrelaunchGrant = ledger.get(params.agentId)
        return {
          ok: true,
          fleetId: params.agentId,
          tmuxSession: 'fleet-preallocated-ledger',
          harness: 'codex',
          model: params.model,
          pending: true,
        }
      },
    })

    const result = await launcher.handlers.spawn({
      agent_id: suppliedAgentId,
      name: 'preallocated-ledger',
      model: 'gpt-5.5',
      kind: 'codex',
      cwd: tmp,
      requester: { id: 'fleet:requester', name: 'requester' },
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.agent_id, suppliedAgentId)
    assert.equal(observedPrelaunchGrant?.id, suppliedAgentId)
    assert.equal(observedPrelaunchGrant?.source, 'spawn')
    const row = ledger.get(suppliedAgentId)
    assert.deepEqual(row?.spawnPolicy, { name: 'unsandboxed', policy: 'unsandboxed' })
    assert.equal(row?.sessionId, '22222222-2222-4333-8444-555555555555')
    assert.equal(result.resume_id, '22222222-2222-4333-8444-555555555555')
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('daemon launcher rolls back a supplied fresh agent ledger row when launch fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-preallocated-fail-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    ledger.setSync('fleet:requester', {
      spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
      permissionSet: permissionSet(),
      source: 'test-requester',
    })

    const suppliedAgentId = 'fleet:preallocated-failure'
    let observedPrelaunchGrant = null
    const launcher = createAgentLauncher({
      activeConfigName: 'test',
      configDir: tmp,
      loadConfig: () => ({
        spawnPolicy: { permissionProfiles: { ops: permissionSet() }, defaultProfile: 'ops' },
      }),
      log: { info() {}, warn() {}, error() {} },
      machineId: 'test-machine',
      permissionLedger: ledger,
      sendMsg: () => true,
      getProjects: () => [],
      tmux: async () => true,
      startupFailureProbeMs: 1,
      spawnImpl: async (params) => {
        observedPrelaunchGrant = ledger.get(params.agentId)
        throw new Error('deliberate launch failure')
      },
    })

    const result = await launcher.handlers.spawn({
      agent_id: suppliedAgentId,
      name: 'preallocated-failure',
      model: 'gpt-5.5',
      kind: 'codex',
      cwd: tmp,
      requester: { id: 'fleet:requester', name: 'requester' },
    })

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(observedPrelaunchGrant?.id, suppliedAgentId)
    assert.equal(ledger.get(suppliedAgentId), null)
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('daemon launcher preserves an existing respawn ledger row when launch fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-respawn-fail-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    const targetAgentId = 'fleet:existing-respawn'
    ledger.setSync(targetAgentId, {
      spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
      permissionSet: permissionSet(),
      source: 'existing-seat',
    })

    const launcher = createAgentLauncher({
      activeConfigName: 'test',
      configDir: tmp,
      loadConfig: () => ({
        spawnPolicy: { permissionProfiles: { ops: permissionSet() }, defaultProfile: 'ops' },
      }),
      log: { info() {}, warn() {}, error() {} },
      machineId: 'test-machine',
      permissionLedger: ledger,
      sendMsg: () => true,
      getProjects: () => [],
      tmux: async () => true,
      startupFailureProbeMs: 1,
      spawnImpl: async () => {
        throw new Error('deliberate respawn failure')
      },
    })

    const result = await launcher.handlers.spawn({
      agent_id: targetAgentId,
      name: 'existing-respawn',
      model: 'gpt-5.5',
      kind: 'codex',
      cwd: tmp,
      respawn: true,
      requester: { id: targetAgentId, name: 'existing-respawn' },
    })

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(ledger.get(targetAgentId)?.source, 'existing-seat')
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

function emptyIntersectionPermissionSet() {
  // The shape a collapsed spawn-policy intersection produces: confers nothing,
  // but is NOT a deliberately-requested `none` (name/projected ≠ none, compiled
  // from an intersection). This is exactly the 2026-07-10 caged-agent grant.
  return {
    type: 'permission-set',
    name: 'grant',
    operations: {
      read: { allow: [], deny: [] },
      write: { allow: [], deny: [] },
      spawn: { allow: [], deny: [] },
    },
    rules: [],
    projectedPolicy: { name: 'cwd', policy: 'cwd' },
    compiledFrom: 'intersection',
  }
}

test('daemon launcher hard-refuses a spawn whose grant resolves to nothing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-nogrant-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    // Spawner itself holds a caged (confers-nothing) grant, so the spawn
    // intersection collapses to empty — no readable, no writable zone.
    ledger.setSync('fleet:requester', {
      spawnPolicy: { name: 'cwd', policy: 'cwd' },
      permissionSet: emptyIntersectionPermissionSet(),
      source: 'test-requester',
    })

    let spawnImplCalled = false
    const launcher = createAgentLauncher({
      activeConfigName: 'test',
      configDir: tmp,
      loadConfig: () => ({
        spawnPolicy: {
          permissionProfiles: { ops: permissionSet() },
          defaultProfile: 'ops',
        },
      }),
      log: { info() {}, warn() {}, error() {} },
      machineId: 'test-machine',
      permissionLedger: ledger,
      sendMsg: () => true,
      getProjects: () => [],
      tmux: async () => true,
      startupFailureProbeMs: 1,
      spawnImpl: async (params) => {
        spawnImplCalled = true
        return { ok: true, fleetId: params.agentId, tmuxSession: 'x', harness: 'codex', model: params.model, pending: true }
      },
    })

    const result = await launcher.handlers.spawn({
      name: 'caged-victim',
      model: 'gpt-5.5',
      kind: 'codex',
      cwd: tmp,
      requester: { id: 'fleet:requester', name: 'requester' },
    })

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.match(result.error || '', /no grant|spawn refused/i)
    assert.equal(spawnImplCalled, false, 'must refuse before launching the seat')
    // No ledger row for the refused agent (refuse happens before any mint/write).
    assert.equal(ledger.get('fleet:caged-victim'), null)
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('session identity recording does not fabricate an empty permission grant', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-session-ledger-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    const result = ledger.setSessionSync('fleet:no-grant-yet', {
      sessionId: 'session-without-grant',
      sessionKind: 'codex',
      cwd: tmp,
      friendlyName: 'no-grant-yet',
    })

    assert.equal(result, null)
    assert.equal(ledger.get('fleet:no-grant-yet'), null)
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
