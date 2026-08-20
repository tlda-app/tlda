import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { shouldBuildOnPush } from './build-decision.mjs'
import { createBuildQueue } from './build-queue.mjs'
import { closeProjectStore, initProjectStore } from './project-store.mjs'

function makeQueue() {
  const starts = []
  const queue = createBuildQueue({
    transport: {
      start(job, handlers) {
        starts.push({ job, handlers })
        return { cancel() {} }
      },
    },
    getProjectsDir: () => '/unused',
    relayMessage() {},
  })
  return { queue, starts }
}

function initialSvgDecision(buildStatus = 'none') {
  return shouldBuildOnPush(
    { format: 'svg', pages: 0, buildStatus },
    'new-svg-project',
    { changedFiles: ['main.tex'], anyChanged: true },
  )
}

test('a new SVG project builds eagerly because no page can trigger the lazy build', () => {
  assert.deepEqual(
    shouldBuildOnPush(
      { format: 'svg', pages: 0, buildStatus: 'none' },
      'unused-new-svg-project',
      { changedFiles: ['main.tex'], anyChanged: true },
    ),
    { build: true, eager: true, reason: 'initial-svg-build' },
  )
})

test('an established SVG project builds eagerly so accepted edits enter history', () => {
  assert.deepEqual(
    shouldBuildOnPush(
      { format: 'svg', pages: 1, buildStatus: 'success' },
      'unused-established-svg-project',
      { changedFiles: [], anyChanged: true },
    ),
    { build: true, eager: true, reason: 'svg-eager' },
  )
})

test('unchanged policy ignores legacy buildStatus and uses durable readiness', () => {
  const project = { format: 'markdown', pages: 1, buildStatus: 'success' }
  assert.equal(shouldBuildOnPush(project, 'paper', { anyChanged: false, ready: false }).build, true)
  assert.deepEqual(
    shouldBuildOnPush({ ...project, buildStatus: 'failed' }, 'paper', { anyChanged: false, ready: true }),
    { build: false, eager: false, reason: 'unchanged' },
  )
})

test('a later initial SVG accept reaches the queue while the first build is running', async () => {
  const { queue, starts } = makeQueue()

  const firstDecision = initialSvgDecision()
  assert.equal(firstDecision.eager, true)
  const first = queue.dispatchBuild('new-svg-project')

  // Counterfactual for the deleted admission gate: page count is still zero
  // and the first build is active, but the accepted follow-up remains build-
  // worthy and reaches the queue's pending slot.
  assert.deepEqual(initialSvgDecision(), {
    build: true,
    eager: true,
    reason: 'initial-svg-build',
  })
  const second = queue.dispatchBuild('new-svg-project')

  assert.equal(starts.length, 1)
  assert.equal(queue.isBuildKindPending('new-svg-project', 'build'), true)

  await starts[0].handlers.onExit(0)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(starts.length, 2, 'the accepted follow-up starts after the initial build')
  await starts[1].handlers.onExit(0)
  await Promise.all([first, second])
})

test('an active parts job does not suppress the initial normal SVG build', () => {
  const { queue, starts } = makeQueue()
  queue.dispatchBuild('new-svg-project', { kind: 'parts' })

  const decision = initialSvgDecision()
  assert.deepEqual(decision, { build: true, eager: true, reason: 'initial-svg-build' })
  queue.dispatchBuild('new-svg-project')

  assert.equal(queue.isBuildKindPending('new-svg-project', 'parts'), true)
  assert.equal(queue.isBuildKindPending('new-svg-project', 'build'), true)
  assert.deepEqual(starts.map(({ job }) => job.kind), ['parts', 'build'])
})

test('a queued parts job does not suppress the initial normal SVG build', () => {
  const { queue } = makeQueue()
  queue.dispatchBuild('other-project')
  queue.dispatchBuild('new-svg-project', { kind: 'parts' })

  assert.equal(queue.isBuildKindPending('new-svg-project', 'parts'), true)
  assert.equal(queue.isBuildKindPending('new-svg-project', 'build'), false)
  assert.deepEqual(initialSvgDecision(), {
    build: true,
    eager: true,
    reason: 'initial-svg-build',
  })
})

test('a page-zero SVG can retry after its initial build completes or fails', async () => {
  const { queue, starts } = makeQueue()
  // A worker that exits non-zero failed, and dispatchBuild now says so instead
  // of resolving as if the build had succeeded. The caller has to hold the
  // rejection; this test used to drop the promise on the floor.
  const dispatched = assert.rejects(
    queue.dispatchBuild('new-svg-project'),
    /exited with code 1/,
  )
  assert.equal(initialSvgDecision().build, true)

  await starts[0].handlers.onExit(1)
  await dispatched
  assert.deepEqual(initialSvgDecision('failed'), {
    build: true,
    eager: true,
    reason: 'initial-svg-build',
  })
})

test('all document formats build eagerly after an accepted source change', () => {
  for (const format of ['markdown', 'html', 'slides']) {
    assert.deepEqual(
      shouldBuildOnPush(
        { format, pages: 0, buildStatus: 'none' },
        `unused-${format}`,
        { anyChanged: true },
      ),
      { build: true, eager: true, reason: 'format-eager' },
    )
  }

  assert.deepEqual(
    shouldBuildOnPush(
      { format: 'svg', pages: 2, buildStatus: 'success' },
      'unused-established-svg-project',
      { anyChanged: true },
    ),
    { build: true, eager: true, reason: 'svg-eager' },
  )
})

test('SVG source changes without a usable relevant-files filter still build eagerly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-decision-'))
  try {
    await initProjectStore(root)
    assert.deepEqual(
      shouldBuildOnPush(
        { format: 'svg', pages: 2, buildStatus: 'success' },
        'unused-no-relevant-files-project',
        { changedFiles: ['main.tex'], anyChanged: true },
      ),
      { build: true, eager: true, reason: 'no-relevant-files-yet' },
    )
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
