import assert from 'node:assert/strict'
import test from 'node:test'

import { createBuildQueue } from './build-queue.mjs'
import { projectRevisionStatus } from './source-lifecycle.mjs'

test('build queue carries source revision and acceptance sequence to worker transport', async () => {
  const started = []
  const transport = {
    start(job, handlers) {
      started.push(job)
      setImmediate(() => handlers.onExit(0))
      return { cancel() {} }
    },
  }
  const queue = createBuildQueue({
    transport,
    getProjectsDir: () => '/projects',
    relayMessage() {},
  })

  await queue.dispatchBuild('paper', {
    sourceRevision: 'sha256:full-source-revision',
    acceptSeq: 17,
  })

  assert.equal(started.length, 1)
  assert.equal(started[0].sourceRevision, 'sha256:full-source-revision')
  assert.equal(started[0].acceptSeq, 17)
})

test('queue coalescing durably settles displaced revisions and preserves the latest identity', async () => {
  const started = []
  const dispositions = []
  const transport = {
    start(job, handlers) {
      started.push({ job, handlers })
      return { cancel() { handlers.onExit(null) } }
    },
  }
  const queue = createBuildQueue({
    transport,
    getProjectsDir: () => '/projects',
    relayMessage() {},
    recordDisposition(job, state, result) {
      dispositions.push({ sourceRevision: job.sourceRevision, acceptSeq: job.acceptSeq, state, result })
    },
  })

  const first = queue.dispatchBuild('paper', { sourceRevision: 'revision-1', acceptSeq: 1 })
  const second = queue.dispatchBuild('paper', { sourceRevision: 'revision-2', acceptSeq: 2 })
  const third = queue.dispatchBuild('paper', { sourceRevision: 'revision-3', acceptSeq: 3 })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(dispositions[0], {
    sourceRevision: 'revision-2', acceptSeq: 2, state: 'superseded',
    result: { bySourceRevision: 'revision-3', byAcceptSeq: 3 },
  })

  await started[0].handlers.onExit(0)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(started[1].job.sourceRevision, 'revision-3')
  assert.equal(started[1].job.acceptSeq, 3)
  await started[1].handlers.onExit(0)
  await Promise.all([first, second, third])
  assert.deepEqual(dispositions.map(entry => [entry.sourceRevision, entry.state]), [
    ['revision-2', 'superseded'],
    ['revision-1', 'built'],
    ['revision-3', 'built'],
  ])
})

test('queue restart replay settles a leased revision after the replacement worker exits', async () => {
  const dispositions = []
  const makeQueue = () => createBuildQueue({
    transport: {
      start(job, handlers) {
        setImmediate(() => handlers.onExit(0))
        return { cancel() {} }
      },
    },
    getProjectsDir: () => '/projects',
    relayMessage() {},
    recordDisposition(job, state) { dispositions.push([job.sourceRevision, job.acceptSeq, state]) },
  })
  await makeQueue().dispatchBuild('paper', { sourceRevision: 'revision-replayed-after-restart', acceptSeq: 9 })
  assert.deepEqual(dispositions, [['revision-replayed-after-restart', 9, 'built']])
})

test('queue cancellation settles queued and coalesced revisions', async () => {
  const dispositions = []
  const started = []
  const queue = createBuildQueue({
    transport: {
      start(job, handlers) {
        started.push({ job, handlers })
        return { cancel() { handlers.onExit(null) } }
      },
    },
    getProjectsDir: () => '/projects',
    relayMessage() {},
    recordDisposition(job, state) { dispositions.push([job.sourceRevision, state]) },
  })
  const running = queue.dispatchBuild('running', { sourceRevision: 'running-revision', acceptSeq: 1 })
  const queued = queue.dispatchBuild('queued', { sourceRevision: 'queued-revision', acceptSeq: 2 })
  const pending = queue.dispatchBuild('running', { sourceRevision: 'pending-revision', acceptSeq: 3 })
  await queue.killBuild('queued')
  await queue.killBuild('running')
  await Promise.all([running, queued, pending])
  assert.deepEqual(dispositions.sort(), [
    ['pending-revision', 'cancelled'],
    ['queued-revision', 'cancelled'],
    ['running-revision', 'cancelled'],
  ])
})

test('project status is projected only from the latest durable revision phases', () => {
  const status = projectRevisionStatus([
    { sourceRevision: 'old', acceptSeq: 1, build: { state: 'built' }, version: { state: 'versioned' }, mirror: { state: 'mirrored' } },
    { sourceRevision: 'current', acceptSeq: 2, build: { state: 'built' }, version: { state: 'versioned' }, mirror: { state: 'pending' } },
  ])
  assert.equal(status.status, 'building')
  assert.equal(status.phase, 'mirror')
  assert.equal(status.sourceRevision, 'current')
  assert.equal(status.acceptSeq, 2)
})
