import test from 'node:test'
import assert from 'node:assert/strict'
import { createBuildQueue } from '../server/lib/build-queue.mjs'

function tick() {
  return new Promise(resolve => setImmediate(resolve))
}

function fakeTransport() {
  const started = []
  return {
    started,
    start(job, handlers) {
      const record = { job, handlers, cancelled: false }
      started.push(record)
      return {
        cancel() {
          record.cancelled = true
          handlers.onExit(143)
        },
      }
    },
  }
}

test('build dispatcher caps cross-document concurrency', async () => {
  const transport = fakeTransport()
  const dispatcher = createBuildQueue({ transport, getProjectsDir: () => '/tmp/tlda-projects-test' }, { maxConcurrency: 1, priority: 12 })

  const first = dispatcher.dispatchBuild('doc-a')
  const second = dispatcher.dispatchBuild('doc-b')

  assert.equal(transport.started.length, 1)
  assert.equal(transport.started[0].job.name, 'doc-a')
  assert.equal(transport.started[0].job.priority, 12)
  assert.equal(dispatcher.isBuilding('doc-b'), true)

  transport.started[0].handlers.onExit(0)
  await first
  await tick()

  assert.equal(transport.started.length, 2)
  assert.equal(transport.started[1].job.name, 'doc-b')

  transport.started[1].handlers.onExit(0)
  await second
})

test('build dispatcher waits for a coalesced rebuild requested during an active build', async () => {
  const transport = fakeTransport()
  const dispatcher = createBuildQueue({ transport, getProjectsDir: () => '/tmp/tlda-projects-test' }, { maxConcurrency: 1 })

  const first = dispatcher.dispatchBuild('doc', { priorityPages: [1] })
  let firstResolved = false
  first.then(() => { firstResolved = true })
  let secondResolved = false
  const second = dispatcher.dispatchBuild('doc', { priorityPages: [2] }).then(() => { secondResolved = true })

  assert.equal(transport.started.length, 1)
  assert.deepEqual(transport.started[0].job.priorityPages, [1])

  transport.started[0].handlers.onExit(0)
  await tick()

  assert.equal(firstResolved, false)
  assert.equal(secondResolved, false)
  assert.equal(transport.started.length, 2)
  assert.deepEqual(transport.started[1].job.priorityPages, [2])

  transport.started[1].handlers.onExit(0)
  await first
  await second
  assert.equal(firstResolved, true)
  assert.equal(secondResolved, true)
})

test('build dispatcher resolves pending waiters when a build is killed', async () => {
  const transport = fakeTransport()
  const dispatcher = createBuildQueue({ transport, getProjectsDir: () => '/tmp/tlda-projects-test' }, { maxConcurrency: 1 })

  const first = dispatcher.dispatchBuild('doc')
  let secondResolved = false
  const second = dispatcher.dispatchBuild('doc').then(() => { secondResolved = true })

  dispatcher.killBuild('doc')
  await first
  await second

  assert.equal(transport.started[0].cancelled, true)
  assert.equal(secondResolved, true)
  assert.equal(dispatcher.isBuilding('doc'), false)
})
