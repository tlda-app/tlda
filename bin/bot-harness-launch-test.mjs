#!/usr/bin/env node

import assert from 'node:assert/strict'
import { launchMintProcess } from '../agent-launch/index.mjs'
import { createHarnessRuntime } from '../daemon/harness-runtime.mjs'

let captured = null

const result = await launchMintProcess({
  mintId: 'mint-bot-test',
  fleetId: 'fleet:bot-test',
  name: 'sodd',
  kind: 'bot',
  cwd: process.cwd(),
  botName: 'todd',
  botScript: 'bin/bots/todd.mjs',
  botIdFile: '/tmp/tlda-bot-test/todd.fleet-id',
  botPidFile: '/tmp/tlda-bot-test/todd.pid',
  botHeartbeatFile: '/tmp/tlda-bot-test/todd.heartbeat',
  botWaitChannel: 'fleet-bot-todd-test-exit',
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
    uniqueSessionName: async () => 'fleet-sodd',
    resolveDnsAlias: async () => null,
    spawnTmux: async (tmuxSession, cwd, cmd, options) => {
      captured = { tmuxSession, cwd, cmd, options }
      return true
    },
  },
})

assert.equal(result.harness, 'bot')
assert.equal(result.model, 'bot')
assert.equal(result.tmux_session, 'fleet-sodd')
assert.equal(result.daemon_key, 'mini:testing')
assert.equal(captured.tmuxSession, 'fleet-sodd')
assert.match(captured.cmd, /FLEET_ID=.*fleet:bot-test/)
assert.match(captured.cmd, /FLEET_NAME=.*sodd/)
assert.match(captured.cmd, /TLDA_BOT_NAME=.*todd/)
assert.match(captured.cmd, /TLDA_BOT_REQUESTED_NAME=.*todd/)
assert.match(captured.cmd, /TLDA_BOT_IDFILE=.*\/tmp\/tlda-bot-test\/todd\.fleet-id/)
assert.match(captured.cmd, /FLEET_HARNESS=bot/)
assert.match(captured.cmd, /tmux wait-for -S .*fleet-bot-todd-test-exit/)
assert.equal(captured.options.sendKeys, false)

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
          ' 100     1 zsh -lc node /Users/skip/work/tlda/bin/bots/todd.mjs',
          ' 101   100 /opt/homebrew/bin/node /Users/skip/work/tlda/bin/bots/todd.mjs',
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
  tmux_session: 'fleet-sodd',
  metadata: { kind: 'bot' },
}, 'bot'), '100')

console.log('bot harness launch: ok')
