import assert from 'node:assert/strict'
import test from 'node:test'

import { tailSessionIdentityInput } from '../bin/lib/session-identity-tail.mjs'

test('codex tail identity writes fleet_id from watcher owner, not content', () => {
  assert.deepEqual(tailSessionIdentityInput({
    sessionId: '019f2a8d-d06e-74c2-9c7c-f7ca108b0a6d',
    harnessKind: 'codex',
    jsonlPath: '/tmp/rollout.jsonl',
    ownerFleetId: 'fleet:owner123',
    contentIdentity: {
      fleet_id: 'fleet:content0',
      friendly_name: 'durable-fleetid-write',
      cwd: '/work/tlda',
    },
  }), {
    session_id: '019f2a8d-d06e-74c2-9c7c-f7ca108b0a6d',
    harness_kind: 'codex',
    jsonl_path: '/tmp/rollout.jsonl',
    friendly_name: 'durable-fleetid-write',
    cwd: '/work/tlda',
    fleet_id: 'fleet:owner123',
    classified: false,
  })
})

test('codex tail identity ignores missing content-derived fleet_id when owner is known', () => {
  assert.equal(tailSessionIdentityInput({
    sessionId: 'sess',
    harnessKind: 'codex',
    jsonlPath: '/tmp/rollout.jsonl',
    ownerFleetId: 'fleet:owner123',
    contentIdentity: { cwd: '/work/tlda' },
  }).fleet_id, 'fleet:owner123')
})

test('non-codex tail identity does not synthesize fleet_id from watcher owner', () => {
  const input = tailSessionIdentityInput({
    sessionId: 'claude-session',
    harnessKind: 'claude',
    jsonlPath: '/tmp/session.jsonl',
    ownerFleetId: 'fleet:owner123',
    contentIdentity: { friendly_name: 'reader' },
  })
  assert.equal('fleet_id' in input, false)
})
