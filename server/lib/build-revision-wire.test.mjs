import assert from 'node:assert/strict'
import test from 'node:test'

import { createBuildQueue } from './build-queue.mjs'

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
