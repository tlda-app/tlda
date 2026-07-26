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
defaultEnv: testing
environments:
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

async function recordAgent({ friendlyName, fleetId, cwd, ledgerGrant }) {
  const mintStore = new MintStore(join(configDir, 'daemon-mints.sqlite'))
  try {
    const mintId = `mint-${friendlyName}`
    mintStore.ensure(mintId)
    mintStore.setFact(mintId, 'fleet_id', fleetId)
    mintStore.setFact(mintId, 'friendly_name', friendlyName)
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

async function wakeAndCapture(agent) {
  let captured = null
  await runFleetSpawn([agent.friendly_name], {
    configDir,
    localAgentLedgerPath: join(configDir, 'daemon-mints.sqlite'),
    apiImpl: async (method, path) => {
      assert.equal(method, 'GET')
      assert.equal(path, '/api/state')
      return { agents: [agent] }
    },
    lifecycleImpl: async (op, params) => {
      captured = { op, params }
      return { ok: true, tmux_session: `fleet-${agent.friendly_name}`, agent_id: agent.id }
    },
  })
  return captured
}

try {
  await recordAgent({
    friendlyName: 'wake-meta-proof',
    fleetId: 'fleet:wake-meta-proof',
    cwd: '/tmp/tlda-wake-meta-proof',
    ledgerGrant: 'app-dev',
  })
  const metadataGrant = await wakeAndCapture({
    id: 'fleet:wake-meta-proof',
    friendly_name: 'wake-meta-proof',
    cwd: '/tmp/tlda-wake-meta-proof',
    metadata: { kind: 'codex', permissionGrant: 'wd' },
  })
  assert.equal(metadataGrant.op, 'wake')
  assert.equal(metadataGrant.params.fleet_id, 'fleet:wake-meta-proof')
  assert.equal(metadataGrant.params.permissionGrant, 'wd')
  assert.ok(metadataGrant.params.permissionSet)

  await recordAgent({
    friendlyName: 'wake-ledger-proof',
    fleetId: 'fleet:wake-ledger-proof',
    cwd: '/tmp/tlda-wake-ledger-proof',
    ledgerGrant: 'app-dev',
  })
  const ledgerGrant = await wakeAndCapture({
    id: 'fleet:wake-ledger-proof',
    friendly_name: 'wake-ledger-proof',
    cwd: '/tmp/tlda-wake-ledger-proof',
    metadata: { kind: 'codex' },
  })
  assert.equal(ledgerGrant.op, 'wake')
  assert.equal(ledgerGrant.params.fleet_id, 'fleet:wake-ledger-proof')
  assert.equal(ledgerGrant.params.permissionGrant, 'app-dev')
  assert.ok(ledgerGrant.params.permissionSet)

  console.log('agent wake grant regression: ok')
} finally {
  rmSync(configDir, { recursive: true, force: true })
}
