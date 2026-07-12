import test from 'node:test'
import assert from 'node:assert/strict'
import { DAEMON_OUTBOX_ID_FIELD } from '../shared/daemon-delivery.mjs'
import { daemonEventFailureIncident } from '../server/lib/daemon-event-failures.mjs'

test('daemon event failure incident includes retryable activity-event context', () => {
  const err = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
  const incident = daemonEventFailureIncident({
    type: 'activity-event',
    agent_id: 'fleet:agent',
    tool: 'Bash',
    ts: '2026-07-12T05:00:00.000Z',
    [DAEMON_OUTBOX_ID_FIELD]: 'outbox-1',
  }, 'activity-write', err)

  assert.equal(incident.component, 'daemon-events')
  assert.equal(incident.operation, 'activity-write')
  assert.equal(incident.actors.agentId, 'fleet:agent')
  assert.equal(incident.actors.daemonOutboxId, 'outbox-1')
  assert.equal(incident.evidence.type, 'activity-event')
  assert.equal(incident.evidence.tool, 'Bash')
  assert.equal(incident.evidence.timestamp, '2026-07-12T05:00:00.000Z')
  assert.equal(incident.error.code, 'SQLITE_BUSY')
  assert.match(incident.impact, /durable outbox will retry/)
})

test('daemon event failure incident includes terminal-chat context', () => {
  const incident = daemonEventFailureIncident({
    type: 'terminal-chat',
    agent_id: 'fleet:agent',
    session_id: 'session-1',
    text: 'hello from terminal',
    ts: '2026-07-12T05:01:00.000Z',
    [DAEMON_OUTBOX_ID_FIELD]: 'outbox-2',
  }, 'terminal-chat-write', new Error('write failed'))

  assert.equal(incident.operation, 'terminal-chat-write')
  assert.equal(incident.evidence.type, 'terminal-chat')
  assert.equal(incident.evidence.sessionId, 'session-1')
  assert.equal(incident.evidence.textBytes, 'hello from terminal'.length)
  assert.equal(incident.error.message, 'write failed')
})
