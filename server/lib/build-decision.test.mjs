import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldBuildOnPush } from './build-decision.mjs'
import { createBuildQueue } from './build-queue.mjs'

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

function initialSvgDecision(queue, buildStatus = 'none') {
  return shouldBuildOnPush(
    { format: 'svg', pages: 0, buildStatus },
    'new-svg-project',
    { changedFiles: ['main.tex'], anyChanged: true, building: queue.isBuildKindPending('new-svg-project', 'build') },
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

test('a new SVG project already queued or building does not dispatch or become stale again', () => {
  const { queue, starts } = makeQueue()
  const first = initialSvgDecision(queue)
  assert.equal(first.eager, true)
  queue.dispatchBuild('new-svg-project')

  assert.deepEqual(initialSvgDecision(queue), {
    build: false,
    eager: false,
    reason: 'already-building',
  })
  assert.deepEqual(
    shouldBuildOnPush(
      { format: 'svg', pages: 0, buildStatus: 'success' },
      'new-svg-project',
      { anyChanged: false, building: true },
    ),
    { build: false, eager: false, reason: 'already-building' },
  )
  assert.equal(starts.length, 1)
})

test('two rapid initial SVG pushes produce exactly one dispatch', () => {
  const { queue, starts } = makeQueue()

  for (let push = 0; push < 2; push++) {
    const decision = initialSvgDecision(queue)
    if (decision.build && decision.eager) queue.dispatchBuild('new-svg-project')
  }

  assert.equal(starts.length, 1)
})

test('an active parts job does not suppress the initial normal SVG build', () => {
  const { queue, starts } = makeQueue()
  queue.dispatchBuild('new-svg-project', { kind: 'parts' })

  const decision = initialSvgDecision(queue)
  assert.deepEqual(decision, { build: true, eager: true, reason: 'initial-svg-build' })
  queue.dispatchBuild('new-svg-project')

  assert.equal(queue.isBuildKindPending('new-svg-project', 'parts'), true)
  assert.equal(queue.isBuildKindPending('new-svg-project', 'build'), true)
  assert.deepEqual(starts.map(({ job }) => job.kind), ['parts'])
})

test('a queued parts job does not suppress the initial normal SVG build', () => {
  const { queue } = makeQueue()
  queue.dispatchBuild('other-project')
  queue.dispatchBuild('new-svg-project', { kind: 'parts' })

  assert.equal(queue.isBuildKindPending('new-svg-project', 'parts'), true)
  assert.equal(queue.isBuildKindPending('new-svg-project', 'build'), false)
  assert.deepEqual(initialSvgDecision(queue), {
    build: true,
    eager: true,
    reason: 'initial-svg-build',
  })
})

test('a page-zero SVG can retry after its initial build completes or fails', async () => {
  const { queue, starts } = makeQueue()
  queue.dispatchBuild('new-svg-project')
  assert.equal(initialSvgDecision(queue).build, false)

  await starts[0].handlers.onExit(1)
  assert.deepEqual(initialSvgDecision(queue, 'failed'), {
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
        { anyChanged: true, building: true },
      ),
      { build: true, eager: true, reason: 'format-eager' },
    )
  }

  assert.deepEqual(
    shouldBuildOnPush(
      { format: 'svg', pages: 2, buildStatus: 'success' },
      'unused-established-svg-project',
      { anyChanged: true, building: true },
    ),
    { build: true, eager: true, reason: 'svg-eager' },
  )
})
