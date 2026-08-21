import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import test from 'node:test'

test('public manifest and MCP health contain no legacy document-format authority', () => {
  const manifest = readFileSync(join(import.meta.dirname, 'manifest.mjs'), 'utf8')
  const mcp = readFileSync(join(import.meta.dirname, '..', 'mcp-server', 'index.mjs'), 'utf8')
  assert.doesNotMatch(manifest, /doc\.format|merged\.format/)
  assert.doesNotMatch(mcp, /config\.format/)
  assert.match(mcp, /sourceFormat: config\.sourceFormat/)
  assert.match(mcp, /documentFormat: config\.documentFormat/)
})
