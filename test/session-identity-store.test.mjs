import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  findSessionsByFleetId,
  getSessionIdentity,
  isIngestionCaughtUp,
  loadSessionIdentityStore,
  saveSessionIdentityStore,
  sessionIdentityPath,
  updateFleetFriendlyName,
  updateIngestionStatus,
  upsertSessionIdentity,
} from '../bin/lib/session-identity-store.mjs'

test('session identity store persists tuple, by_fleet_id index, name history, and ingestion status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-session-identity-'))
  const file = sessionIdentityPath(dir)
  try {
    const store = loadSessionIdentityStore(file)
    const nowValues = [
      '2026-07-04T12:00:00.000Z',
      '2026-07-04T12:01:00.000Z',
      '2026-07-04T12:02:00.000Z',
    ]
    const now = () => nowValues.shift()

    assert.equal(upsertSessionIdentity(store, {
      session_id: 'sess1',
      harness_kind: 'claude',
      fleet_id: 'fleet:abc123',
      friendly_name: 'daemon-impl',
      cwd: '/repo',
      jsonl_path: '/repo/sess1.jsonl',
      classified: true,
    }, { now }), true)
    assert.equal(updateFleetFriendlyName(store, 'fleet:abc123', 'daemon-impl:day', { now }), true)
    assert.equal(updateIngestionStatus(store, { caught_up: false, active_tails: 2, pending_jobs: 1 }, { now }), true)
    saveSessionIdentityStore(file, store)

    const loaded = loadSessionIdentityStore(file)
    assert.deepEqual(loaded.by_fleet_id, { 'fleet:abc123': ['sess1'] })
    assert.equal(loaded.sessions.sess1.friendly_name, 'daemon-impl:day')
    assert.deepEqual(loaded.sessions.sess1.name_history, [
      { friendlyName: 'daemon-impl', fromTs: '2026-07-04T12:00:00.000Z', toTs: '2026-07-04T12:01:00.000Z' },
      { friendlyName: 'daemon-impl:day', fromTs: '2026-07-04T12:01:00.000Z', toTs: null },
    ])
    assert.equal(loaded.ingestion.caught_up, false)
    assert.equal(loaded.ingestion.active_tails, 2)
    assert.equal(loaded.ingestion.pending_jobs, 1)

    assert.equal(getSessionIdentity('sess1', { filePath: file }).cwd, '/repo')
    assert.equal(findSessionsByFleetId('fleet:abc123', 'claude', { filePath: file })[0].session_id, 'sess1')
    assert.equal(isIngestionCaughtUp({ filePath: file }), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
