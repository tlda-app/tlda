import assert from 'node:assert/strict'
import test from 'node:test'

const mod = await import('../src/appShellFreshness.ts')

test('classifies current app shell when loaded and live shas match', () => {
  assert.equal(
    mod.classifyAppShellFreshness(
      { gitSha: 'abc123' },
      { gitSha: 'abc123' },
    ),
    'current',
  )
})

test('classifies stale app shell when loaded and live shas differ', () => {
  assert.equal(
    mod.classifyAppShellFreshness(
      { gitSha: 'old123' },
      { gitSha: 'new456' },
    ),
    'stale',
  )
})

test('does not claim freshness without a loaded bundle stamp', () => {
  assert.equal(
    mod.classifyAppShellFreshness(
      null,
      { gitSha: 'new456' },
    ),
    'missing-loaded-stamp',
  )
})

test('does not claim freshness without a live server stamp', () => {
  assert.equal(
    mod.classifyAppShellFreshness(
      { gitSha: 'old123' },
      null,
    ),
    'missing-live-stamp',
  )
})
