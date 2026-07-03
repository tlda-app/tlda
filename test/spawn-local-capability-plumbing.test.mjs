import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('spawn-direct capability flags are passed to the shared Node spawn helper', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /flagFromRaw\(spawnArgs, 'capability'\) \|\| flagFromRaw\(spawnArgs, 'spawn-capability'\)/)
  assert.match(cli, /requestedCapability,/)
})

test('spawn-direct uses the daemon privilege ledger as spawner authority', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /resolveSpawnGrant\(\{/)
  assert.match(cli, /ledger\.grantFor\(\{ id: spawnerId \}\)/)
  assert.match(cli, /spawnerPolicy: spawnerGrant\.spawnPolicy/)
  assert.match(cli, /spawnerPrivilegeSet: spawnerGrant\.privilegeSet/)
  assert.match(cli, /spawnPolicy: grant\.grantedPolicy/)
  assert.match(cli, /privilegeSet: grant\.grantedPrivilegeSet/)
  assert.match(cli, /config,/)
  assert.match(cli, /await ledger\.set\(preallocatedAgentId/)
  assert.match(cli, /await ledger\.delete\(preallocatedAgentId\)/)
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
  assert.match(tools, /acknowledgeNoSecurity: !!opts\.iLikeToLiveDangerously/)
  assert.match(server, /acknowledgeNoSecurity: !!iLikeToLiveDangerously/)
  assert.match(daemon, /acknowledgeNoSecurity: !!acknowledgeNoSecurity/)
})

test('MCP local spawn capability is passed to the shared Node spawn helper', () => {
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  assert.match(tools, /const requestedCapability = opts\.capability \|\| opts\.spawnCapability \|\| undefined/)
  assert.match(tools, /requestedCapability: grant\.grantedCapability/)
  assert.match(tools, /config,/)
  assert.match(tools, /await privilegeLedger\.set\(preallocatedAgentId/)
  assert.match(tools, /await privilegeLedger\.delete\(preallocatedAgentId\)/)
})

test('MCP spawn exposes policy as an explicit fence request', () => {
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  assert.match(tools, /policy: \{ type: 'string'/)
  assert.match(tools, /policy: args\.policy/)
  const daemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  assert.match(daemon, /requestedCapability: requestedCapability \|\| \(policy != null \? 'write' : undefined\)/)
  assert.match(daemon, /explicitPolicy: policy != null/)
})
