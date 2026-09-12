#!/usr/bin/env node
// `bots.yaml`'s `env:` never reached the bot. Both ends were built and the
// transport between them did not list the field.
//
// The receiving end has been correct since it was written: `agent-launch/harness/
// bot.mjs` emits `botEnv` into the tmux command, and `test/bot-harness-env.test.mjs`
// asserts it does -- by calling `buildCmd` with `botEnv` directly. That test passed
// the entire time the setting was being dropped, because it supplies the argument
// whose delivery is the only thing in question. It is the shape AGENTS.md warns
// about: calling the sender's function and the receiver's function proves both
// functions and nothing about whether they are connected.
//
// So this test covers the two hops that were actually broken, at the boundaries
// they cross in production:
//
//   1. CLI -> daemon: `--bot-env` is classified as a spawn option, parsed, and
//      arrives in the params of the daemon lifecycle call.
//   2. launch params -> bot process: the value reaches the real tmux command
//      through agent-launch, rather than through the ambient environment, which
//      the harness allowlist correctly refuses to carry.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'tlda-bot-declared-env-'))
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

const { runFleetSpawn } = await import(`../cli/tlda.mjs?bot-declared-env-test=${Date.now()}`)
const { launchMintProcess } = await import('../agent-launch/index.mjs')

const DECLARED = {
  TLDA_DEV_BOT_DISABLED_CHECKS: 'doc-render,misconfigured-agents',
  TLDA_DEV_BOT_LINKED_REMOTE_INTERVAL_MS: '1800000',
}

// --- Hop 1: the CLI hands it to the daemon -----------------------------------
const calls = []
await runFleetSpawn([
  '--fresh', 'dev',
  '--mint-id', 'bot:stable:dev',
  '--model', 'bot',
  '--kind', 'bot',
  '--cwd', configDir,
  '--bot-script', '/Users/skip/work/tlda-bots/dev/dev-bot.mjs',
  '--bot-name', 'dev',
  '--bot-env', JSON.stringify(DECLARED),
], {
  configDir,
  localAgentLedgerPath: join(configDir, 'daemon-mints.sqlite'),
  lifecycleImpl: async (op, params) => {
    calls.push([op, params])
    return { ok: true, agent_id: 'fleet:seat', mint_id: params.mint_id, name: params.name }
  },
})

assert.equal(calls.length, 1)
assert.deepEqual(calls[0][1].botEnv, DECLARED, 'the declared env must reach the daemon call as data')
// A flag the CLI does not classify is collected as a model option and handed to
// the harness as a model setting, which is how it would go missing again.
assert.equal('bot-env' in (calls[0][1].modelOptions || {}), false)

// --- Hop 2: the launch carries it into the real command ----------------------
let captured = null
await launchMintProcess({
  mintId: 'mint-bot-declared-env',
  fleetId: 'fleet:bot-declared-env',
  name: 'dev',
  kind: 'bot',
  cwd: process.cwd(),
  botName: 'dev',
  botScript: '/opt/tlda-bots/dev/dev-bot.mjs',
  botEnv: DECLARED,
  tmuxSession: 'fleet-bot-dev_stable',
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
  mintStorePath: join(configDir, 'launch-mints.sqlite'),
  _deps: {
    resolveApi: () => ({ base: 'https://example.invalid' }),
    // spawnTmux(session, cwd, cmd) -- the command is the third argument.
    spawnTmux: async (_session, _cwd, cmd) => { captured = cmd; return true },
    sessionRuntimeState: async () => ({ runtime: false, mcp: false, probed: true }),
    uniqueSessionName: name => name,
  },
})

assert.ok(captured, 'the launch must have produced a tmux command')
for (const [key, value] of Object.entries(DECLARED)) {
  assert.ok(captured.includes(key), `${key} must reach the bot process`)
  assert.ok(captured.includes(value), `${key}'s value must reach the bot process`)
}

// The allowlist is untouched and still refuses ambient environment. This is the
// thing the fix must NOT have done: widening it would have carried the declared
// values by leaking everything else too.
assert.ok(!captured.includes('TLDA_SHOULD_NOT_LEAK'), 'ambient environment must not be carried')

rmSync(configDir, { recursive: true, force: true })
console.log('PASS: a bot receives the env its config declares, as data rather than as ambient environment')
