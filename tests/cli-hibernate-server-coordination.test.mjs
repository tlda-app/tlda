import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')

test('operator hibernate uses the server-coordinated process transition', () => {
  const start = source.indexOf('async function hibernateAgent(name)')
  const end = source.indexOf('\nasync function hibernateLocalAgent', start)
  assert.ok(start >= 0 && end > start)
  const block = source.slice(start, end)
  assert.match(block, /api\('POST', '\/api\/kill-session', \{ agent: agent\.id \}\)/)
  assert.doesNotMatch(block, /hibernateLocalAgent\(/)
})
