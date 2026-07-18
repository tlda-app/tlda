import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeStateFromProcessList } from '../agent-launch/tmux.mjs'

test('Codex parent without tlda MCP is runtime-present but not usable', () => {
  const state = runtimeStateFromProcessList(['100'], [
    '100 1 -zsh',
    '101 100 codex --no-alt-screen',
  ].join('\n'))
  assert.deepEqual(state, { runtime: true, mcp: false })
})

test('Codex parent with descendant tlda MCP is runtime-present and MCP-ready', () => {
  const state = runtimeStateFromProcessList(['100'], [
    '100 1 -zsh',
    '101 100 codex --no-alt-screen',
    '102 101 node /repo/mcp-server/index.mjs',
  ].join('\n'))
  assert.deepEqual(state, { runtime: true, mcp: true })
})
