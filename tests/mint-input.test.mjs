import test from 'node:test'
import assert from 'node:assert/strict'
import { activeMintToken, applyMintCandidate, parseMintInput } from '../src/fleet/mint-input.ts'

test('mint input parses positional fields and colon-bound keyword args', () => {
  assert.deepEqual(parseMintInput('bregman helm opus effort:high'), {
    doc: 'bregman', name: 'helm', model: 'opus', options: { effort: 'high' }, effort: 'high',
  })
})

test('mint IntelliSense advances across positional tokens', () => {
  assert.deepEqual(activeMintToken('bregman '), { pos: 2, prefix: '' })
  assert.deepEqual(activeMintToken('bregman helm op'), { pos: 3, prefix: 'op' })
  assert.deepEqual(activeMintToken('bregman helm opus '), { pos: 4, prefix: '' })
  assert.deepEqual(activeMintToken('bregman helm opus effort:h'), { pos: 4, prefix: 'effort:h' })
})

test('mint choices replace the active token without changing the grammar', () => {
  assert.equal(applyMintCandidate('bregman helm op', 'opus'), 'bregman helm opus')
  assert.equal(applyMintCandidate('bregman helm opus ', 'verbosity:'), 'bregman helm opus verbosity:')
  assert.equal(applyMintCandidate('bregman helm opus effort:h', 'high'), 'bregman helm opus effort:high')
})
