import assert from 'node:assert/strict'
import test from 'node:test'

import { notificationIsStale } from './notification-symptom-action.mjs'

const MIN = 60_000
const now = Date.parse('2026-09-19T05:00:00.000Z')
const ago = minutes => new Date(now - minutes * MIN).toISOString()

test('a notice inside the window still wakes', () => {
  assert.equal(notificationIsStale(ago(19), now, 20 * MIN), false)
})

test('a notice past the window does not', () => {
  assert.equal(notificationIsStale(ago(21), now, 20 * MIN), true)
})

// The undelivered backlog this exists for: 342 notices to sleeping agents,
// 287 of them to two agents, the oldest days old. Every one is a wake.
test('a days-old notice does not wake', () => {
  assert.equal(notificationIsStale(ago(60 * 48), now, 20 * MIN), true)
})

// A missing timestamp must not disable waking. The server may send no
// observed_at; refusing on absence would silently stop every wake, which is a
// worse failure than acting on a notice whose age is unknown.
test('a missing timestamp is treated as current', () => {
  assert.equal(notificationIsStale(null, now, 20 * MIN), false)
  assert.equal(notificationIsStale('', now, 20 * MIN), false)
  assert.equal(notificationIsStale('not-a-date', now, 20 * MIN), false)
})

test('a zero window disables the cutoff', () => {
  assert.equal(notificationIsStale(ago(60 * 48), now, 0), false)
})

// The setting is a duration with a unit, the same shape as
// notifications.ackTimeout -- not a bare number with the unit in its name.
test('the configured window reads as a duration string', async () => {
  const { parseDurationMs } = await import('../shared/inbox-attention.mjs')
  assert.equal(parseDurationMs('20m'), 20 * MIN)
  assert.equal(parseDurationMs('90s'), 90_000)
  assert.equal(parseDurationMs('20'), null, 'a bare number has no unit and is refused')
})
