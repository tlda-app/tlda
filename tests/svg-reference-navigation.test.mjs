import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('SVG reference navigation moves the primary document camera', async () => {
  const source = await readFile(new URL('../src/SvgDocument.tsx', import.meta.url), 'utf8')

  assert.match(source, /const targetPage = document\.pages\[page - 1\]/)
  assert.match(source, /editor\.centerOnPoint\(/)
})
