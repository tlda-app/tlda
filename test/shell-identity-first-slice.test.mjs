import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const serverSource = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
const fleetToolsSource = readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')

test('wake/respawn queue requires the target owner machine', () => {
  assert.doesNotMatch(serverSource, /agent\.machine_id\s*\|\|\s*machineIds\[0\]/)
  assert.doesNotMatch(serverSource, /machineIds\.length\s*===\s*0\)\s*continue/)
  assert.match(serverSource, /agent .* has no machine_id; cannot route wake\/respawn/)
  assert.match(serverSource, /daemonConnections\.get\(machineId\)/)
  assert.match(serverSource, /No fleet-daemon connected for machine/)
})

test('combined spawn delegate targets the reserved shell mailbox', () => {
  assert.match(fleetToolsSource, /mailboxTarget:\s*true/)
  assert.match(fleetToolsSource, /spawnResult\?\.agent/)
  assert.match(fleetToolsSource, /sendWS\('resolve-agent'/)
  assert.doesNotMatch(fleetToolsSource, /Not delegating: a registry row is not a usable agent/)
  assert.doesNotMatch(fleetToolsSource, /not alive\/usable yet\. Not delegating/)
})

test('spawn relay can return a pre-claim shell for mailbox delivery', () => {
  assert.match(serverSource, /mailboxTarget/)
  assert.match(serverSource, /shell\?\.metadata\?\.shell/)
  assert.match(serverSource, /pending:\s*true/)
  assert.match(serverSource, /no reserved shell row exists/)
})
