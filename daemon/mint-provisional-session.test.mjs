// The launch emission lives apart from the observation: `session_id` means an
// observed transcript record, and the pre-minted id waits in
// `provisional_session_id` — where no observed-reader looks — until an
// observation promotes past it. Promotion is one-way and clears the column.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MintStore } from './mint-store.mjs'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-provisional-'))
  const store = new MintStore(join(dir, 'daemon-mints.sqlite'), { defaultEnvName: 'testing' })
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('a fresh row carries no provisional identity', () => {
  const { store, cleanup } = freshStore()
  try {
    store.ensure('mint-1')
    assert.equal(store.get('mint-1')?.provisionalSessionId, null)
  } finally { cleanup() }
})

test('provisional records without touching the observed column', () => {
  const { store, cleanup } = freshStore()
  try {
    store.ensure('mint-1')
    store.updateProvisionalSession('mint-1', 'emitted-1')
    const row = store.get('mint-1')
    assert.equal(row?.provisionalSessionId, 'emitted-1')
    assert.equal(row?.sessionId, null)
    assert.equal(row?.joinedAt, null)
  } finally { cleanup() }
})

test('provisional rotates on relaunch rather than conflicting', () => {
  const { store, cleanup } = freshStore()
  try {
    store.ensure('mint-1')
    store.updateProvisionalSession('mint-1', 'emitted-1')
    store.updateProvisionalSession('mint-1', 'emitted-2')
    assert.equal(store.get('mint-1')?.provisionalSessionId, 'emitted-2')
  } finally { cleanup() }
})

test('an observed identity promotes past the provisional and clears it', () => {
  const { store, cleanup } = freshStore()
  try {
    store.ensure('mint-1')
    store.updateProvisionalSession('mint-1', 'emitted-1')
    store.updateSessionFacts('mint-1', { sessionId: 'observed-1', sessionPath: '/s/observed-1.jsonl' })
    const row = store.get('mint-1')
    assert.equal(row?.sessionId, 'observed-1')
    assert.equal(row?.sessionPath, '/s/observed-1.jsonl')
    assert.equal(row?.provisionalSessionId, null)
  } finally { cleanup() }
})

test('a path-only observation leaves the provisional emission alone', () => {
  const { store, cleanup } = freshStore()
  try {
    store.ensure('mint-1')
    store.updateProvisionalSession('mint-1', 'emitted-1')
    store.updateSessionFacts('mint-1', { sessionPath: '/s/maybe.jsonl' })
    const row = store.get('mint-1')
    assert.equal(row?.sessionId, null)
    assert.equal(row?.provisionalSessionId, 'emitted-1')
  } finally { cleanup() }
})

test('provisional on a missing row throws like the other per-launch facts', () => {
  const { store, cleanup } = freshStore()
  try {
    assert.throws(() => store.updateProvisionalSession('mint-missing', 'emitted-1'), /no daemon mint facts/)
  } finally { cleanup() }
})
