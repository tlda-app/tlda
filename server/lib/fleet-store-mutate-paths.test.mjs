// The one-namespace rule across the three writes that take a name or a label.
//
// `me` and `my_labels` are routing words the matcher resolves against the
// subscriber, not stored tags: a stored `my_labels` label makes `to:my_labels`
// addressed as a literal match a holder it was never addressed to (probe
// 2026-09-23), and a friendly_name of `me` would give a second holder to a
// word every agent's mandatory `to:me` slot answers to. checkNameAvailable is
// the gate for all three writes — mutateAgentLabels (refuses), upsertAgent
// register/login (refuses the name, strips the label), renameAgentFriendlyName
// (refuses) — and this test fails against any one of them ungated.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetStore } from './fleet-store.mjs'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-mutate-paths-'))
  const store = new FleetStore(join(dir, 'fleet.db'))
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('me and my_labels are refused as labels and as names on every write', async () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:a', friendly_name: 'alpha' })
    store.upsertAgent({ id: 'fleet:b', friendly_name: 'beta' })

    // The mutate path refuses both words, on add and on replace.
    assert.throws(() => store.mutateAgentLabels('fleet:a', 'add', ['my_labels']), /reserved routing word/,
      'adding my_labels as a label is refused')
    assert.throws(() => store.mutateAgentLabels('fleet:a', 'replace', ['me']), /reserved routing word/,
      'replacing labels with me is refused')
    assert.deepEqual(store.getAgent('fleet:a').labels, [],
      'control: the refused writes stored nothing')

    // The rename path refuses both words as names.
    await assert.rejects(() => store.renameAgentFriendlyName('fleet:b', 'me'), /reserved routing word/,
      'renaming onto me is refused')
    await assert.rejects(() => store.renameAgentFriendlyName('fleet:b', 'my_labels'), /reserved routing word/,
      'renaming onto my_labels is refused')
    assert.equal(store.getAgent('fleet:b').friendly_name, 'beta',
      'control: the refused renames left the name untouched')

    // The register/login path refuses both words as names.
    assert.throws(() => store.upsertAgent({ id: 'fleet:c', friendly_name: 'me' }), /reserved routing word/,
      'registering with friendly_name me is refused')

    // And strips both words from labels, the way it already strips a label
    // held by another living agent as a name or a singleton label.
    store.upsertAgent({ id: 'fleet:d', friendly_name: 'delta', labels: ['me', 'my_labels', 'ok'] })
    assert.deepEqual(store.getAgent('fleet:d').labels, ['ok'],
      'register strips the routing words and keeps the ordinary label')

    // Ordinary writes still pass on all three paths.
    store.mutateAgentLabels('fleet:a', 'add', ['teal'])
    await store.renameAgentFriendlyName('fleet:b', 'beta2')
    store.upsertAgent({ id: 'fleet:e', friendly_name: 'echo', labels: ['teal'] })
    assert.deepEqual(store.getAgent('fleet:a').labels, ['teal'])
    assert.equal(store.getAgent('fleet:b').friendly_name, 'beta2')
    assert.deepEqual(store.getAgent('fleet:e').labels, ['teal'])
  } finally {
    cleanup()
  }
})

test('a rename onto a live label or name is refused in the store', async () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:a', friendly_name: 'alpha' })
    store.upsertAgent({ id: 'fleet:b', friendly_name: 'beta' })
    store.mutateAgentLabels('fleet:a', 'add', ['teal'])

    // Positive control: an ordinary rename works, so a green refusal below
    // cannot come from renames always failing.
    await store.renameAgentFriendlyName('fleet:b', 'beta2')
    assert.equal(store.getAgent('fleet:b').friendly_name, 'beta2')

    await assert.rejects(() => store.renameAgentFriendlyName('fleet:b', 'teal'), /already a label/,
      'a rename onto another living agents label is refused')
    await assert.rejects(() => store.renameAgentFriendlyName('fleet:b', 'alpha'), /friendly name of a living agent/,
      'a rename onto another living agents name is refused')
    assert.equal(store.getAgent('fleet:b').friendly_name, 'beta2',
      'the refused renames left the name untouched')

    // The register path refuses the same collisions.
    assert.throws(() => store.upsertAgent({ id: 'fleet:e', friendly_name: 'teal' }), /already a label/,
      'registering with a live label as the name is refused')
  } finally {
    cleanup()
  }
})
