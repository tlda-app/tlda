import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')

test('spawn requests use a longer WS timeout than ordinary fleet requests', () => {
  assert.match(source, /const WS_REQUEST_IDLE_MS = 45_000;/)
  assert.match(source, /const SPAWN_WS_DEADLINE_MS = 30_000;/)
  assert.match(source, /const idleTimeoutMs = opts\.idleTimeoutMs \?\? WS_REQUEST_IDLE_MS;/)
  assert.match(source, /const deadlineMs = opts\.deadlineMs;/)

  const spawnCalls = [...source.matchAll(/sendWS\('spawn',\s*\{[\s\S]*?\}\s*(?:,\s*\{[^)]*\})?\)/g)]
    .map(match => match[0])

  assert.equal(spawnCalls.length, 2)
  for (const call of spawnCalls) {
    assert.match(call, /\{\s*deadlineMs:\s*SPAWN_WS_DEADLINE_MS\s*\}/)
  }
})
