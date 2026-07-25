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

test('permanent receiver rejection deletes the server outbox row without retry', async () => {
  const inflight = new Map([['outbox-3', 'mini:testing']])
  const errors = []
  const acks = []
  const attempts = []
  const timers = []
  const permanent = []
  const row = {
    id: 'outbox-3',
    type: 'agent-seat-binding-obligation',
    payload: { type: 'agent-seat-binding-obligation', obligation_id: 'obligation-1' },
  }
  const outbox = {
    ack: id => acks.push(id),
    markError: (id, error) => errors.push([id, error]),
    get: id => id === 'outbox-3' ? row : null,
    pendingForDaemon: () => [{ id: 'outbox-3', type: 'agent-seat-binding-obligation', payload: row.payload }],
    markAttempt: id => attempts.push(id),
  }
  const control = createDaemonWsControlPlane({
    daemonConnections: new Map([['mini:testing', { readyState: 1, send: () => {} }]]),
    serverDaemonOutbox: outbox,
    serverDaemonOutboxInflight: inflight,
    setTimeoutFn: (fn, ms) => {
      timers.push({ fn, ms })
      return { unref() {} }
    },
    onPermanentServerDaemonOutboxError: event => permanent.push(event),
  })

  const result = await control.handleDaemonOutboxEnvelope(
    { readyState: 1, send() {} },
    { type: SERVER_DAEMON_OUTBOX_ERROR_TYPE, outbox_id: 'outbox-3', error: 'no local tmux recipe', permanent: true },
    async () => { throw new Error('error control frame reached domain handler') },
  )

  assert.equal(result.kind, 'server-daemon-outbox-error')
  assert.deepEqual(acks, ['outbox-3'])
  assert.deepEqual(errors, [])
  assert.equal(inflight.has('outbox-3'), false)
  assert.deepEqual(timers, [])
  assert.deepEqual(attempts, [])
  assert.equal(permanent.length, 1)
  assert.equal(permanent[0].outboxId, 'outbox-3')
  assert.equal(permanent[0].daemonKey, 'mini:testing')
  assert.deepEqual(permanent[0].row, row)
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
