import assert from 'node:assert/strict'
import test from 'node:test'

import { ServerTimerScheduler } from './timer-scheduler.mjs'

test('firing a timer stores and broadcasts it without waking the agent', async () => {
  const event = {
    id: 42,
    type: 'timer',
    from: 'fleet:sender',
    to: 'fleet:recipient',
    text: 'Timer fired',
    metadata: {},
  }
  const broadcasts = []
  let notifyCalls = 0
  const scheduler = new ServerTimerScheduler({
    store: {
      getEventById: async () => event,
      claimTimerTerminal: async () => true,
      listPendingTimerEvents: async () => [],
    },
    broadcast: (event, data) => broadcasts.push({ event, data }),
    notify: async () => { notifyCalls += 1 },
    now: () => Date.parse('2026-08-11T12:00:00.000Z'),
  })

  const result = await scheduler.fire(42)

  assert.equal(result.ok, true)
  assert.equal(result.notified, false)
  assert.equal(notifyCalls, 0)
  assert.equal(broadcasts.length, 1)
  assert.equal(broadcasts[0].event, 'event-update')
  assert.equal(broadcasts[0].data.metadata.state, 'fired')
})
