/**
 * Focused tests for the no-fallback environment resolver (shared/config.mjs).
 *
 * Run: node shared/config.test.mjs
 * Uses a temp TLDA_CONFIG_DIR; never touches ~/.config.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const DIR = mkdtempSync(join(tmpdir(), 'tlda-cfg-test-'))
process.env.TLDA_CONFIG_DIR = DIR
delete process.env.TLDA_ENV
delete process.env.TLDA_SERVER
delete process.env.TLDA_TOKEN
delete process.env.TLDA_MACHINE_ID

const SERVER_COMPLETE = ''
const DAEMON_COMPLETE = `environments:
  default: complete
  values:
    complete:
      database: https://db.example
      store: https://store.example
      licenseKey: SERVER-LICENSE
    unlicensed:
      database: https://db2.example
      store: https://store2.example
      licenseKey: ""
regions:
  cwd:
    - cwd
profiles:
  wd:
    read:
      allow:
        - cwd
      deny: []
grants:
  localhost: wd
models:
  default: gpt
  values:
    gpt:
      id: gpt
      harness:
        kind: codex
        required: []
        preferences: []
        controls: true
default: wd
`

writeFileSync(join(DIR, 'server.yaml'), SERVER_COMPLETE)
writeFileSync(join(DIR, 'daemon.yaml'), DAEMON_COMPLETE)

const cfg = await import('./config.mjs?bust=' + Date.now())
const ledger = await import('../agent-launch/permission-ledger.mjs?bust=' + Date.now())
const failures = []
function check(name, cond) {
  console.log((cond ? '  ok  ' : '  FAIL ') + name)
  if (!cond) failures.push(name)
}
function throws(fn) {
  try { fn(); return false } catch { return true }
}

const r = cfg.resolveConfig()
check('complete: database axis resolves', r.database.http === 'https://db.example')
check('complete: store axis resolves', r.store.http === 'https://store.example')
check('complete: uses per-environment license', r.licenseKey === 'SERVER-LICENSE')
check('daemon reader accepts local daemon config',
      ledger.readDaemonConfig(join(DIR, 'daemon.yaml')).default === 'wd')
check('getFleetServerUrl = database axis', cfg.getFleetServerUrl() === 'https://db.example')
check('getServerUrl = store axis', cfg.getServerUrl() === 'https://store.example')
check('fleet and store axes are distinct', cfg.getFleetServerUrl() !== cfg.getServerUrl())

writeDaemon(`- not
- a
- map
`)
check('list-valued daemon root THROWS in resolver', throws(() => cfg.resolveConfig()))
check('list-valued daemon root THROWS in daemon reader',
      throws(() => ledger.readDaemonConfig(join(DIR, 'daemon.yaml'))))
writeDaemon(`environments:
  default: complete
`)
check('absent environments.values THROWS in resolver', throws(() => cfg.resolveConfig()))
writeDaemon(`environments:
  default: missing
  values:
    complete:
      database: https://db.example
      store: https://store.example
      licenseKey: L
`)
check('environments.default missing target THROWS in resolver', throws(() => cfg.resolveConfig()))
writeDaemon(`environments:
  default: ""
  values:
    complete:
      database: https://db.example
      store: https://store.example
      licenseKey: L
`)
check('empty environments.default THROWS in resolver', throws(() => cfg.resolveConfig()))
writeDaemon(`environments:
  default: urlonly
  values:
    urlonly:
      url: https://both.example
`)
check('legacy url-only entry THROWS in resolver', throws(() => cfg.resolveConfig()))
writeDaemon(`environments:
  default: nostore
  values:
    nostore:
      database: https://db.example
      licenseKey: L
`)
check('missing store THROWS in resolver', throws(() => cfg.resolveConfig()))
writeDaemon(`licenseKey: TOP-LEVEL-MUST-NOT-BE-USED
environments:
  default: nolicense
  values:
    nolicense:
      database: https://db.example
      store: https://store.example
`)
check('top-level license fallback THROWS in resolver', throws(() => cfg.resolveConfig()))

writeFileSync(join(DIR, 'server.yaml'), SERVER_COMPLETE)
writeFileSync(join(DIR, 'daemon.yaml'), DAEMON_COMPLETE)
check('empty-string license is accepted', cfg.resolveConfig('unlicensed').licenseKey === '')
process.env.TLDA_ENV = 'complete'
check('string override selects the named environment',
      cfg.resolveConfig('unlicensed').database.http === 'https://db2.example')
check('non-string environment override THROWS', throws(() => cfg.resolveConfig({ some: 'obj' })))
delete process.env.TLDA_ENV

const projectDir = join(DIR, 'project')
mkdirSync(projectDir)
writeFileSync(join(projectDir, '.tlda-daemon.yaml'), `default: wd
agentConfigDir: /tmp/project-agent-config
models:
  default: gpt
`)
check('project override accepts profile/model policy fields',
      ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml')).default === 'wd')
check('project override carries the agent config folder',
      ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml')).agentConfigDir === '/tmp/project-agent-config')
writeFileSync(join(projectDir, '.tlda-daemon.yaml'), 'agentConfigDir: ""\n')
check('project override rejects an empty agent config folder',
      throws(() => ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml'))))
writeFileSync(join(projectDir, '.tlda-daemon.yaml'), `environments:
  default: complete
  values:
    complete:
      database: https://db.example
      store: https://store.example
      licenseKey: L
`)
check('project override rejects environments authority',
      throws(() => ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml'))))

check('absent tokens.json => getRwToken null', cfg.getRwToken() === null)
writeFileSync(join(DIR, 'tokens.json'), '{ this is not valid json')
check('malformed tokens.json => getRwToken THROWS', throws(() => cfg.getRwToken()))
writeFileSync(join(DIR, 'tokens.json'), JSON.stringify({ tokenRw: 'RW123' }))
check('valid tokens.json => token returned', cfg.getRwToken() === 'RW123')

writeFileSync(join(DIR, 'bots.yaml'), `bots:
  todd: { script: bin/bots/todd.mjs }
  grammar: { script: bin/bots/grammar-bot.mjs }
environments:
  complete: [todd]
  unlicensed: [todd, grammar]
`)
const todd = cfg.getManagedBots().find(b => b.name === 'todd')
const botEnvironments = cfg.getManagedBotEnvironments()
check('bots.yaml definitions become named bot objects',
      todd.script === 'bin/bots/todd.mjs')
check('bots.yaml environments list bot names by environment',
      botEnvironments.unlicensed.join(',') === 'todd,grammar')
check('bot environment names route to fleet/database, never the store axis',
      cfg.getFleetServerUrl('unlicensed') !== cfg.getServerUrl('unlicensed'))

writeFileSync(join(DIR, 'daemon.yaml'), `# keep this comment
regions: {}
profiles: {}
grants: {}
models: {}
`)
cfg.saveMachineId('mini-xyz')
const after = readFileSync(join(DIR, 'daemon.yaml'), 'utf8')
check('machineId written to daemon.yaml', /machineId:\s*mini-xyz/.test(after))
check('daemon.yaml comment preserved on write', after.includes('# keep this comment'))
check('no config.json was created for machineId',
      !existsSyncSafe(join(DIR, 'config.json')))

function existsSyncSafe(p) { try { readFileSync(p); return true } catch { return false } }
function writeDaemon(text) { writeFileSync(join(DIR, 'daemon.yaml'), text) }

rmSync(DIR, { recursive: true, force: true })
if (failures.length) {
  console.log(`\n${failures.length} FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll config tests passed.')
