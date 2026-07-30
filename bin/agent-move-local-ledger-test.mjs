#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PermissionLedger } from '../agent-launch/permission-ledger.mjs'
import { attachToAgent, moveAgentToEnvironment } from '../cli/tlda.mjs'
import { runtimeStateFromProcessList } from '../agent-launch/tmux.mjs'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-move-ledger-'))
const ledger = new PermissionLedger(path.join(tempDir, 'permissions.sqlite'))
try {
  ledger.setSyncForTest('fleet:test-move', {
    permissionGrant: 'app-dev',
    source: 'test',
  })
  ledger.setSessionSync('fleet:test-move', {
    friendlyName: 'test-move',
    sessionId: '019fa987-f687-76f1-989b-22a56b4287a5',
    sessionKind: 'codex',
    sessionPath: '/tmp/test-move.jsonl',
    tmuxSession: 'fleet-test-move',
    model: 'gpt-5.6-sol',
    machineId: 'mini',
    envName: 'testing',
    daemonKey: 'mini:testing',
    terminalCapability: 'termcap:source',
    cwd: '/tmp/project',
  })

  const moved = ledger.moveAddressSync('fleet:test-move', {
    fromMachineId: 'mini',
    fromEnvName: 'testing',
    toMachineId: 'mini',
    toEnvName: 'stable',
  })
  assert.equal(moved.alreadyMoved, false)
  assert.equal(moved.row.machineId, 'mini')
  assert.equal(moved.row.envName, 'stable')
  assert.equal(moved.row.daemonKey, 'mini:stable')
  assert.equal(moved.row.terminalCapability, null)
  assert.equal(moved.row.sessionId, '019fa987-f687-76f1-989b-22a56b4287a5')
  assert.equal(moved.row.tmuxSession, 'fleet-test-move')

  const repeated = ledger.moveAddressSync('fleet:test-move', {
    fromMachineId: 'mini',
    fromEnvName: 'testing',
    toMachineId: 'mini',
    toEnvName: 'stable',
  })
  assert.equal(repeated.alreadyMoved, true)
  assert.throws(() => ledger.moveAddressSync('fleet:test-move', {
    fromMachineId: 'mini',
    fromEnvName: 'other',
    toMachineId: 'mini',
    toEnvName: 'production',
  }), /address conflict/)
  assert.equal(ledger.get('fleet:test-move').envName, 'stable')
} finally {
  await ledger.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
}

let attached = null
const attachResult = await attachToAgent('test-move', {
  openLedger: () => ({
    resolve: identifier => {
      assert.equal(identifier, 'test-move')
      return {
        mintId: 'mint:test-move',
        fleetId: 'fleet:test-move',
        friendlyName: 'test-move',
        processState: { tmux_session: 'exact-local-session' },
      }
    },
    close() {},
  }),
  spawnSyncImpl: (command, args) => {
    attached = { command, args }
    return { status: 0 }
  },
  exitImpl() {},
})
assert.equal(attachResult.ok, true)
assert.equal(attached.command, 'tmux')
assert.deepEqual(attached.args.slice(-3), ['attach-session', '-t', '=exact-local-session'])

const runtimeIdentity = runtimeStateFromProcessList(['10'], [
  '10 1 -zsh',
  '11 10 node /opt/homebrew/bin/codex -c mcp_servers.tlda.env.FLEET_ID="fleet:test-move" -c mcp_servers.tlda.env.TLDA_ENV="testing" -c mcp_servers.tlda.env.FLEET_DAEMON_KEY="mini:testing"',
  '12 11 node /tmp/tlda/mcp-server/index.mjs',
].join('\n'))
assert.deepEqual(runtimeIdentity, {
  runtime: true,
  mcp: true,
  daemonKey: 'mini:testing',
  fleetId: 'fleet:test-move',
  envName: 'testing',
})

const moveAgent = {
  id: 'fleet:test-move',
  friendly_name: 'test-move',
  machine_id: 'mini',
  env_name: 'stable',
  metadata: { kind: 'codex', cwd: '/tmp/project' },
}
const moveLog = []
let readbackCalls = 0
const successfulMove = await moveAgentToEnvironment({
  agent: moveAgent,
  sourceEnv: 'stable',
  targetEnv: 'testing',
  hibernateImpl: async () => ({ status: 0 }),
  moveAddressImpl: async () => ({ alreadyMoved: false }),
  reserveShellImpl: async () => ({ ok: true }),
  lifecycleImpl: async () => ({ ok: true }),
  ensureWakeGrantImpl: async () => ({ permissionGrant: 'app-dev', permissionSet: {} }),
  readbackImpl: async () => {
    readbackCalls += 1
    return { ok: true, tmuxSession: 'fleet-test-move' }
  },
  log: { log: line => moveLog.push(line) },
})
assert.equal(successfulMove.ok, true)
assert.equal(readbackCalls, 1)
assert.match(moveLog.at(-1), /runtime and identity read back/)

const addressMoves = []
const lifecycleCalls = []
let rollbackReadbacks = 0
await assert.rejects(() => moveAgentToEnvironment({
  agent: moveAgent,
  sourceEnv: 'stable',
  targetEnv: 'testing',
  hibernateImpl: async () => ({ status: 0 }),
  moveAddressImpl: async (_id, move) => {
    addressMoves.push(`${move.fromEnvName}->${move.toEnvName}`)
    return { alreadyMoved: false }
  },
  reserveShellImpl: async () => ({ ok: true }),
  lifecycleImpl: async (op, _params, options) => {
    lifecycleCalls.push(`${op}:${options.socketPath}`)
    if (lifecycleCalls.length === 1) throw new Error('injected target wake failure')
    return { ok: true }
  },
  ensureWakeGrantImpl: async () => ({ permissionGrant: 'app-dev', permissionSet: {} }),
  readbackImpl: async (_id, target) => {
    rollbackReadbacks += 1
    assert.equal(target.envName, 'stable')
    return { ok: true, tmuxSession: 'fleet-test-move' }
  },
  terminateRuntimeImpl: async () => true,
  log: { log() {} },
}), /Rolled back to stable; runtime and identity read back/)
assert.deepEqual(addressMoves, ['stable->testing', 'testing->stable'])
assert.equal(lifecycleCalls.length, 2)
assert.equal(rollbackReadbacks, 1)

console.log('agent move local-ledger tests passed')
