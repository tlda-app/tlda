import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../server/routes/projects.mjs', import.meta.url), 'utf8')

test('batch part deletion validates the whole set and rebuilds once', () => {
  const start = source.indexOf("router.delete('/:name/parts',")
  const end = source.indexOf("router.delete('/:name/parts/:id',", start)
  const route = source.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(route, /missing\.length[^]*return res\.status\(404\)/)
  assert.equal((route.match(/writeProjectPartsManifest\(/g) || []).length, 1)
  assert.equal((route.match(/await dispatchBuild\(/g) || []).length, 2)
  assert.match(route, /parts: manifest\.parts\.filter\(part => !deleted\.has\(part\.id\)\)/)
})
