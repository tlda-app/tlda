import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { shouldBuildOnPush } from './build-decision.mjs'
import { closeProjectStore, initProjectStore } from './project-store.mjs'

test('a new SVG project builds eagerly because no page can trigger the lazy build', () => {
  assert.deepEqual(shouldBuildOnPush(
    { format: 'svg', pages: 0, buildStatus: 'none' },
    'unused-new-svg-project',
    { changedFiles: ['main.tex'], anyChanged: true },
  ), { build: true, eager: true, reason: 'initial-svg-build' })
})

test('an established SVG project builds eagerly so accepted edits enter history', () => {
  assert.deepEqual(shouldBuildOnPush(
    { format: 'svg', pages: 1, buildStatus: 'success' },
    'unused-established-svg-project',
    { changedFiles: [], anyChanged: true },
  ), { build: true, eager: true, reason: 'svg-eager' })
})

test('unchanged policy ignores legacy buildStatus and uses durable readiness', () => {
  const project = { format: 'markdown', pages: 1, buildStatus: 'success' }
  assert.equal(shouldBuildOnPush(project, 'paper', { anyChanged: false, ready: false }).build, true)
  assert.deepEqual(
    shouldBuildOnPush({ ...project, buildStatus: 'failed' }, 'paper', { anyChanged: false, ready: true }),
    { build: false, eager: false, reason: 'unchanged' },
  )
})

test('all document formats build eagerly after an accepted source change', () => {
  for (const format of ['markdown', 'html', 'slides']) {
    assert.deepEqual(shouldBuildOnPush(
      { format, pages: 0, buildStatus: 'none' },
      `unused-${format}`,
      { anyChanged: true, building: true },
    ), { build: true, eager: true, reason: 'format-eager' })
  }
  assert.deepEqual(shouldBuildOnPush(
    { format: 'svg', pages: 2, buildStatus: 'success' },
    'unused-established-svg-project',
    { anyChanged: true, building: true },
  ), { build: true, eager: true, reason: 'svg-eager' })
})

test('SVG source changes without a usable relevant-files filter still build eagerly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-decision-'))
  try {
    await initProjectStore(root)
    assert.deepEqual(shouldBuildOnPush(
      { format: 'svg', pages: 2, buildStatus: 'success' },
      'unused-no-relevant-files-project',
      { changedFiles: ['main.tex'], anyChanged: true },
    ), { build: true, eager: true, reason: 'no-relevant-files-yet' })
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
