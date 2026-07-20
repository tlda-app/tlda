#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentLauncher } from '../agent-launch/agent-launch.mjs'
import { runWakeRouteLifecycle } from '../server/lib/wake-route-lifecycle.mjs'

function permissionSet(name = 'test') {
  return {
    type: 'permission-set',
    name,
    operations: {
      read: { allow: ['**'], deny: [] },
      write: { allow: ['**'], deny: [] },
      spawn: { allow: ['**'], deny: [] },
    },
    rules: [],
  }
}

function configFor(cwd) {
  return {
    profiles: {
      test: {
        read: { allow: ['**'], deny: [] },
        write: { allow: ['**'], deny: [] },
        spawn: { allow: ['**'], deny: [] },
      },
    },
    spawnPolicy: { projectProfiles: { [cwd]: 'test' } },
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
  const wakeAttempts = []
  const result = await runWakeRouteLifecycle({
    agentId: 'fleet:live',
    agent: { id: 'fleet:live', friendly_name: 'live-agent', metadata: { kind: 'codex', deliveryChannel: 'tmux' } },
    seat: {
      agent_id: 'fleet:live',
      session_id: 'rollout-live',
      daemon_key: 'mini:prod',
      terminal_capability: 'termcap:live',
    },
    daemonKey: 'mini:prod',
    ownerDaemon: { readyState: 1 },
    traceId: 'trace-live',
    isAgentAlive: () => false,
    sendRpcResilient: async (daemonKey, type, params) => {
      assert.equal(daemonKey, 'mini:prod')
      assert.equal(type, 'check-alive')
      assert.deepEqual(params, {
        agent_id: 'fleet:live',
        terminal_capability: 'termcap:live',
      })
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
    recordWakeAttempt: async event => { wakeAttempts.push(event) },
    recordRuntimeLiveness() {},
  })

  assert.equal(result.action, 'already-awake')
  assert.equal(spawnCalls, 0)
  assert.ok(wakeAttempts.some(event => event.reason === 'already-awake' && event.outcome === 'delivered'))
}

async function testFreshStartFailsWhenDurableHandleCannotBePersisted() {
  const cwd = mkdtempSync(join(tmpdir(), 'tlda-wake-resume-'))
  const ledger = memoryLedger()
  await ledger.set('fleet:requester', {
    permissionSet: permissionSet('requester'),
    permissionProfile: 'test',
    spawnPolicy: { policy: 'unsandboxed' },
  })
  const sent = []
  const launcher = createAgentLauncher({
    activeConfigName: 'prod',
    configDir: cwd,
    loadConfig: () => configFor(cwd),
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
      pending: true,
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
    assert.match(result.error, /could not persist a durable resume handle at session start/)
    assert.equal(ledger.get('fleet:newborn'), null)
    assert.equal(sent.some(msg => msg.type === 'agent-seat'), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function testPendingSeatBindingResultDoesNotCountAsWritten() {
  const cwd = mkdtempSync(join(tmpdir(), 'tlda-wake-resume-'))
  const ledger = memoryLedger()
  await ledger.set('fleet:requester', {
    permissionSet: permissionSet('requester'),
    permissionProfile: 'test',
    spawnPolicy: { policy: 'unsandboxed' },
  })
  let bindAttempts = 0
  const launcher = createAgentLauncher({
    activeConfigName: 'prod',
    configDir: cwd,
    loadConfig: () => configFor(cwd),
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
    assert.match(result.error, /could not persist a durable resume handle at session start/)
    assert.equal(bindAttempts, 1)
    assert.equal(ledger.get('fleet:pending-bind'), null)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

await testLiveTmuxWakeDoesNotRespawnWhenServerStatusIsStale()
await testFreshStartFailsWhenDurableHandleCannotBePersisted()
await testPendingSeatBindingResultDoesNotCountAsWritten()
console.log('wake resume handle regression tests passed')
