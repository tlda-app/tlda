import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('wake/create permission flags are passed to the shared Node spawn helper', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /flagFromRaw\(spawnArgs, 'permissions'\)/)
  assert.match(cli, /requestedPermission,/)
})

test('operator lifecycle CLI is not gated by spawner authority', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /resolveDirectSpawnGrant\(\{/)
  assert.doesNotMatch(cli, /flagFromRaw\(spawnArgs, 'spawner-id'\)/)
  assert.doesNotMatch(cli, /TLDA_SPAWNER_ID/)
  assert.doesNotMatch(cli, /fleet:skip/)
  assert.doesNotMatch(cli, /ledger\.grantFor/)
  assert.match(cli, /spawnPolicy: grant\.grantedPolicy/)
  assert.match(cli, /permissionSet: grant\.grantedPermissionSet/)
  assert.match(cli, /config,/)
  assert.match(cli, /await ledger\.set\(preallocatedAgentId/)
  assert.match(cli, /await ledger\.delete\(preallocatedAgentId\)/)
})

test('operator lifecycle CLI exposes no routed spawn redirect helper', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(cli, /function routedSpawnCliDisabledMessage\(rawArgs\)/)
  assert.doesNotMatch(cli, /Server-routed CLI spawn is disabled/)
  assert.doesNotMatch(cli, /spawnDirectSuggestion\(rawArgs\)/)
  assert.doesNotMatch(cli, /async function runRoutedSpawn\(rawArgs\)/)
  assert.match(cli, /case 'create':\s+await runFleetSpawn\(agentCreateArgs\(process\.argv\.slice\(4\)\)\)/)
  assert.match(cli, /case 'wake':\s+await runFleetSpawn\(process\.argv\.slice\(4\)\)/)
  assert.doesNotMatch(cli, /fleetWsRequest/)
  assert.doesNotMatch(cli, /formatSpawnFailure/)
  assert.doesNotMatch(cli, /import\('ws'\)/)
})

test('routed daemon spawn remains requester gated', () => {
  const daemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  assert.match(daemon, /daemon RPC requester identity is required/)
  assert.match(daemon, /permissionLedger\.grantFor\(requester\)/)
  assert.match(daemon, /resolveSpawnGrant\(\{/)
  assert.match(daemon, /spawnerPolicy: spawnerGrant\?\.spawnPolicy/)
  assert.match(daemon, /spawnerPermissionSet: spawnerGrant\?\.permissionSet/)
})

test('operator lifecycle CLI opts into fence enforcement but daemon spawn does not', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  const daemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  assert.match(cli, /enforceFence: true/)
  assert.doesNotMatch(daemon, /enforceFence/)
})

test('spawn permission specs are accepted as CLI file-or-name and relayed to daemon/MCP', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  const daemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  const server = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')

  assert.match(cli, /'permissions'/)
  assert.match(cli, /function permissionsFromRaw\(rawArgs\)/)
  assert.match(cli, /normalizeRequestedPermissions\(requestedPermissions \|\| policyArg, requestedPermission \|\| undefined\)/)
  assert.match(cli, /permissionSet: grant\.grantedPermissionSet/)
  assert.match(tools, /permissions: args\.permissions/)
  assert.match(server, /requestedPermissions: permissionRequest \|\| undefined/)
  assert.match(daemon, /requestedPermissions,/)
})

test('operator lifecycle policy flag forces an explicit fenced launch without raising permission', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /const policyArg = flagFromRaw\(spawnArgs, 'policy'\)/)
  assert.match(cli, /const requestedPermission = permissionArg \|\| \(policyArg != null \? 'write' : undefined\)/)
  assert.match(cli, /normalizeRequestedPermissions\(requestedPermissions \|\| policyArg, requestedPermission \|\| undefined\)/)
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
  assert.match(tools, /iLikeToLiveDangerously/)
  assert.match(tools, /iLikeToLiveDangerously: !!args\.iLikeToLiveDangerously/)
  assert.match(server, /acknowledgeNoSecurity: !!iLikeToLiveDangerously/)
  assert.match(daemon, /acknowledgeNoSecurity: !!acknowledgeNoSecurity/)
})

test('MCP spawn permission is forwarded through the server spawn path', () => {
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  const server = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const spawnHelper = fs.readFileSync(new URL('../bin/lib/spawn/index.mjs', import.meta.url), 'utf8')

  assert.match(tools, /permission: args\.permission/)
  assert.match(tools, /policy: args\.policy/)
  assert.match(tools, /permissions: args\.permissions/)
  assert.match(server, /const requestedPermission = permission \|\| spawnPermission \|\| null/)
  assert.match(server, /requestedPermission: requestedPermission \|\| undefined/)
  assert.match(spawnHelper, /requestedPermission: params\.requestedPermission/)
  assert.match(spawnHelper, /acknowledgeNoSecurity: !!params\.acknowledgeNoSecurity/)
  assert.match(spawnHelper, /permissionSet: params\.permissionSet/)
})

test('MCP spawn exposes policy as an explicit fence request', () => {
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  assert.match(tools, /policy: \{ type: 'string'/)
  assert.match(tools, /policy: args\.policy/)
  const daemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  assert.match(daemon, /requestedPermission: requestedPermission \|\| \(policy != null \? 'write' : undefined\)/)
  assert.match(daemon, /explicitPolicy: policy != null/)
})
