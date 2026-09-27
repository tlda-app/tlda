import test from 'node:test'
import assert from 'node:assert/strict'

import { surveyBotHeartbeats } from './bot-heartbeats.mjs'

const NOW = 1_800_000_000_000
const FRESH = { mtimeMs: NOW - 60_000, birthtimeMs: NOW - 3_600_000 }
const STALE = { mtimeMs: NOW - 3_600_000, birthtimeMs: NOW - 7_200_000 }

const entry = over => JSON.stringify({ ts: NOW - 120_000, reason: 'tick', ...over })

function survey(text, { stat = FRESH } = {}) {
  return surveyBotHeartbeats({
    declaredBots: ['probe'],
    heartbeatDir: '/nonexistent',
    envName: 'testing',
    staleMs: 600_000,
    now: () => NOW,
    readDir: () => [],
    statFile: () => ({ ...stat }),
    readFile: () => text,
  })
}

test('a down send-path statement verdicts sendDown, not beating', () => {
  const result = survey([entry({}), entry({ reason: 'send-down', sendUp: false })].join('\n'))
  assert.deepEqual(result.beating, [])
  assert.equal(result.sendDown.length, 1)
  assert.equal(result.sendDown[0].name, 'probe')
  assert.equal(result.sendDown[0].reason, 'send-down')
})

test('a later send-up statement clears the sendDown verdict', () => {
  const result = survey([
    entry({ reason: 'send-down', sendUp: false }),
    entry({ reason: 'send-up', sendUp: true }),
  ].join('\n'))
  assert.deepEqual(result.sendDown, [])
  assert.deepEqual(result.beating, ['probe'])
})

test('ticks without a send field do not bury a down edge', () => {
  // Two writers: the send path appends edges while the bot's own loop appends
  // ticks. The ticks are newer but say nothing about the send path.
  const result = survey([
    entry({ reason: 'send-down', sendUp: false }),
    entry({ reason: 'tick' }),
    entry({ reason: 'tick' }),
  ].join('\n'))
  assert.equal(result.sendDown.length, 1)
  assert.deepEqual(result.beating, [])
})

test('a stale file with a down statement verdicts stopped, not sendDown', () => {
  const result = survey(entry({ reason: 'send-down', sendUp: false }), { stat: STALE })
  assert.deepEqual(result.sendDown, [])
  assert.equal(result.stopped.length, 1)
})

test('a file with no send statements still verdicts beating', () => {
  const result = survey([entry({}), entry({})].join('\n'))
  assert.deepEqual(result.sendDown, [])
  assert.deepEqual(result.beating, ['probe'])
})

test('an ISO-string ts normalizes to epoch ms for the notice', () => {
  const result = survey(entry({ ts: new Date(NOW - 120_000).toISOString(), reason: 'send-down', sendUp: false }))
  assert.equal(result.sendDown[0].ts, NOW - 120_000)
})

test('malformed tail lines do not hide a down statement', () => {
  const result = survey([entry({ reason: 'send-down', sendUp: false }), 'not json{'].join('\n'))
  assert.equal(result.sendDown.length, 1)
})
