import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('the live image ships and asserts the native PDF build tools', () => {
  const dockerfile = readFileSync(join(import.meta.dirname, '..', '..', 'Dockerfile.live'), 'utf8')
  assert.match(dockerfile, /apt-get install[^]*\bpoppler-utils\b/)
  for (const binary of ['pdfinfo', 'pdftocairo', 'pdftotext']) {
    assert.match(dockerfile, new RegExp(`RUN[^\\n]*(?:\\\\\\n[^\\n]*)*\\b${binary} -v\\b`))
  }
})
