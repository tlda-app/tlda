import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { shouldBuildOnPush } from './build-decision.mjs'
import { closeProjectStore, initProjectStore } from './project-store.mjs'

const latexProject = updates => ({
  sourceFormat: 'tex', renderer: 'latex', documentFormat: 'paged', ...updates,
})

const documentProject = (sourceFormat, renderer, documentFormat, updates = {}) => ({
  sourceFormat, renderer, documentFormat, ...updates,
})

test('a new SVG project builds eagerly because no page can trigger the lazy build', () => {
  assert.deepEqual(shouldBuildOnPush(
    latexProject({ pages: 0, buildStatus: 'none' }),
    'unused-new-svg-project',
    { changedFiles: ['main.tex'], anyChanged: true },
  ), { build: true, eager: true, reason: 'initial-build' })
})

test('an established SVG project builds eagerly so accepted edits enter history', () => {
  assert.deepEqual(shouldBuildOnPush(
    latexProject({ pages: 1, buildStatus: 'success' }),
    'unused-established-svg-project',
    { changedFiles: [], anyChanged: true },
  ), { build: true, eager: true, reason: 'relevant-eager' })
})

test('unchanged policy ignores legacy buildStatus and uses durable readiness', () => {
  const project = documentProject('md', 'markdown', 'html', { pages: 1, buildStatus: 'success' })
  assert.equal(shouldBuildOnPush(project, 'paper', { anyChanged: false, ready: false }).build, true)
  assert.deepEqual(
    shouldBuildOnPush({ ...project, buildStatus: 'failed' }, 'paper', { anyChanged: false, ready: true }),
    { build: false, eager: false, reason: 'unchanged' },
  )
})

test('all document formats build eagerly after an accepted source change', () => {
  for (const [label, project] of [
    ['markdown', documentProject('md', 'markdown', 'html')],
    ['html', documentProject('html', 'identity', 'html')],
    ['slides', documentProject('html', 'identity', 'slides')],
    ['qmd', documentProject('qmd', 'quarto', 'html')],
    ['pdf', documentProject('pdf', 'identity', 'paged')],
  ]) {
    assert.deepEqual(shouldBuildOnPush(
      { ...project, pages: 0, buildStatus: 'none' },
      `unused-${label}`,
      { anyChanged: true, building: true },
    ), { build: true, eager: true, reason: 'initial-build' })
  }
  assert.deepEqual(shouldBuildOnPush(
    latexProject({ pages: 2, buildStatus: 'success' }),
    'unused-established-svg-project',
    { anyChanged: true, building: true },
  ), { build: true, eager: true, reason: 'relevant-eager' })
})

test('SVG source changes without a usable relevant-files filter still build eagerly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-decision-'))
  try {
    await initProjectStore(root)
    assert.deepEqual(shouldBuildOnPush(
      latexProject({ pages: 2, buildStatus: 'success' }),
      'unused-no-relevant-files-project',
      { changedFiles: ['main.tex'], anyChanged: true },
    ), { build: true, eager: true, reason: 'no-relevant-files-yet' })
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
