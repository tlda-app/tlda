import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('absent optional document metadata returns an empty success response', () => {
  const source = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('if (BARE_METADATA.has(filePath))')
  const end = source.indexOf("if (filePath.endsWith('.html'))", start)
  const route = source.slice(start, end)

  assert.match(route, /if \(aliased\)/)
  assert.match(route, /return res\.status\(204\)\.end\(\)/)
})
