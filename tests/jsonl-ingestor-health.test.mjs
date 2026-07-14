import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createJsonlIngesterMessageHandler,
  jsonlRuntimeFailureActivityHealth,
} from '../daemon/jsonl-ingestor.mjs'
import { ACTIVITY_HEALTH_BOUNDARIES } from '../shared/activity-health.mjs'

function makeTail() {
  return {
    watchId: 'watch-1',
    primaryAgentId: 'fleet:agent',
    sessionId: 'session-1',
    jsonlPath: '/tmp/session-1.jsonl',
    pendingDeliveries: 0,
    pendingFlushOffset: null,
    lastDeliveryOk: true,
  }
}

function makeHarness({
  sendJsonlIngesterMessage = () => {},
  processJsonlChildOutputs = () => true,
} = {}) {
  const tail = makeTail()
  const childWatchers = new Map([[tail.watchId, tail]])
  const retired = []
  const sent = []
  const log = { info() {}, warn() {}, error() {} }
  const sendActivityHealth = (agentId, patch) => {
    sent.push({
      type: 'activity-health',
      agent_id: agentId,
      state: patch.state,
      boundary: patch.boundary,
      reason: patch.reason || null,
      session_id: patch.sessionId || null,
      jsonl_path: patch.jsonlPath || null,
    })
  }
  const retireJsonlTail = (pw, reason, options = {}) => {
    retired.push({ pw, reason, options })
    if (options.healthKind) {
      sendActivityHealth(pw.primaryAgentId, jsonlRuntimeFailureActivityHealth(pw, options.healthKind, options.healthDetail))
    }
    pw.stopped = true
    childWatchers.delete(pw.watchId)
  }
  const handler = createJsonlIngesterMessageHandler({
    log,
    childWatchers,
    cursors: {},
    scheduleCursorSave() {},
    refreshIngestionCaughtUp() {},
    handleJsonlBackfillBatch() {},
    handleJsonlBackfillSessionComplete() {},
    handleJsonlBackfillJobDone() {},
    retireJsonlTail,
    processJsonlChildOutputs,
    sendJsonlIngesterMessage,
    maybeCompleteDisplayCatchup() {},
    updateJsonlCursorFromTail() {},
  })
  return { tail, handler, retired, sent, retireJsonlTail }
}

function assertRuntimeFailure({ retired, sent }, { boundary, reason, healthKind }) {
  assert.equal(retired.length, 1)
  assert.equal(retired[0].options.healthKind, healthKind)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], {
    type: 'activity-health',
    agent_id: 'fleet:agent',
    state: 'unavailable',
    boundary,
    reason,
    session_id: 'session-1',
    jsonl_path: '/tmp/session-1.jsonl',
  })
}

test('handler start-failed retires watcher and emits exact unhealthy health', () => {
  const harness = makeHarness()

  harness.handler({ type: 'start-failed', watchId: 'watch-1', error: 'ENOENT' })

  assertRuntimeFailure(harness, {
    boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_START_FAILED,
    reason: 'ENOENT',
    healthKind: 'start-failed',
  })
})

test('handler child error retires watcher and emits exact unhealthy health', () => {
  const harness = makeHarness()

  harness.handler({ type: 'error', watchId: 'watch-1', error: 'child exited' })

  assertRuntimeFailure(harness, {
    boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_RUNTIME_ERROR,
    reason: 'child exited',
    healthKind: 'error',
  })
})

test('handler ACK IPC failure retires watcher and emits exact unhealthy health', () => {
  const harness = makeHarness({
    sendJsonlIngesterMessage() {
      throw new Error('IPC closed')
    },
  })

  harness.handler({ type: 'batch', watchId: 'watch-1', seq: 7, outputs: [] })

  assertRuntimeFailure(harness, {
    boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_ACK_FAILED,
    reason: 'IPC closed',
    healthKind: 'ack-failed',
  })
})

test('handler delivery failure retires watcher and emits exact unhealthy health', () => {
  const harness = makeHarness({
    processJsonlChildOutputs: () => false,
  })

  harness.handler({ type: 'batch', watchId: 'watch-1', seq: 8, outputs: [{ type: 'activity', events: [{}] }] })

  assertRuntimeFailure(harness, {
    boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_DELIVERY_FAILED,
    reason: 'activity delivery failed',
    healthKind: 'delivery-failed',
  })
})

test('intentional watcher teardown retirement emits no activity health', () => {
  const harness = makeHarness()

  harness.retireJsonlTail(harness.tail, 'daemon watcher teardown')

  assert.equal(harness.retired.length, 1)
  assert.deepEqual(harness.retired[0].options, {})
  assert.deepEqual(harness.sent, [])
})
