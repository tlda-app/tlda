import assert from 'node:assert/strict'
import test from 'node:test'

import { isPriorFinalSuffixEcho } from '../src/voice-indicator.mjs'

test('drops a final that only repeats the suffix of the preceding final', () => {
  assert.equal(isPriorFinalSuffixEcho('on the quotient', 'quotient', false), true)
})

test('keeps revised and newly-interimmed finals', () => {
  assert.equal(isPriorFinalSuffixEcho('very', 'very', true), false)
  assert.equal(isPriorFinalSuffixEcho('', 'quotient', false), false)
  assert.equal(isPriorFinalSuffixEcho('on the quotient', 'new words', false), false)
})
