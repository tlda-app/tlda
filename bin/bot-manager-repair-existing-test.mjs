#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const configDir = mkdtempSync(join(tmpdir(), 'tlda-bot-repair-'))
process.env.TLDA_DAEMON_CONFIG_DIR = configDir
process.env.TLDA_ENV = 'testing'
writeFileSync(join(configDir, 'server.yaml'), '')
writeFileSync(join(configDir, 'daemon.yaml'), `machineId: mini
environments:
  default: testing
  values:
    testing: { database: http://127.0.0.1:9, store: http://127.0.0.1:9, licenseKey: "" }
regions: { machine: ["**"] }
profiles:
  app-dev:
    read: { allow: [machine], deny: [] }
    write: { allow: [machine], deny: [] }
grants: { localhost: app-dev }
models:
  default: bot
  values:
    bot: { id: bot, harness: { kind: bot, required: [], preferences: [], controls: false } }
default: app-dev
`)

const { runFleetSpawn } = await import(`../cli/tlda.mjs?bot-repair=${Date.now()}`)
const { MintStore } = await import('../daemon/mint-store.mjs')
const { createDaemonMintCore } = await import('../daemon/mint-core.mjs')
const ledgerPath = join(configDir, 'daemon-mints.sqlite')
const store = new MintStore(ledgerPath)
try {
  store.ensure('legacy-debt-mint')
  store.setFact('legacy-debt-mint', 'fleet_id', 'fleet:legacy-debt')
  store.setFact('legacy-debt-mint', 'friendly_name', 'debt')
  store.setFact('legacy-debt-mint', 'launch_recipe', { kind: 'claude', model: 'opus', cwd: '/tmp/legacy-debt' })
  store.markJoined('legacy-debt-mint', '2026-08-10T00:00:00Z')
} finally {
  store.close()
}

let captured = null
try {
  await runFleetSpawn([
    'debt', '--fresh', '--model', 'bot', '--kind', 'bot', '--cwd', '/tmp/legacy-debt',
    '--bot-script', '/tmp/debt.mjs', '--bot-name', 'debt',
    '--bot-pid-file', '/tmp/debt.pid', '--repair-existing-bot',
  ], {
    configDir,
    localAgentLedgerPath: ledgerPath,
    apiImpl: async () => ({ agents: [{ id: 'fleet:legacy-debt', friendly_name: 'debt' }] }),
    lifecycleImpl: async (op, params) => {
      captured = { op, params }
      return { ok: true, mint_id: params.mint_id, fleet_id: params.fleet_id, agent_id: params.fleet_id, name: 'debt' }
    },
  })
  assert.equal(captured.op, 'mint')
  assert.equal(captured.params.mint_id, 'legacy-debt-mint')
  assert.equal(captured.params.fleet_id, 'fleet:legacy-debt')
  assert.equal(captured.params.kind, 'bot')
  assert.equal(captured.params.repair_existing_bot, true)
  assert.equal(captured.params.botScript, '/tmp/debt.mjs')
  assert.equal(captured.params.botPidFile, '/tmp/debt.pid')

  const repairStore = new MintStore(ledgerPath)
  try {
    let launched = null
    const core = createDaemonMintCore({
      store: repairStore,
      processAlive: async () => false,
      launchProcess: async params => {
        launched = params
        return { session_id: 'bot-session', harness: 'bot', cwd: params.cwd }
      },
      requestSeat: async () => { throw new Error('repair must reuse the existing fleet seat') },
      bindSeat: async () => {},
    })
    await core.mint({
      mint_id: 'legacy-debt-mint',
      fleet_id: 'fleet:legacy-debt',
      name: 'debt',
      request_seat: false,
      replace_launch_recipe: true,
      launch: { kind: 'bot', model: 'bot', cwd: '/tmp/legacy-debt', botScript: '/tmp/debt.mjs' },
    })
    assert.equal(launched.kind, 'bot')
    assert.equal(repairStore.get('legacy-debt-mint').launchRecipe.botScript, '/tmp/debt.mjs')
  } finally {
    repairStore.close()
  }
  console.log('bot manager repair existing: ok')
} finally {
  rmSync(configDir, { recursive: true, force: true })
}
