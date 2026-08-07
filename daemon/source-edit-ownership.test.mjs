import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWatchedSourceFile } from './source-sync.mjs'

test('owning daemon maps a local checkout Edit to its exact project source file', () => {
  const watchers = new Map([
    ['bregman', { sourceDir: '/Users/skip/work/bregman' }],
    ['other', { sourceDir: '/Users/skip/work/other' }],
  ])
  assert.deepEqual(
    resolveWatchedSourceFile(watchers, '/Users/skip/work/bregman/b4-outline.md'),
    { project: 'bregman', file: 'b4-outline.md' },
  )
  assert.equal(resolveWatchedSourceFile(watchers, '/Users/skip/work/unbound.md'), null)
})
