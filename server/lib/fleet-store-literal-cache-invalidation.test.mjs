// Resolving an agent-set expression caches the candidate set of each LITERAL.
// These tests are about the one rule that keeps that cache honest, and they are
// written so that getting it wrong fails here rather than months later in a
// message that silently went to the wrong people.
//
// The rule: invalidate on the union of the terms an agent answered to BEFORE
// the change and the terms it answers to AFTER.
//
// The after half is the obvious one and it is not sufficient. An agent that has
// just had a label REMOVED no longer answers to it, so the terms it carries now
// cannot tell you which cached set still wrongly contains it. Anyone
// "simplifying" the invalidation to the current label set passes every test
// that only adds labels — which is why the removal case is first.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'
import { parseFilter } from '../../shared/fleet-labels.mjs'

const NOW = '2026-09-19T06:00:00.000Z'

async function withStore(testFn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-literal-cache-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: NOW, last_seen: NOW })
    await testFn(store)
  } finally {
    store.close?.()
    await rm(dir, { recursive: true, force: true })
  }
}

function recipients(store, expression) {
  return store.resolveChatRecipients(parseFilter(expression), {
    from: 'fleet:sender',
    filter: expression,
  })
}

function setLabels(store, id, labels) {
  store.upsertAgent({ id, friendly_name: id.replace('fleet:', ''), labels, registered_at: NOW, last_seen: NOW })
}

test('a REMOVED label stops matching — the before-half of the rule', () => withStore(async (store) => {
  setLabels(store, 'fleet:rev', ['reviewers'])

  assert.deepEqual(recipients(store, 'reviewers'), ['fleet:rev'], 'precondition: resolves and fills the cache')

  setLabels(store, 'fleet:rev', [])

  // After-set-only invalidation leaves the `reviewers` entry untouched here,
  // because the agent no longer mentions `reviewers` at all. This is the
  // assertion that fails in that case.
  assert.deepEqual(recipients(store, 'reviewers'), [], 'a dropped label must not keep resolving from cache')
}))

test('an ADDED label starts matching — the after-half', () => withStore(async (store) => {
  setLabels(store, 'fleet:rev', [])
  assert.deepEqual(recipients(store, 'reviewers'), [], 'precondition: no match, and the empty set is cached')

  setLabels(store, 'fleet:rev', ['reviewers'])

  assert.deepEqual(recipients(store, 'reviewers'), ['fleet:rev'], 'a new label must invalidate the cached empty set')
}))

test('a label moving between agents invalidates for both', () => withStore(async (store) => {
  setLabels(store, 'fleet:one', ['helm'])
  setLabels(store, 'fleet:two', [])
  assert.deepEqual(recipients(store, 'helm'), ['fleet:one'])

  setLabels(store, 'fleet:one', [])
  setLabels(store, 'fleet:two', ['helm'])

  assert.deepEqual(recipients(store, 'helm'), ['fleet:two'], 'the term must follow the label, not the first answer')
}))

test('a rename invalidates the old name as well as the new', () => withStore(async (store) => {
  store.upsertAgent({ id: 'fleet:r', friendly_name: 'oldname', labels: [], registered_at: NOW, last_seen: NOW })
  assert.deepEqual(recipients(store, 'oldname'), ['fleet:r'], 'precondition: the name resolves and is cached')

  store.upsertAgent({ id: 'fleet:r', friendly_name: 'newname', labels: [], registered_at: NOW, last_seen: NOW })

  assert.deepEqual(recipients(store, 'oldname'), [], 'the old name must stop resolving')
  assert.deepEqual(recipients(store, 'newname'), ['fleet:r'], 'the new name must resolve')
}))

test('an expression over two literals sees a change to either', () => withStore(async (store) => {
  setLabels(store, 'fleet:both', ['mathy', 'reviewers'])
  assert.deepEqual(recipients(store, 'mathy & reviewers'), ['fleet:both'])

  setLabels(store, 'fleet:both', ['mathy'])

  assert.deepEqual(
    recipients(store, 'mathy & reviewers'), [],
    'invalidating one literal of a conjunction must change the conjunction',
  )
}))
