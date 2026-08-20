import assert from 'node:assert/strict'
import test from 'node:test'

import { createBuildQueue } from './build-queue.mjs'

function harness({ slots = 1, draws = [0.5], heads = {}, ancestors = {} } = {}) {
  const started = []
  const dispositions = []
  const signals = []
  let drawIndex = 0
  const queue = createBuildQueue({
    transport: {
      start(job, handlers) {
        const run = { job, handlers, cancelled: false }
        started.push(run)
        return { cancel() { run.cancelled = true; signals.push(job.sourceRevision); void handlers.onExit(null) } }
      },
    },
    getProjectsDir: () => '/projects',
    relayMessage() {},
    recordDisposition(job, state, result) { dispositions.push({ revision: job.sourceRevision, state, result }) },
    getCurrentHead: async name => heads[name] ?? null,
    isAncestor: async (a, b) => ancestors[`${a}>${b}`] === true,
    random() { return draws[drawIndex++] },
  }, { maxConcurrency: slots })
  const submit = (revision, daemonId, basedOnRevision = heads.paper, extra = {}) =>
    queue.dispatchBuild('paper', { sourceRevision: revision, daemonId, basedOnRevision, ...extra })
  async function flush() { await new Promise(resolve => setImmediate(resolve)) }
  async function finishAll() {
    const finished = new Set()
    for (;;) {
      await flush()
      const run = started.find(item => !finished.has(item))
      if (!run) {
        if (queue.inspect().pending.length === 0 && queue.inspect().running.length === 0) return
        continue
      }
      finished.add(run)
      await run.handlers.onExit(0)
    }
  }
  return { queue, submit, started, dispositions, signals, flush, finishAll, drawsUsed: () => drawIndex }
}

test('priority is sampled once and integer ring positions dominate stored draws', async () => {
  const h = harness({ slots: 1, draws: [0.01, 0.99, 0.2], heads: { paper: 'head' } })
  const a1 = h.submit('a1', 'a')
  await h.flush()
  const b1 = h.submit('b1', 'b')
  const a2 = h.submit('a2', 'a')
  await h.flush()
  assert.equal(h.drawsUsed(), 3)
  const queued = h.queue.inspect().pending
  const b = queued.find(job => job.sourceRevision === 'b1')
  const a = queued.find(job => job.sourceRevision === 'a2')
  assert.ok(a.integerPriority > b.integerPriority)
  assert.ok(a.priority > b.priority)
  const saved = queued.map(job => [job.sourceRevision, job.priority])
  await h.started[0].handlers.onExit(0)
  await h.flush()
  assert.equal(h.drawsUsed(), 3)
  for (const [revision, priority] of saved) {
    const job = [...h.queue.inspect().pending, ...h.queue.inspect().running].find(item => item.sourceRevision === revision)
    if (job) assert.equal(job.priority, priority)
  }
  await h.finishAll()
  await Promise.all([a1, b1, a2])
})

test('equal integer positions are ordered by their independently stored draws', async () => {
  const h = harness({ slots: 1, draws: [0.1, 0.2, 0.8], heads: { paper: 'head' } })
  const blocker = h.submit('blocker', 'other')
  await h.flush()
  const low = h.submit('low', 'a')
  const high = h.submit('high', 'a')
  await h.flush()
  const [lowJob, highJob] = ['low', 'high'].map(revision => h.queue.inspect().pending.find(job => job.sourceRevision === revision))
  assert.equal(lowJob.integerPriority, highJob.integerPriority)
  assert.ok(highJob.priority > lowJob.priority)
  await h.started[0].handlers.onExit(0)
  await h.flush()
  assert.equal(h.started[1].job.sourceRevision, 'high')
  await h.finishAll()
  await Promise.all([blocker, low, high])
})

test('submission does not rotate; start rotates only future submissions', async () => {
  const h = harness({ slots: 1, draws: [0.1, 0.2, 0.3, 0.4], heads: { paper: 'head' } })
  const blocker = h.submit('blocker', 'blocker')
  await h.flush()
  const a1 = h.submit('a1', 'a')
  const b1 = h.submit('b1', 'b')
  await h.flush()
  const a1Priority = h.queue.inspect().pending.find(j => j.sourceRevision === 'a1').priority
  await h.started[0].handlers.onExit(0)
  await h.flush()
  assert.equal(h.started[1].job.sourceRevision, 'a1')
  const a2 = h.submit('a2', 'a')
  await h.flush()
  assert.ok(h.queue.inspect().pending.find(j => j.sourceRevision === 'b1').integerPriority > h.queue.inspect().pending.find(j => j.sourceRevision === 'a2').integerPriority)
  assert.equal(h.started[1].job.priority, a1Priority)
  await h.finishAll()
  await Promise.all([blocker, a1, a2, b1])
})

test('pending descendant thins ancestor without starting or signalling it', async () => {
  const h = harness({ slots: 1, draws: [0.1, 0.2, 0.3], heads: { paper: 'head' }, ancestors: { 'old>new': true } })
  const blocker = h.submit('blocker', 'other')
  await h.flush()
  const old = h.submit('old', 'a')
  const newer = h.submit('new', 'a')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.started.map(x => x.job.sourceRevision), ['blocker'])
  assert.deepEqual(h.signals, [])
  assert.equal(h.queue.inspect().pending.some(j => j.sourceRevision === 'old'), false)
  assert.equal(h.dispositions.find(x => x.revision === 'old').result.thinned, true)
  await h.finishAll()
  await Promise.all([blocker, old, newer])
})

test('running ancestor is not killed by descendant and valid work is not priority-preempted', async () => {
  const h = harness({ slots: 1, draws: [0.1, 0.9], heads: { paper: 'head' }, ancestors: { 'old>new': true } })
  const old = h.submit('old', 'a')
  await h.flush()
  const newer = h.submit('new', 'a')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.started[0].cancelled, false)
  assert.deepEqual(h.signals, [])
  await h.finishAll()
  await Promise.all([old, newer])
})

test('head change kills pending and running work that needs a rebase', async () => {
  const h = harness({ slots: 1, draws: [0.1, 0.2], heads: { paper: 'old-head' } })
  const running = h.submit('r1', 'a')
  await h.flush()
  const pending = h.submit('r2', 'b')
  await h.queue.projectHeadChanged('paper', 'new-head')
  await Promise.all([running, pending])
  assert.deepEqual(h.signals, ['r1'])
  assert.deepEqual(h.dispositions.map(x => [x.revision, x.state]).sort(), [['r1', 'cancelled'], ['r2', 'cancelled']])
  assert.equal(h.dispositions.find(x => x.revision === 'r1').result.reason, 'needs-rebase')
})

test('a failed ancestor releases its slot and a surviving descendant starts', async () => {
  const h = harness({ slots: 1, draws: [0.1, 0.2], heads: { paper: 'head' }, ancestors: { 'old>new': true } })
  const old = h.submit('old', 'a').catch(error => error)
  await h.flush()
  const newer = h.submit('new', 'a')
  h.started[0].handlers.onMessage({ t: 'done', ok: false, error: 'expected failure' })
  await h.started[0].handlers.onExit(1)
  await h.flush()
  assert.equal(h.started[1].job.sourceRevision, 'new')
  await h.started[1].handlers.onExit(0)
  assert.match((await old).message, /expected failure/)
  await newer
})

test('B running descendants plus newest pending bound one edit line at B+1', async () => {
  const ancestors = {}
  for (let i = 0; i < 20; i++) for (let j = i + 1; j < 20; j++) ancestors[`r${i}>r${j}`] = true
  const h = harness({ slots: 3, draws: Array.from({ length: 20 }, (_, i) => i / 20), heads: { paper: 'head' }, ancestors })
  const promises = []
  for (let i = 0; i < 20; i++) promises.push(h.submit(`r${i}`, 'a'))
  await h.flush()
  assert.equal(h.queue.inspect().running.length, 3)
  assert.equal(h.queue.inspect().pending.length, 1)
  await h.finishAll()
  await Promise.all(promises)
})
