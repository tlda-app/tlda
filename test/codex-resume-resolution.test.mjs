import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CODEX_FLEET_ID_MIGRATION_COMMAND,
  isBareCodexResumeId,
  resolveCodexResumeHandle,
} from '../bin/lib/codex-resume-resolver.mjs'
import { saveSessionIdentityStore, sessionIdentityPath } from '../bin/lib/session-identity-store.mjs'

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

test('resolveCodexResumeHandle repairs existing corrupted rollout basename record from jsonl path', async () => {
  const root = tmpdir()
  const configDir = path.join(root, 'config')
  const bareId = '019f2a8d-d06e-74c2-9c7c-f7ca108b0a6d'
  const corruptedId = `rollout-2026-07-03T20-36-04-${bareId}`
  const jsonl = path.join(root, 'sessions', '2026', '07', '03', `${corruptedId}.jsonl`)
  writeJsonl(jsonl, [{ type: 'session_meta', payload: { id: bareId, cwd: '/tmp/corrupted' } }])
  writeSessionIdentity(configDir, {
    sessions: {
      [corruptedId]: {
        session_id: corruptedId,
        harness_kind: 'codex',
        fleet_id: 'fleet:corrupted',
        cwd: '/tmp/corrupted',
        jsonl_path: jsonl,
        updated_at: '2026-07-05T00:00:00.000Z',
      },
    },
  })

  const result = await resolveCodexResumeHandle({ id: 'fleet:corrupted' }, { identityConfigDir: configDir })
  assert.equal(result.ok, true)
  assert.equal(result.resumeId, bareId)
  assert.equal(result.jsonlPath, jsonl)
  assert.equal(result.source, 'identity-store-repaired')
})

test('daemon resolver does not cold-scan owned rollouts on indexed misses', async () => {
  const root = tmpdir()
  const configDir = path.join(root, 'config')
  const sessionsBase = path.join(root, 'codex-sessions')
  const sid = '22222222-2222-4222-8222-222222222222'
  const jsonl = path.join(sessionsBase, '2026', '07', '04', `rollout-2026-07-04T10-00-00-${sid}.jsonl`)
  writeJsonl(jsonl, [
    { type: 'session_meta', payload: { id: sid, cwd: '/tmp/owned-but-unindexed' } },
    ...codexRegisterRows('fleet:advance', 'advance', 'call-owned'),
  ])
  const agent = { id: 'fleet:advance', friendly_name: 'advance' }
  const result = await resolveCodexResumeHandle(agent, {
    identityConfigDir: configDir,
    sessionsBase,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'missing-resume-handle')
  assert.equal(result.detail.reason, 'no-record')
  assert.equal(result.detail.escape_hatch, CODEX_FLEET_ID_MIGRATION_COMMAND)
  assert.equal(result.detail.daemon_must_be_stopped, true)
  assert.match(result.message, /can't find a cached identity for advance \(fleet:advance\)/)
  assert.match(result.message, /node scripts\/migrate-codex-fleet-ids\.mjs/)
})

test('daemon resolver miss points at manual migration escape hatch', async () => {
  const root = tmpdir()
  const result = await resolveCodexResumeHandle({ id: 'fleet:pending', name: 'pending' }, {
    identityConfigDir: path.join(root, 'config'),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'missing-resume-handle')
  assert.equal(result.detail.reason, 'no-record')
  assert.equal(result.detail.escape_hatch, CODEX_FLEET_ID_MIGRATION_COMMAND)
  assert.match(result.message, /can't find a cached identity for pending \(fleet:pending\)/)
})
