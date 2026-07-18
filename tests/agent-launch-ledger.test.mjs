import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'
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
    projectedPolicy: { policy: 'unsandboxed' },
  }
}

function regionPermissionSet(name, allow) {
  return {
    type: 'permission-set',
    name,
    operations: {
      read: { allow, deny: [] },
      write: { allow, deny: [] },
      spawn: { allow: [], deny: [] },
    },
    rules: [],
    projectedPolicy: { policy: 'cwd' },
  }
}

test('daemon launcher writes fresh-spawn ledger row before starting seat', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-ledger-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    ledger.setSync('fleet:requester', {
      spawnPolicy: { policy: 'unsandboxed' },
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
        model: 'gpt-5.5',
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
    assert.deepEqual(observedPrelaunchGrant?.spawnPolicy, { policy: 'unsandboxed' })
    const row = ledger.get(result.agent_id)
    assert.deepEqual(row?.spawnPolicy, { policy: 'unsandboxed' })
    assert.equal(row?.sessionId, '11111111-2222-4333-8444-555555555555')
    assert.equal(row?.sessionKind, 'codex')
    assert.equal(row?.tmuxSession, 'fleet-fresh-ledger')
    assert.equal(row?.model, 'gpt-5.5')
    assert.equal(row?.machineId, 'test-machine')
    assert.equal(row?.envName, 'test')
    assert.equal(row?.daemonKey, 'test-machine:test')
    assert.equal(result.resume_id, '11111111-2222-4333-8444-555555555555')
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('daemon launcher carries structured permission intersections through preallocation, spawn params, and return', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-intersection-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    const shared = path.join(tmp, 'shared')
    const alpha = regionPermissionSet('alpha', [path.join(tmp, 'alpha'), shared])
    const beta = regionPermissionSet('beta', [path.join(tmp, 'beta'), shared])
    ledger.setSync('fleet:requester', {
      spawnPolicy: { policy: 'cwd' },
      permissionProfile: 'beta',
      permissionSet: beta,
      source: 'test-requester',
    })

    let observedPrelaunchGrant = null
    let observedSpawnParams = null
    const launcher = createAgentLauncher({
      activeConfigName: 'test',
      configDir: tmp,
      loadConfig: () => ({
        spawnPolicy: {
          permissionProfiles: { alpha, beta },
          defaultProfile: 'alpha',
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
        sessionId: '31111111-2222-4333-8444-555555555555',
        jsonlPath: path.join(tmp, 'rollout-31111111-2222-4333-8444-555555555555.jsonl'),
        model: 'gpt-5.5',
      }),
      spawnImpl: async (params) => {
        observedSpawnParams = params
        observedPrelaunchGrant = ledger.get(params.agentId)
        return {
          ok: true,
          fleetId: params.agentId,
          tmuxSession: 'fleet-intersection-ledger',
          harness: 'codex',
          model: params.model,
          pending: true,
        }
      },
    })

    const result = await launcher.handlers.spawn({
      name: 'intersection-ledger',
      model: 'gpt-5.5',
      kind: 'codex',
      cwd: tmp,
      permissionRequest: 'alpha',
      requester: { id: 'fleet:requester', name: 'requester' },
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(observedPrelaunchGrant?.permissionIntersection?.profiles, ['alpha', 'beta'])
    assert.deepEqual(observedSpawnParams?.permissionIntersection?.profiles, ['alpha', 'beta'])
    assert.deepEqual(result.permissionIntersection?.profiles, ['alpha', 'beta'])
    assert.equal(result.permissionProfile, null)
    const row = ledger.get(result.agent_id)
    assert.deepEqual(row?.permissionIntersection?.profiles, ['alpha', 'beta'])
    assert.equal(row?.permissionProfile, null)
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('daemon launcher fallback grant writer preserves structured permission intersections', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-intersection-fallback-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    const shared = path.join(tmp, 'shared')
    const alpha = regionPermissionSet('alpha', [path.join(tmp, 'alpha'), shared])
    const beta = regionPermissionSet('beta', [path.join(tmp, 'beta'), shared])
    ledger.setSync('fleet:requester', {
      spawnPolicy: { policy: 'cwd' },
      permissionProfile: 'beta',
      permissionSet: beta,
      source: 'test-requester',
    })

    const launcher = createAgentLauncher({
      activeConfigName: 'test',
      configDir: tmp,
      loadConfig: () => ({
        spawnPolicy: {
          permissionProfiles: { alpha, beta },
          defaultProfile: 'alpha',
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
        sessionId: '41111111-2222-4333-8444-555555555555',
        jsonlPath: path.join(tmp, 'rollout-41111111-2222-4333-8444-555555555555.jsonl'),
        model: 'gpt-5.5',
      }),
      spawnImpl: async (params) => ({
        ok: true,
        fleetId: 'fleet:fallback-intersection',
        tmuxSession: 'fleet-fallback-intersection',
        harness: 'codex',
        model: params.model,
        pending: true,
      }),
    })

    const result = await launcher.handlers.spawn({
      name: 'fallback-intersection',
      model: 'gpt-5.5',
      kind: 'codex',
      cwd: tmp,
      refresh: true,
      permissionRequest: 'alpha',
      requester: { id: 'fleet:requester', name: 'requester' },
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.agent_id, 'fleet:fallback-intersection')
    const row = ledger.get('fleet:fallback-intersection')
    assert.deepEqual(row?.permissionIntersection?.profiles, ['alpha', 'beta'])
    assert.equal(row?.permissionProfile, null)
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('daemon launcher refuses cross-box spawn without a local requester grant', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-remote-ledger-'))
  const priorConfigDir = process.env.TLDA_DAEMON_CONFIG_DIR
  process.env.TLDA_DAEMON_CONFIG_DIR = tmp
  fs.writeFileSync(path.join(tmp, 'daemon.yaml'), `
regions:
  project: [${JSON.stringify(tmp)}]
  machine: ['**']
profiles:
  app-dev:
    read: { allow: [project] }
    write: { allow: [project] }
  ops:
    read: { allow: [machine] }
    write: { allow: [machine] }
models:
  default: gpt
  values:
    gpt: { id: gpt-5.5, provider: codex, kind: codex }
default: app-dev
`)
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    const launcher = createAgentLauncher({
      activeConfigName: 'test',
      configDir: tmp,
      loadConfig: () => ({}),
      log: { info() {}, warn() {}, error() {} },
      machineId: 'destination-box',
      permissionLedger: ledger,
      sendMsg: () => true,
      getProjects: () => [],
      tmux: async () => true,
      startupFailureProbeMs: 1,
      liveCodexSessionIdentityResolver: async () => ({
        sessionId: '21111111-2222-4333-8444-555555555555',
        jsonlPath: path.join(tmp, 'rollout-21111111-2222-4333-8444-555555555555.jsonl'),
        model: 'gpt-5.5',
      }),
      spawnImpl: async () => { throw new Error('spawn should not run without local requester grant') },
    })

    const result = await launcher.handlers.spawn({
      name: 'remote-child',
      model: 'gpt',
      kind: 'codex',
      cwd: tmp,
      permissionRequest: 'app-dev',
      requester: {
        id: 'fleet:remote-parent',
        daemonId: 'source-box:default',
      },
    })

    assert.equal(result.ok, false)
    assert.match(result.error, /has no daemon permission ledger entry/)
    assert.equal(ledger.get('fleet:remote-parent'), null)
  } finally {
    if (priorConfigDir == null) delete process.env.TLDA_DAEMON_CONFIG_DIR
    else process.env.TLDA_DAEMON_CONFIG_DIR = priorConfigDir
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('daemon launcher writes a supplied fresh agent id before starting seat', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-preallocated-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    ledger.setSync('fleet:requester', {
      spawnPolicy: { policy: 'unsandboxed' },
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
        model: 'gpt-5.5',
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
    assert.deepEqual(row?.spawnPolicy, { policy: 'unsandboxed' })
    assert.equal(row?.sessionId, '22222222-2222-4333-8444-555555555555')
    assert.equal(row?.tmuxSession, 'fleet-preallocated-ledger')
    assert.equal(row?.model, 'gpt-5.5')
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

test('daemon respawn restores persisted configured-profile grant identity into params, trace, and result', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-respawn-profile-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    const targetAgentId = 'fleet:respawn-profile'
    ledger.setSync(targetAgentId, {
      spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
      permissionProfile: 'ops',
      permissionSet: permissionSet(),
      source: 'frozen-ledger',
    })
    const traces = []
    let observedSpawnParams = null
    const launcher = createAgentLauncher({
      activeConfigName: 'test',
      configDir: tmp,
      loadConfig: () => ({ spawnPolicy: { permissionProfiles: { ops: permissionSet() }, defaultProfile: 'ops' } }),
      log: {
        info(message) {
          if (String(message).startsWith('[spawn-trace] ')) traces.push(message)
        },
        warn() {},
        error() {},
      },
      machineId: 'test-machine',
      permissionLedger: ledger,
      sendMsg: () => true,
      getProjects: () => [],
      tmux: async () => true,
      startupFailureProbeMs: 1,
      liveCodexSessionIdentityResolver: async () => ({
        sessionId: '51111111-2222-4333-8444-555555555555',
        jsonlPath: path.join(tmp, 'rollout-51111111-2222-4333-8444-555555555555.jsonl'),
        model: 'gpt-5.5',
      }),
      spawnImpl: async (params) => {
        observedSpawnParams = params
        return {
          ok: true,
          fleetId: targetAgentId,
          tmuxSession: 'fleet-respawn-profile',
          harness: 'codex',
          model: 'gpt-5.5',
          pending: true,
        }
      },
    })

    const result = await launcher.handlers.spawn({
      agent_id: targetAgentId,
      name: 'respawn-profile',
      respawn: true,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(observedSpawnParams?.permissionProfile, 'ops')
    assert.equal(observedSpawnParams?.permissionIntersection ?? null, null)
    assert.equal(result.permissionProfile, 'ops')
    assert.equal(result.permissionIntersection ?? null, null)
    assert.equal(ledger.get(targetAgentId)?.permissionProfile, 'ops')
    const traceText = traces.join('\n')
    assert.match(traceText, /"permissionProfile":"ops"/)
    assert.doesNotMatch(traceText, /"permissionIntersection":\{/)
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('daemon respawn restores persisted structured-intersection grant identity into params, trace, and result', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-respawn-intersection-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    const targetAgentId = 'fleet:respawn-intersection'
    const shared = path.join(tmp, 'shared')
    const intersection = {
      type: 'permission-intersection',
      profiles: ['alpha', 'beta'],
      permissionSet: regionPermissionSet('grant', [shared]),
      provenance: {
        requestedProfile: 'alpha',
        modelPermissionProfile: null,
        spawnerPermissionProfile: 'beta',
      },
    }
    ledger.setSync(targetAgentId, {
      spawnPolicy: { name: 'grant', policy: 'cwd' },
      permissionIntersection: intersection,
      permissionSet: intersection.permissionSet,
      source: 'frozen-ledger',
    })
    const traces = []
    let observedSpawnParams = null
    const launcher = createAgentLauncher({
      activeConfigName: 'test',
      configDir: tmp,
      loadConfig: () => ({ spawnPolicy: { permissionProfiles: {}, defaultProfile: null } }),
      log: {
        info(message) {
          if (String(message).startsWith('[spawn-trace] ')) traces.push(message)
        },
        warn() {},
        error() {},
      },
      machineId: 'test-machine',
      permissionLedger: ledger,
      sendMsg: () => true,
      getProjects: () => [],
      tmux: async () => true,
      startupFailureProbeMs: 1,
      liveCodexSessionIdentityResolver: async () => ({
        sessionId: '61111111-2222-4333-8444-555555555555',
        jsonlPath: path.join(tmp, 'rollout-61111111-2222-4333-8444-555555555555.jsonl'),
        model: 'gpt-5.5',
      }),
      spawnImpl: async (params) => {
        observedSpawnParams = params
        return {
          ok: true,
          fleetId: targetAgentId,
          tmuxSession: 'fleet-respawn-intersection',
          harness: 'codex',
          model: 'gpt-5.5',
          pending: true,
        }
      },
    })

    const result = await launcher.handlers.spawn({
      agent_id: targetAgentId,
      name: 'respawn-intersection',
      respawn: true,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(observedSpawnParams?.permissionProfile ?? null, null)
    assert.deepEqual(observedSpawnParams?.permissionIntersection?.profiles, ['alpha', 'beta'])
    assert.equal(result.permissionProfile ?? null, null)
    assert.deepEqual(result.permissionIntersection?.profiles, ['alpha', 'beta'])
    assert.deepEqual(ledger.get(targetAgentId)?.permissionIntersection?.profiles, ['alpha', 'beta'])
    const traceText = traces.join('\n')
    assert.match(traceText, /"permissionIntersection":\{"type":"permission-intersection","profiles":\["alpha","beta"\]/)
    assert.match(traceText, /"permissionProfile":null/)
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('permission ledger opens and upgrades pre-session-column schema', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-ledger-upgrade-'))
  const dbFile = path.join(tmp, 'fleet-daemon.db')
  try {
    const db = new Database(dbFile)
    db.exec(`
      CREATE TABLE permission_grants (
        id TEXT PRIMARY KEY,
        spawn_policy TEXT NOT NULL,
        permission_set TEXT,
        updated_at TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    db.close()

    const ledger = createPermissionLedger(dbFile)
    try {
      assert.equal(ledger.get('fleet:missing'), null)
      assert.equal(ledger.findByFriendlyName('mend'), null)
    } finally {
      await ledger.close()
    }
  } finally {
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

test('daemon launcher emits current binding when respawn finds runtime already alive', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-already-live-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    ledger.setSync('fleet:seat-owner', {
      spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
      permissionSet: permissionSet(),
      source: 'test',
    })
    ledger.setSessionSync('fleet:seat-owner', {
      sessionId: '44444444-2222-4333-8444-555555555555',
      sessionKind: 'codex',
      sessionPath: '/tmp/rollout-44444444-2222-4333-8444-555555555555.jsonl',
      tmuxSession: 'fleet-seat-owner',
      model: 'gpt-5.5',
      machineId: 'mini',
      envName: 'fly',
      daemonKey: 'mini:fly',
      cwd: tmp,
      friendlyName: 'seat-owner',
    })
    const messages = []
    const launcher = createAgentLauncher({
      activeConfigName: 'fly',
      configDir: tmp,
      loadConfig: () => ({ spawnPolicy: { permissionProfiles: { ops: permissionSet() }, defaultProfile: 'ops' } }),
      log: { info() {}, warn() {}, error() {} },
      machineId: 'mini',
      permissionLedger: ledger,
      sendMsg: msg => { messages.push(msg); return true },
      getProjects: () => [],
      tmux: async () => true,
      startupFailureProbeMs: 1,
      spawnImpl: async () => ({
        ok: true,
        fleetId: 'fleet:seat-owner',
        tmuxSession: 'fleet-seat-owner',
        harness: 'codex',
        model: 'gpt-5.5',
        alreadyAlive: true,
      }),
    })

    const result = await launcher.handlers.spawn({
      name: 'seat-owner',
      agent_id: 'fleet:seat-owner',
      respawn: true,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    const binding = messages.find(m => m.type === 'agent-seat')
    assert.deepEqual(binding, {
      type: 'agent-seat',
      agent_id: 'fleet:seat-owner',
      session_id: '44444444-2222-4333-8444-555555555555',
      resume_id: '44444444-2222-4333-8444-555555555555',
      kind: 'codex',
      model: 'gpt-5.5',
      cwd: tmp,
      machine_id: 'mini',
      env_name: 'fly',
      daemon_key: 'mini:fly',
      tmux_session: 'fleet-seat-owner',
      created_source: 'spawn-runtime-already-live',
    })
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('daemon ledger session identity is validate-equal after first write', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-session-conflict-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    ledger.setSync('fleet:seat-owner', {
      spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
      permissionSet: permissionSet(),
      source: 'test',
    })
    ledger.setSessionSync('fleet:seat-owner', {
      sessionId: '33333333-2222-4333-8444-555555555555',
      sessionKind: 'codex',
      sessionPath: '/tmp/rollout-33333333-2222-4333-8444-555555555555.jsonl',
      tmuxSession: 'fleet-seat-owner',
      model: 'gpt-5.5',
      machineId: 'mini',
      envName: 'fly',
      daemonKey: 'mini:fly',
      cwd: tmp,
      friendlyName: 'seat-owner',
    })

    assert.throws(() => ledger.setSessionSync('fleet:seat-owner', {
      sessionId: '33333333-2222-4333-8444-555555555555',
      sessionKind: 'codex',
      sessionPath: '/tmp/rollout-33333333-2222-4333-8444-555555555555.jsonl',
      tmuxSession: 'fleet-liveness',
      model: 'gpt-5.5',
      machineId: 'mini',
      envName: 'fly',
      daemonKey: 'mini:fly',
      cwd: tmp,
    }), /daemon ledger identity conflict.*tmuxSession/)
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

async function runLiveIdentityPolicyCase({ harness, identities, timeoutMs = 1_000, existingSessionId = null }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `tlda-agent-launch-${harness}-identity-policy-`))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  let now = 0
  const sleeps = []
  let calls = 0
  const resolverInputs = []
  const resolver = async input => {
    resolverInputs.push(input)
    return identities[Math.min(calls++, identities.length - 1)]
  }
  try {
    ledger.setSync('fleet:requester', {
      spawnPolicy: { policy: 'unsandboxed' },
      permissionSet: permissionSet(),
      source: 'test-requester',
    })
    const agentId = `fleet:${harness}-identity-policy`
    if (existingSessionId) {
      ledger.setSync(agentId, {
        spawnPolicy: { policy: 'unsandboxed' },
        permissionSet: permissionSet(),
        source: 'test-existing-seat',
      })
      ledger.setSessionSync(agentId, {
        sessionId: existingSessionId,
        sessionKind: harness,
        sessionPath: null,
        tmuxSession: `fleet-${harness}-identity-policy`,
        model: harness === 'codex' ? 'gpt-5.5' : 'claude-opus-4-6',
        machineId: 'test-machine',
        envName: 'test',
        daemonKey: 'test-machine:test',
        cwd: tmp,
        friendlyName: `${harness}-identity-policy`,
      })
    }
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
      liveCodexSessionIdentityResolver: harness === 'codex' ? resolver : null,
      liveClaudeSessionIdentityResolver: harness === 'claude' ? resolver : null,
      liveSessionIdentityTimeoutMs: timeoutMs,
      liveSessionIdentityPollMs: 500,
      liveSessionIdentityNow: () => now,
      liveSessionIdentitySleep: async ms => {
        sleeps.push(ms)
        now += ms
      },
      spawnImpl: async params => ({
        ok: true,
        fleetId: params.agentId,
        tmuxSession: `fleet-${harness}-identity-policy`,
        harness,
        model: params.model,
        pending: true,
      }),
    })
    const result = await launcher.handlers.spawn({
      agent_id: existingSessionId ? agentId : undefined,
      name: `${harness}-identity-policy`,
      model: harness === 'codex' ? 'gpt-5.5' : 'opus',
      kind: harness,
      cwd: tmp,
      requester: { id: 'fleet:requester', name: 'requester' },
    })
    return { calls, resolverInputs, sleeps, result, row: ledger.get(result.agent_id) }
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

test('Codex and Claude live identity resolution share retry and persistence behavior', async () => {
  const sessionId = '55555555-2222-4333-8444-555555555555'
  const outcomes = []
  for (const harness of ['codex', 'claude']) {
    outcomes.push(await runLiveIdentityPolicyCase({
      harness,
      identities: [null, null, { sessionId, jsonlPath: `/tmp/${harness}-${sessionId}.jsonl`, model: null }],
    }))
  }

  for (const outcome of outcomes) {
    assert.equal(outcome.result.ok, true, JSON.stringify(outcome.result))
    assert.equal(outcome.calls, 3)
    assert.deepEqual(outcome.sleeps, [500, 500])
    assert.equal(outcome.result.resume_id, sessionId)
    assert.equal(outcome.row?.sessionId, sessionId)
    assert.match(outcome.row?.sessionPath || '', /\.jsonl$/)
  }
})

test('Codex and Claude fill a missing session path without changing durable identity', async () => {
  const sessionId = '66666666-2222-4333-8444-555555555555'
  for (const harness of ['codex', 'claude']) {
    const sessionPath = `/tmp/${harness}-${sessionId}.jsonl`
    const outcome = await runLiveIdentityPolicyCase({
      harness,
      existingSessionId: sessionId,
      identities: [{ sessionId, jsonlPath: sessionPath, model: null }],
    })

    assert.equal(outcome.result.ok, true, JSON.stringify(outcome.result))
    assert.equal(outcome.calls, 1)
    assert.deepEqual(outcome.sleeps, [])
    assert.equal(outcome.row?.sessionId, sessionId)
    assert.equal(outcome.row?.sessionPath, sessionPath)
    assert.equal(outcome.row?.daemonKey, 'test-machine:test')
    assert.equal(outcome.resolverInputs[0]?.sessionId, sessionId)
  }
})

test('Codex and Claude live identity resolution share timeout behavior', async () => {
  const outcomes = []
  for (const harness of ['codex', 'claude']) {
    outcomes.push(await runLiveIdentityPolicyCase({
      harness,
      identities: [null],
    }))
  }

  for (const outcome of outcomes) {
    assert.equal(outcome.result.ok, true, JSON.stringify(outcome.result))
    assert.equal(outcome.calls, 3)
    assert.deepEqual(outcome.sleeps, [500, 500])
    assert.equal(outcome.result.resume_id, null)
    assert.equal(outcome.row?.sessionId, null)
  }
})
