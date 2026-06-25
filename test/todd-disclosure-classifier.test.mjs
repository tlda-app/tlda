import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyDisclosureEvent, isDisclosureCandidate } from '../bin/lib/todd-disclosure-classifier.mjs'
import { isLooseEndReport } from '../bin/lib/todd-loose-ends.mjs'
import { toddDisclosureExamples } from './fixtures/todd-disclosure-examples.mjs'

test('seed disclosure examples classify to expected decision and reason', () => {
  for (const example of toddDisclosureExamples) {
    const actual = classifyDisclosureEvent(example)
    assert.equal(actual.decision, example.label, `${example.id} decision`)
    assert.equal(actual.reasonCode, example.reasonCode, `${example.id} reasonCode`)
  }
})

test('classifier emits feature map for audit and future statistical model', () => {
  const actual = classifyDisclosureEvent(toddDisclosureExamples[0])

  assert.equal(typeof actual.confidence, 'number')
  assert.equal(actual.features.claimsCompletion, true)
  assert.equal(actual.features.claimsVerification, false)
  assert.equal(actual.features.skipLive, false)
})

test('disclosure classifier separates ordinary handled status from legacy regex overfire', () => {
  const handled = toddDisclosureExamples.find(example => example.id === 'completion-with-surface')

  assert.equal(isLooseEndReport(handled.text), true)
  assert.equal(classifyDisclosureEvent(handled).decision, 'suppress')
})

test('candidate detector scopes extraction to disclosure-like turns', () => {
  assert.equal(isDisclosureCandidate('Status: partial. Remaining: needs browser verification.'), true)
  assert.equal(isDisclosureCandidate('I am reading the file now.'), false)
})

test('guarded classifier suppresses approval boundaries and owned replies', () => {
  assert.deepEqual(
    pickDecision(classifyDisclosureEvent({
      text: 'Fixed. Now it checks the bot target correctly. To activate: Todd needs a restart. Your OK?',
      context: {},
    })),
    ['suppress', 'guarded-boundary-suppress'],
  )

  assert.deepEqual(
    pickDecision(classifyDisclosureEvent({
      text: 'On it — I am reading the log now and I will come back with the bounded answer.',
      context: {},
    })),
    ['suppress', 'guarded-owned-suppress'],
  )

  assert.deepEqual(
    pickDecision(classifyDisclosureEvent({
      text: 'That is likely a coverage gap. I’ll check the event stream and daemon extraction window now.',
      context: {},
    })),
    ['suppress', 'guarded-owned-suppress'],
  )

  assert.deepEqual(
    pickDecision(classifyDisclosureEvent({
      text: 'First inventory from chat:\\n\\nAgreed source of truth:\\n- Your chat is the source for reconstructing the argument.\\n\\nAgreed goal:\\n- We need a real draft.',
      context: {},
    })),
    ['suppress', 'guarded-live-conversation-suppress'],
  )

  assert.deepEqual(
    pickDecision(classifyDisclosureEvent({
      text: 'Status: handled. Checked: node --test passed and the browser surface showed the fixed route. Changed: fixed the route.',
      context: {},
    })),
    ['suppress', 'guarded-verified-suppress'],
  )
})

function pickDecision(result) {
  return [result.decision, result.reasonCode]
}
