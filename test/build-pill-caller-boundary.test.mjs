import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const pills = [
  'src/pills/BuildWarningPill.tsx',
  'src/pills/BuildErrorPill.tsx',
]

test('build result pills do not expose the deleted manual build entry point', async () => {
  for (const file of pills) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\/api\/projects\/.*\/build/, `${file} calls the deleted manual build route`)
    assert.doesNotMatch(source, /Clean rebuild/i, `${file} exposes a build action outside daemon proposals`)
  }
})
