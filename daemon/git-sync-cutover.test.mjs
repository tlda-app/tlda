import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const fleetDaemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')

test('fleet daemon has exactly one Git source manager', () => {
  assert.equal((fleetDaemon.match(/createGitSyncManager\s*\(/g) || []).length, 1)
  assert.doesNotMatch(fleetDaemon, /createGitSourceManager|\bgitSources\b/)
  assert.doesNotMatch(fleetDaemon, /afterMirror\s*:/)
})
