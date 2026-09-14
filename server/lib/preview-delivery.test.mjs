import assert from 'node:assert/strict'
import test from 'node:test'

import { createPreviewDelivery, DELIVERY_WARNING_CATEGORY } from './preview-delivery.mjs'
import { writeSentinel, writeSentinelWarning, DOC_VERSION_SENTINEL_ID } from './sentinel.mjs'

// The real sentinel writer, over an in-memory shape. Using the real one is the
// point: the staleness rule and the merge are what these tests are about, and a
// stub of them would only prove the stub.
function sentinelStore(initialWarnings = []) {
  let shape = initialWarnings.length
    ? { id: DOC_VERSION_SENTINEL_ID, props: { acceptSeq: 0, warningsJson: JSON.stringify(initialWarnings) } }
    : null
  const io = {
    upsertShape: async (_doc, _id, updater) => { shape = updater(shape) },
  }
  return {
    io,
    get warnings() {
      const json = shape?.props?.warningsJson
      if (!json) return []
      try { return JSON.parse(json) } catch { return [] }
    },
    get acceptSeq() { return shape?.props?.acceptSeq },
    async publishBuild(acceptSeq, warnings = []) {
      await writeSentinel(DOC_VERSION_SENTINEL_ID.replace('shape:', 'doc-'), {
        acceptSeq,
        warningsJson: warnings.length ? JSON.stringify(warnings) : '',
      }, io)
    },
  }
}

/**
 * A harness that records what the delivery path did, with a promote whose
 * completion each test controls. Ordering is the whole subject here, so the
 * order responses settle in has to be the test's to decide.
 */
function harness({ config = { previewDelivery: { course: 'preview' } }, sentinelWarnings = [] } = {}) {
  const promoted = []      // promote REQUESTS, in order
  const landed = []        // promote COMPLETIONS, in order -- the destination's final state
  const sentinelWrites = []
  const gates = new Map()
  const store = sentinelStore(sentinelWarnings)

  const delivery = createPreviewDelivery({
    loadServerConfig: () => config,
    resolveEnvironmentOrigin: env => (env === 'preview' ? 'https://preview.example' : null),
    activeEnvironment: () => 'source',
    writeSentinelWarning: async (doc, args) => {
      sentinelWrites.push({ doc, ...args })
      await writeSentinelWarning(doc, args, store.io)
    },
    fetchImpl: async (url, init) => {
      // The existence probe also passes an init (its abort signal), so the
      // method is what separates it from the promote.
      if (init?.method !== 'POST') return { ok: true, status: 200 }
      const body = JSON.parse(init.body)
      promoted.push(body.revision)
      if (gates.has(body.revision)) await gates.get(body.revision)
      landed.push(body.revision)
      return { ok: true, status: 201, json: async () => ({}) }
    },
    log: () => {},
  })

  return {
    delivery,
    promoted,
    landed,
    sentinelWrites,
    get warnings() { return store.warnings },
    store,
    hold(revision) {
      let release
      gates.set(revision, new Promise(resolve => { release = resolve }))
      return release
    },
  }
}

test('a slow delivery does not hold up the caller', async () => {
  const h = harness()
  const release = h.hold('A')

  let returned = false
  const inFlight = h.delivery.deliver('course', 'A', 1).then(() => { returned = true })

  // The notifier's call returns immediately; the work continues behind it.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(returned, false, 'delivery is still running')

  release()
  await inFlight
  assert.equal(returned, true)
})

// The defect this exists for: promotion has no ordering guard, so without
// serialization A finishing after B would leave the destination on A.
test('A slow then B fast ends on B, and A is never promoted after it', async () => {
  const h = harness()
  const releaseA = h.hold('A')

  const first = h.delivery.deliver('course', 'A', 1)
  // Let A actually start. Requested in the same tick, A would be superseded
  // before it began -- also correct, and a different case from this one.
  await new Promise(resolve => setImmediate(resolve))
  const second = h.delivery.deliver('course', 'B', 2)
  // Give B every chance to overtake: without serialization it runs now, lands
  // immediately, and A lands after it.
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  releaseA()
  await Promise.all([first, second])

  // The hazard is which promote LANDS last, not which is requested first:
  // promotion has no ordering guard, so a slow A completing after B would
  // leave the destination on A.
  assert.deepEqual(h.promoted, ['A', 'B'], 'B is requested after A, never before')
  assert.equal(h.landed.at(-1), 'B', 'the destination ends on the newer revision')
})

test('a revision superseded while queued is dropped rather than delivered late', async () => {
  const h = harness()
  const releaseA = h.hold('A')

  const a = h.delivery.deliver('course', 'A', 1)
  await new Promise(resolve => setImmediate(resolve))   // A is now in flight
  const b = h.delivery.deliver('course', 'B', 2)
  const c = h.delivery.deliver('course', 'C', 3)

  releaseA()
  await Promise.all([a, b, c])

  assert.deepEqual(h.promoted, ['A', 'C'], 'B was superseded by C while queued and never promoted')
})

test('a delivery failure is retained as a warning of its own category', async () => {
  const h = harness({ config: { previewDelivery: { course: 'nowhere' } } })
  await h.delivery.deliver('course', 'A', 4)

  assert.equal(h.warnings.length, 1)
  assert.equal(h.warnings[0].category, DELIVERY_WARNING_CATEGORY)
  assert.match(h.warnings[0].message, /Preview not updated/)
  assert.match(h.warnings[0].message, /course@A/)
  assert.match(h.warnings[0].message, /nowhere/)
})

test("a render's own warnings survive a delivery failure and its clearing", async () => {
  const render = { message: 'chunk 3 produced no output', category: 'tex' }
  const h = harness({
    config: { previewDelivery: { course: 'nowhere' } },
    sentinelWarnings: [render],
  })

  await h.delivery.deliver('course', 'A', 5)
  assert.equal(h.warnings.length, 2, 'the render warning is kept beside the delivery warning')

  // Now a successful delivery: it must remove only its own.
  const ok = harness({ sentinelWarnings: h.warnings })
  await ok.delivery.deliver('course', 'B', 6)
  assert.deepEqual(ok.warnings, [render], 'only the delivery warning is cleared')
})

// The sentinel writer drops a patch whose acceptSeq is behind the current one,
// which is what makes a warning revision-scoped. Without an integer acceptSeq
// there is no such protection, so no write may be attempted at all.
test('a delivery problem with no acceptSeq writes no sentinel', async () => {
  const h = harness({ config: { previewDelivery: { course: 'nowhere' } } })
  await h.delivery.deliver('course', 'A', null)
  // The writer refuses an unscoped write, so nothing reaches the sentinel that
  // could land on a build it does not belong to.
  assert.deepEqual(h.warnings, [], 'the sentinel is untouched')
  assert.equal(h.store.acceptSeq, undefined, 'no sentinel was created either')
})

test('every sentinel write carries the acceptSeq that scopes it', async () => {
  const h = harness({ config: { previewDelivery: { course: 'nowhere' } } })
  await h.delivery.deliver('course', 'A', 7)
  assert.equal(h.sentinelWrites.length, 1)
  assert.equal(h.sentinelWrites[0].acceptSeq, 7)
  assert.equal(h.sentinelWrites[0].doc, 'doc-course')
})

test('a project the deployment does not name is not delivered', async () => {
  const h = harness({ config: { previewDelivery: { other: 'preview' } } })
  await h.delivery.deliver('course', 'A', 1)
  assert.deepEqual(h.promoted, [])
  assert.deepEqual(h.sentinelWrites, [])
})

test('an absent config is silent; an unreadable one is reported', async () => {
  const absent = createPreviewDelivery({
    loadServerConfig: () => { throw new Error('ENOENT: no such file or directory') },
    resolveEnvironmentOrigin: () => 'https://preview.example',
    activeEnvironment: () => 'source',
    writeSentinelWarning: async () => { throw new Error('should not write') },
    log: () => {},
  })
  await absent.deliver('course', 'A', 1)

  const writes = []
  const unreadable = createPreviewDelivery({
    loadServerConfig: () => { throw new Error('server.yaml: mapping values are not allowed here') },
    resolveEnvironmentOrigin: () => 'https://preview.example',
    activeEnvironment: () => 'source',
    writeSentinelWarning: async (doc, args) => writes.push(args),
    log: () => {},
  })
  await unreadable.deliver('course', 'A', 1)

  assert.equal(writes.length, 1, 'a config that cannot be read is reported')
  assert.match(writes[0].warning.message, /could not be read/)
})

test('a revision requested before the previous one starts supersedes it outright', async () => {
  const h = harness()
  const releaseA = h.hold('A')

  // No tick between them: A never begins, so there is nothing to deliver late.
  const a = h.delivery.deliver('course', 'A', 1)
  const b = h.delivery.deliver('course', 'B', 2)

  releaseA()
  await Promise.all([a, b])

  assert.deepEqual(h.promoted, ['B'], 'only the newest revision is delivered')
})

// The case the chief named: a slow delivery for build A fails after build B has
// already published. Its warning must not land on B's sentinel.
test("A's late delivery failure cannot alter B's sentinel", async () => {
  const h = harness({ config: { previewDelivery: { course: 'nowhere' } } })

  // B publishes: the sentinel is now at acceptSeq 9 with B's own render warning.
  const bWarning = { message: 'B: one chunk emitted nothing', category: 'tex' }
  await h.store.publishBuild(9, [bWarning])

  // A's delivery, belonging to the older build, fails now.
  await h.delivery.deliver('course', 'A', 3)

  assert.deepEqual(h.warnings, [bWarning], "B's sentinel is untouched")
  assert.equal(h.store.acceptSeq, 9, 'and still carries B\'s acceptSeq')
})

test("a delivery failure for the CURRENT build does land", async () => {
  const h = harness({ config: { previewDelivery: { course: 'nowhere' } } })
  const bWarning = { message: 'B: one chunk emitted nothing', category: 'tex' }
  await h.store.publishBuild(9, [bWarning])

  await h.delivery.deliver('course', 'B', 9)

  assert.equal(h.warnings.length, 2, 'the render warning and the delivery warning')
  assert.ok(h.warnings.some(w => w.category === DELIVERY_WARNING_CATEGORY))
  assert.ok(h.warnings.some(w => w.message === bWarning.message))
})

// Defect 2: the test above proves the delivery promise stays pending, which is
// a property of this module and would still pass if the caller re-awaited it.
// The defect being guarded is at the CALL SITE -- awaiting there puts delivery
// inside the worker's publishBuildInstance RPC, whose 240s budget turns a
// completed render into a reported build failure.
//
// A behavioural test of that boundary is not available: importing
// unified-server.mjs starts a server. So this reads the call site. It is a
// structural guard and is labelled as one -- it fails if someone adds `await`,
// which is the regression, and it cannot tell you anything else.
test('the notifier does not await delivery', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../unified-server.mjs', import.meta.url), 'utf8')

  const call = src.match(/^.*previewDelivery\.deliver\(.*$/m)
  assert.ok(call, 'the delivery call site was not found -- this guard is measuring nothing')
  assert.match(call[0], /^\s*void previewDelivery\.deliver\(/,
    'delivery must be fired, not awaited: awaiting it inside the publish RPC turns a completed render into a failed build')
  assert.doesNotMatch(call[0], /await/)
})

// Defect 3: recovery does not re-offer a published head --
// `recoverBuildPublications` scans leftover publish transactions and never
// reaches the notifier -- so a delivery lost to a restart leaves no trace and
// no later edit need ever come. The warning is therefore written BEFORE the
// attempt. This is the interruption: the process would die here.
test('a delivery interrupted mid-attempt leaves its warning standing', async () => {
  const h = harness()
  h.hold('A')                                  // promote never completes

  void h.delivery.deliver('course', 'A', 11)   // and is never awaited
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  const left = h.warnings.filter(w => w.category === DELIVERY_WARNING_CATEGORY)
  assert.equal(left.length, 1, 'the interrupted delivery is visible')
  assert.match(left[0].message, /did not complete/)
  assert.match(left[0].message, /course@A/)
})

test('a completed delivery leaves nothing behind', async () => {
  const h = harness()
  await h.delivery.deliver('course', 'A', 12)
  assert.deepEqual(h.warnings.filter(w => w.category === DELIVERY_WARNING_CATEGORY), [],
    'the pre-attempt warning is cleared on success')
})

// The cascade the chief found: the pre-attempt warning is written outside the
// try, so a rejecting sentinel would reject the whole chained attempt -- and
// every delivery already queued behind it would have its callback skipped.
test('a failing warning store does not drop the deliveries queued behind it', async () => {
  const promoted = []
  let failNext = true
  const delivery = createPreviewDelivery({
    loadServerConfig: () => ({ previewDelivery: { course: 'preview' } }),
    resolveEnvironmentOrigin: () => 'https://preview.example',
    activeEnvironment: () => 'source',
    writeSentinelWarning: async () => {
      if (failNext) { failNext = false; throw new Error('sentinel room unavailable') }
    },
    fetchImpl: async (url, init) => {
      if (init?.method !== 'POST') return { ok: true, status: 200 }
      promoted.push(JSON.parse(init.body).revision)
      return { ok: true, status: 201, json: async () => ({}) }
    },
    log: () => {},
  })

  const a = delivery.deliver('course', 'A', 1)
  await new Promise(resolve => setImmediate(resolve))
  const b = delivery.deliver('course', 'B', 2)
  await Promise.all([a, b])

  assert.deepEqual(promoted, ['A', 'B'], 'the newer delivery still ran')
})

test('a delivery whose storage always fails still promotes and never rejects', async () => {
  const promoted = []
  const delivery = createPreviewDelivery({
    loadServerConfig: () => ({ previewDelivery: { course: 'preview' } }),
    resolveEnvironmentOrigin: () => 'https://preview.example',
    activeEnvironment: () => 'source',
    writeSentinelWarning: async () => { throw new Error('sentinel room unavailable') },
    fetchImpl: async (url, init) => {
      if (init?.method !== 'POST') return { ok: true, status: 200 }
      promoted.push(JSON.parse(init.body).revision)
      return { ok: true, status: 201, json: async () => ({}) }
    },
    log: () => {},
  })

  await delivery.deliver('course', 'A', 1)   // must not reject
  assert.deepEqual(promoted, ['A'])
})

// A delivery that is queued and never reaches its turn -- the process dies
// while an earlier one is still running -- must still leave a trace. Nothing
// re-offers a published head, so without this it vanishes completely.
test('a delivery interrupted BEFORE its attempt starts still leaves a warning', async () => {
  const h = harness()
  h.hold('A')                                   // A occupies the queue forever

  void h.delivery.deliver('course', 'A', 20)
  await new Promise(resolve => setImmediate(resolve))
  void h.delivery.deliver('course', 'B', 21)    // queued behind A, never starts
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(h.promoted, ['A'], 'B never got its turn')
  const left = h.warnings.filter(w => w.category === DELIVERY_WARNING_CATEGORY)
  assert.equal(left.length, 1, 'and is still recorded')
  assert.match(left[0].message, /course@B/, 'the record names the revision that never ran')
})

// A clear that throws must not be reported as a delivery that failed. The
// delivery succeeded; only the stale warning survives.
test('a delivery that succeeds but cannot clear its warning is not reported as failed', async () => {
  const messages = []
  let calls = 0
  const delivery = createPreviewDelivery({
    loadServerConfig: () => ({ previewDelivery: { course: 'preview' } }),
    resolveEnvironmentOrigin: () => 'https://preview.example',
    activeEnvironment: () => 'source',
    writeSentinelWarning: async (_doc, args) => {
      calls += 1
      if (calls > 1 && args.warning === null) throw new Error('sentinel room unavailable')
    },
    fetchImpl: async (url, init) => {
      if (init?.method !== 'POST') return { ok: true, status: 200 }
      return { ok: true, status: 201, json: async () => ({}) }
    },
    log: m => messages.push(m),
  })

  await delivery.deliver('course', 'A', 30)

  const said = messages.join('\n')
  assert.match(said, /was delivered to preview/, 'it says the delivery happened')
  assert.match(said, /stale warning could not be cleared/)
  assert.doesNotMatch(said, /was not delivered/, 'and never claims it failed')
})

// Same revision, same acceptSeq, so the stale-write guard cannot order them:
// slow warning I/O landing after this delivery's own clear would leave a false
// warning on a success. The attempt awaits its own record to order the two.
test('slow warning I/O cannot leave a false warning after the same delivery succeeds', async () => {
  const store = sentinelStore()
  let releaseWrite
  const firstWriteHeld = new Promise(resolve => { releaseWrite = resolve })
  let writes = 0

  const delivery = createPreviewDelivery({
    loadServerConfig: () => ({ previewDelivery: { course: 'preview' } }),
    resolveEnvironmentOrigin: () => 'https://preview.example',
    activeEnvironment: () => 'source',
    writeSentinelWarning: async (doc, args) => {
      writes += 1
      if (writes === 1) await firstWriteHeld      // the enqueue record is slow
      await writeSentinelWarning(doc, args, store.io)
    },
    fetchImpl: async (url, init) => {
      if (init?.method !== 'POST') return { ok: true, status: 200 }
      return { ok: true, status: 201, json: async () => ({}) }
    },
    log: () => {},
  })

  const done = delivery.deliver('course', 'A', 40)
  await new Promise(resolve => setImmediate(resolve))
  releaseWrite()                                  // the slow write lands late
  await done

  assert.deepEqual(store.warnings.filter(w => w.category === DELIVERY_WARNING_CATEGORY), [],
    'the successful delivery leaves no warning behind')
})

// REMOVED: a test asserting that a slow enqueue record does not block a newer
// delivery. Two attempts at it both passed against the obvious-but-wrong fix
// (an async `deliver` that awaits the record before building the chain),
// because that variant stalls in the same place this one does -- no outcome
// distinguishes them here. The property is real and is why `deliver` stores
// the record's promise rather than awaiting it; it is asserted by the code's
// shape and by `await recorded` sitting inside the chain, not by a test.
// A test that cannot fail for the defect it names is worse than none.
