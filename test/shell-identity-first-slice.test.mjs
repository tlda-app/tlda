import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const serverSource = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
const fleetToolsSource = readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')

test('wake/respawn queue requires the target owner machine', () => {
  assert.doesNotMatch(serverSource, /agent\.machine_id\s*\|\|\s*machineIds\[0\]/)
  assert.doesNotMatch(serverSource, /machineIds\.length\s*===\s*0\)\s*continue/)
  assert.match(serverSource, /agent .* has no machine_id; cannot route wake\/respawn/)
  assert.match(serverSource, /agentDaemonAddress\(agent\)/)
  assert.match(serverSource, /daemonConnections\.get\(daemonKey\)/)
  assert.match(serverSource, /No fleet-daemon connected for \$\{daemonKey\}/)
})

test('combined spawn delegate follows the async spawn mailbox identity', () => {
  assert.match(fleetToolsSource, /if \(spawnResult\?\.async\)/)
  assert.match(fleetToolsSource, /const pendingAgentId = spawnResult\.agent_id/)
  assert.match(fleetToolsSource, /startOperationMailbox\('delegate'/)
  assert.match(fleetToolsSource, /spawn_mailbox_id: spawnResult\.mailbox_id/)
  assert.match(fleetToolsSource, /spawn_agent_id: pendingAgentId/)
  assert.match(fleetToolsSource, /delegateToResolvedAgent\(pendingAgentId,[\s\S]*allowPendingAgent: true/)
  assert.match(fleetToolsSource, /findSpawnedDelegateTarget\(agentName, spawnResult/)
  assert.match(fleetToolsSource, /spawnResult\?\.agent_id && a\.id === spawnResult\.agent_id/)
  assert.doesNotMatch(fleetToolsSource, /delegateToResolvedAgent\(spawned\.id/)
  assert.match(fleetToolsSource, /const assignedName = spawned\.friendly_name \|\| agentName/)
  assert.match(fleetToolsSource, /friendly_name: assignedName/)
})

test('spawn relay can return a pre-claim shell for mailbox delivery', () => {
  assert.match(serverSource, /mailboxTarget/)
  assert.match(serverSource, /shell\?\.metadata\?\.shell/)
  assert.match(serverSource, /pending:\s*true/)
  assert.match(serverSource, /no reserved shell row exists/)
})
