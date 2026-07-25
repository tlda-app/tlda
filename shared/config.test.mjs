/**
 * Focused tests for the no-fallback config resolver (shared/config.mjs).
 * Covers B1 (complete {database,store,licenseKey}, no legacy url/database-as-store/
 * top-level-license fallback), B2 (malformed tokens.json fails loud), B4 (fleet =
 * database axis, distinct from store), B5 (string server-name override routing).
 *
 * Run:  node shared/config.test.mjs
 * Exits non-zero on failure. Uses a temp TLDA_CONFIG_DIR — never touches ~/.config.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const DIR = mkdtempSync(join(tmpdir(), 'tlda-cfg-test-'))
process.env.TLDA_CONFIG_DIR = DIR
delete process.env.TLDA_CONFIG
delete process.env.TLDA_SERVER
delete process.env.TLDA_TOKEN
delete process.env.TLDA_MACHINE_ID

const SERVER_COMPLETE = `defaultServer: complete
servers:
  complete:
    database: https://db.example
    store: https://store.example
    licenseKey: SERVER-LICENSE
  unlicensed:
    database: https://db2.example
    store: https://store2.example
    licenseKey: ""
`

const DAEMON_COMPLETE = `
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

// --- B1: complete entry resolves; per-server license (not top-level) ---
const r = cfg.resolveConfig()
check('complete: database axis resolves', r.database.http === 'https://db.example')
check('complete: store axis resolves', r.store.http === 'https://store.example')
check('complete: uses per-server license, NOT top-level',
      r.licenseKey === 'SERVER-LICENSE')
const daemonConfig = ledger.readDaemonConfig(join(DIR, 'daemon.yaml'))
check('daemon reader accepts local daemon-only config',
      daemonConfig.default === 'wd')

// --- B4: fleet URL = database axis, distinct from store URL ---
check('getFleetServerUrl = database axis', cfg.getFleetServerUrl() === 'https://db.example')
check('getServerUrl = store axis', cfg.getServerUrl() === 'https://store.example')
check('fleet and store axes are distinct', cfg.getFleetServerUrl() !== cfg.getServerUrl())

// --- B1: server.yaml owns server authority; daemon.yaml rejects authority keys as foreign ---
writeBoth(`- not
- a
- map
`)
check('list-valued daemon root THROWS in resolver',
      throws(() => cfg.resolveConfig()))
check('list-valued daemon root THROWS in daemon reader',
      throws(() => ledger.readDaemonConfig(join(DIR, 'daemon.yaml'))))
writeBoth(`defaultServer: complete
`)
check('absent servers THROWS in resolver',
      throws(() => cfg.resolveConfig()))
writeBoth(`defaultServer: missing
servers:
  complete:
    database: https://db.example
    store: https://store.example
    licenseKey: L
`)
check('defaultServer missing target THROWS in resolver',
      throws(() => cfg.resolveConfig()))
writeBoth(`defaultServer: ""
servers:
  complete:
    database: https://db.example
    store: https://store.example
    licenseKey: L
`)
check('empty defaultServer THROWS in resolver',
      throws(() => cfg.resolveConfig()))
writeBoth(`defaultServer: urlonly
servers:
  urlonly:
    url: https://both.example
`)
check('legacy url-only entry THROWS in resolver (no url fallback)',
      throws(() => cfg.resolveConfig()))
writeBoth(`defaultServer: nostore
servers:
  nostore:
    database: https://db.example
    licenseKey: L
`)
check('missing store THROWS in resolver (no database->store fallback)',
      throws(() => cfg.resolveConfig()))
writeBoth(`licenseKey: TOP-LEVEL-MUST-NOT-BE-USED
defaultServer: nolicense
servers:
  nolicense:
    database: https://db.example
    store: https://store.example
`)
check('top-level license fallback THROWS in resolver',
      throws(() => cfg.resolveConfig()))
writeBoth(`defaultConfig: complete
servers:
  complete:
    database: https://db.example
    store: https://store.example
    licenseKey: L
`)
check('legacy defaultConfig selector THROWS in resolver',
      throws(() => cfg.resolveConfig()))
check('legacy defaultConfig selector THROWS in daemon reader',
      throws(() => ledger.readDaemonConfig(join(DIR, 'daemon.yaml'))))
writeBoth(`defaultServer: complete
mystery: true
servers:
  complete:
    database: https://db.example
    store: https://store.example
    licenseKey: L
`)
check('unknown top-level key THROWS in resolver',
      throws(() => cfg.resolveConfig()))
check('unknown top-level key THROWS in daemon reader',
      throws(() => ledger.readDaemonConfig(join(DIR, 'daemon.yaml'))))
writeBoth(`servers:
  chosen:
    database: https://chosen-db.example
    store: https://chosen-store.example
    licenseKey: L
`)
process.env.TLDA_CONFIG = 'chosen'
check('TLDA_CONFIG selector cannot bypass missing defaultServer',
      throws(() => cfg.resolveConfig()))
delete process.env.TLDA_CONFIG
check('explicit selector cannot bypass missing defaultServer',
      throws(() => cfg.resolveConfig('chosen')))
writeBoth(`defaultServer: missing
servers:
  chosen:
    database: https://chosen-db.example
    store: https://chosen-store.example
    licenseKey: L
`)
process.env.TLDA_CONFIG = 'chosen'
check('TLDA_CONFIG selector cannot bypass invalid defaultServer target',
      throws(() => cfg.resolveConfig()))
delete process.env.TLDA_CONFIG
check('explicit selector cannot bypass invalid defaultServer target',
      throws(() => cfg.resolveConfig('chosen')))

writeFileSync(join(DIR, 'server.yaml'), SERVER_COMPLETE)
writeFileSync(join(DIR, 'daemon.yaml'), DAEMON_COMPLETE)

const projectDir = join(DIR, 'project')
mkdirSync(projectDir)
writeFileSync(join(projectDir, '.tlda-daemon.yaml'), `default: wd
models:
  default: gpt
`)
check('project override accepts profile/model policy fields',
      ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml')).default === 'wd')
writeFileSync(join(projectDir, '.tlda-daemon.yaml'), `defaultServer: complete
`)
check('project override rejects defaultServer authority',
      throws(() => ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml'))))
writeFileSync(join(projectDir, '.tlda-daemon.yaml'), `servers:
  complete:
    database: https://db.example
    store: https://store.example
    licenseKey: L
`)
check('project override rejects servers authority',
      throws(() => ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml'))))
writeFileSync(join(projectDir, '.tlda-daemon.yaml'), `machineId: mini
`)
check('project override rejects machineId authority',
      throws(() => ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml'))))

// --- licenseKey "" is a VALID explicit value (unlicensed), not a failure ---
check('empty-string license is accepted (explicit unlicensed)',
      cfg.resolveConfig('unlicensed').licenseKey === '')

// --- B5: string server-name override routes, and beats env ---
process.env.TLDA_CONFIG = 'complete'
check('string override selects the named server',
      cfg.resolveConfig('unlicensed').database.http === 'https://db2.example')
check('string override THROWS for a broken server even when env is valid',
      throws(() => cfg.resolveConfig('nolicense')))
check('non-string server override THROWS (no legacy config-object shim)',
      throws(() => cfg.resolveConfig({ some: 'obj' })))
delete process.env.TLDA_CONFIG

// --- B2: tokens.json — absent => null; malformed => THROW ---
check('absent tokens.json => getRwToken null', cfg.getRwToken() === null)
writeFileSync(join(DIR, 'tokens.json'), '{ this is not valid json')
check('malformed tokens.json => getRwToken THROWS', throws(() => cfg.getRwToken()))
writeFileSync(join(DIR, 'tokens.json'), JSON.stringify({ tokenRw: 'RW123' }))
check('valid tokens.json => token returned', cfg.getRwToken() === 'RW123')

// --- B4/B5: bots are defined once; environments list bot names ---
writeFileSync(join(DIR, 'bots.yaml'), `bots:\n  todd: { script: bin/bots/todd.mjs }\n  grammar: { script: bin/bots/grammar-bot.mjs }\nenvironments:\n  default: [todd]\n  unlicensed: [todd, grammar]\n`)
const todd = cfg.getManagedBots().find(b => b.name === 'todd')
const botEnvironments = cfg.getManagedBotEnvironments()
check('bots.yaml definitions become named bot objects',
      todd.script === 'bin/bots/todd.mjs')
check('bots.yaml environments list bot names by environment',
      botEnvironments.unlicensed.join(',') === 'todd,grammar')
check('bot environment names route to fleet/database, never the store axis',
      cfg.getFleetServerUrl('unlicensed') !== cfg.getServerUrl('unlicensed'))
writeFileSync(join(DIR, 'bots.yaml'), `bots:\n  - name: pinned\n    script: bin/bots/x.mjs\n    server: unlicensed\n  - name: unpinned\n    script: bin/bots/y.mjs\n`)
const pinned = cfg.getManagedBots().find(b => b.name === 'pinned')
const legacyEnvironments = cfg.getManagedBotEnvironments()
check('legacy bots.yaml list shape still reads bot definitions',
      pinned.script === 'bin/bots/x.mjs')
check('legacy bots.yaml list shape maps pinned bots to their named environment',
      legacyEnvironments.unlicensed.join(',') === 'pinned')
check('legacy bots.yaml list shape maps unpinned bots to defaultServer',
      legacyEnvironments.complete.join(',') === 'unpinned')

// --- B3: machineId persists into daemon.yaml (NOT config.json), comments kept ---
import { readFileSync } from 'fs'
const DIR2 = mkdtempSync(join(tmpdir(), 'tlda-mid-test-'))
const prevDir = process.env.TLDA_CONFIG_DIR
// saveMachineId targets DAEMON_FILE resolved from the module's CONFIG_DIR (frozen
// at import = DIR), so write the fixture there and assert against DIR's daemon.yaml.
writeFileSync(join(DIR, 'daemon.yaml'), `# keep this comment\nregions: {}\nprofiles: {}\ngrants: {}\nmodels: {}\n`)
cfg.saveMachineId('mini-xyz')
const after = readFileSync(join(DIR, 'daemon.yaml'), 'utf8')
check('machineId written to daemon.yaml', /machineId:\s*mini-xyz/.test(after))
check('daemon.yaml comment preserved on write', after.includes('# keep this comment'))
check('no config.json was created for machineId',
      !existsSyncSafe(join(DIR, 'config.json')))
rmSync(DIR2, { recursive: true, force: true })

function existsSyncSafe(p) { try { readFileSync(p); return true } catch { return false } }
function writeServer(text) { writeFileSync(join(DIR, 'server.yaml'), text) }
function writeDaemon(text) { writeFileSync(join(DIR, 'daemon.yaml'), text) }
function writeBoth(text) {
  writeServer(text)
  writeDaemon(text)
}

rmSync(DIR, { recursive: true, force: true })
if (failures.length) {
  console.log(`\n${failures.length} FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall config resolver tests passed')
