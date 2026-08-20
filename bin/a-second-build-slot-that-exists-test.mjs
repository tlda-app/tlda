#!/usr/bin/env node
//
// The existing unconfigured default is two concurrent builds. This is a
// capacity/latency choice, not a starvation guarantee: queue fairness is tested
// separately at k=1. Keep pinning the configured behavior here without turning
// the value into a correctness claim.
import assert from 'node:assert/strict'
import { createBuildQueue } from '../server/lib/build-queue.mjs'

// A transport that starts jobs and never finishes them, so "how many can be in
// flight at once" is directly observable.
function harness(options) {
  const running = []
  const transport = {
    start(job, handlers) {
      running.push(job)
      return { cancel() { handlers.onExit(null) } }
    },
  }
  const queue = createBuildQueue({
    transport,
    getProjectsDir: () => '/projects',
    relayMessage() {},
  }, options)
  return { queue, running }
}

// ---------------------------------------------------------------------------
// 1. UNCONFIGURED. Two different projects must build concurrently.

{
  const { queue, running } = harness(undefined)
  queue.dispatchBuild('alpha', { sourceRevision: 'a1', acceptSeq: 1 })
  queue.dispatchBuild('beta', { sourceRevision: 'b1', acceptSeq: 1 })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(running.length, 2,
    `with nothing configured, a second project builds concurrently (saw ${running.length} in flight)`)
  assert.deepEqual(running.map(job => job.name).sort(), ['alpha', 'beta'],
    'and they are the two different projects, not one twice')
}

// ---------------------------------------------------------------------------
// 2. The same, through the shape the dispatcher actually passes.
//
// `build-dispatch.mjs` hands `maxConcurrency: _config.buildMaxConcurrency`, and
// that key is absent from a `server.yaml` that has not set it — so the value
// arriving here is `undefined` rather than a missing property. That is the exact
// call that produced 1, and it is worth pinning as itself.

{
  const { queue, running } = harness({ maxConcurrency: undefined, priority: 10 })
  queue.dispatchBuild('alpha', { sourceRevision: 'a1', acceptSeq: 1 })
  queue.dispatchBuild('beta', { sourceRevision: 'b1', acceptSeq: 1 })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(running.length, 2,
    'an ABSENT buildMaxConcurrency is the unconfigured case, not the k=1 case')
}

// ---------------------------------------------------------------------------
// 3. An explicit 1 is still honoured.
//
// Nothing in this app exists to protect people from decisions they meant to
// make. A floor that overrode a configured value would be exactly that, and it
// would also be undebuggable — the config would say one thing and the machine
// would do another.

{
  const { queue, running } = harness({ maxConcurrency: 1 })
  queue.dispatchBuild('alpha', { sourceRevision: 'a1', acceptSeq: 1 })
  queue.dispatchBuild('beta', { sourceRevision: 'b1', acceptSeq: 1 })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(running.length, 1,
    'CONFIGURED 1 MEANS 1: the default is a default, not a floor that overrides the operator')
}

// ---------------------------------------------------------------------------
// 4. A larger configured value is honoured too, so this is a default rather
//    than a cap that happens to sit at 2.

{
  const { queue, running } = harness({ maxConcurrency: 3 })
  for (const name of ['alpha', 'beta', 'gamma']) queue.dispatchBuild(name, { sourceRevision: 'r', acceptSeq: 1 })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(running.length, 3, 'a configured 3 runs three')
}

console.log('a second build slot that exists: unconfigured is 2, an explicit 1 is honoured, and 3 is three')
process.exit(0)
