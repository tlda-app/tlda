import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')

test('MCP spawn requests return through the ordinary WS request path without a spawn deadline', () => {
  assert.match(source, /const WS_REQUEST_IDLE_MS = 45_000;/)
  assert.doesNotMatch(source, /SPAWN_WS_DEADLINE_MS/)
  assert.match(source, /const idleTimeoutMs = opts\.idleTimeoutMs \?\? WS_REQUEST_IDLE_MS;/)
  assert.match(source, /const deadlineMs = opts\.deadlineMs;/)
  assert.match(source, /mailbox_id/)

  const spawnCalls = [...source.matchAll(/sendWS\('spawn',\s*\{[\s\S]*?\}\s*(?:,\s*\{[^)]*\})?\)/g)]
    .map(match => match[0])

  assert.equal(spawnCalls.length, 2)
  for (const call of spawnCalls) {
    assert.doesNotMatch(call, /deadlineMs/)
  }
})
