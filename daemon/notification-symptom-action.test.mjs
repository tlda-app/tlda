import test from 'node:test'
import assert from 'node:assert/strict'

import { actionForSymptom, NOTIFICATION_SYMPTOM_ACTION } from './notification-symptom-action.mjs'

// This table is the whole of the daemon's decision, so it is tested as a
// decision. The effectful half — checkAlive, wake, restart — is composed from
// primitives that already have their own coverage; what is new here is the
// judgement about which symptom deserves which of the daemon's two jobs.

test('the two symptoms that mean "no process I can reach" ensure a process', () => {
  assert.equal(actionForSymptom('no-channel'), 'ensure-process')
  assert.equal(actionForSymptom('channel-closed'), 'ensure-process')
})

test('a channel that went silent gets turned off and on again', () => {
  assert.equal(actionForSymptom('channel-silent'), 'restart')
})

// The most important row, and the one a future editor is most likely to "fix".
test('a refusal is not a fault and provokes nothing', () => {
  assert.equal(actionForSymptom('channel-refused'), null)
})

// A restart is the destructive action in this table, so it is worth asserting
// that nothing reaches it by accident. An unrecognised symptom from a newer
// server must not be guessed into one.
test('an unknown symptom does nothing rather than defaulting', () => {
  for (const unknown of ['channel-exploded', '', null, undefined, 'restart', 'ensure-process']) {
    assert.equal(actionForSymptom(unknown), null, `${JSON.stringify(unknown)} must not map to an action`)
  }
})

test('nothing maps to an action outside the daemon two jobs', () => {
  const allowed = new Set(['ensure-process', 'restart', null])
  for (const [symptom, action] of Object.entries(NOTIFICATION_SYMPTOM_ACTION)) {
    assert.ok(allowed.has(action), `${symptom} maps to "${action}", which is not one of the daemon's two jobs`)
  }
})

// Prototype keys are not symptoms. `NOTIFICATION_SYMPTOM_ACTION['constructor']`
// is a function rather than undefined, and `?? null` would pass it straight
// through to the caller as an action.
test('a prototype key is not mistaken for a symptom', () => {
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(actionForSymptom(key), null, `${key} must not resolve to an action`)
  }
})
