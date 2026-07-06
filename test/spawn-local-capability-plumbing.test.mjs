import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('spawn-direct capability flags are passed to the shared Node spawn helper', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /flagFromRaw\(spawnArgs, 'capability'\) \|\| flagFromRaw\(spawnArgs, 'spawn-capability'\)/)
  assert.match(cli, /requestedCapability,/)
})

test('spawn-direct is not gated by spawner authority', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /resolveDirectSpawnGrant\(\{/)
  assert.doesNotMatch(cli, /flagFromRaw\(spawnArgs, 'spawner-id'\)/)
  assert.doesNotMatch(cli, /TLDA_SPAWNER_ID/)
  assert.doesNotMatch(cli, /fleet:skip/)
  assert.doesNotMatch(cli, /ledger\.grantFor/)
  assert.match(cli, /spawnPolicy: grant\.grantedPolicy/)
  assert.match(cli, /privilegeSet: grant\.grantedPrivilegeSet/)
  assert.match(cli, /config,/)
  assert.match(cli, /await ledger\.set\(preallocatedAgentId/)
  assert.match(cli, /await ledger\.delete\(preallocatedAgentId\)/)
})

test('operator CLI routed spawn refuses and redirects to local spawn-direct', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /function routedSpawnCliDisabledMessage\(rawArgs\)/)
  assert.match(cli, /Server-routed CLI spawn is disabled/)
  assert.match(cli, /spawnDirectSuggestion\(rawArgs\)/)
  assert.match(cli, /async function runRoutedSpawn\(rawArgs\) \{\n\s+parseRoutedSpawn\(rawArgs\)\n\s+throw new Error\(routedSpawnCliDisabledMessage\(rawArgs\)\)\n\}/)
  assert.doesNotMatch(cli, /fleetWsRequest/)
  assert.doesNotMatch(cli, /formatSpawnFailure/)
  assert.doesNotMatch(cli, /import\('ws'\)/)
})

test('routed daemon spawn remains requester gated', () => {
  const daemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  assert.match(daemon, /daemon RPC requester identity is required/)
  assert.match(daemon, /privilegeLedger\.grantFor\(requester\)/)
  assert.match(daemon, /resolveSpawnGrant\(\{/)
  assert.match(daemon, /spawnerPolicy: spawnerGrant\?\.spawnPolicy/)
  assert.match(daemon, /spawnerPrivilegeSet: spawnerGrant\?\.privilegeSet/)
})

test('spawn-direct opts into fence enforcement but daemon spawn does not', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  const daemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  assert.match(cli, /enforceFence: true/)
  assert.doesNotMatch(daemon, /enforceFence/)
})

test('spawn privilege specs are accepted as CLI file-or-name and relayed to daemon/MCP', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  const daemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  const server = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')

  assert.match(cli, /'privileges'/)
  assert.match(cli, /function privilegesFromRaw\(rawArgs\)/)
  assert.match(cli, /normalizeRequestedPrivileges\(requestedPrivileges \|\| policyArg, requestedCapability \|\| undefined\)/)
  assert.match(cli, /privilegeSet: grant\.grantedPrivilegeSet/)
  assert.match(cli, /body\.privileges = privileges/)
  assert.match(tools, /privileges: args\.privileges/)
  assert.match(server, /requestedPrivileges: privilegeRequest \|\| undefined/)
  assert.match(daemon, /requestedPrivileges,/)
})

test('spawn-direct policy flag forces an explicit fenced launch without raising capability', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /const policyArg = flagFromRaw\(spawnArgs, 'policy'\)/)
  assert.match(cli, /const requestedCapability = capabilityArg \|\| \(policyArg != null \? 'write' : undefined\)/)
  assert.match(cli, /normalizeRequestedPrivileges\(requestedPrivileges \|\| policyArg, requestedCapability \|\| undefined\)/)
  assert.match(cli, /spawnPolicy: grant\.grantedPolicy/)
  assert.match(cli, /explicitPolicy: policyArg != null/)
})

test('no-security acknowledgment is plumbed through every spawn surface', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  const daemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  const server = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')

  assert.match(cli, /hasRawFlag\(spawnArgs, 'i-like-to-live-dangerously'\)/)
  assert.match(cli, /acknowledgeNoSecurity,/)
  assert.match(cli, /body\.iLikeToLiveDangerously = true/)
  assert.match(tools, /iLikeToLiveDangerously/)
  assert.match(tools, /iLikeToLiveDangerously: !!args\.iLikeToLiveDangerously/)
  assert.match(server, /acknowledgeNoSecurity: !!iLikeToLiveDangerously/)
  assert.match(daemon, /acknowledgeNoSecurity: !!acknowledgeNoSecurity/)
})

test('MCP spawn capability is forwarded through the server spawn path', () => {
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  const server = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const spawnHelper = fs.readFileSync(new URL('../bin/lib/spawn/index.mjs', import.meta.url), 'utf8')

  assert.match(tools, /capability: args\.capability/)
  assert.match(tools, /policy: args\.policy/)
  assert.match(tools, /privileges: args\.privileges/)
  assert.match(server, /const requestedCapability = capability \|\| spawnCapability \|\| null/)
  assert.match(server, /requestedCapability: requestedCapability \|\| undefined/)
  assert.match(spawnHelper, /requestedCapability: params\.requestedCapability/)
  assert.match(spawnHelper, /acknowledgeNoSecurity: !!params\.acknowledgeNoSecurity/)
  assert.match(spawnHelper, /privilegeSet: params\.privilegeSet/)
})

test('MCP spawn exposes policy as an explicit fence request', () => {
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  assert.match(tools, /policy: \{ type: 'string'/)
  assert.match(tools, /policy: args\.policy/)
  const daemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  assert.match(daemon, /requestedCapability: requestedCapability \|\| \(policy != null \? 'write' : undefined\)/)
  assert.match(daemon, /explicitPolicy: policy != null/)
})
