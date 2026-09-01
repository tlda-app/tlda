import assert from 'node:assert/strict'
import test from 'node:test'

import { createBuildQueue } from './build-queue.mjs'
import { BuildQueueStore } from './build-queue-store.mjs'

test('records a revision admission before its worker can start', async t => {
  const events = []
  const store = new BuildQueueStore(':memory:')
  t.after(() => store.close())

  const queue = createBuildQueue({
    store,
    getProjectsDir: () => '/tmp/projects',
    getCurrentHead: async () => null,
    recordAdmission: async job => events.push(`admitted:${job.sourceRevision}`),
    transport: {
      start(job) {
        events.push(`worker:${job.sourceRevision}`)
        return { cancel() {} }
      },
    },
  }, { stallTimeoutMs: 0 })

  await queue.admitBuild('project', {
    revision: 'revision-1',
    daemonId: 'mini:testing',
  })

  assert.deepEqual(events, [
    'admitted:revision-1',
    'worker:revision-1',
  ])
})
