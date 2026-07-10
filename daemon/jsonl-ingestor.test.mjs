import test from 'node:test'
import assert from 'node:assert/strict'
import {
  catchupReplayBoundary,
  shouldSuppressCatchupOutput,
} from './jsonl-ingestor.mjs'
import { tailLedgerSessionInput } from '../agent-runtime/ledger-session-tail.mjs'

test('large JSONL tail gaps enter display catch-up mode', () => {
  assert.equal(catchupReplayBoundary({
    startOffset: 100,
    liveOffset: 1000,
    thresholdBytes: 500,
  }), 1000)
})

test('small JSONL tail gaps replay normally', () => {
  assert.equal(catchupReplayBoundary({
    startOffset: 100,
    liveOffset: 300,
    thresholdBytes: 500,
  }), null)
})

test('display catch-up suppresses chat/activity but preserves indexing and identity', () => {
  for (const type of ['activity', 'context', 'qualification', 'terminalChat', 'nativeTask']) {
    assert.equal(shouldSuppressCatchupOutput({ type }), true, type)
  }
  for (const type of ['searchIndex', 'identity']) {
    assert.equal(shouldSuppressCatchupOutput({ type }), false, type)
  }
})

test('codex tail ledger input stores bare resume UUID', () => {
  const rolloutId = '11111111-2222-4333-8444-555555555555'
  const input = tailLedgerSessionInput({
    sessionId: `rollout-2026-07-10T12-00-00-${rolloutId}`,
    harnessKind: 'codex',
    jsonlPath: `/tmp/rollout-2026-07-10T12-00-00-${rolloutId}.jsonl`,
    ownerFleetId: 'fleet:test-resume',
    contentIdentity: {
      cwd: '/tmp/tlda-resume-test',
      friendly_name: 'test-resume',
    },
  })

  assert.equal(input.session_id, rolloutId)
  assert.equal(input.fleet_id, 'fleet:test-resume')
  assert.equal(input.harness_kind, 'codex')
})

test('codex tail ledger input keys by watcher owner, not JSONL content identity', () => {
  const rolloutId = '11111111-2222-4333-8444-555555555555'
  const input = tailLedgerSessionInput({
    sessionId: `rollout-2026-07-10T12-00-00-${rolloutId}`,
    harnessKind: 'codex',
    jsonlPath: `/tmp/rollout-2026-07-10T12-00-00-${rolloutId}.jsonl`,
    ownerFleetId: 'fleet:watcher-owner',
    contentIdentity: {
      fleet_id: 'fleet:stale-content-owner',
      friendly_name: 'stale-content-owner',
      cwd: '/tmp/tlda-resume-test',
    },
  })

  assert.equal(input.session_id, rolloutId)
  assert.equal(input.fleet_id, 'fleet:watcher-owner')
  assert.equal(input.friendly_name, 'stale-content-owner')
})
