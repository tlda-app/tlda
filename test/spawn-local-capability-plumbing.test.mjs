import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('spawn-local capability flags are passed to the shared Node spawn helper', () => {
  const cli = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(cli, /flagFromRaw\(spawnArgs, 'capability'\) \|\| flagFromRaw\(spawnArgs, 'spawn-capability'\)/)
  assert.match(cli, /requestedCapability,/)
})

test('MCP local spawn capability is passed to the shared Node spawn helper', () => {
  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  assert.match(tools, /requestedCapability: opts\.capability \|\| opts\.spawnCapability \|\| undefined/)
})
