import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { spawn } from '../agent-launch/index.mjs'
import { createLocalAgentLedger } from '../agent-launch/local-agent-ledger.mjs'
import { FleetStore } from '../server/lib/fleet-store.mjs'

function permissionSet(name = 'app-dev') {
  return {
    type: 'permission-set',
    name,
    operations: {
      read: { allow: ['**'], deny: [] },
      write: { allow: ['**'], deny: [] },
      spawn: { allow: [], deny: [] },
    },
    rules: [],
    projectedPolicy: { name, policy: 'unsandboxed' },
  }
}

const config = {
  modelSpecs: {
    gpt: {
      alias: 'gpt',
      id: 'gpt-5.5',
      provider: 'codex',
      harness: 'codex',
      harnessOptions: { required: [], preferences: [], controls: false },
    },
  },
  spawnPolicy: {
    permissionProfiles: {
      'app-dev': permissionSet('app-dev'),
    },
  },
}

test('shared fresh mint launches locally without a server id and persists its recipe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-offline-mint-'))
  const ledgerFile = path.join(dir, 'fleet-daemon.db')
  let command = null
  try {
    const result = await spawn({
      spawnMode: 'fresh',
      name: 'offline-test',
      model: 'gpt',
      config,
      cwd: dir,
      breakGlass: true,
      acknowledgeNoSecurity: true,
      explicitPolicy: true,
      localAgentLedgerPath: ledgerFile,
      _deps: {
        resolveApi: () => 'https://unavailable.example',
        ensureServer: async () => false,
        uniqueSessionName: async () => 'fleet-offline-test',
        resolveDnsAlias: async () => null,
        spawnTmux: async (_tmux, _cwd, cmd) => { command = cmd; return true },
        injectCodexPrompt: async () => true,
      },
    })
    assert.match(result.localAgentId, /^local:/)
    assert.equal(result.fleetId, null)
    assert.equal(result.registrationDeferred, true)
    assert.match(command, new RegExp(`FLEET_LOCAL_ID='${result.localAgentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
    assert.doesNotMatch(command, /FLEET_ID=/)

    const ledger = createLocalAgentLedger(ledgerFile)
    try {
      const stored = ledger.get(result.localAgentId)
      assert.equal(stored.serverAgentId, null)
      assert.equal(stored.process.tmuxName, 'fleet-offline-test')
      assert.equal(stored.process.cwd, dir)
      assert.equal(stored.conversation.harness, 'codex')
      assert.equal(stored.process.permissionProfile, null)
    } finally { ledger.close() }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fresh mint persists the resolved grant profile supplied by the daemon', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-offline-requested-profile-'))
  const ledgerFile = path.join(dir, 'fleet-daemon.db')
  try {
    const result = await spawn({
      spawnMode: 'fresh',
      name: 'offline-requested-profile-test',
      model: 'gpt',
      config,
      cwd: dir,
      permissionProfile: 'app-dev',
      spawnPolicy: { name: 'app-dev', policy: 'unsandboxed' },
      permissionSet: permissionSet('app-dev'),
      explicitPolicy: true,
      localAgentLedgerPath: ledgerFile,
      _deps: {
        resolveApi: () => 'https://unavailable.example',
        ensureServer: async () => false,
        uniqueSessionName: async () => 'fleet-offline-requested-profile-test',
        resolveDnsAlias: async () => null,
        spawnTmux: async () => true,
        injectCodexPrompt: async () => true,
      },
    })

    const ledger = createLocalAgentLedger(ledgerFile)
    try {
      const stored = ledger.get(result.localAgentId)
      assert.equal(stored.process.permissionProfile, 'app-dev')
    } finally { ledger.close() }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fresh Codex prompt failure returns the launched route without destroying runtime evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-prompt-failure-route-'))
  const ledgerFile = path.join(dir, 'fleet-daemon.db')
  let terminated = false
  try {
    const result = await spawn({
      spawnMode: 'fresh',
      agentId: 'fleet:prompt-failure',
      name: 'prompt-failure',
      model: 'gpt',
      config,
      cwd: dir,
      breakGlass: true,
      acknowledgeNoSecurity: true,
      explicitPolicy: true,
      localAgentLedgerPath: ledgerFile,
      _deps: {
        resolveApi: () => 'https://fleet.example',
        ensureServer: async () => true,
        uniqueSessionName: async () => 'fleet-prompt-failure',
        resolveDnsAlias: async () => null,
        checkFreshNameAvailable: async () => {},
        wsReserveShell: async () => ({ server_agent_id: 'fleet:prompt-failure' }),
        spawnTmux: async () => true,
        injectCodexPrompt: async () => false,
        terminateTmuxSession: async () => { terminated = true; return true },
      },
    })

    assert.equal(result.fleetId, 'fleet:prompt-failure')
    assert.equal(result.tmuxSession, 'fleet-prompt-failure')
    assert.deepEqual(result.promptDelivery, { ok: false, reason: 'unverified' })
    assert.equal(terminated, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fresh Codex polls exact identity during prompt transport and awaits both settlements', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-concurrent-identity-poll-'))
  const ledgerFile = path.join(dir, 'fleet-daemon.db')
  const events = []
  let resolveIdentity
  let resolvePrompt
  const identity = new Promise(resolve => { resolveIdentity = resolve })
  const prompt = new Promise(resolve => { resolvePrompt = resolve })
  try {
    const spawned = spawn({
      spawnMode: 'fresh',
      agentId: 'fleet:concurrent-identity',
      name: 'concurrent-identity',
      model: 'gpt',
      config,
      cwd: dir,
      breakGlass: true,
      acknowledgeNoSecurity: true,
      explicitPolicy: true,
      localAgentLedgerPath: ledgerFile,
      startFreshIdentityPolling: async (route) => {
        events.push(`identity-start:${route.tmuxSession}`)
        const resolved = await identity
        events.push('identity-resolved')
        return resolved
      },
      _deps: {
        resolveApi: () => 'https://fleet.example',
        ensureServer: async () => true,
        uniqueSessionName: async () => 'fleet-concurrent-identity',
        resolveDnsAlias: async () => null,
        checkFreshNameAvailable: async () => {},
        wsReserveShell: async () => ({ server_agent_id: 'fleet:concurrent-identity' }),
        spawnTmux: async () => { events.push('runtime-launched'); return true },
        injectCodexPrompt: async () => {
          events.push('prompt-start')
          const delivered = await prompt
          events.push('prompt-settled')
          return delivered
        },
      },
    })

    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(events, ['runtime-launched', 'identity-start:fleet-concurrent-identity', 'prompt-start'])
    resolveIdentity({ identity: { sessionId: '11111111-2222-4333-8444-555555555555', model: 'gpt-5.6-sol' }, diagnostics: null })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(events.at(-1), 'identity-resolved')
    resolvePrompt(false)

    const result = await spawned
    assert.equal(events.at(-1), 'prompt-settled')
    assert.equal(result.identityResolution.identity.sessionId, '11111111-2222-4333-8444-555555555555')
    assert.deepEqual(result.promptDelivery, { ok: false, reason: 'unverified' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fresh Codex preserves later exact identity when prompt transport rejects first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-transport-reject-identity-later-'))
  const ledgerFile = path.join(dir, 'fleet-daemon.db')
  let resolveIdentity
  let rejectPrompt
  let settled = false
  const identity = new Promise(resolve => { resolveIdentity = resolve })
  const prompt = new Promise((_, reject) => { rejectPrompt = reject })
  try {
    const spawned = spawn({
      spawnMode: 'fresh', agentId: 'fleet:transport-reject', name: 'transport-reject', model: 'gpt', config, cwd: dir,
      breakGlass: true, acknowledgeNoSecurity: true, explicitPolicy: true, localAgentLedgerPath: ledgerFile,
      startFreshIdentityPolling: async () => await identity,
      _deps: {
        resolveApi: () => 'https://fleet.example', ensureServer: async () => true,
        uniqueSessionName: async () => 'fleet-transport-reject', resolveDnsAlias: async () => null,
        checkFreshNameAvailable: async () => {}, wsReserveShell: async () => ({ server_agent_id: 'fleet:transport-reject' }),
        spawnTmux: async () => true, injectCodexPrompt: async () => await prompt,
      },
    }).finally(() => { settled = true })

    rejectPrompt(new Error('transport failed'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    resolveIdentity({ identity: { sessionId: '66666666-2222-4333-8444-555555555555', model: 'gpt-5.6-sol' }, diagnostics: null })

    const result = await spawned
    assert.equal(result.identityResolution.identity.sessionId, '66666666-2222-4333-8444-555555555555')
    assert.deepEqual(result.promptDelivery, { ok: false, reason: 'unverified' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fresh Codex awaits later prompt settlement when identity polling rejects first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-identity-reject-prompt-later-'))
  const ledgerFile = path.join(dir, 'fleet-daemon.db')
  let rejectIdentity
  let resolvePrompt
  let settled = false
  const identity = new Promise((_, reject) => { rejectIdentity = reject })
  const prompt = new Promise(resolve => { resolvePrompt = resolve })
  try {
    const spawned = spawn({
      spawnMode: 'fresh', agentId: 'fleet:identity-reject', name: 'identity-reject', model: 'gpt', config, cwd: dir,
      breakGlass: true, acknowledgeNoSecurity: true, explicitPolicy: true, localAgentLedgerPath: ledgerFile,
      startFreshIdentityPolling: async () => await identity,
      _deps: {
        resolveApi: () => 'https://fleet.example', ensureServer: async () => true,
        uniqueSessionName: async () => 'fleet-identity-reject', resolveDnsAlias: async () => null,
        checkFreshNameAvailable: async () => {}, wsReserveShell: async () => ({ server_agent_id: 'fleet:identity-reject' }),
        spawnTmux: async () => true, injectCodexPrompt: async () => await prompt,
      },
    }).finally(() => { settled = true })

    rejectIdentity(new Error('identity poll failed'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    resolvePrompt(true)

    const result = await spawned
    assert.deepEqual(result.identityResolution, { identity: null, diagnostics: { failureStage: 'poll-error' } })
    assert.equal(result.promptDelivery, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('offline fresh Codex prompt failure preserves the failure fact for caller cleanup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-offline-prompt-failure-'))
  const ledgerFile = path.join(dir, 'fleet-daemon.db')
  try {
    const result = await spawn({
      spawnMode: 'fresh',
      name: 'offline-prompt-failure',
      model: 'gpt',
      config,
      cwd: dir,
      breakGlass: true,
      acknowledgeNoSecurity: true,
      explicitPolicy: true,
      localAgentLedgerPath: ledgerFile,
      _deps: {
        resolveApi: () => 'https://unavailable.example',
        ensureServer: async () => false,
        uniqueSessionName: async () => 'fleet-offline-prompt-failure',
        resolveDnsAlias: async () => null,
        spawnTmux: async () => true,
        injectCodexPrompt: async () => false,
      },
    })

    assert.equal(result.registrationDeferred, true)
    assert.deepEqual(result.promptDelivery, { ok: false, reason: 'unverified' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an existing local identity receives the complete wake recipe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-local-recipe-'))
  const ledger = createLocalAgentLedger(path.join(dir, 'fleet-daemon.db'))
  try {
    ledger.create({ localAgentId: 'local:recipe', serverAgentId: 'fleet:recipe' })
    ledger.create({
      localAgentId: 'local:recipe',
      serverAgentId: 'fleet:recipe',
      friendlyName: 'recipe-agent',
      harness: 'codex',
      model: 'gpt-5.5',
      tmuxName: 'fleet-recipe-agent',
      cwd: dir,
      permissionProfile: 'app-dev',
    })
    const stored = ledger.findByFriendlyName('recipe-agent')
    assert.equal(stored.process.permissionProfile, 'app-dev')
    assert.equal(stored.process.tmuxName, 'fleet-recipe-agent')
    assert.equal(stored.conversation.harness, 'codex')
  } finally {
    ledger.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('server daemon binding is immutable and idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-server-binding-'))
  const store = new FleetStore(path.join(dir, 'fleet.db'), { taskDoc: false })
  try {
    const first = store.bindDaemonAgent({ daemonKey: 'air:live', localAgentId: 'local:one', agentId: 'fleet:one' })
    assert.equal(first.agent_id, 'fleet:one')
    assert.equal(store.bindDaemonAgent({ daemonKey: 'air:live', localAgentId: 'local:one', agentId: 'fleet:one' }).agent_id, 'fleet:one')
    assert.throws(() => store.bindDaemonAgent({ daemonKey: 'air:live', localAgentId: 'local:one', agentId: 'fleet:two' }), /already bound/)
    assert.throws(() => store.bindDaemonAgent({ daemonKey: 'mini:live', localAgentId: 'local:two', agentId: 'fleet:one' }), /already bound/)
  } finally {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
