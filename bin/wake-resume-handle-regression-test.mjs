#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentLauncher } from '../agent-launch/agent-launch.mjs'
import { completePendingSeatBinding, createPendingSeatBindingManager, reuseExactPendingSeatBinding } from '../agent-launch/pending-seat-binding.mjs'
import { runWakeRouteLifecycle } from '../server/lib/wake-route-lifecycle.mjs'

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tlda-wake-config-'))
writeFileSync(join(TEST_CONFIG_DIR, 'daemon.yaml'), `machineId: test\nregions:\n  machine: ["**"]\nprofiles:\n  test:\n    read: { allow: [machine], deny: [] }\n    write: { allow: [machine], deny: [] }\ngrants:\n  localhost: test\nmodels:\n  default: gpt\n  values:\n    gpt:\n      id: gpt-5.5\n      harness:\n        kind: codex\n        required: []\n        preferences: []\n        controls: true\ndefault: test\n`)
process.env.TLDA_DAEMON_CONFIG_DIR = TEST_CONFIG_DIR

function configFor(cwd) {
  return {
    profiles: {
      test: {
        read: { allow: ['**'], deny: [] },
        write: { allow: ['**'], deny: [] },
        spawn: { allow: ['**'], deny: [] },
      },
    },
  }
}

function memoryLedger() {
  const rows = new Map()
  return {
    get(id) { return rows.get(id) || null },
    async set(id, row) { rows.set(id, { ...(rows.get(id) || {}), ...row }) },
    setSessionSync(id, session) { rows.set(id, { ...(rows.get(id) || {}), ...session }) },
    async delete(id) { rows.delete(id) },
    rows,
  }
}

async function testLiveTmuxWakeDoesNotRespawnWhenServerStatusIsStale() {
  let spawnCalls = 0
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runWakeRouteLifecycle({
      agentId: 'fleet:live',
      agent: { id: 'fleet:live', friendly_name: 'live-agent', metadata: { kind: 'codex', deliveryChannel: 'tmux' } },
      seat: {
        agent_id: 'fleet:live', session_id: 'rollout-live', daemon_key: 'mini:prod',
        terminal_capability: 'termcap:live',
      },
      daemonKey: 'mini:prod', ownerDaemon: { readyState: 1 }, traceId: `trace-live-${attempt}`,
      isAgentAwake: () => false,
      sendRpcResilient: async (daemonKey, type, params) => {
        assert.equal(daemonKey, 'mini:prod')
        assert.equal(type, 'check-alive')
        assert.deepEqual(params, { agent_id: 'fleet:live', terminal_capability: 'termcap:live' })
        return { alive: true }
      },
      sendRpc: async () => {
        spawnCalls += 1
        throw new Error('spawn must not be called for a live routed tmux endpoint')
      },
      spawnLibrarian: {
        observeLiveness() {},
        decideWake(agent, checked, opts) {
          assert.equal(checked.state, 'alive')
          assert.equal(opts.serverAlive, true)
          return { action: 'deliver' }
        },
      },
      recordRuntimeLiveness() {},
    })
    assert.equal(result.action, 'already-awake')
  }
  assert.equal(spawnCalls, 0)
}

async function testFreshStartRetainsRuntimeWhenDurableRecoveryCannotBePersisted() {
  const cwd = mkdtempSync(join(tmpdir(), 'tlda-wake-resume-'))
  const ledger = memoryLedger()
  await ledger.set('fleet:requester', {
    permissionGrant: 'test',
  })
  const sent = []
  const launcher = createAgentLauncher({
    activeEnvName: 'prod',
    configDir: cwd,
    loadDaemonLaunchConfig: () => configFor(cwd),
    log: { info() {}, warn() {} },
    machineId: 'mini',
    permissionLedger: ledger,
    sendMsg: msg => { sent.push(msg) },
    getProjects: () => [{ name: 'test-doc', sourceDir: cwd }],
    tmux: async (cmd) => {
      assert.ok(cmd === 'has-session' || cmd === 'kill-session')
    },
    spawnImpl: async () => ({
      ok: true,
      pending: false,
      fleetId: 'fleet:newborn',
      tmuxSession: 'fleet-newborn',
      harness: 'codex',
      model: 'gpt-5.5',
      resumeId: null,
    }),
    liveCodexSessionIdentityResolver: async () => null,
    liveSessionIdentityTimeoutMs: 0,
    liveSessionIdentityPollMs: 1,
  })

  try {
    const result = await launcher.handlers.spawn({
      name: 'newborn',
      model: 'gpt',
      cwd,
      requester: { id: 'fleet:requester', name: 'requester' },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'missing-resume-handle')
    assert.match(result.error, /exact process retained for on-disk session recovery/)
    assert.equal(result.ownership_retained, true)
    assert.equal(sent.some(msg => msg.type === 'agent-seat'), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function testPendingSeatBindingResultDoesNotCountAsWritten() {
  const cwd = mkdtempSync(join(tmpdir(), 'tlda-wake-resume-'))
  const ledger = memoryLedger()
  await ledger.set('fleet:requester', {
    permissionGrant: 'test',
  })
  let bindAttempts = 0
  const launcher = createAgentLauncher({
    activeEnvName: 'prod',
    configDir: cwd,
    loadDaemonLaunchConfig: () => configFor(cwd),
    log: { info() {}, warn() {} },
    machineId: 'mini',
    permissionLedger: ledger,
    sendMsg: () => {},
    getProjects: () => [{ name: 'test-doc', sourceDir: cwd }],
    tmux: async (cmd) => {
      assert.ok(cmd === 'has-session' || cmd === 'kill-session')
    },
    spawnImpl: async () => ({
      ok: true,
      pending: true,
      fleetId: 'fleet:pending-bind',
      tmuxSession: 'fleet-pending-bind',
      harness: 'codex',
      model: 'gpt-5.5',
      resumeId: null,
    }),
    liveCodexSessionIdentityResolver: async () => ({
      sessionId: 'rollout-pending-bind',
      jsonlPath: join(cwd, 'rollout-pending-bind.jsonl'),
      model: 'gpt-5.5',
    }),
    bindAgentSeatImpl: async () => {
      bindAttempts += 1
      return { bound: false, pending: true, payload: { agent_id: 'fleet:pending-bind' } }
    },
    liveSessionIdentityTimeoutMs: 0,
    liveSessionIdentityPollMs: 1,
  })

  try {
    const result = await launcher.handlers.spawn({
      name: 'pending-bind',
      model: 'gpt',
      cwd,
      requester: { id: 'fleet:requester', name: 'requester' },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'missing-resume-handle')
    assert.match(result.error, /exact process retained for on-disk session recovery/)
    assert.equal(bindAttempts, 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function testFreshStartPersistsRecoveryBeforeReturningPending() {
  const cwd = mkdtempSync(join(tmpdir(), 'tlda-wake-resume-'))
  const ledger = memoryLedger()
  await ledger.set('fleet:requester', {
    permissionGrant: 'test',
  })
  const persisted = []
  let killed = false
  const launcher = createAgentLauncher({
    activeEnvName: 'prod', configDir: cwd, loadDaemonLaunchConfig: () => configFor(cwd),
    log: { info() {}, warn() {} }, machineId: 'mini', permissionLedger: ledger,
    sendMsg: () => {}, getProjects: () => [{ name: 'test-doc', sourceDir: cwd }],
    tmux: async cmd => { if (cmd === 'kill-session') killed = true },
    spawnImpl: async () => ({
      ok: true, pending: false, localAgentId: 'local:newborn', fleetId: 'fleet:newborn',
      tmuxSession: 'fleet-newborn', harness: 'codex', model: 'gpt-5.5', resumeId: null,
    }),
    liveCodexSessionIdentityResolver: async () => null,
    persistPendingSeatBinding: async payload => {
      persisted.push(payload)
      return { ok: true, pending: true, obligation: { ...payload, obligation_id: 'obligation:newborn' } }
    },
    liveSessionIdentityTimeoutMs: 0, liveSessionIdentityPollMs: 1,
  })
  try {
    const result = await launcher.handlers.spawn({
      name: 'newborn', model: 'gpt', cwd,
      requester: { id: 'fleet:requester', name: 'requester' },
    })
    assert.equal(result.ok, true)
    assert.equal(result.pending, true)
    assert.equal(result.binding_obligation_id, 'obligation:newborn')
    assert.equal(killed, false)
    assert.deepEqual(persisted.map(row => ({
      agent_id: row.agent_id, local_agent_id: row.local_agent_id,
      daemon_key: row.daemon_key,
    })), [{
      agent_id: 'fleet:newborn', local_agent_id: 'local:newborn',
      daemon_key: 'mini:prod',
    }])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function testPendingRecoveryFindsOnDiskSessionAndIsIdempotent() {
  const cwd = mkdtempSync(join(tmpdir(), 'tlda-wake-resume-'))
  const rollout = join(cwd, 'rollout-recovered.jsonl')
  const obligation = {
    obligation_id: 'obligation:recover', agent_id: 'fleet:recover',
    daemon_key: 'mini:prod', tmux_session: 'fleet-recover',
  }
  let resolveCalls = 0
  let completeCalls = 0
  let terminalCalls = 0
  const manager = createPendingSeatBindingManager({
    watchPath: () => cwd,
    watch: () => ({ close() {} }),
    setPeriodic: () => ({ unref() {} }),
    clearPeriodic() {},
    tmuxAlive: async () => true,
    resolveIdentity: async () => {
      resolveCalls += 1
      if (!existsSync(rollout)) return null
      return { sessionId: 'rollout-recovered', jsonlPath: rollout, model: 'gpt-5.5' }
    },
    complete: async (_obligation, identity) => {
      completeCalls += 1
      assert.equal(identity.sessionId, 'rollout-recovered')
    },
    terminal: async () => { terminalCalls += 1 },
    log: { warn() {} },
  })
  try {
    assert.equal(manager.accept(obligation), true)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(completeCalls, 0)
    writeFileSync(rollout, '{"type":"session_meta","payload":{"id":"rollout-recovered"}}\n')
    await manager.attempt(obligation)
    await manager.attempt(obligation)
    assert.ok(resolveCalls >= 2)
    assert.equal(completeCalls, 1)
    assert.equal(terminalCalls, 0)
    assert.equal(manager.pendingCount(), 0)
  } finally {
    manager.close()
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function testRestartReplayReusesExactBoundSeatAndCapability() {
  const obligation = {
    obligation_id: 'obligation:restart', agent_id: 'fleet:restart',
    daemon_key: 'mini:prod', tmux_session: 'fleet-restart',
  }
  const identity = { sessionId: 'rollout-restart', jsonlPath: '/tmp/rollout-restart.jsonl', model: 'gpt-5.5' }
  const capability = 'termcap:unchanged'
  let seat = null
  let bindCalls = 0
  let completionAttempts = 0
  const managers = []

  function makeManager({ failCompletion }) {
    const manager = createPendingSeatBindingManager({
      watchPath: () => '/tmp', watch: () => ({ close() {} }),
      setPeriodic: () => ({ unref() {} }), clearPeriodic() {},
      tmuxAlive: async () => true,
      resolveIdentity: async () => identity,
      complete: (replayedObligation, recoveredIdentity) => completePendingSeatBinding({
        obligation: replayedObligation,
        identity: recoveredIdentity,
        readExistingBinding: async () => reuseExactPendingSeatBinding({
          obligation: replayedObligation,
          identity: recoveredIdentity,
          seat,
          local: seat ? { terminalCapability: capability } : null,
        }),
        bindSeat: async () => {
          bindCalls += 1
          seat = {
            agent_id: obligation.agent_id, session_id: identity.sessionId,
            daemon_key: obligation.daemon_key, terminal_capability: capability,
          }
          return { bound: true, seat }
        },
        emitComplete: async () => {
          completionAttempts += 1
          if (failCompletion) throw new Error('daemon exited before completion acknowledgement')
        },
      }),
      terminal: async () => { throw new Error('replay must not retire the exact live seat') },
      log: { warn() {} },
    })
    managers.push(manager)
    return manager
  }

  try {
    const beforeRestart = makeManager({ failCompletion: true })
    assert.equal(beforeRestart.accept(obligation), true)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(bindCalls, 1)
    assert.equal(completionAttempts, 1)
    assert.equal(beforeRestart.pendingCount(), 1)
    beforeRestart.close()

    const afterRestart = makeManager({ failCompletion: false })
    assert.equal(afterRestart.accept(obligation), true)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(bindCalls, 1)
    assert.equal(completionAttempts, 2)
    assert.equal(seat.terminal_capability, capability)
    assert.equal(afterRestart.pendingCount(), 0)

    let respawns = 0
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const wake = await runWakeRouteLifecycle({
        agentId: obligation.agent_id,
        agent: { id: obligation.agent_id, metadata: { kind: 'codex', deliveryChannel: 'tmux' } },
        seat,
        daemonKey: obligation.daemon_key,
        ownerDaemon: { readyState: 1 },
        traceId: `trace-restart-${attempt}`,
        isAgentAwake: () => false,
        sendRpcResilient: async (_daemonKey, type, params) => {
          assert.equal(type, 'check-alive')
          assert.equal(params.terminal_capability, capability)
          return { alive: true }
        },
        sendRpc: async () => { respawns += 1; throw new Error('must not respawn') },
        spawnLibrarian: {
          observeLiveness() {},
          decideWake: () => ({ action: 'deliver' }),
        },
        recordRuntimeLiveness() {},
      })
      assert.equal(wake.action, 'already-awake')
    }
    assert.equal(respawns, 0)
  } finally {
    for (const manager of managers) manager.close()
  }
}

async function testRespawnKeepsExistingIdGrantAndReportsMissingResume() {
  const cwd = mkdtempSync(join(tmpdir(), 'tlda-wake-resume-'))
  const ledger = memoryLedger()
  const originalGrant = {
    permissionGrant: 'test',
    source: 'existing-seat',
  }
  await ledger.set('fleet:existing', originalGrant)
  const launcher = createAgentLauncher({
    activeEnvName: 'prod',
    configDir: cwd,
    loadDaemonLaunchConfig: () => configFor(cwd),
    log: { info() {}, warn() {} },
    machineId: 'mini',
    permissionLedger: ledger,
    sendMsg: () => {},
    getProjects: () => [{ name: 'test-doc', sourceDir: cwd }],
    tmux: async () => { throw new Error('tmux should not be reached when resume handle is missing') },
    spawnImpl: async () => {
      const error = new Error("can't find a daemon-ledger resume identity for existing (fleet:existing); this is a ledger write/key bug, not a lost rollout")
      error.reason = 'missing-resume-handle'
      error.code = 'missing-resume-handle'
      throw error
    },
    liveSessionIdentityTimeoutMs: 0,
  })

  try {
    const result = await launcher.handlers.spawn({
      agent_id: 'fleet:existing',
      name: 'fleet:existing',
      respawn: true,
      cwd,
      requester: { id: 'fleet:requester', name: 'requester' },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'missing-resume-handle')
    assert.match(result.error, /daemon-ledger resume identity|missing-resume-handle|could not locate/i)
    assert.deepEqual(ledger.get('fleet:existing'), originalGrant)
    assert.equal([...ledger.rows.keys()].filter(id => id.startsWith('fleet:')).length, 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

await testLiveTmuxWakeDoesNotRespawnWhenServerStatusIsStale()
await testFreshStartRetainsRuntimeWhenDurableRecoveryCannotBePersisted()
await testPendingSeatBindingResultDoesNotCountAsWritten()
await testFreshStartPersistsRecoveryBeforeReturningPending()
await testPendingRecoveryFindsOnDiskSessionAndIsIdempotent()
await testRestartReplayReusesExactBoundSeatAndCapability()
await testRespawnKeepsExistingIdGrantAndReportsMissingResume()
rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
console.log('wake resume handle regression tests passed')
