import assert from 'node:assert/strict'
import test from 'node:test'

import { isPriorFinalSuffixEcho, trimSubmittedPrefixFromDeepgramText } from '../src/voice-indicator.mjs'

test('drops a final that only repeats the suffix of the preceding final', () => {
  assert.equal(isPriorFinalSuffixEcho('on the quotient', 'quotient', false), true)
})

test('keeps revised and newly-interimmed finals', () => {
  assert.equal(isPriorFinalSuffixEcho('very', 'very', true), false)
  assert.equal(isPriorFinalSuffixEcho('', 'quotient', false), false)
  assert.equal(isPriorFinalSuffixEcho('on the quotient', 'new words', false), false)
})

test('keeps a corrected carried word without repeating the submitted suffix', () => {
  assert.deepEqual(
    trimSubmittedPrefixFromDeepgramText(
      'possible. That itself is a bug. Do you understand?',
      "okay like that shouldn't be that itself is a bug do you understand",
    ),
    { text: 'possible.', droppedWords: 8 },
  )
})

test('removes a submitted prefix from a carried continuation', () => {
  assert.deepEqual(
    trimSubmittedPrefixFromDeepgramText('world, new words', 'hello world'),
    { text: 'new words', droppedWords: 1 },
  )
})
