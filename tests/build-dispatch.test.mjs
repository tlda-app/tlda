import test from 'node:test'
import assert from 'node:assert/strict'
import { createBuildQueue } from '../server/lib/build-queue.mjs'
import { createDispatcherWithOptions } from '../server/lib/build-dispatch.mjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

test('build dispatcher keeps build and parts jobs distinct for the same project', async () => {
  const transport = fakeTransport()
  const dispatcher = createBuildQueue({ transport, getProjectsDir: () => '/tmp/tlda-projects-test' }, { maxConcurrency: 1 })

  const first = dispatcher.dispatchBuild('doc', { kind: 'build' })
  let buildResolved = false
  first.then(() => { buildResolved = true })
  const parts = dispatcher.dispatchBuild('doc', { kind: 'parts' })
  const secondBuild = dispatcher.dispatchBuild('doc', { kind: 'build' })

  assert.equal(transport.started.length, 1)
  assert.equal(transport.started[0].job.kind, 'build')

  transport.started[0].handlers.onExit(0)
  await tick()

  assert.equal(buildResolved, false)
  assert.equal(transport.started.length, 2)
  assert.equal(transport.started[1].job.kind, 'parts')

  transport.started[1].handlers.onExit(0)
  await tick()

  assert.equal(transport.started.length, 3)
  assert.equal(transport.started[2].job.kind, 'build')

  transport.started[2].handlers.onExit(0)
  await first
  await parts
  await secondBuild
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

test('dispatcher relays non-SVG worker side effects through server sinks', async () => {
  const transport = fakeTransport()
  const relayed = []
  const dispatcher = createDispatcherWithOptions(transport, {
    sinks: {
      updateProject: (...args) => relayed.push(['updateProject', args]),
      writeSentinel: (...args) => relayed.push(['writeSentinel', args]),
      broadcastSignal: (...args) => relayed.push(['broadcastSignal', args]),
    },
  })

  const build = dispatcher.dispatchBuild('markdown-doc')
  const { handlers } = transport.started[0]
  handlers.onMessage({ t: 'report', m: 'updateProject', a: ['markdown-doc', { buildStatus: 'success', pages: 2 }] })
  handlers.onMessage({ t: 'report', m: 'writeSentinel', a: ['doc-markdown-doc', { buildReadyAt: 12 }] })
  handlers.onMessage({ t: 'report', m: 'broadcastSignal', a: ['doc-markdown-doc', 'signal:reload', { pages: 2 }] })
  handlers.onExit(0)
  await build

  assert.deepEqual(relayed, [
    ['updateProject', ['markdown-doc', { buildStatus: 'success', pages: 2 }]],
    ['writeSentinel', ['doc-markdown-doc', { buildReadyAt: 12 }]],
    ['broadcastSignal', ['doc-markdown-doc', 'signal:reload', { pages: 2 }]],
  ])
})

test('dispatcher waits for an async sentinel relay before completing a build', async () => {
  const transport = fakeTransport()
  let releaseSentinel
  const sentinelDone = new Promise(resolve => { releaseSentinel = resolve })
  const order = []
  const dispatcher = createDispatcherWithOptions(transport, {
    sinks: {
      writeSentinel: async () => { await sentinelDone; order.push('sentinel') },
      broadcastSignal: () => order.push('reload'),
    },
  })

  let completed = false
  const build = dispatcher.dispatchBuild('markdown-doc').then(() => { completed = true })
  const { handlers } = transport.started[0]
  handlers.onMessage({ t: 'report', m: 'writeSentinel', a: ['doc-markdown-doc', {}] })
  handlers.onMessage({ t: 'report', m: 'broadcastSignal', a: ['doc-markdown-doc', 'signal:reload', {}] })
  handlers.onExit(0)
  await tick()
  assert.equal(completed, false)

  releaseSentinel()
  await build
  assert.deepEqual(order, ['sentinel', 'reload'])
})

test('project request handlers schedule builds instead of importing non-SVG builders', () => {
  const source = readFileSync(resolve('server/routes/projects.mjs'), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.\/lib\/format-builders\.mjs['"]/)
  assert.doesNotMatch(source, /\bbuildMarkdown\s*\(/)
  assert.doesNotMatch(source, /\bbuildHtml\s*\(/)
  assert.doesNotMatch(source, /\bbuildSlides\s*\(/)
  assert.match(source, /dispatchBuild\([^\n]+\{ kind: 'parts' \}\)/)
})
