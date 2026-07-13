import test from 'node:test'
import assert from 'node:assert/strict'

import { buildDaemonActivityRecord, finiteMessageMs, normalizeDaemonActivityEvent } from '../server/lib/daemon-activity-ingest.mjs'

test('finiteMessageMs accepts finite numeric message fields only', () => {
  assert.equal(finiteMessageMs(null), null)
  assert.equal(finiteMessageMs(''), null)
  assert.equal(finiteMessageMs('12.5'), 12.5)
  assert.equal(finiteMessageMs(42), 42)
  assert.equal(finiteMessageMs('nope'), null)
})

test('normalizeDaemonActivityEvent preserves timing and bounds metadata', () => {
  const huge = 'x'.repeat(100_000)
  const activity = normalizeDaemonActivityEvent({
    tool: '_text',
    arg: huge,
    input: { nested: huge },
    ts: '2026-07-13T12:00:00.000Z',
    prettyResult: huge,
    daemon_received_at: '2026-07-13T12:00:00.050Z',
    daemon_received_at_ms: '1783944000050',
    daemon_sent_at: '2026-07-13T12:00:00.100Z',
    daemon_sent_at_ms: 1783944000100,
  }, {
    serverReceivedAtMs: 1783944000200,
    serverBroadcastQueuedAtMs: 1783944000300,
  })

  assert.ok(activity.text.length < 17_000)
  assert.equal(activity.timestamp, '2026-07-13T12:00:00.000Z')
  assert.equal(activity.metadata.activityLatency.daemonReceivedAtMs, 1783944000050)
  assert.equal(activity.metadata.activityLatency.daemonSentAtMs, 1783944000100)
  assert.equal(activity.metadata.activityLatency.serverReceivedAtMs, 1783944000200)
  assert.equal(activity.metadata.activityLatency.serverBroadcastQueuedAtMs, 1783944000300)
  assert.ok(activity.metadata.input.nested.length < 17_000)
  assert.ok(JSON.stringify(activity.metadata).length < 80_000)
})

test('buildDaemonActivityRecord returns bounded fleet-store record shape', () => {
  const huge = 'x'.repeat(100_000)
  const record = buildDaemonActivityRecord({
    agent_id: 'fleet:agent',
    tool: 'Bash',
    arg: huge,
    input: { command: huge },
    usage: { nested: huge },
    prettyResult: huge,
    origTool: 'functions.exec_command',
    ts: '2026-07-13T12:00:00.000Z',
  }, {
    serverReceivedAtMs: 1783944000200,
    serverBroadcastQueuedAtMs: 1783944000210,
  })

  assert.equal(record.type, 'activity')
  assert.equal(record.from, 'fleet:agent')
  assert.equal(record.to, 'fleet:agent')
  assert.equal(record.text, 'Bash')
  assert.equal(record.unread, false)
  assert.equal(record.timestamp, '2026-07-13T12:00:00.000Z')
  assert.equal(record.metadata.origTool, 'functions.exec_command')
  assert.ok(record.metadata.arg.length < 17_000)
  assert.ok(record.metadata.input.command.length < 17_000)
  assert.ok(record.metadata.usage.nested.length < 17_000)
  assert.ok(record.metadata.prettyResult.length < 17_000)
})
