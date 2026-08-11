#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchMintProcess, spawn } from '../agent-launch/index.mjs'
import { runtimeStateFromProcessList } from '../agent-launch/tmux.mjs'
import { MintStore } from '../daemon/mint-store.mjs'
import { createHarnessRuntime } from '../daemon/harness-runtime.mjs'

let captured = null
let requestedUniqueSession = false

const result = await launchMintProcess({
  mintId: 'mint-bot-test',
  fleetId: 'fleet:bot-test',
  name: 'sodd',
  kind: 'bot',
  cwd: process.cwd(),
  botName: 'todd',
  botScript: '/opt/tlda-bots/todd/todd.mjs',
  botPidFile: '/tmp/tlda-bot-test/todd.pid',
  botHeartbeatFile: '/tmp/tlda-bot-test/todd.heartbeat',
  botWaitChannel: 'fleet-bot-todd-test-exit',
  tmuxSession: 'fleet-bot-todd_testing',
  exactTmuxSession: true,
  permissionGrant: { profile: 'test' },
  permissionSet: {
    name: 'test',
    operations: {
      read: { allow: ['cwd'], deny: [] },
      write: { allow: ['cwd'], deny: [] },
      spawn: { allow: [], deny: [] },
    },
  },
  acknowledgeNoSecurity: true,
  config: {},
  activeEnvName: 'testing',
  machineId: 'mini',
  _deps: {
    resolveApi: () => ({ base: 'https://example.invalid' }),
    uniqueSessionName: async () => {
      requestedUniqueSession = true
      throw new Error('durable bot wake must not allocate a different tmux name')
    },
    resolveDnsAlias: async () => null,
    spawnTmux: async (tmuxSession, cwd, cmd, options) => {
      captured = { tmuxSession, cwd, cmd, options }
      return true
    },
  },
})

assert.equal(result.harness, 'bot')
assert.equal(result.model, 'bot')
assert.equal(result.tmux_session, 'fleet-bot-todd_testing')
assert.equal(result.daemon_key, 'mini:testing')
assert.equal(requestedUniqueSession, false)
assert.equal(captured.tmuxSession, 'fleet-bot-todd_testing')
assert.match(captured.cmd, /FLEET_ID=.*fleet:bot-test/)
assert.match(captured.cmd, /FLEET_NAME=.*sodd/)
assert.match(captured.cmd, /TLDA_BOT_NAME=.*todd/)
assert.match(captured.cmd, /TLDA_BOT_REQUESTED_NAME=.*todd/)
assert.match(captured.cmd, /FLEET_HARNESS=bot/)
assert.match(captured.cmd, /tmux wait-for -S .*fleet-bot-todd-test-exit/)
assert.equal(captured.options.sendKeys, false)

const BOT_CONFIG = {
  modelSpecs: {
    bot: {
      alias: 'bot',
      id: 'bot',
      model: 'bot',
      harness: 'bot',
      kind: 'bot',
      provider: 'bot',
      group: 'bot',
      available: true,
      verified: true,
    },
  },
  modelCatalog: { default: 'bot', values: {} },
  permissionProfiles: {},
}
BOT_CONFIG.modelCatalog.values = BOT_CONFIG.modelSpecs

const BOT_PERMISSION_SET = {
  name: 'test',
  operations: {
    read: { allow: ['cwd'], deny: [] },
    write: { allow: ['cwd'], deny: [] },
    spawn: { allow: [], deny: [] },
  },
}

function writeBotWakeMint(dir) {
  const mintStorePath = join(dir, 'daemon-mints.sqlite')
  const store = new MintStore(mintStorePath)
  try {
    store.ensure('mint-bot-wake-test')
    store.setFact('mint-bot-wake-test', 'fleet_id', 'fleet:bot-wake-test')
    store.setFact('mint-bot-wake-test', 'friendly_name', 'bot-wake-test')
    store.updateLaunchRecipe('mint-bot-wake-test', { kind: 'bot', model: 'bot', cwd: process.cwd() })
    store.updateProcessState('mint-bot-wake-test', {
      fleet_id: 'fleet:bot-wake-test',
      local_agent_id: 'mint-bot-wake-test',
      name: 'bot-wake-test',
      harness: 'bot',
      model: 'bot',
      tmuxName: 'fleet-bot-wake-test',
      tmux_session: 'fleet-bot-wake-test',
      cwd: process.cwd(),
      permission_grant: 'test',
    })
  } finally {
    store.close()
  }
  return mintStorePath
}

async function wakeBotWithDeps(deps) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-bot-wake-'))
  try {
    const mintStorePath = writeBotWakeMint(dir)
    return await spawn({
      spawnMode: 'respawn',
      agentId: 'fleet:bot-wake-test',
      model: 'bot',
      config: BOT_CONFIG,
      mintStorePath,
      botScript: '/opt/tlda-bots/todd/todd.mjs',
      botName: 'todd',
      permissionSet: BOT_PERMISSION_SET,
      acknowledgeNoSecurity: true,
      _deps: {
        resolveApi: () => ({ base: 'https://example.invalid' }),
        ...deps,
      },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let runtimeProbeCount = 0
let wakeLaunchAttempts = 0
const alreadyLiveWake = await wakeBotWithDeps({
  sessionRuntimeState: async () => {
    runtimeProbeCount += 1
    return runtimeProbeCount === 1
      ? { runtime: false, mcp: false }
      : { runtime: true, mcp: true }
  },
  spawnTmux: async () => {
    wakeLaunchAttempts += 1
    return false
  },
})
assert.equal(alreadyLiveWake.alreadyAlive, true)
assert.equal(wakeLaunchAttempts, 1)
assert.equal(runtimeProbeCount, 2)

await assert.rejects(
  wakeBotWithDeps({
    sessionRuntimeState: async () => ({ runtime: false, mcp: false }),
    spawnTmux: async () => false,
  }),
  /tmux session fleet-bot-wake-test exists but has no live runtime/,
)

assert.equal(runtimeStateFromProcessList(['200'], [
  '200 1 zsh -lc FLEET_HARNESS=bot node /opt/tlda-bots/todd/todd.mjs',
  '201 200 /opt/homebrew/bin/node /opt/tlda-bots/todd/todd.mjs',
].join('\n')).runtime, true)

const runtime = createHarnessRuntime({
  execFileImpl: (cmd, args, options, callback) => {
    if (cmd === 'tmux') {
      callback(null, { stdout: '100\n' })
      return
    }
    if (cmd === 'ps') {
      callback(null, {
        stdout: [
          '  PID  PPID ARGS',
          ' 100     1 zsh -lc node /opt/tlda-bots/todd/todd.mjs',
          ' 101   100 /opt/homebrew/bin/node /opt/tlda-bots/todd/todd.mjs',
        ].join('\n'),
      })
      return
    }
    callback(new Error(`unexpected command ${cmd}`))
  },
})
assert.equal(await runtime.findRuntimePidForAgent({
  id: 'fleet:bot-test',
  friendly_name: 'todd',
  tmux_session: 'fleet-bot-todd_testing',
  metadata: { kind: 'bot' },
}, 'bot'), '100')

console.log('bot harness launch: ok')
