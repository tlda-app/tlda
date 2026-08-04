import assert from 'node:assert/strict'
import test from 'node:test'

import { jsonlRuntimeFailureActivityHealth } from '../daemon/jsonl-ingestor.mjs'
import { ACTIVITY_HEALTH_BOUNDARIES, ACTIVITY_HEALTH_UNAVAILABLE } from '../shared/activity-health.mjs'

test('a stalled JSONL tail reports a runtime watcher failure', () => {
  assert.deepEqual(
    jsonlRuntimeFailureActivityHealth(
      { sessionId: 'session-1', jsonlPath: '/tmp/session-1.jsonl' },
      'tail-error',
      { reason: 'cursor stalled' },
    ),
    {
      state: ACTIVITY_HEALTH_UNAVAILABLE,
      boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_RUNTIME_ERROR,
      reason: 'cursor stalled',
      sessionId: 'session-1',
      jsonlPath: '/tmp/session-1.jsonl',
    },
  )
})
