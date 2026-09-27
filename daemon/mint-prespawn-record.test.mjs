// F2 record-at-creation: the final session name lands in the mint row before
// anything spawns, so a later bind failure can never leave a live session on
// a bare row. Merge-preserving: first write sets, a new session replaces, an
// identical retry leaves the row alone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MintStore } from './mint-store.mjs'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-prespawn-'))
  const store = new MintStore(join(dir, 'daemon-mints.sqlite'), { defaultEnvName: 'testing' })
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('bare row records session and daemon key', () => {
  const { store, cleanup } = freshStore()
  try {
    store.ensure('mint-1')
    store.recordPreSpawnSession('mint-1', 'fleet-sess', 'mini:testing')
    assert.deepEqual(store.get('mint-1')?.processState, { tmux_session: 'fleet-sess', daemon_key: 'mini:testing' })
  } finally { cleanup() }
})

test('identical retry leaves the row alone', () => {
  const { store, cleanup } = freshStore()
  try {
    store.ensure('mint-1')
    store.recordPreSpawnSession('mint-1', 'fleet-sess', 'mini:testing')
    const before = store.get('mint-1')?.processState
    store.recordPreSpawnSession('mint-1', 'fleet-sess', 'mini:testing')
    assert.deepEqual(store.get('mint-1')?.processState, before)
  } finally { cleanup() }
})

test('retry under a new session replaces the name and keeps other fields', () => {
  const { store, cleanup } = freshStore()
  try {
    store.ensure('mint-1')
    store.recordPreSpawnSession('mint-1', 'fleet-old', 'mini:testing')
    store.updateProcessState('mint-1', { tmux_session: 'fleet-old', daemon_key: 'mini:testing', harness: 'codex', pid: 123 })
    store.recordPreSpawnSession('mint-1', 'fleet-new', 'mini:testing')
    assert.deepEqual(store.get('mint-1')?.processState, { tmux_session: 'fleet-new', daemon_key: 'mini:testing', harness: 'codex', pid: 123 })
  } finally { cleanup() }
})

test('missing daemon key records the session without it', () => {
  const { store, cleanup } = freshStore()
  try {
    store.ensure('mint-1')
    store.recordPreSpawnSession('mint-1', 'fleet-sess')
    assert.deepEqual(store.get('mint-1')?.processState, { tmux_session: 'fleet-sess' })
  } finally { cleanup() }
})

test('missing identity throws before touching the row', () => {
  const { store, cleanup } = freshStore()
  try {
    assert.throws(() => store.recordPreSpawnSession(null, 'fleet-sess'), /mint_id is required/)
    assert.throws(() => store.recordPreSpawnSession('mint-1', null), /tmux_session is required/)
  } finally { cleanup() }
})
