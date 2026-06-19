import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeChatDisplayMathDelimiters } from '../shared/chat-math-normalize.mjs'

test('normalizes bracket display delimiters to dollar display math', () => {
  const input = 'Before\n\\[ x^2 + y^2 \\]\nAfter'

  assert.equal(
    normalizeChatDisplayMathDelimiters(input),
    'Before\n$$ x^2 + y^2 $$\nAfter',
  )
})

test('normalizes GPT-style doubled backslash bracket display delimiters', () => {
  const input = 'Before\n\\\\[ x^2 + y^2 \\\\]\nAfter'

  assert.equal(
    normalizeChatDisplayMathDelimiters(input),
    'Before\n$$ x^2 + y^2 $$\nAfter',
  )
})

test('normalizes inline paren delimiters from psc-style chat answers', () => {
  const input = 'Use \\(c\\) for the fixed domination constant and \\(q_x\\) for the penalty.'

  assert.equal(
    normalizeChatDisplayMathDelimiters(input),
    'Use $c$ for the fixed domination constant and $q_x$ for the penalty.',
  )
})

test('normalizes GPT-style doubled backslash inline paren delimiters', () => {
  const input = 'Use \\\\(c\\\\) for the fixed domination constant.'

  assert.equal(
    normalizeChatDisplayMathDelimiters(input),
    'Use $c$ for the fixed domination constant.',
  )
})

test('normalizes bracket-only display block after delimiter backslashes are lost', () => {
  const input = 'Before\n[\nx^2 + y^2\n]\nAfter'

  assert.equal(
    normalizeChatDisplayMathDelimiters(input),
    'Before\n$$x^2 + y^2$$\nAfter',
  )
})

test('does not normalize ordinary inline square brackets', () => {
  const input = 'Keep [this prose] and [that link](https://example.test) alone.'

  assert.equal(normalizeChatDisplayMathDelimiters(input), input)
})

test('does not normalize bracket delimiter examples inside code', () => {
  const input = [
    'Example:',
    '```text',
    '\\[ x^2 + y^2 \\]',
    '```',
    'and `\\[ z \\]` plus `\\(c\\)` inline.',
  ].join('\n')

  assert.equal(normalizeChatDisplayMathDelimiters(input), input)
})

test('does not normalize non-math bracket-only prose blocks', () => {
  const input = 'Before\n[\nplain note\n]\nAfter'

  assert.equal(normalizeChatDisplayMathDelimiters(input), input)
})
