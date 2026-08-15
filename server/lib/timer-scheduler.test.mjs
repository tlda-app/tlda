import assert from 'node:assert/strict'
import test from 'node:test'

import { ServerTimerScheduler } from './timer-scheduler.mjs'

test('firing a timer stores, broadcasts, and reports delivered notification ACKs', async () => {
  const event = {
    id: 42,
    type: 'timer',
    from: 'fleet:sender',
    recipients: ['fleet:recipient'],
    text: 'Timer fired',
    metadata: {},
  }
  const broadcasts = []
  const notifyCalls = []
  const scheduler = new ServerTimerScheduler({
    store: {
      getEventById: async () => event,
      claimTimerTerminal: async () => true,
      listPendingTimerEvents: async () => [],
    },
    broadcast: (event, data) => broadcasts.push({ event, data }),
    notify: async input => {
      notifyCalls.push(input)
      return { ok: true, delivered: true, channel: 'mcp' }
    },
    now: () => Date.parse('2026-08-11T12:00:00.000Z'),
  })

  const result = await scheduler.fire(42)

  assert.equal(result.ok, true)
  assert.equal(result.to, 'fleet:recipient')
  assert.equal(result.notified, true)
  assert.equal(notifyCalls.length, 1)
  assert.equal(notifyCalls[0].to, 'fleet:recipient')
  assert.equal(broadcasts.length, 1)
  assert.equal(broadcasts[0].event, 'event-update')
  assert.equal(broadcasts[0].data.metadata.state, 'fired')
})

test('firing a timer does not treat queued daemon fallback as delivered notification', async () => {
  const event = {
    id: 43,
    type: 'timer',
    from: 'fleet:sender',
    to: 'fleet:recipient',
    text: 'Timer fired',
    metadata: {},
  }
  const scheduler = new ServerTimerScheduler({
    store: {
      getEventById: async () => event,
      claimTimerTerminal: async () => true,
      listPendingTimerEvents: async () => [],
    },
    broadcast: () => {},
    notify: async () => ({ ok: true, delivered: false, queued: true }),
    now: () => Date.parse('2026-08-11T12:00:00.000Z'),
  })

  const result = await scheduler.fire(43)

  assert.equal(result.ok, true)
  assert.equal(result.notified, false)
})
