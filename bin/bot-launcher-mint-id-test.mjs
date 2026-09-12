#!/usr/bin/env node
// The bot manager starts a supervised bot by minting under a mint id derived from
// the (environment, bot) pair rather than a fresh one per start. This checks the
// half of that wire the CLI owns: that --mint-id is what reaches the daemon
// lifecycle call, and that a start whose mint already holds a fleet id keeps it
// instead of asking for a new agent named after the bot.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const configDir = mkdtempSync(join(tmpdir(), 'tlda-bot-launcher-mint-id-'))
process.env.TLDA_DAEMON_CONFIG_DIR = configDir
process.env.TLDA_ENV = 'stable'

writeFileSync(join(configDir, 'server.yaml'), '')
writeFileSync(join(configDir, 'daemon.yaml'), `machineId: mini
environments:
  default: stable
  values:
    stable:
      database: http://127.0.0.1:9
      store: http://127.0.0.1:9
      licenseKey: ""
regions:
  machine: ["**"]
profiles:
  app-dev:
    read: { allow: [machine], deny: [] }
    write: { allow: [machine], deny: [] }
grants:
  localhost: app-dev
models:
  default: bot
  values:
    bot:
      id: bot
      harness:
        kind: bot
        required: []
        preferences: []
        controls: false
default: app-dev
`)

const { botMintId, runFleetSpawn } = await import(`../cli/tlda.mjs?bot-launcher-mint-id-test=${Date.now()}`)
const { MintStore } = await import('../daemon/mint-store.mjs')

// The format is not free to change: the ledger already carries rows under it for
// bots enlisted before the launcher computed it, and those rows are the identities
// this path is meant to keep reusing.
assert.equal(botMintId('stable', 'grammar'), 'bot:stable:grammar')

const ledgerPath = join(configDir, 'daemon-mints.sqlite')
const calls = []
const lifecycleImpl = async (op, params) => {
  calls.push([op, params])
  return { ok: true, agent_id: 'fleet:seat', mint_id: params.mint_id, name: params.name }
}

function spawnArgs() {
  return [
    '--fresh', 'grammar',
    '--mint-id', botMintId('stable', 'grammar'),
    '--model', 'bot',
    '--kind', 'bot',
    '--cwd', configDir,
    '--bot-script', '/Users/skip/work/tlda-bots/grammar/grammar-bot.mjs',
    '--bot-name', 'grammar',
  ]
}

// First start: no mint recorded yet, so the id is taken from the flag rather than
// generated, and nothing asks the allocator to refuse a taken name.
await runFleetSpawn(spawnArgs(), { configDir, localAgentLedgerPath: ledgerPath, lifecycleImpl })
assert.equal(calls.length, 1)
assert.equal(calls[0][0], 'mint')
assert.equal(calls[0][1].mint_id, 'bot:stable:grammar')
assert.equal(calls[0][1].name, 'grammar')
assert.equal(!!calls[0][1].failIfNotFresh, false)
assert.equal(calls[0][1].botScript, '/Users/skip/work/tlda-bots/grammar/grammar-bot.mjs')
// It is a spawn option, not a model option: an unclassified flag is collected as
// one and would be handed to the harness as a model setting.
assert.equal('mint-id' in (calls[0][1].modelOptions || {}), false)

// Restart: the mint now holds a fleet id. The launcher must present the same mint
// id, which is what lets the mint core skip the seat request and relaunch the bot's
// own identity — the property that stops the launcher squatting the bot's name.
const store = new MintStore(ledgerPath, { defaultEnvName: 'stable' })
store.ensure('bot:stable:grammar')
store.setFact('bot:stable:grammar', 'fleet_id', 'fleet:grammar')
store.setFact('bot:stable:grammar', 'friendly_name', 'grammar')
store.close()

await runFleetSpawn(spawnArgs(), { configDir, localAgentLedgerPath: ledgerPath, lifecycleImpl })
assert.equal(calls.length, 2)
assert.equal(calls[1][1].mint_id, 'bot:stable:grammar')

// Without the flag the mint id is still generated per start, so ordinary agent
// mints are untouched by this path.
await runFleetSpawn(['--fresh', 'someone-else', '--model', 'bot', '--cwd', configDir], {
  configDir,
  localAgentLedgerPath: ledgerPath,
  lifecycleImpl,
})
assert.equal(calls.length, 3)
assert.notEqual(calls[2][1].mint_id, 'bot:stable:grammar')
assert.match(calls[2][1].mint_id, /^[0-9a-f-]{36}$/)

rmSync(configDir, { recursive: true, force: true })
console.log('bot-launcher-mint-id-test: ok')
