// Guards the config-check-on-spawn fix: loadConfig() must re-read daemon.yaml FRESH
// on every call (it runs per-spawn at rpcSpawn) so fence-profile + model-alias edits
// take effect on the NEXT spawn without a daemon restart — with keep-last-good so a
// malformed daemon.yaml never half-applies.
//
// loadConfig() is a module-internal function whose keep-last-good closes over daemon
// module state (singleton lock, WS); it can't be called without booting the whole
// daemon. This source-assertion pins the invariant against regression (reverting to
// the frozen startup const). The building blocks it composes — readDaemonConfig
// (fresh YAML read) and withDaemonModelAliases (profiles+aliases merge) — are
// behaviorally covered in spawn-permission-ledger.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const daemon = () => readFileSync(path.join(ROOT, 'bin', 'fleet-daemon.mjs'), 'utf8')

// Extract the body of loadConfig() so assertions target the re-read, not the startup const.
function loadConfigBody(src) {
  const start = src.indexOf('function loadConfig()')
  assert.notEqual(start, -1, 'loadConfig() must exist')
  // balance braces from the first "{" after the signature
  const open = src.indexOf('{', start)
  let depth = 0
  let i = open
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break } }
  }
  return src.slice(start, i)
}

test('_lastGoodDaemon is seeded from the startup daemonSpawnConfig', () => {
  const src = daemon()
  assert.match(src, /let _lastGoodDaemon = daemonSpawnConfig/)
})

test('loadConfig() re-reads daemon.yaml fresh (not the frozen startup const)', () => {
  const body = loadConfigBody(daemon())
  // fresh read of the daemon config file inside loadConfig
  assert.match(body, /readDaemonConfig\(DAEMON_CONFIG_FILE\)/)
  // the fresh value (not the frozen daemonSpawnConfig) is what feeds the alias/profile merge
  assert.match(body, /withDaemonModelAliases\(cfg, freshDaemon\)/)
  assert.equal(
    /withDaemonModelAliases\(cfg, daemonSpawnConfig\)/.test(body),
    false,
    'loadConfig must not pass the frozen startup const to withDaemonModelAliases',
  )
})

test('loadConfig() keeps last good on a malformed daemon.yaml (no half-apply)', () => {
  const body = loadConfigBody(daemon())
  // try the fresh read + record it; on throw, fall back to the last good value
  assert.match(body, /freshDaemon = readDaemonConfig\(DAEMON_CONFIG_FILE\)/)
  assert.match(body, /_lastGoodDaemon = freshDaemon/)
  assert.match(body, /catch \(e\) \{[\s\S]*freshDaemon = _lastGoodDaemon/)
})

test('startup const daemonSpawnConfig still seeds ledger path + startup grants (unchanged, must not move without a restart)', () => {
  const src = daemon()
  assert.match(src, /const daemonSpawnConfig = readDaemonConfig\(DAEMON_CONFIG_FILE\)/)
  assert.match(src, /permissionLedgerPathFromDaemonConfig\(daemonSpawnConfig, CONFIG_DIR\)/)
  assert.match(src, /applyDaemonGrants\(permissionLedger, daemonSpawnConfig\)/)
})
