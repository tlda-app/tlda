import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  directColdReadCodexResumeHandle,
  isBareCodexResumeId,
  resolveCodexResumeHandle,
} from '../bin/lib/codex-resume-resolver.mjs'
import { saveSessionIdentityStore, sessionIdentityPath } from '../bin/lib/session-identity-store.mjs'
import { acquireSingletonLock, sessionReaderLockPath } from '../bin/lib/singleton-lock.mjs'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-resolution-'))
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map(row => `${typeof row === 'string' ? row : JSON.stringify(row)}\n`).join(''))
}

function writeSessionIdentity(configDir, store) {
  saveSessionIdentityStore(sessionIdentityPath(configDir), {
    version: 1,
    sessions: {},
    by_fleet_id: {},
    ingestion: { caught_up: true, active_tails: 0, pending_jobs: 0, updated_at: null },
    ...store,
  })
}

function codexRegisterRows(fleetId, name, callId) {
  return [
    { type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__tlda', name: 'register', call_id: callId, arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: `Registered ${fleetId}. Your name: "${name}"` } },
  ]
}

test('bare Codex resume ids are UUIDs, not rollout basenames', () => {
  assert.equal(isBareCodexResumeId('019f2a8d-d06e-74c2-9c7c-f7ca108b0a6d'), true)
  assert.equal(isBareCodexResumeId('rollout-2026-07-03T20-36-04-019f2a8d-d06e-74c2-9c7c-f7ca108b0a6d'), false)
})

test('resolveCodexResumeHandle returns bare UUID from session identity store', async () => {
  const root = tmpdir()
  const configDir = path.join(root, 'config')
  const sid = '019f2a8d-d06e-74c2-9c7c-f7ca108b0a6d'
  const jsonl = path.join(root, 'sessions', '2026', '07', '03', `rollout-2026-07-03T20-36-04-${sid}.jsonl`)
  writeJsonl(jsonl, [{ type: 'session_meta', payload: { id: sid, cwd: '/tmp/codex-owned' } }])
  writeSessionIdentity(configDir, {
    sessions: {
      [sid]: {
        session_id: sid,
        harness_kind: 'codex',
        fleet_id: 'fleet:frontier',
        cwd: '/tmp/codex-owned',
        jsonl_path: jsonl,
        updated_at: '2026-07-05T00:00:00.000Z',
      },
    },
  })

  const result = await resolveCodexResumeHandle({ id: 'fleet:frontier' }, { identityConfigDir: configDir })
  assert.equal(result.ok, true)
  assert.equal(result.resumeId, sid)
  assert.equal(result.jsonlPath, jsonl)
  assert.equal(result.cwd, '/tmp/codex-owned')
  assert.equal(result.source, 'identity-store')
})

test('resolveCodexResumeHandle rejects stored rollout basename as invalid UUID', async () => {
  const root = tmpdir()
  const configDir = path.join(root, 'config')
  const sid = 'rollout-2026-07-03T20-36-04-019f2a8d-d06e-74c2-9c7c-f7ca108b0a6d'
  writeSessionIdentity(configDir, {
    sessions: {
      [sid]: {
        session_id: sid,
        harness_kind: 'codex',
        fleet_id: 'fleet:frontier',
        updated_at: '2026-07-05T00:00:00.000Z',
      },
    },
  })

  const result = await resolveCodexResumeHandle({ id: 'fleet:frontier' }, { identityConfigDir: configDir })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'missing-resume-handle')
  assert.equal(result.detail.reason, 'invalid-uuid')
  assert.equal(result.detail.session_id, sid)
})

test('direct cold read returns newest owned Codex rollout as bare UUID', () => {
  const root = tmpdir()
  const sessionsBase = path.join(root, 'codex-sessions')
  const oldId = '11111111-1111-4111-8111-111111111111'
  const newId = '22222222-2222-4222-8222-222222222222'
  const oldPath = path.join(sessionsBase, '2026', '07', '03', `rollout-2026-07-03T10-00-00-${oldId}.jsonl`)
  const newPath = path.join(sessionsBase, '2026', '07', '04', `rollout-2026-07-04T10-00-00-${newId}.jsonl`)
  writeJsonl(oldPath, [
    { type: 'session_meta', payload: { id: oldId, cwd: '/tmp/old' } },
    ...codexRegisterRows('fleet:appstyle', 'appstyle', 'call-old'),
  ])
  writeJsonl(newPath, [
    { type: 'session_meta', payload: { id: newId, cwd: '/tmp/new' } },
    ...codexRegisterRows('fleet:appstyle', 'appstyle', 'call-new'),
  ])
  fs.utimesSync(oldPath, new Date('2026-07-03T10:00:00Z'), new Date('2026-07-03T10:00:00Z'))
  fs.utimesSync(newPath, new Date('2026-07-04T10:00:00Z'), new Date('2026-07-04T10:00:00Z'))

  const result = directColdReadCodexResumeHandle({ id: 'fleet:appstyle' }, {
    sessionsBase,
    identityConfigDir: path.join(root, 'config'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.resumeId, newId)
  assert.equal(result.jsonlPath, newPath)
  assert.equal(result.cwd, '/tmp/new')
  assert.equal(result.source, 'direct-cold-read')
})

test('direct cold read extracts bare UUID from rollout basename when session_meta is absent', () => {
  const root = tmpdir()
  const sessionsBase = path.join(root, 'codex-sessions')
  const sid = '33333333-3333-4333-8333-333333333333'
  const fpath = path.join(sessionsBase, '2026', '07', '04', `rollout-2026-07-04T10-00-00-${sid}.jsonl`)
  writeJsonl(fpath, codexRegisterRows('fleet:basename', 'basename', 'call-basename'))

  const result = directColdReadCodexResumeHandle({ id: 'fleet:basename' }, {
    sessionsBase,
    identityConfigDir: path.join(root, 'config'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.resumeId, sid)
  assert.equal(result.jsonlPath, fpath)
})

test('direct cold read returns typed miss when no owned rollout exists', () => {
  const root = tmpdir()
  const result = directColdReadCodexResumeHandle({ id: 'fleet:missing' }, {
    sessionsBase: path.join(root, 'missing-sessions'),
    identityConfigDir: path.join(root, 'config'),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'missing-resume-handle')
  assert.equal(result.detail.reason, 'no-record')
})

test('direct cold read refuses when another session reader holds the lock', { skip: process.platform !== 'darwin' }, () => {
  const root = tmpdir()
  const configDir = path.join(root, 'config')
  const lockPath = sessionReaderLockPath({ configDir })
  const lock = acquireSingletonLock({ lockPath, installPath: root })
  assert.equal(lock.ok, true)
  try {
    const result = directColdReadCodexResumeHandle({ id: 'fleet:locked' }, {
      sessionsBase: path.join(root, 'sessions'),
      identityConfigDir: configDir,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'reader-already-running')
    assert.equal(result.detail.reason, 'lock-held')
    assert.equal(result.detail.lock, lockPath)
  } finally {
    fs.closeSync(lock.fd)
  }
})

test('daemon resolver advances once on miss and rechecks identity store', async () => {
  const root = tmpdir()
  const configDir = path.join(root, 'config')
  const sid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const jsonl = path.join(root, 'rollout.jsonl')
  const agent = { id: 'fleet:advance' }
  let advanced = false
  const result = await resolveCodexResumeHandle(agent, {
    identityConfigDir: configDir,
    advanceOnceOnMiss: true,
    advanceOnce: async () => {
      advanced = true
      writeJsonl(jsonl, [])
      writeSessionIdentity(configDir, {
        sessions: {
          [sid]: {
            session_id: sid,
            harness_kind: 'codex',
            fleet_id: agent.id,
            cwd: '/tmp/advance',
            jsonl_path: jsonl,
            updated_at: '2026-07-05T00:00:00.000Z',
          },
        },
      })
      return { ok: true, active_tail: true }
    },
  })
  assert.equal(advanced, true)
  assert.equal(result.ok, true)
  assert.equal(result.resumeId, sid)
  assert.equal(result.source, 'live-reader')
})

test('daemon resolver reports ingestion pending when advance cannot drain a live tail', async () => {
  const root = tmpdir()
  const result = await resolveCodexResumeHandle({ id: 'fleet:pending' }, {
    identityConfigDir: path.join(root, 'config'),
    advanceOnceOnMiss: true,
    advanceOnce: async () => ({
      ok: false,
      code: 'identity-ingestion-pending',
      retry_after_ms: 1000,
      detail: { advanced_once: false, active_tail: false, reason: 'no-live-tail' },
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'identity-ingestion-pending')
  assert.equal(result.detail.reason, 'no-live-tail')
})
