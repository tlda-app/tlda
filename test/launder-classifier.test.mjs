import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyLaunder, isLaunderCandidate } from '../bin/lib/launder-classifier.mjs'
import { checkLaunderChatLint, formatLaunderChatWarning } from '../mcp-server/fleet-tools.mjs'
import { launderExamples } from './fixtures/launder-examples.mjs'

test('seed laundering examples classify to expected decision and reason', () => {
  for (const example of launderExamples) {
    const actual = classifyLaunder(example)
    assert.equal(actual.decision, example.label, `${example.id} decision`)
    assert.equal(actual.reasonCode, example.reasonCode, `${example.id} reasonCode`)
  }
})

test('classifier emits feature map for audit and future statistical model', () => {
  const actual = classifyLaunder(launderExamples.find(example => example.id === 'per-sample-value-function-intro'))

  assert.equal(typeof actual.confidence, 'number')
  assert.equal(actual.features.toSkip, true)
  assert.equal(actual.features.strongIntroduction, true)
  assert.match(actual.features.matchedSpan, /Let V_i/)
})

test('candidate detector scopes extraction to notation-introduction-like turns', () => {
  assert.equal(isLaunderCandidate('Let Q(t) = P[f_t] be the local benefit profile.'), true)
  assert.equal(isLaunderCandidate('I am reading the file now.'), false)
})

test('hard negatives stay clean', () => {
  for (const id of ['explicit-new-shorthand', 'paper-notation-reference', 'quoted-agent-term', 'repo-code-definition', 'ordinary-status']) {
    const example = launderExamples.find(row => row.id === id)
    assert.equal(classifyLaunder(example).decision, 'clean', id)
  }
})

test('fleet chat warning fires only for Skip recipients', () => {
  const message = 'Let V_i(t) = h_i(t) be the per-sample value function.'

  assert.equal(checkLaunderChatLint(message, ['fleet:skip']).length, 1)
  assert.deepEqual(checkLaunderChatLint(message, ['fleet:manager']), [])
})

test('fleet warning names reason, matched span, and amend affordance', () => {
  const [issue] = checkLaunderChatLint('Define \\bar M(t) as the normalized marginal curvature profile.', ['fleet:skip'])
  const warning = formatLaunderChatWarning(issue, 456)

  assert.match(warning, /ungrounded-notation-introduction/)
  assert.match(warning, /Define \\bar M/)
  assert.match(warning, /ground it explicitly/)
  assert.match(warning, /chat\(\{ amend_id: 456, message: "…"/)
})
