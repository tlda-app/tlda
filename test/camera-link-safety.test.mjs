import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

describe('camera-link automation safety', () => {
  const automationEntrypoints = [
    'bin/tlda-test-setup.mjs',
    'bin/brush-test.mjs',
    'scripts/e2e-test.mjs',
    'tests/verify-panel-tabs.sh',
    'tests/scroll/wheel-routing.test.mjs',
  ]

  for (const file of automationEntrypoints) {
    it(`${file} marks browser sessions as automated`, () => {
      const source = readFileSync(file, 'utf8')
      assert.match(source, /[?&]pw=1/, `${file} must include pw=1 in viewer URLs`)
    })
  }

  it('test setup explicitly clears any stale linked-camera preference before load', () => {
    const source = readFileSync('bin/tlda-test-setup.mjs', 'utf8')
    assert.match(source, /localStorage\.setItem\('tlda-camera-linked', 'false'\)/)
  })
})
