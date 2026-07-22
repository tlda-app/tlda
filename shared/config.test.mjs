/**
 * Focused tests for the no-fallback config resolver (shared/config.mjs).
 * Covers B1 (complete {database,store,licenseKey}, no legacy url/database-as-store/
 * top-level-license fallback), B2 (malformed tokens.json fails loud), B4 (fleet =
 * database axis, distinct from store), B5 (string server-name override routing).
 *
 * Run:  node shared/config.test.mjs
 * Exits non-zero on failure. Uses a temp TLDA_CONFIG_DIR — never touches ~/.config.
 */
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const DIR = mkdtempSync(join(tmpdir(), 'tlda-cfg-test-'))
process.env.TLDA_CONFIG_DIR = DIR
delete process.env.TLDA_CONFIG
delete process.env.TLDA_SERVER
delete process.env.TLDA_TOKEN
delete process.env.TLDA_MACHINE_ID

writeFileSync(join(DIR, 'daemon.yaml'), `
licenseKey: TOP-LEVEL-MUST-NOT-BE-USED
defaultServer: complete
servers:
  complete:
    database: https://db.example
    store: https://store.example
    licenseKey: SERVER-LICENSE
  unlicensed:
    database: https://db2.example
    store: https://store2.example
    licenseKey: ""
  urlonly:
    url: https://both.example
  nostore:
    database: https://db.example
    licenseKey: L
  nolicense:
    database: https://db.example
    store: https://store.example
`)

const cfg = await import('./config.mjs?bust=' + Date.now())
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

// --- B4: fleet URL = database axis, distinct from store URL ---
check('getFleetServerUrl = database axis', cfg.getFleetServerUrl() === 'https://db.example')
check('getServerUrl = store axis', cfg.getServerUrl() === 'https://store.example')
check('fleet and store axes are distinct', cfg.getFleetServerUrl() !== cfg.getServerUrl())

// --- B1: every fallback removed ---
check('legacy url-only entry THROWS (no url fallback)',
      throws(() => cfg.resolveConfig('urlonly')))
check('missing store THROWS (no database->store fallback)',
      throws(() => cfg.resolveConfig('nostore')))
check('missing per-server license THROWS (no top-level license fallback)',
      throws(() => cfg.resolveConfig('nolicense')))

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

// --- B4/B5: a bot's declared `server:` routes it to that server's DATABASE axis ---
// Mirrors the exact expression the bots use: getManagedBots().find(...).server
// -> getFleetServerUrl(server). A pinned bot reaches its server's fleet axis; an
// unpinned bot uses the default server's fleet axis.
writeFileSync(join(DIR, 'bots.yaml'), `bots:\n  - name: pinned\n    script: bin/bots/x.mjs\n    server: unlicensed\n  - name: unpinned\n    script: bin/bots/y.mjs\n`)
const pinned = cfg.getManagedBots().find(b => b.name === 'pinned')
const unpinned = cfg.getManagedBots().find(b => b.name === 'unpinned')
check('bot with server: routes to that server\'s database (fleet) axis',
      cfg.getFleetServerUrl(pinned.server) === 'https://db2.example')
check('bot without server: uses the default server\'s database axis',
      cfg.getFleetServerUrl(unpinned.server) === 'https://db.example')
check('bots route to fleet/database, never the store axis',
      cfg.getFleetServerUrl(pinned.server) !== cfg.getServerUrl())

// --- B3: machineId persists into daemon.yaml (NOT config.json), comments kept ---
import { readFileSync } from 'fs'
const DIR2 = mkdtempSync(join(tmpdir(), 'tlda-mid-test-'))
const prevDir = process.env.TLDA_CONFIG_DIR
// saveMachineId targets DAEMON_FILE resolved from the module's CONFIG_DIR (frozen
// at import = DIR), so write the fixture there and assert against DIR's daemon.yaml.
writeFileSync(join(DIR, 'daemon.yaml'), `# keep this comment\ndefaultServer: complete\nservers:\n  complete:\n    database: https://db.example\n    store: https://store.example\n    licenseKey: L\n`)
cfg.saveMachineId('mini-xyz')
const after = readFileSync(join(DIR, 'daemon.yaml'), 'utf8')
check('machineId written to daemon.yaml', /machineId:\s*mini-xyz/.test(after))
check('daemon.yaml comment preserved on write', after.includes('# keep this comment'))
check('no config.json was created for machineId',
      !existsSyncSafe(join(DIR, 'config.json')))
rmSync(DIR2, { recursive: true, force: true })

function existsSyncSafe(p) { try { readFileSync(p); return true } catch { return false } }

rmSync(DIR, { recursive: true, force: true })
if (failures.length) {
  console.log(`\n${failures.length} FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall config resolver tests passed')
