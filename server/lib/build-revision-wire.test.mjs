import assert from 'node:assert/strict'
import test from 'node:test'

import { createBuildQueue } from './build-queue.mjs'

test('build admission rejects a submission without its authenticated daemon namespace', async () => {
  let starts = 0
  const queue = createBuildQueue({
    transport: { start() { starts += 1; throw new Error('must not start') } },
    getProjectsDir: () => '/projects',
    getCurrentHead: async () => null,
  })
  await assert.rejects(
    queue.admitBuild('paper', { revision: 'a'.repeat(40), branch: 'main' }),
    /daemonId/,
  )
  assert.equal(starts, 0)
})

test('build queue carries immutable proposal revision, daemon, and branch to worker transport', async () => {
  const started = []
  const queue = createBuildQueue({
    transport: {
      start(job, handlers) {
        started.push(job)
        setImmediate(() => handlers.onExit(0))
        return { cancel() {} }
      },
    },
    getProjectsDir: () => '/projects',
    getCurrentHead: async () => null,
  })

  await queue.admitBuild('paper', {
    revision: 'b'.repeat(40),
    daemonId: 'mini:testing',
    branch: 'paper-edits',
  })

  assert.equal(started.length, 1)
  assert.equal(started[0].sourceRevision, 'b'.repeat(40))
  assert.equal(started[0].daemonId, 'mini:testing')
  assert.equal(started[0].branch, 'paper-edits')
  assert.equal(started[0].acceptSeq, 1)
})
