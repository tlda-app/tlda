import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

test('missing resume handle error does not recommend refresh', () => {
  const source = read('bin/lib/spawn/index.mjs')
  assert.doesNotMatch(source, /Use refresh to start fresh/)
  assert.match(source, /Session resolution failed/)
  assert.match(source, /session-tracking fault/)
})

test('MCP spawn surface does not expose refresh', () => {
  const source = read('mcp-server/fleet-tools.mjs')
  assert.doesNotMatch(source, /Pass refresh=true/)
  assert.doesNotMatch(source, /breaks compaction loops/)
})

test('server rejects MCP refresh before spawn routing', () => {
  const source = read('server/unified-server.mjs')
  assert.match(source, /refresh is disabled through MCP spawn/)
  assert.doesNotMatch(source, /codex refresh is not supported through MCP spawn/)
})
