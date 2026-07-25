import test from 'node:test'
import assert from 'node:assert/strict'
import { timeShort } from '../src/fleet/chat-render.mjs'

// The rule: show the least that still identifies the moment unambiguously.
const NOW = new Date('2026-07-25T18:00:00.000Z')

test('a message from today shows time only — no date', () => {
  const label = timeShort('2026-07-25T16:05:00.000Z', NOW)
  assert.match(label, /\d{1,2}:05/)
  assert.doesNotMatch(label, /Jul/)
  assert.doesNotMatch(label, /2026/)
})

test('a message from earlier this year shows month and day, but no year', () => {
  const label = timeShort('2026-07-11T16:05:00.000Z', NOW)
  assert.match(label, /Jul\s+11/)
  assert.match(label, /\d{1,2}:05/)
  assert.doesNotMatch(label, /2026/)
})

test('a message from a previous year shows the year', () => {
  const label = timeShort('2025-07-11T16:05:00.000Z', NOW)
  assert.match(label, /Jul\s+11/)
  assert.match(label, /2025/)
  assert.match(label, /\d{1,2}:05/)
})

test('a moment just past midnight is not "today" the next day', () => {
  const label = timeShort('2026-07-24T23:30:00-04:00', NOW)
  assert.match(label, /Jul\s+24/)
})

test('empty and unparseable timestamps render as empty', () => {
  assert.equal(timeShort(''), '')
  assert.equal(timeShort(null), '')
  assert.equal(timeShort('not a date'), '')
})
