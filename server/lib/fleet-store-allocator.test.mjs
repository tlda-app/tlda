import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

function createStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-allocator-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  return { dir, store }
}

function hold(store, id, name) {
  store.upsertAgent({
    id,
    friendly_name: name,
    labels: [],
    registered_at: '2026-08-08T00:00:00.000Z',
  })
}

// Independent statement of the spec (lowercase roman numerals), not a copy of
// the implementation: if the allocator emits anything else, the exhaustion
// test below finds the gap instead of the throw.
function romanLower(n) {
  const table = [[100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  for (const [value, numeral] of table) {
    while (n >= value) { out += numeral; n -= value }
  }
  return out
}

test('a free name is returned unchanged', () => {
  const { dir, store } = createStore()
  try {
    assert.equal(store.allocateFreshFriendlyName('chief-pa'), 'chief-pa')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collisions walk -jr then roman numerals from -iii', () => {
  const { dir, store } = createStore()
  try {
    hold(store, 'fleet:orig', 'chief-pa')
    const expected = ['chief-pa-jr', 'chief-pa-iii', 'chief-pa-iv', 'chief-pa-v',
      'chief-pa-vi', 'chief-pa-vii', 'chief-pa-viii', 'chief-pa-ix', 'chief-pa-x']
    expected.forEach((name, i) => {
      assert.equal(store.allocateFreshFriendlyName('chief-pa', { excludeId: `fleet:next-${i}` }), name)
      hold(store, `fleet:next-${i}`, name)
    })
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('taken suffixes are skipped without breaking the stem', () => {
  const { dir, store } = createStore()
  try {
    hold(store, 'fleet:orig', 'chief-pa')
    hold(store, 'fleet:jr', 'chief-pa-jr')
    hold(store, 'fleet:iv', 'chief-pa-iv')
    assert.equal(store.allocateFreshFriendlyName('chief-pa', { excludeId: 'fleet:new' }), 'chief-pa-iii')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('matching ignores case while the stem keeps its case', () => {
  const { dir, store } = createStore()
  try {
    hold(store, 'fleet:orig', 'alpha')
    assert.equal(store.allocateFreshFriendlyName('ALPHA', { excludeId: 'fleet:new' }), 'ALPHA-jr')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('roman exhaustion falls back to numeric suffixes', () => {
  const { dir, store } = createStore()
  try {
    hold(store, 'fleet:orig', 'chief-pa')
    let name = 'chief-pa'
    for (let i = 0; i < 200; i++) {
      name = store.allocateFreshFriendlyName('chief-pa', { excludeId: `fleet:chain-${i}` })
      assert.ok(name.startsWith('chief-pa-'), `stem survived as a prefix: ${name}`)
      if (name === 'chief-pa-2') break
      hold(store, `fleet:chain-${i}`, name)
      assert.notEqual(i, 199, 'never reached the numeric backstop')
    }
    assert.equal(name, 'chief-pa-2')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('total exhaustion throws instead of handing back a taken name', () => {
  const { dir, store } = createStore()
  try {
    const names = ['chief-pa', 'chief-pa-jr']
    for (let n = 3; n <= 99; n++) names.push(`chief-pa-${romanLower(n)}`)
    for (let i = 2; i < 10000; i++) names.push(`chief-pa-${i}`)
    const ins = store.db.prepare(
      "INSERT INTO agents (id, friendly_name, labels, last_seen, dead) VALUES (?, ?, '[]', '2026-07-25T10:00:00Z', 0)"
    )
    store.db.transaction((all) => {
      all.forEach((name, i) => ins.run(`fleet:fill-${i}`, name))
    })(names)
    assert.throws(
      () => store.allocateFreshFriendlyName('chief-pa', { excludeId: 'fleet:new' }),
      /No available friendly-name variant for "chief-pa"/
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reserved routing words throw; blank names return null', () => {
  const { dir, store } = createStore()
  try {
    assert.throws(() => store.allocateFreshFriendlyName('awake'), /reserved routing label/)
    assert.equal(store.allocateFreshFriendlyName(''), null)
    assert.equal(store.allocateFreshFriendlyName(null), null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
