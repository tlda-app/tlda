import assert from 'node:assert/strict'
import test from 'node:test'

import { createNotificationAttemptRecorder } from '../server/lib/notification-attempts.mjs'

function recorderHarness() {
  const shared = []
  const incidents = []
  const logs = []
  const recorder = createNotificationAttemptRecorder({
    fleetStore: {
      async share(event) {
        shared.push(event)
        return { id: shared.length }
      },
    },
    logger: {
      info(payload, message) {
        logs.push({ payload, message })
      },
    },
    async reportIncident(incident) {
      incidents.push(incident)
      return { id: 100 + incidents.length }
    },
  })
  return { recorder, shared, incidents, logs }
}

test('notification recorder persists delivered attempts without incident', async () => {
  const { recorder, shared, incidents, logs } = recorderHarness()

  const result = await recorder.record({
    agentId: 'fleet:agent-one',
    reason: 'chat',
    sourceEventId: 42,
    outcome: 'delivered',
    evidence: { deliveryPath: 'channel' },
  })

  assert.equal(result.ok, true)
  assert.equal(result.eventId, 1)
  assert.equal(shared.length, 1)
  assert.equal(shared[0].type, 'notification_attempt')
  assert.equal(shared[0].to, 'fleet:agent-one')
  assert.equal(shared[0].unread, false)
  assert.equal(shared[0].metadata.outcome, 'delivered')
  assert.equal(shared[0].metadata.sourceEventId, 42)
  assert.equal(incidents.length, 0)
  assert.equal(logs[0].payload.event, 'notification_attempt')
})

test('notification recorder persists the correlated wake trace id', async () => {
  const { recorder, shared } = recorderHarness()
  const result = await recorder.record({
    agentId: 'fleet:chief', traceId: 'delegate:wake-proof', sourceEventId: 42,
    sourceTaskId: 'wake-task', outcome: 'acknowledged', reason: 'inbox-acknowledgment',
  })
  assert.equal(result.ok, true)
  assert.equal(shared[0].metadata.traceId, 'delegate:wake-proof')
  assert.equal(shared[0].metadata.trace_id, 'delegate:wake-proof')
  assert.equal(shared[0].metadata.sourceEventId, 42)
  assert.equal(shared[0].metadata.sourceTaskId, 'wake-task')
})

test('notification recorder reports failed attempts as incidents', async () => {
  const { recorder, shared, incidents } = recorderHarness()

  const result = await recorder.record({
    agentId: 'fleet:agent-two',
    reason: 'chat',
    sourceEventId: 99,
    outcome: 'send-failed',
    intendedSurface: 'channel',
    nextAction: 'retry-on-reconnect',
    evidence: { error: 'notification timeout' },
  })

  assert.equal(result.ok, true)
  assert.equal(result.eventId, 1)
  assert.equal(shared[0].metadata.outcome, 'send-failed')
  assert.equal(incidents.length, 1)
  assert.equal(incidents[0].component, 'notification-delivery')
  assert.equal(incidents[0].operation, 'notify-inbox-pending')
  assert.equal(incidents[0].actors.agentId, 'fleet:agent-two')
  assert.equal(incidents[0].error, 'notification timeout')
  assert.equal(incidents[0].evidence.notificationAttemptEventId, 1)
})

test('notification recorder requires an agent id', async () => {
  const { recorder } = recorderHarness()

  await assert.rejects(
    () => recorder.record({ outcome: 'delivered' }),
    /requires agentId/
  )
})
