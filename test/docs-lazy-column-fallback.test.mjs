import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('a lazy column failure falls through to an existing built document', () => {
  const source = readFileSync(
    new URL('../server/unified-server.mjs', import.meta.url),
    'utf8',
  )
  const routeStart = source.indexOf("app.use('/docs'")
  const catchStart = source.indexOf('} catch (e) {', source.indexOf("if (filePath.endsWith('.html'))", routeStart))
  const outputFallback = source.indexOf('// Try project output first', catchStart)
  const failurePath = source.slice(catchStart, outputFallback)

  assert.match(failurePath, /lazy column render failed/)
  assert.doesNotMatch(failurePath, /return res\.status\(500\)/)
  assert.ok(outputFallback > catchStart)
})
