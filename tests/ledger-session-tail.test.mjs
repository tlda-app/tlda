import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ledgerSessionId } from '../agent-runtime/ledger-session-tail.mjs'

const UUID = '019f4d6d-bfe2-7523-bc54-862ff8a963b3'

test('codex: recovers session id from the rollout filename when session_id is absent', () => {
  // The daemon-ledger resume-identity write bug: the id sits in the rollout
  // filename, but ledgerSessionId used to bail on a falsy session_id before
  // reaching the filename fallback, writing a null ledger session_id.
  assert.equal(
    ledgerSessionId({ harness_kind: 'codex', jsonl_path: `/x/rollout-2026-07-10T15-07-46-${UUID}.jsonl` }),
    UUID,
  )
})

test('codex: still extracts the UUID from an explicit session_id', () => {
  assert.equal(ledgerSessionId({ harness_kind: 'codex', session_id: UUID }), UUID)
  assert.equal(ledgerSessionId({ harness_kind: 'codex', session_id: `sess-${UUID}` }), UUID)
})

test('codex: session_id takes precedence over the filename', () => {
  const other = '11111111-2222-3333-4444-555555555555'
  assert.equal(
    ledgerSessionId({ harness_kind: 'codex', session_id: UUID, jsonl_path: `/x/rollout-${other}.jsonl` }),
    UUID,
  )
})

test('codex: returns null when neither session_id nor a filename UUID is present', () => {
  assert.equal(ledgerSessionId({ harness_kind: 'codex' }), null)
  assert.equal(ledgerSessionId({ harness_kind: 'codex', jsonl_path: '/x/no-uuid-here.jsonl' }), null)
})

test('non-codex: returns the raw session_id or null', () => {
  assert.equal(ledgerSessionId({ harness_kind: 'claude', session_id: 'abc-123' }), 'abc-123')
  assert.equal(ledgerSessionId({ harness_kind: 'claude' }), null)
  assert.equal(ledgerSessionId({}), null)
})
