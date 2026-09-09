#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const configDir = mkdtempSync(join(tmpdir(), 'tlda-agent-wake-grant-'))
process.env.TLDA_DAEMON_CONFIG_DIR = configDir
process.env.TLDA_ENV = 'testing'

writeFileSync(join(configDir, 'server.yaml'), '')

writeFileSync(join(configDir, 'daemon.yaml'), `machineId: mini
environments:
  default: testing
  values:
    testing:
      database: http://127.0.0.1:9
      store: http://127.0.0.1:9
      licenseKey: ""
regions:
  machine: ["**"]
profiles:
  wd:
    read: { allow: [machine], deny: [] }
    write: { allow: [machine], deny: [] }
  app-dev:
    read: { allow: [machine], deny: [] }
    write: { allow: [machine], deny: [] }
grants:
  localhost: wd
models:
  default: gpt
  values:
    gpt:
      id: gpt-5.5
      harness:
        kind: codex
        required: []
        preferences: []
        controls: true
default: wd
`)

const { runFleetSpawn } = await import(`../cli/tlda.mjs?agent-wake-grant-test=${Date.now()}`)
const { MintStore } = await import('../daemon/mint-store.mjs')
const { createPermissionLedger } = await import('../agent-launch/permission-ledger.mjs')

async function recordAgent({ friendlyName, fleetId, cwd, metadata, ledgerGrant }) {
  const mintStore = new MintStore(join(configDir, 'daemon-mints.sqlite'), { defaultEnvName: 'testing' })
  try {
    const mintId = `mint-${friendlyName}`
    mintStore.ensure(mintId)
    mintStore.setFact(mintId, 'fleet_id', fleetId)
    mintStore.setFact(mintId, 'friendly_name', friendlyName)
    mintStore.setFact(mintId, 'env_name', 'testing')
    mintStore.setFact(mintId, 'metadata', metadata)
    mintStore.setFact(mintId, 'launch_recipe', { cwd })
  } finally {
    mintStore.close()
  }

  const ledger = createPermissionLedger(join(configDir, 'fleet-daemon.db'))
  try {
    await ledger.set(fleetId, { permissionGrant: ledgerGrant, source: 'test' })
  } finally {
    await ledger.close()
  }
}

async function wakeAndCapture(friendlyName) {
  let captured = null
  await runFleetSpawn([friendlyName], {
    configDir,
    localAgentLedgerPath: join(configDir, 'daemon-mints.sqlite'),
    lifecycleImpl: async (op, params) => {
      captured = { op, params }
      return { ok: true, tmux_session: `fleet-${friendlyName}` }
    },
  })
  return captured
}

try {
  await recordAgent({
    friendlyName: 'wake-meta-proof',
    fleetId: 'fleet:wake-meta-proof',
    cwd: '/tmp/tlda-wake-meta-proof',
    metadata: { kind: 'codex', permissionGrant: 'wd' },
    ledgerGrant: 'app-dev',
  })
  const metadataGrant = await wakeAndCapture('wake-meta-proof')
  assert.equal(metadataGrant.op, 'wake')
  assert.equal(metadataGrant.params.mint_id, 'mint-wake-meta-proof')
  assert.equal(metadataGrant.params.wait_until_complete, true)
  assert.equal('permissionGrant' in metadataGrant.params, false,
    'wake must leave durable grant resolution to the daemon instead of forwarding stale mint metadata')

  await recordAgent({
    friendlyName: 'wake-ledger-proof',
    fleetId: 'fleet:wake-ledger-proof',
    cwd: '/tmp/tlda-wake-ledger-proof',
    metadata: { kind: 'codex' },
    ledgerGrant: 'app-dev',
  })
  const ledgerGrant = await wakeAndCapture('wake-ledger-proof')
  assert.equal(ledgerGrant.op, 'wake')
  assert.equal(ledgerGrant.params.mint_id, 'mint-wake-ledger-proof')
  assert.equal(ledgerGrant.params.wait_until_complete, true)
  assert.equal('permissionGrant' in ledgerGrant.params, false,
    'wake without an operator override must leave the durable ledger grant to the daemon')

  console.log('agent wake grant regression: ok')
} finally {
  rmSync(configDir, { recursive: true, force: true })
}
