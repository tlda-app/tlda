#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PermissionLedger } from '../agent-launch/permission-ledger.mjs'
import { attachToAgent } from '../cli/tlda.mjs'

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

console.log('agent move local-ledger tests passed')
