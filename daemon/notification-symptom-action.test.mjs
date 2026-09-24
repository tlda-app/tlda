import test from 'node:test'
import assert from 'node:assert/strict'

import {
  actionForSymptom,
  NOTIFICATION_SYMPTOM_ACTION,
  performNotificationSymptomAction,
  suggestRestartDue,
} from './notification-symptom-action.mjs'

// The table and its effectful dispatch are both covered here: a mapped action
// is not enough if the handler later ignores it.

test('the two symptoms that mean "no process I can reach" ensure a process', () => {
  assert.equal(actionForSymptom('no-channel'), 'ensure-process')
  assert.equal(actionForSymptom('channel-closed'), 'ensure-process')
})

test('a channel that went silent suggests an explicit restart', () => {
  assert.equal(actionForSymptom('channel-silent'), 'suggest-restart')
})

test('a live agent with no channel is ensured, not restarted', async () => {
  const calls = []
  const action = await performNotificationSymptomAction({
    symptom: 'no-channel',
    ensureProcess: async () => { calls.push('ensure-process') },
    suggestRestart: async () => { calls.push('suggest-restart') },
  })
  assert.equal(action, 'wake')
  assert.deepEqual(calls, ['ensure-process'])
})

test('a live agent whose channel is silent keeps its live tmux session', async () => {
  const calls = []
  const action = await performNotificationSymptomAction({
    symptom: 'channel-silent',
    ensureProcess: async () => { calls.push('ensure-process') },
    suggestRestart: async () => { calls.push('suggest-restart') },
  })
  assert.equal(action, 'suggest-restart')
  assert.deepEqual(calls, ['suggest-restart'])
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

test('nothing maps outside process recovery and the restart suggestion', () => {
  const allowed = new Set(['ensure-process', 'suggest-restart', null])
  for (const [symptom, action] of Object.entries(NOTIFICATION_SYMPTOM_ACTION)) {
    assert.ok(allowed.has(action), `${symptom} maps to unsupported action "${action}"`)
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

// A typed notice is a turn: repeating it faster than the agent can act
// re-interrupts an agent that is already told. Under load the server reports
// channel-silent in bursts, so the repeat needs a per-agent cooldown.
test('a suggest-restart is due when never sent or the cooldown elapsed', () => {
  const cooldown = 30 * 60_000
  assert.equal(suggestRestartDue(0, 1_000_000, cooldown), true)
  assert.equal(suggestRestartDue(null, 1_000_000, cooldown), true)
  assert.equal(suggestRestartDue(1_000_000, 1_000_000 + cooldown, cooldown), true)
  assert.equal(suggestRestartDue(1_000_000, 1_000_000 + cooldown + 1, cooldown), true)
})

test('a suggest-restart inside the cooldown is not due', () => {
  const cooldown = 30 * 60_000
  assert.equal(suggestRestartDue(1_000_000, 1_000_000 + 1, cooldown), false)
  assert.equal(suggestRestartDue(1_000_000, 1_000_000 + cooldown - 1, cooldown), false)
})
