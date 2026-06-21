import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLiveStore } from './live-store.ts'
import type { Filter, LiveStore, Rec } from './live-store.ts'

interface TestRec extends Rec {
  labels: readonly string[]
  alive: boolean
  score: number
}

function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]
}

function randomRec(random: () => number, id: string): TestRec {
  const labels = ['mathy', 'reviewers', 'awake', 'pickup', 'ops', 'goose']
  const selected: string[] = []
  for (const label of labels) {
    if (random() < 0.34) selected.push(label)
  }
  return {
    id,
    labels: selected,
    alive: random() < 0.72,
    score: Math.floor(random() * 100),
  }
}

function ids(records: readonly TestRec[]): string[] {
  return records.map((rec) => rec.id)
}

function assertSameRecords(actual: readonly TestRec[], expected: readonly TestRec[]): void {
  assert.deepEqual(ids(actual), ids(expected))
  assert.deepEqual(actual, expected)
}

test('maintains views and indexes equivalent to full scans after every random op', () => {
  const random = rng(0xdecafbad)
  const store = createLiveStore<TestRec>()
  const filters: Array<{ key: string; filter: Filter<TestRec> }> = [
    { key: 'alive', filter: (rec) => rec.alive },
    { key: 'mathy', filter: (rec) => rec.labels.includes('mathy') },
    { key: 'awake-reviewer', filter: (rec) => rec.alive && rec.labels.includes('reviewers') },
    { key: 'high-score', filter: (rec) => rec.score >= 60 },
    { key: 'ops-or-pickup', filter: (rec) => rec.labels.includes('ops') || rec.labels.includes('pickup') },
  ]
  const views = filters.map(({ key, filter }) => ({ filter, view: store.view(filter, { key }) }))
  const byLabel = store.index('byLabel', (rec) => rec.labels)
  const byAlive = store.index('byAlive', (rec) => rec.alive)
  const byScoreBand = store.index('byScoreBand', (rec) => Math.floor(rec.score / 25))

  const labels = ['mathy', 'reviewers', 'awake', 'pickup', 'ops', 'goose']
  const idsToUse = Array.from({ length: 35 }, (_value, index) => `rec-${index}`)

  for (let step = 0; step < 500; step++) {
    const id = pick(random, idsToUse)
    if (random() < 0.78) store.upsert(randomRec(random, id))
    else store.remove(id)

    const all = store.all()
    for (const { filter, view } of views) {
      assertSameRecords(view.list, all.filter(filter))
      assertSameRecords(view.get(), view.list)
      assert.equal(view.size, view.list.length)
    }
    for (const label of labels) {
      assertSameRecords(byLabel.get(label), all.filter((rec) => rec.labels.includes(label)))
    }
    for (const alive of [true, false]) {
      assertSameRecords(byAlive.get(alive), all.filter((rec) => rec.alive === alive))
    }
    for (const band of [0, 1, 2, 3]) {
      assertSameRecords(byScoreBand.get(band), all.filter((rec) => Math.floor(rec.score / 25) === band))
    }
  }
})

test('dedupes keyed views with ref-counted disposal', () => {
  const store = createLiveStore<TestRec>({
    initial: [
      { id: 'a', labels: ['ops'], alive: true, score: 10 },
      { id: 'b', labels: [], alive: false, score: 90 },
    ],
  })
  const filter: Filter<TestRec> = (rec) => rec.alive
  const first = store.view(filter, { key: 'alive' })
  const second = store.view(() => false, { key: 'alive' })

  assert.equal(first, second)
  assert.deepEqual(ids(first.list), ['a'])
  first.dispose()
  store.upsert({ id: 'c', labels: [], alive: true, score: 11 })
  assert.deepEqual(ids(second.list), ['a', 'c'])
  second.dispose()
  store.upsert({ id: 'd', labels: [], alive: true, score: 12 })
  assert.deepEqual(ids(second.list), [])
})

test('does not rescan the collection on mutation paths', () => {
  const store = createLiveStore<TestRec>()
  let filterCalls = 0
  let keyCalls = 0
  const filters = [
    (rec: TestRec) => {
      filterCalls += 1
      return rec.alive
    },
    (rec: TestRec) => {
      filterCalls += 1
      return rec.labels.includes('ops')
    },
    (rec: TestRec) => {
      filterCalls += 1
      return rec.score > 40
    },
  ]
  for (const [index, filter] of filters.entries()) store.view(filter, { key: `counted-${index}` })
  store.index('counted-labels', (rec) => {
    keyCalls += 1
    return rec.labels
  })
  store.index('counted-alive', (rec) => {
    keyCalls += 1
    return rec.alive
  })

  filterCalls = 0
  keyCalls = 0
  const random = rng(123)
  const opCount = 300
  for (let step = 0; step < opCount; step++) {
    const id = `rec-${Math.floor(random() * 80)}`
    if (random() < 0.85) store.upsert(randomRec(random, id))
    else store.remove(id)
  }

  assert.ok(filterCalls <= opCount * filters.length * 2)
  assert.ok(keyCalls <= opCount * 2 * 2)
})

test('bulk coalesces listener and view subscriber notifications', () => {
  const store = createLiveStore<TestRec>()
  const view = store.view((rec) => rec.alive, { key: 'alive' })
  let listenerCalls = 0
  let viewCalls = 0
  store.listen(() => {
    listenerCalls += 1
  })
  view.subscribe(() => {
    viewCalls += 1
  })

  store.bulk((s) => {
    s.upsert({ id: 'a', labels: [], alive: true, score: 1 })
    s.upsert({ id: 'b', labels: [], alive: true, score: 2 })
    s.upsert({ id: 'c', labels: [], alive: false, score: 3 })
    s.remove('a')
  })

  assert.equal(listenerCalls, 1)
  assert.equal(viewCalls, 1)
  assert.deepEqual(ids(view.list), ['b'])
})

test('dispose clears store-owned references and view.dispose removes only that view', () => {
  let store: LiveStore<TestRec> | null = createLiveStore<TestRec>()
  const kept = store.view((rec) => rec.alive, { key: 'kept' })
  const dropped = store.view((rec) => rec.score > 10, { key: 'dropped' })
  kept.subscribe(() => {})
  dropped.subscribe(() => {})
  dropped.dispose()

  store.upsert({ id: 'a', labels: [], alive: true, score: 20 })
  assert.deepEqual(ids(kept.list), ['a'])
  assert.deepEqual(ids(dropped.list), [])

  const viewRef = typeof WeakRef === 'undefined' ? null : new WeakRef(kept)
  store.dispose()
  assert.throws(() => store?.upsert({ id: 'b', labels: [], alive: true, score: 1 }), /disposed/)
  assert.deepEqual(kept.list, [])
  store = null

  if (viewRef && typeof globalThis.gc === 'function') {
    for (let i = 0; i < 5; i++) globalThis.gc()
    assert.equal(viewRef.deref(), kept)
  }
})

test('listener reentrancy applies nested ops after current notification', () => {
  const store = createLiveStore<TestRec>()
  const emitted: string[] = []
  store.listen((delta) => {
    emitted.push(delta.kind === 'remove' ? `remove:${delta.id}` : `${delta.kind}:${delta.rec.id}`)
    if (delta.kind === 'add' && delta.rec.id === 'a') {
      store.upsert({ id: 'b', labels: ['ops'], alive: true, score: 2 })
    }
  })

  store.upsert({ id: 'a', labels: [], alive: true, score: 1 })

  assert.deepEqual(emitted, ['add:a', 'add:b'])
  assert.deepEqual(ids(store.all()), ['a', 'b'])
})
