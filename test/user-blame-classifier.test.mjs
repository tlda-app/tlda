import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyUserBlame, isUserBlameCandidate } from '../bin/lib/user-blame-classifier.mjs'
import { checkUserBlameChatLint, formatUserBlameChatWarning } from '../mcp-server/fleet-tools.mjs'
import { userBlameExamples } from './fixtures/user-blame-examples.mjs'

test('seed user-blame examples classify to expected decision and reason', () => {
  for (const example of userBlameExamples) {
    const actual = classifyUserBlame(example)
    assert.equal(actual.decision, example.label, `${example.id} decision`)
    assert.equal(actual.reasonCode, example.reasonCode, `${example.id} reasonCode`)
  }
})

test('classifier emits feature map for audit and future statistical model', () => {
  const actual = classifyUserBlame(userBlameExamples.find(example => example.id === 'accept-cert-prompt-blame'))

  assert.equal(typeof actual.confidence, 'number')
  assert.equal(actual.features.toSkip, true)
  assert.equal(actual.features.hasUserFaultLanguage, true)
  assert.equal(actual.features.matchedSpan, 'You need to')
})

test('candidate detector scopes extraction to blame-like turns', () => {
  assert.equal(isUserBlameCandidate('You need to accept the cert prompt before it will work.'), true)
  assert.equal(isUserBlameCandidate('I am reading the file now.'), false)
})

test('hard negatives stay clean', () => {
  for (const id of ['agreeing-with-skip', 'quoted-log-you', 'neutral-status', 'repo-code-explanation', 'owned-wrong-surface']) {
    const example = userBlameExamples.find(row => row.id === id)
    assert.equal(classifyUserBlame(example).decision, 'clean', id)
  }
})

test('fleet chat warning fires only for Skip recipients', () => {
  const message = 'You hit the wrong URL, so the viewer cannot load from your browser.'

  assert.equal(checkUserBlameChatLint(message, ['fleet:skip']).length, 1)
  assert.deepEqual(checkUserBlameChatLint(message, ['fleet:manager']), [])
})

test('fleet warning names reason, matched span, and amend affordance', () => {
  const [issue] = checkUserBlameChatLint('You need to accept the cert prompt before this will work.', ['fleet:skip'])
  const warning = formatUserBlameChatWarning(issue, 123)

  assert.match(warning, /user-fault-framing/)
  assert.match(warning, /Matched: `You need to`/)
  assert.match(warning, /chat\(\{ amend_id: 123, message: "…"/)
  assert.match(warning, /edits the message Skip is reading, no new message/)
})
