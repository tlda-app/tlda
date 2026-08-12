#!/usr/bin/env node
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCmd } from '../agent-launch/harness/claude.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cmd = buildCmd({
  fleetId: 'fleet:claude-launch',
  localAgentId: 'local-claude-launch',
  tmuxSession: 'fleet-claude-launch',
  model: 'sonnet',
  name: 'claude-launch',
  cwd: root,
  config: {
    profiles: {},
    models: {
      default: 'sonnet',
      values: {
        sonnet: { harness: 'claude', id: 'sonnet' },
      },
    },
  },
  harnessOptions: {
    required: ['--dangerously-skip-permissions'],
  },
})

const match = cmd.match(/--mcp-config '([^']+)'/)
assert.ok(match, cmd)
const config = JSON.parse(match[1])
assert.equal(config.mcpServers.tlda.type, 'stdio')
assert.equal(config.mcpServers.tlda.command, process.execPath)
assert.deepEqual(config.mcpServers.tlda.args, [path.join(root, 'mcp-server', 'index.mjs')])
assert.equal(config.mcpServers.tlda.env.TLDA_MCP_FLEET_ONLY, '1')
console.log('PASS: Claude launch command carries a checkout-local tlda MCP config')
