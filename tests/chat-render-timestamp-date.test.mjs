import test from 'node:test'
import assert from 'node:assert/strict'
import { timeShort } from '../src/fleet/chat-render.mjs'

test('chat timestamps include calendar day and time', () => {
  const label = timeShort('2026-07-11T20:05:00.000Z')
  assert.match(label, /Jul\s+11/)
  assert.match(label, /\d{1,2}:05/)
})
