import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'
import { serverOwnerUpsertRow } from './server-owner-row.mjs'

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-owner-row-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    return run(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const OWNER = 'fleet:skip'

test('the first insert carries labels, a later start does not', () => {
  assert.deepEqual(serverOwnerUpsertRow({ id: OWNER, name: 'skip', existing: null }).labels, [])
  const later = serverOwnerUpsertRow({ id: OWNER, name: 'skip', existing: { id: OWNER } })
  assert.equal(
    Object.prototype.hasOwnProperty.call(later, 'labels'), false,
    'an existing owner row must be upserted with no labels key at all — ' +
    'upsertAgent reads key PRESENCE as intent, so labels: [] would clear them',
  )
})

test("a restart keeps the owner's labels", () => withStore(store => {
  store.upsertAgent({ id: OWNER, friendly_name: 'skip', human: true, labels: ['on-call', 'chief'] })

  const existing = store.getAgent(OWNER)
  store.upsertAgent(serverOwnerUpsertRow({ id: OWNER, name: 'skip', existing }))

  assert.deepEqual(store.getAgent(OWNER).labels, ['on-call', 'chief'])
}))

// The control. Without it the test above passes for a reason it never states:
// it would pass just as well if COALESCE ignored `'[]'`, and then it would not
// be testing anything. This asserts the damage is real, so the test above is
// known to be able to fail.
test('passing labels: [] for an existing row is what clears them', () => withStore(store => {
  store.upsertAgent({ id: OWNER, friendly_name: 'skip', human: true, labels: ['on-call', 'chief'] })

  store.upsertAgent({ id: OWNER, friendly_name: 'skip', human: true, dead: false, labels: [] })

  assert.deepEqual(
    store.getAgent(OWNER).labels, [],
    'if this ever stops clearing, the startup fix is no longer load-bearing and should be re-examined',
  )
}))

// `registered_at` is the same argument as `labels` and was missed: written
// unconditionally, every restart reset the owner's registration date to the
// moment the server came up. Measured on the live store — `fleet:skip` read
// `registered_at 2026-09-19T21:26:30Z`, which is a restart, visible as a burst
// of agent logins in the same second. The column stopped meaning "when this
// identity was created".
test('an existing owner keeps the date they were actually created', () => {
  const row = serverOwnerUpsertRow({
    id: 'fleet:skip',
    name: 'skip',
    existing: { registered_at: '2026-03-01T09:00:00.000Z', labels: ['ops'] },
    now: '2026-09-19T21:26:30.000Z',
  })
  assert.equal(row.registered_at, '2026-03-01T09:00:00.000Z', 'a restart must not re-date the identity')
  assert.equal(row.last_seen, '2026-09-19T21:26:30.000Z', 'but last_seen is exactly what a restart should move')
})

test('a first insert is still stamped with now', () => {
  const row = serverOwnerUpsertRow({
    id: 'fleet:skip', name: 'skip', existing: null, now: '2026-09-19T21:26:30.000Z',
  })
  assert.equal(row.registered_at, '2026-09-19T21:26:30.000Z')
  assert.deepEqual(row.labels, [], 'and a first insert still seeds labels')
})

test('an existing row with no recorded date falls back to now', () => {
  const row = serverOwnerUpsertRow({
    id: 'fleet:skip', name: 'skip', existing: { labels: ['ops'] }, now: '2026-09-19T21:26:30.000Z',
  })
  assert.equal(row.registered_at, '2026-09-19T21:26:30.000Z', 'no date to preserve is not a reason to write nothing')
})
