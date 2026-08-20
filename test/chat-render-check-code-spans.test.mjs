import assert from 'node:assert/strict'
import test from 'node:test'

import { checkChatRender } from '../shared/chat-render-check.mjs'

// Built from real false positives seen in fleet chat on 2026-08-08. Every case
// below FLAGGED before the proseOnly() change and must stay clean after.
//
// The delimiters are assembled rather than written literally so that this file
// does not trip the very checker it tests when an agent pastes it into chat.
const D = '$' + '$'

test('a display delimiter written as a literal in inline code is not math', () => {
  const msg = 'Raw `' + D + '` delimiters arrived, nothing rendered.'
  assert.deepEqual(checkChatRender(msg).validity, [])
})

test('shell variables in a fenced block are not math', () => {
  const msg = 'Run:\n```sh\necho $HOME and $USER\n```\nDone.'
  assert.deepEqual(checkChatRender(msg).validity, [])
})

test('a paper macro quoted as SOURCE in a fenced block does not demand a preamble', () => {
  const msg = 'The file says:\n```latex\n' + D + '\\E[\\ind{A}] = \\P(A)' + D + '\n```\nThat is the source.'
  assert.deepEqual(checkChatRender(msg).validity, [])
})

test('explicit tex and latex fences may show literal TeX', () => {
  for (const language of ['tex', 'latex']) {
    const msg = 'The source is:\n```' + language + '\n\\frac{a}{b}\n```'
    assert.deepEqual(checkChatRender(msg).validity, [])
  }
})

test('an untagged fence containing LaTeX still warns', () => {
  const issues = checkChatRender('This should render:\n```\n\\frac{a}{b}\n```').validity
  assert.ok(issues.some(i => /Don\'t put LaTeX in a code block/.test(i)))
})

test('a latex command as a literal in inline code is not math', () => {
  assert.deepEqual(checkChatRender('Write `\\hat\\mu`, not the word.').validity, [])
})

// Counterfactuals: the checks that must keep working. A stripper that silences
// everything would pass the four tests above.
test('a genuinely unclosed display block still flags', () => {
  const issues = checkChatRender('Here is ' + D + 'x = y + 1\nand prose continues').validity
  assert.equal(issues.length, 1)
  assert.match(issues[0], /Unclosed/)
})

test('genuinely broken latex still flags', () => {
  const issues = checkChatRender('Here is ' + D + '\\frac{1}{' + D + ' broken').validity
  assert.ok(issues.some(i => /parse error/i.test(i)))
})

test('an unclosed code fence still flags — that check reads the raw message', () => {
  const issues = checkChatRender('Look:\n```sh\necho hi').validity
  assert.ok(issues.some(i => /Unclosed code fence/.test(i)))
})

test('real display math is still checked and still passes', () => {
  assert.deepEqual(checkChatRender('Result: ' + D + 'x = y + 1' + D + ' done.').validity, [])
})

test('a paper macro used as real math still asks for the preamble', () => {
  const issues = checkChatRender('We have ' + D + '\\E[\\ind{A}] = \\P(A)' + D + ' as usual.').validity
  assert.ok(issues.some(i => /macros that aren't loaded/.test(i)))
})
