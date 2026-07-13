import test from 'node:test'
import assert from 'node:assert/strict'

import { activityEventMessage } from '../agent-runtime/activity-send.mjs'

test('activity-event wire message preserves daemon receive time and stamps daemon send time', () => {
  const originalNow = Date.now
  Date.now = () => 1783944000100
  try {
    const msg = activityEventMessage('fleet:latency', {
      tool: 'Bash',
      arg: 'npm test',
      ts: '2026-07-13T12:00:00.000Z',
      daemonReceivedAt: '2026-07-13T12:00:00.050Z',
      daemonReceivedAtMs: 1783944000050,
    })

    assert.equal(msg.type, 'activity-event')
    assert.equal(msg.agent_id, 'fleet:latency')
    assert.equal(msg.daemon_received_at, '2026-07-13T12:00:00.050Z')
    assert.equal(msg.daemon_received_at_ms, 1783944000050)
    assert.equal(msg.daemon_sent_at, '2026-07-13T12:00:00.100Z')
    assert.equal(msg.daemon_sent_at_ms, 1783944000100)
  } finally {
    Date.now = originalNow
  }
})

test('activity-event wire message leaves unmeasured daemon receive time null', () => {
  const originalNow = Date.now
  Date.now = () => 1783944000100
  try {
    const msg = activityEventMessage('fleet:latency', {
      tool: 'Bash',
      ts: '2026-07-13T12:00:00.000Z',
      daemonReceivedAtMs: null,
    })

    assert.equal(msg.daemon_received_at, null)
    assert.equal(msg.daemon_received_at_ms, null)
    assert.equal(msg.daemon_sent_at_ms, 1783944000100)
  } finally {
    Date.now = originalNow
  }
})
