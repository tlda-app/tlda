/**
 * One name for the config directory: every resolver honors TLDA_CONFIG_DIR,
 * and the removed TLDA_DAEMON_CONFIG_DIR redirects nothing.
 *
 * Run: node agent-launch/config-dir.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { defaultDaemonConfigPath, defaultPermissionLedgerPath } from './permission-ledger.mjs'
import { defaultLocalAgentLedgerPath } from './local-agent-ledger.mjs'

const LIVE = path.join(os.homedir(), '.config', 'tlda')

function withEnv(vars, fn) {
  const prev = {}
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key]
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  try {
    return fn()
  } finally {
    for (const key of Object.keys(vars)) {
      if (prev[key] === undefined) delete process.env[key]
      else process.env[key] = prev[key]
    }
  }
}

test('every resolver honors TLDA_CONFIG_DIR', () => {
  withEnv({ TLDA_CONFIG_DIR: '/tmp/cfg-single', TLDA_DAEMON_CONFIG_DIR: undefined }, () => {
    assert.equal(defaultDaemonConfigPath(), path.join('/tmp/cfg-single', 'daemon.yaml'))
    assert.equal(defaultPermissionLedgerPath(), path.join('/tmp/cfg-single', 'fleet-daemon.db'))
    assert.equal(defaultLocalAgentLedgerPath(), path.join('/tmp/cfg-single', 'fleet-daemon.db'))
  })
})

test('the removed TLDA_DAEMON_CONFIG_DIR redirects nothing', () => {
  withEnv({ TLDA_CONFIG_DIR: undefined, TLDA_DAEMON_CONFIG_DIR: '/tmp/cfg-legacy' }, () => {
    assert.equal(defaultDaemonConfigPath(), path.join(LIVE, 'daemon.yaml'))
    assert.equal(defaultPermissionLedgerPath(), path.join(LIVE, 'fleet-daemon.db'))
    assert.equal(defaultLocalAgentLedgerPath(), path.join(LIVE, 'fleet-daemon.db'))
  })
})
