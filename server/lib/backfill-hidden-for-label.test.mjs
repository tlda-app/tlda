import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

// The backfill half of the `hidden` agent-metadata field. The field alone
// changes nothing anyone can see -- no existing row carries it -- so this is
// the part that actually clears the panel, and it is a write across ~960 live
// rows on a box someone is using.
//
// Everything here runs against a disposable store built in a temp dir. Nothing
// in this file reads, names, or touches any real project or any live fleet.

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-backfill-hidden-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    await fn(store)
  } finally {
    try { store.close?.() } catch { /* a closed store is the goal, not the test */ }
    await rm(dir, { recursive: true, force: true })
  }
}

function addAgent(store, id, { labels = [], metadata = {}, dead = 0 } = {}) {
  store.db.prepare(`
    INSERT INTO agents (id, friendly_name, labels, registered_at, last_seen, dead, human, metadata)
    VALUES (@id, @name, @labels, @now, @now, @dead, 0, @metadata)
  `).run({
    id,
    name: id.replace(/^fleet:/, ''),
    labels: JSON.stringify(labels),
    now: new Date().toISOString(),
    dead,
    metadata: JSON.stringify(metadata),
  })
}

// The query leans on json_extract returning 1 for a JSON `true`. If that is
// wrong the WHERE never matches, the backfill reports 0 rows, and 0 reads
// exactly like "nothing to do". Pin it before trusting anything below.
test('json_extract reports a JSON true as 1, which is what the WHERE clause assumes', async () => {
  await withStore(async store => {
    addAgent(store, 'fleet:probe-json', { labels: ['dev-probe'], metadata: { hidden: true } })
    const row = store.db.prepare(
      "SELECT json_extract(metadata, '$.hidden') AS h FROM agents WHERE id = 'fleet:probe-json'",
    ).get()
    assert.equal(row.h, 1)
  })
})

test('it flags exactly the labelled live agents and nothing else', async () => {
  await withStore(async store => {
    addAgent(store, 'fleet:probe-1', { labels: ['dev-probe'] })
    addAgent(store, 'fleet:probe-2', { labels: ['dev-probe', 'other'] })
    // The controls. Without these a backfill that flags EVERYTHING passes the
    // count assertion and reads as working.
    addAgent(store, 'fleet:ordinary', { labels: ['app'] })
    addAgent(store, 'fleet:no-labels')
    addAgent(store, 'fleet:dead-probe', { labels: ['dev-probe'], dead: 1 })
    addAgent(store, 'fleet:shell-probe', { labels: ['dev-probe'], metadata: { shell: 1 } })

    const result = await store.backfillHiddenForLabel('dev-probe')
    assert.equal(result.converged, true)
    assert.equal(result.flagged, 2)

    const hidden = (id) => store.getAgent(id)?.metadata?.hidden === true
    assert.equal(hidden('fleet:probe-1'), true)
    assert.equal(hidden('fleet:probe-2'), true)
    assert.equal(hidden('fleet:ordinary'), false)
    assert.equal(hidden('fleet:no-labels'), false)
    assert.equal(hidden('fleet:dead-probe'), false)
    assert.equal(hidden('fleet:shell-probe'), false)
  })
})

test('it deletes nothing and marks nothing dead', async () => {
  await withStore(async store => {
    addAgent(store, 'fleet:probe-1', { labels: ['dev-probe'] })
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM agents').get().n
    await store.backfillHiddenForLabel('dev-probe')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM agents').get().n, before)
    const agent = store.getAgent('fleet:probe-1')
    assert.equal(agent.dead, false)
    // The labels it was scoped by are untouched, so a re-run finds the same set.
    assert.deepEqual(agent.labels, ['dev-probe'])
  })
})

test('other metadata on the row survives the patch', async () => {
  await withStore(async store => {
    addAgent(store, 'fleet:probe-1', { labels: ['dev-probe'], metadata: { model: 'opus', project: 'p' } })
    await store.backfillHiddenForLabel('dev-probe')
    const meta = store.getAgent('fleet:probe-1').metadata
    assert.equal(meta.hidden, true)
    assert.equal(meta.model, 'opus')
    assert.equal(meta.project, 'p')
  })
})

test('re-running converges instead of doing the work twice', async () => {
  await withStore(async store => {
    for (let i = 0; i < 250; i++) addAgent(store, `fleet:probe-${i}`, { labels: ['dev-probe'] })

    const first = await store.backfillHiddenForLabel('dev-probe')
    assert.equal(first.flagged, 250)
    assert.equal(first.converged, true)

    // The idempotency IS the WHERE clause: nothing left matches, so the second
    // run is a single empty query. No cursor, no done-flag to get wedged.
    const second = await store.backfillHiddenForLabel('dev-probe')
    assert.equal(second.flagged, 0)
    assert.equal(second.batches, 0)
    assert.equal(second.converged, true)
  })
})

test('a run interrupted partway is resumed by running it again', async () => {
  await withStore(async store => {
    for (let i = 0; i < 250; i++) addAgent(store, `fleet:probe-${i}`, { labels: ['dev-probe'] })

    // Stop it after one batch, the way a crash or a kill would.
    let stopped = 0
    const realUpdate = store.updateAgentMeta.bind(store)
    store.updateAgentMeta = (id, patch) => {
      if (stopped >= 100) throw new Error('interrupted')
      stopped++
      return realUpdate(id, patch)
    }
    await assert.rejects(() => store.backfillHiddenForLabel('dev-probe'), /interrupted/)
    store.updateAgentMeta = realUpdate

    const resumed = await store.backfillHiddenForLabel('dev-probe')
    assert.equal(resumed.flagged, 150)
    assert.equal(resumed.converged, true)
    const total = store.db.prepare(
      "SELECT COUNT(*) AS n FROM agents WHERE json_extract(metadata, '$.hidden') = 1",
    ).get().n
    assert.equal(total, 250)
  })
})

test('a row that cannot be written stops the run instead of spinning', async () => {
  await withStore(async store => {
    for (let i = 0; i < 5; i++) addAgent(store, `fleet:probe-${i}`, { labels: ['dev-probe'] })
    store.updateAgentMeta = () => {}   // writes nothing, throws nothing

    const result = await store.backfillHiddenForLabel('dev-probe')
    assert.equal(result.converged, false)
    assert.equal(result.flagged, 0)
    assert.equal(result.batches, 1)
    assert.ok(result.stalledOn.length > 0, 'a stall must name the rows it stalled on')
  })
})

test('it yields to the event loop between batches', async () => {
  await withStore(async store => {
    for (let i = 0; i < 250; i++) addAgent(store, `fleet:probe-${i}`, { labels: ['dev-probe'] })

    // The claim is "a slow backfill cannot park chat behind it". Something
    // scheduled on the loop must get to run WHILE the backfill is in flight --
    // asserted as a boundary, not as a duration, because a timing threshold on
    // a loaded box is a flake and a flaky guard gets disabled.
    let interleaved = 0
    const tick = () => { interleaved++; if (interleaved < 50) setImmediate(tick) }
    setImmediate(tick)

    const result = await store.backfillHiddenForLabel('dev-probe')
    assert.equal(result.flagged, 250)
    assert.ok(interleaved > 0, 'the loop never ran anything else; the backfill held it')
  })
})

test('the batch bound holds at 100 however large the caller asks for', async () => {
  await withStore(async store => {
    for (let i = 0; i < 250; i++) addAgent(store, `fleet:probe-${i}`, { labels: ['dev-probe'] })
    const sizes = []
    await store.backfillHiddenForLabel('dev-probe', { batchSize: 5000, onBatch: b => sizes.push(b.batchSize) })
    assert.ok(sizes.every(n => n <= 100), `a batch exceeded the bound: ${sizes.join(', ')}`)
    assert.deepEqual(sizes, [100, 100, 50])
  })
})
