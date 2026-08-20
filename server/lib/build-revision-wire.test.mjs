import assert from 'node:assert/strict'
import test from 'node:test'

import { createBuildQueue } from './build-queue.mjs'
import { createDispatcherWithOptions } from './build-dispatch.mjs'

test('dispatcher rejects missing trusted daemon context before worker or disposition side effects', async () => {
  let starts = 0
  let dispositions = 0
  const dispatcher = createDispatcherWithOptions({
    start() {
      starts += 1
      throw new Error('must not start')
    },
  }, {
    sinks: { recordBuildResult() { dispositions += 1 } },
  })

  await assert.rejects(
    dispatcher.dispatchBuild('paper', { sourceRevision: 'forged-revision', basedOnRevision: null }),
    /trusted daemon context/,
  )
  assert.equal(starts, 0)
  assert.equal(dispositions, 0)
})

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
    getCurrentHead: async () => 'accepted-head',
  })

  await queue.dispatchBuild('paper', {
    sourceRevision: 'sha256:full-source-revision',
    acceptSeq: 17,
    daemonId: 'daemon:test',
    basedOnRevision: 'accepted-head',
  })

  assert.equal(started.length, 1)
  assert.equal(started[0].sourceRevision, 'sha256:full-source-revision')
  assert.equal(started[0].acceptSeq, 17)
  assert.equal(started[0].daemonId, 'daemon:test')
  assert.equal(started[0].basedOnRevision, 'accepted-head')
})
