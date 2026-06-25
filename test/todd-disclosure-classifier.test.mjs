import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyDisclosureEvent } from '../bin/lib/todd-disclosure-classifier.mjs'
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
