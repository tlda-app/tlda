import assert from 'node:assert/strict'
import test from 'node:test'

import { createDaemonWsControlPlane } from '../server/lib/daemon-ws-control-plane.mjs'
import {
  SERVER_DAEMON_OUTBOX_ACK_TYPE,
  SERVER_DAEMON_OUTBOX_ERROR_TYPE,
} from '../shared/daemon-delivery.mjs'

test('receiver rejection retains the server outbox row and schedules retry', async () => {
  const inflight = new Map([['outbox-1', 'mini:default']])
  const errors = []
  const acks = []
  const attempts = []
  const sent = []
  const timers = []
  const outbox = {
    ack: id => acks.push(id),
    markError: (id, error) => errors.push([id, error]),
    pendingForDaemon: () => [{ id: 'outbox-1', type: 'agent-seat-binding-obligation', payload: { type: 'agent-seat-binding-obligation' } }],
    markAttempt: id => attempts.push(id),
  }
  const control = createDaemonWsControlPlane({
    daemonConnections: new Map([['mini:default', { readyState: 1, send: value => sent.push(JSON.parse(value)) }]]),
    serverDaemonOutbox: outbox,
    serverDaemonOutboxInflight: inflight,
    setTimeoutFn: (fn, ms) => {
      timers.push({ fn, ms })
      return { unref() {} }
    },
  })

  const result = await control.handleDaemonOutboxEnvelope(
    { readyState: 1, send() {} },
    { type: SERVER_DAEMON_OUTBOX_ERROR_TYPE, outbox_id: 'outbox-1', error: 'not accepted locally' },
    async () => { throw new Error('error control frame reached domain handler') },
  )

  assert.equal(result.kind, 'server-daemon-outbox-error')
  assert.deepEqual(errors, [['outbox-1', 'not accepted locally']])
  assert.deepEqual(acks, [])
  assert.equal(inflight.has('outbox-1'), false)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 1000)
  timers[0].fn()
  assert.deepEqual(attempts, ['outbox-1'])
  assert.deepEqual(sent, [{ type: 'agent-seat-binding-obligation' }])
})

test('receiver acceptance deletes the server outbox row', async () => {
  const inflight = new Map([['outbox-2', 'mini:default']])
  const acks = []
  const control = createDaemonWsControlPlane({
    daemonConnections: new Map(),
    serverDaemonOutbox: {
      ack: id => acks.push(id),
      markError() {},
      pendingForDaemon: () => [],
    },
    serverDaemonOutboxInflight: inflight,
  })

  const result = await control.handleDaemonOutboxEnvelope(
    { readyState: 1, send() {} },
    { type: SERVER_DAEMON_OUTBOX_ACK_TYPE, outbox_id: 'outbox-2' },
    async () => { throw new Error('ack control frame reached domain handler') },
  )

  assert.equal(result.kind, 'server-daemon-outbox-ack')
  assert.deepEqual(acks, ['outbox-2'])
  assert.equal(inflight.has('outbox-2'), false)
})
