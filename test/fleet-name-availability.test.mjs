import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FleetStore } from '../server/lib/fleet-store.mjs'

let store
let dbPath

function kinds(collisions) {
  return collisions.map(c => c.kind).sort()
}

describe('fleet name/label availability', () => {
  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fleet-name-availability-${process.pid}-${Date.now()}.db`)
    store = new FleetStore(dbPath)
    store.upsertAgent({ id: 'fleet:a', friendly_name: 'alpha', labels: ['reviewers'], dead: false })
    store.upsertAgent({ id: 'fleet:b', friendly_name: 'bravo', labels: [], dead: false })
  })

  afterEach(() => {
    store?.close?.()
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      fs.rmSync(f, { force: true })
    }
  })

  it('rejects friendly names that collide anywhere in the live routing label space', () => {
    assert.deepEqual(kinds(store.checkNameAvailable(['alpha'], { excludeId: 'fleet:b', asFriendlyName: true })), ['friendly_name'])
    assert.deepEqual(kinds(store.checkNameAvailable(['reviewers'], { excludeId: 'fleet:b', asFriendlyName: true })), ['label'])
    assert.deepEqual(kinds(store.checkNameAvailable(['fleet:a'], { excludeId: 'fleet:b', asFriendlyName: true })), ['agent_id'])
    assert.deepEqual(kinds(store.checkNameAvailable(['awake'], { excludeId: 'fleet:b', asFriendlyName: true })), ['pseudo_label'])
  })

  it('rejects labels that collide with reserved labels, live names, or durable ids', () => {
    assert.deepEqual(kinds(store.checkNameAvailable(['alpha'], { excludeId: 'fleet:b' })), ['friendly_name'])
    assert.deepEqual(kinds(store.checkNameAvailable(['fleet:a'], { excludeId: 'fleet:b' })), ['agent_id'])
    assert.deepEqual(kinds(store.checkNameAvailable(['human'], { excludeId: 'fleet:b' })), ['pseudo_label'])
  })

  it('allows shared ordinary group labels', () => {
    assert.deepEqual(store.checkNameAvailable(['reviewers'], { excludeId: 'fleet:b' }), [])
  })

  it('allocates deterministic variants for fresh friendly-name collisions', () => {
    assert.equal(store.allocateFreshFriendlyName('alpha', { excludeId: 'fleet:c' }), 'alpha-2')
    assert.equal(store.allocateFreshFriendlyName('bravo', { excludeId: 'fleet:c' }), 'aravo')
    assert.equal(store.allocateFreshFriendlyName('charlie', { excludeId: 'fleet:c' }), 'charlie')
  })

  it('keeps decrementing when the first variant is also unavailable', () => {
    store.upsertAgent({ id: 'fleet:c', friendly_name: 'bharlie', labels: [], dead: false })
    store.upsertAgent({ id: 'fleet:d', friendly_name: 'charlie', labels: [], dead: false })
    assert.equal(store.allocateFreshFriendlyName('charlie', { excludeId: 'fleet:e' }), 'aharlie')
  })

  it('avoids labels, durable ids, and case variants when allocating fresh names', () => {
    assert.equal(store.allocateFreshFriendlyName('reviewers', { excludeId: 'fleet:c' }), 'qeviewers')
    assert.equal(store.allocateFreshFriendlyName('ALPHA', { excludeId: 'fleet:c' }), 'ALPHA-2')
    assert.equal(store.allocateFreshFriendlyName('fleet:a', { excludeId: 'fleet:c' }), 'eleet:a')
  })

  it('keeps reserved pseudo-labels invalid instead of renaming them', () => {
    assert.throws(
      () => store.allocateFreshFriendlyName('awake', { excludeId: 'fleet:c' }),
      /reserved routing label/
    )
  })
})
