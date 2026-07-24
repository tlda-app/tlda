/**
 * Focused tests for split config authority.
 *
 * `server.yaml` is the strict server-runner authority and requires complete
 * {database, store, licenseKey} entries. `daemon.yaml` is the daemon-runner
 * authority and contains endpoint-only remote entries plus spawn policy; its
 * reader validates top-level shape and returns the parsed object unchanged.
 *
 * Run: node shared/config.test.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const DIR = mkdtempSync(join(tmpdir(), 'tlda-cfg-test-'))
process.env.TLDA_CONFIG_DIR = DIR
delete process.env.TLDA_CONFIG
delete process.env.TLDA_SERVER
delete process.env.TLDA_TOKEN
delete process.env.TLDA_MACHINE_ID

function serverFixture() {
  return `defaultServer: complete
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
}

function daemonFixture() {
  return `defaultServer: complete
servers:
  complete:
    database: https://db.example
    store: https://store.example
  unlicensed:
    database: https://db2.example
    store: https://store2.example
regions:
  CWD:
    - cwd
profiles:
  WD:
    description: Keep this spacing
    read:
      allow:
        - CWD
      deny: []
    write:
      allow:
        - CWD
      deny: []
grants:
  localhost: WD
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
default: WD
tmuxSocket: "  keep-space  "
spawnMachineId: " mini "
`
}

writeFileSync(join(DIR, 'server.yaml'), serverFixture())
writeFileSync(join(DIR, 'daemon.yaml'), daemonFixture())

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
function writeServer(text) { writeFileSync(join(DIR, 'server.yaml'), text) }
function writeDaemon(text) { writeFileSync(join(DIR, 'daemon.yaml'), text) }
function existsSyncSafe(p) { try { readFileSync(p); return true } catch { return false } }

// Strict server authority: complete entries resolve with distinct database/store axes.
const r = cfg.resolveConfig()
check('server config: database axis resolves', r.database.http === 'https://db.example')
check('server config: store axis resolves', r.store.http === 'https://store.example')
check('server config: uses per-server license', r.licenseKey === 'SERVER-LICENSE')
check('getFleetServerUrl = database axis', cfg.getFleetServerUrl() === 'https://db.example')
check('getServerUrl = store axis', cfg.getServerUrl() === 'https://store.example')
check('fleet and store axes are distinct', cfg.getFleetServerUrl() !== cfg.getServerUrl())

// Daemon authority: endpoint-only entries are accepted and the reader does not normalize.
const daemonConfig = ledger.readDaemonConfig(join(DIR, 'daemon.yaml'))
check('daemon reader accepts endpoint-only servers',
      daemonConfig.servers.complete.database === 'https://db.example' &&
      daemonConfig.servers.complete.store === 'https://store.example' &&
      !Object.prototype.hasOwnProperty.call(daemonConfig.servers.complete, 'licenseKey'))
check('daemon reader preserves profile key case',
      Object.prototype.hasOwnProperty.call(daemonConfig.profiles, 'WD'))
check('daemon reader preserves region key case',
      Object.prototype.hasOwnProperty.call(daemonConfig.regions, 'CWD'))
check('daemon reader preserves scalar strings unchanged',
      daemonConfig.tmuxSocket === '  keep-space  ' && daemonConfig.spawnMachineId === ' mini ')
check('daemon consumer compiles profiles at use site',
      ledger.withDaemonModelAliases({}, daemonConfig).permissionProfiles.wd?.type === 'permission-set')

// Server resolver rejects legacy and partial server authority.
writeServer(`- not
- a
- map
`)
check('list-valued server root THROWS', throws(() => cfg.resolveConfig()))
writeServer(`defaultServer: complete
`)
check('absent server entries THROW', throws(() => cfg.resolveConfig()))
writeServer(`defaultServer: urlonly
servers:
  urlonly:
    url: https://both.example
`)
check('legacy url-only server entry THROWS', throws(() => cfg.resolveConfig()))
writeServer(`defaultServer: nostore
servers:
  nostore:
    database: https://db.example
    licenseKey: L
`)
check('missing store THROWS', throws(() => cfg.resolveConfig()))
writeServer(`licenseKey: TOP-LEVEL-MUST-NOT-BE-USED
defaultServer: nolicense
servers:
  nolicense:
    database: https://db.example
    store: https://store.example
`)
check('top-level license fallback THROWS', throws(() => cfg.resolveConfig()))
writeServer(`defaultConfig: complete
servers:
  complete:
    database: https://db.example
    store: https://store.example
    licenseKey: L
`)
check('legacy defaultConfig selector THROWS', throws(() => cfg.resolveConfig()))
writeServer(`defaultServer: complete
mystery: true
servers:
  complete:
    database: https://db.example
    store: https://store.example
    licenseKey: L
`)
check('unknown server top-level key THROWS', throws(() => cfg.resolveConfig()))
writeServer(serverFixture())

// Daemon reader validates only the daemon-owned shape, not server license authority.
writeDaemon(`- not
- a
- map
`)
check('list-valued daemon root THROWS', throws(() => ledger.readDaemonConfig(join(DIR, 'daemon.yaml'))))
writeDaemon(`defaultServer: complete
mystery: true
servers:
  complete:
    database: https://db.example
    store: https://store.example
`)
check('unknown daemon top-level key THROWS', throws(() => ledger.readDaemonConfig(join(DIR, 'daemon.yaml'))))
writeDaemon(daemonFixture())

// Project overrides may change spawn policy, but not daemon server authority.
const projectDir = join(DIR, 'project')
mkdirSync(projectDir)
writeFileSync(join(projectDir, '.tlda-daemon.yaml'), `default: WD
models:
  default: gpt
`)
check('project override accepts profile/model policy fields',
      ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml')).default === 'WD')
writeFileSync(join(projectDir, '.tlda-daemon.yaml'), `defaultServer: complete
`)
check('project override rejects defaultServer authority',
      throws(() => ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml'))))
writeFileSync(join(projectDir, '.tlda-daemon.yaml'), `servers:
  complete:
    database: https://db.example
    store: https://store.example
`)
check('project override rejects servers authority',
      throws(() => ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml'))))
writeFileSync(join(projectDir, '.tlda-daemon.yaml'), `machineId: mini
`)
check('project override rejects machineId authority',
      throws(() => ledger.readDaemonConfigForCwd(projectDir, join(DIR, 'daemon.yaml'))))

// String server-name override routes and beats env.
process.env.TLDA_CONFIG = 'complete'
check('string override selects the named server',
      cfg.resolveConfig('unlicensed').database.http === 'https://db2.example')
check('non-string server override THROWS', throws(() => cfg.resolveConfig({ some: 'obj' })))
delete process.env.TLDA_CONFIG

// Tokens: absent => null; malformed existing file => loud failure.
check('absent tokens.json => getRwToken null', cfg.getRwToken() === null)
writeFileSync(join(DIR, 'tokens.json'), '{ this is not valid json')
check('malformed tokens.json => getRwToken THROWS', throws(() => cfg.getRwToken()))
writeFileSync(join(DIR, 'tokens.json'), JSON.stringify({ tokenRw: 'RW123' }))
check('valid tokens.json => token returned', cfg.getRwToken() === 'RW123')

// machineId persists into daemon.yaml and preserves comments.
writeDaemon(`# keep this comment
defaultServer: complete
servers:
  complete:
    database: https://db.example
    store: https://store.example
`)
cfg.saveMachineId('mini-xyz')
const after = readFileSync(join(DIR, 'daemon.yaml'), 'utf8')
check('machineId written to daemon.yaml', /machineId:\s*mini-xyz/.test(after))
check('daemon.yaml comment preserved on write', after.includes('# keep this comment'))
check('no config.json was created for machineId', !existsSyncSafe(join(DIR, 'config.json')))

rmSync(DIR, { recursive: true, force: true })
if (failures.length) {
  console.log(`\n${failures.length} FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall config resolver tests passed')
