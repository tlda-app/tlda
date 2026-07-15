import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../agent-launch/tmux.mjs', import.meta.url), 'utf8')
const start = source.indexOf('export async function injectCodexPrompt')
const end = source.indexOf('\nexport async function injectClaudePrompt', start)
assert.notEqual(start, -1)
assert.notEqual(end, -1)
const block = source.slice(start, end)

assert.match(block, /stdout\.includes\('Starting MCP servers'\)/)
assert.match(block, /!mcpStarting/)
assert.match(block, /stdout\.includes\('MCP startup interrupted'\)/)

console.log('codex prompt injection startup guards present')
