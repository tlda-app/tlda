import assert from 'node:assert/strict'
import test from 'node:test'

import { createBuildQueue } from './build-queue.mjs'

/**
 * **A build that never finishes must not hold its slot forever.**
 *
 * The stall watchdog is liveness, not progress: ANY message — heartbeats
 * included — proves the worker's event loop is running. A render hung with
 * its loop alive (R waiting on input only it can see) therefore never trips
 * it. Measured on testing 2026-09-24: corpse builds holding both worker
 * slots, one 10 days old, while admitted jobs starved.
 *
 * The time budget bounds the ATTEMPT, not the work: a build that outlasts it
 * settles as failed with reason `build-time-budget`, its slot releases, and
 * the queue drains on. The default (12h) is twenty times the longest
 * legitimate build on record (0.6h); it reaps the hung, not the slow.
 */

function harness({ budgetMs }) {
  const started = []
  const dispositions = []
  const queue = createBuildQueue({
    transport: {
      start(job, handlers) {
        const run = { job, handlers, cancelled: false, beats: null }
        started.push(run)
        // A corpse with a pulse: heartbeats forever, renders never.
        run.beats = setInterval(() => handlers.onMessage({ t: 'heartbeat' }), 5)
        run.beats.unref?.()
        return {
          cancel() {
            run.cancelled = true
            clearInterval(run.beats)
            void handlers.onExit(null, 'SIGTERM')
          },
        }
      },
    },
    getProjectsDir: () => '/projects',
    relayMessage() {},
    recordDisposition(job, state, result) { dispositions.push({ revision: job.sourceRevision, state, result }) },
    getCurrentHead: async () => null,
    isAncestor: async () => true,
    random: () => 0.5,
  }, { maxConcurrency: 1, stallTimeoutMs: 0, timeBudgetMs: budgetMs })
  return { queue, started, dispositions }
}

test('a build that outlasts its budget fails named and releases its slot', async () => {
  const { queue, started, dispositions } = harness({ budgetMs: 80 })

  await queue.admitBuild('paper', { revision: 'corpse-revision', daemonId: 'mini:testing', branch: 'main' })
  await queue.admitBuild('paper', { revision: 'next-revision', daemonId: 'mini:testing', branch: 'main' })
  const deadline = Date.now() + 5000
  while (dispositions.length < 1 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  assert.equal(dispositions.length, 1, 'the corpse settled')
  assert.equal(dispositions[0].state, 'failed')
  assert.equal(dispositions[0].result?.reason, 'build-time-budget')
  assert.match(dispositions[0].result?.error || '', /time budget/)
  assert.equal(started[0].cancelled, true, 'the worker was cancelled first')

  // The slot came back: the queued job behind the corpse started.
  const drainDeadline = Date.now() + 5000
  while (started.length < 2 && Date.now() < drainDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(started.length, 2, 'the next job started after the budget reaped the corpse')
  assert.equal(started[1].job.sourceRevision, 'next-revision')
})

test('a build that finishes inside its budget is untouched', async () => {
  const started = []
  const dispositions = []
  const queue = createBuildQueue({
    transport: {
      start(job, handlers) {
        const run = { job, handlers }
        started.push(run)
        return { cancel() {} }
      },
    },
    getProjectsDir: () => '/projects',
    relayMessage() {},
    recordDisposition(job, state, result) { dispositions.push({ revision: job.sourceRevision, state, result }) },
    getCurrentHead: async () => null,
    isAncestor: async () => true,
    random: () => 0.5,
  }, { maxConcurrency: 1, stallTimeoutMs: 0, timeBudgetMs: 60000 })

  await queue.admitBuild('paper', { revision: 'quick-revision', daemonId: 'mini:testing', branch: 'main' })
  await started[0].handlers.onExit(0)

  assert.equal(dispositions.length, 1)
  assert.equal(dispositions[0].state, 'complete')
  assert.equal(dispositions[0].result?.reason, undefined, 'no budget reason on a clean finish')
})
