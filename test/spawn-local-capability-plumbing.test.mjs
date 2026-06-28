import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('spawn-local capability flags are passed to the shared Node spawn helper', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /flagFromRaw\(spawnArgs, 'capability'\) \|\| flagFromRaw\(spawnArgs, 'spawn-capability'\)/)
  assert.match(cli, /requestedCapability,/)
})

test('spawn-local policy flag forces an explicit fenced launch without raising capability', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /const policyArg = flagFromRaw\(spawnArgs, 'policy'\)/)
  assert.match(cli, /const requestedCapability = capabilityArg \|\| \(policyArg != null \? 'write' : undefined\)/)
  assert.match(cli, /explicitPolicy: policyArg != null/)
})

test('MCP local spawn capability is passed to the shared Node spawn helper', () => {
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  assert.match(tools, /requestedCapability: opts\.capability \|\| opts\.spawnCapability \|\| undefined/)
})

test('MCP spawn exposes policy as an explicit fence request', () => {
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  assert.match(tools, /policy: \{ type: 'string'/)
  assert.match(tools, /policy: args\.policy/)
  const daemon = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  assert.match(daemon, /requestedCapability: requestedCapability \|\| \(policy != null \? 'write' : undefined\)/)
  assert.match(daemon, /explicitPolicy: policy != null/)
})
