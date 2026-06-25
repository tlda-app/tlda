import test from 'node:test'
import assert from 'node:assert/strict'

import { blockingChatLintIssues, checkChatRender, lintChatMessage } from '../mcp-server/fleet-tools.mjs'

test('chat lint accepts bracket display delimiters supported by fleet renderer', () => {
  const issues = lintChatMessage('Use \\[ x^2 + y^2 \\] for the condition.', {})

  assert.equal(issues.some(issue => /does not support \\\[/.test(issue)), false)
  assert.deepEqual(blockingChatLintIssues(issues), [])
})

test('chat lint accepts GPT-style doubled backslash display delimiters', () => {
  const issues = lintChatMessage('Use \\\\[ x^2 + y^2 \\\\] for the condition.', {})

  assert.equal(issues.some(issue => /does not support \\\[/.test(issue)), false)
  assert.equal(issues.some(issue => /^LaTeX parse error/.test(issue)), false)
  assert.deepEqual(blockingChatLintIssues(issues), [])
})

test('chat lint accepts standalone bracket display blocks after delimiter backslashes are lost', () => {
  const issues = lintChatMessage('Condition:\n[\nx^2 + y^2 = z^2\n]\nDone.', {})

  assert.equal(issues.some(issue => /does not support \\\[/.test(issue)), false)
  assert.equal(issues.some(issue => /^LaTeX parse error/.test(issue)), false)
  assert.deepEqual(blockingChatLintIssues(issues), [])
})

test('chat lint accepts LaTeX inline paren delimiters supported by fleet renderer', () => {
  const issues = lintChatMessage('The object is \\( z^\\dagger \\), not the comparator.', {})

  assert.equal(issues.some(issue => /does not support \\\(/.test(issue)), false)
  assert.equal(issues.some(issue => /^LaTeX parse error/.test(issue)), false)
  assert.deepEqual(issues, [])
  assert.deepEqual(blockingChatLintIssues(issues), [])
})

test('chat lint accepts psc-style readability fixture with inline paren math', () => {
  const issues = lintChatMessage([
    'The one-line meaning of \\(c\\) is that the objective excess for \\(q_x\\) dominates variance cost.',
    '$$',
    "q_x''(t) \\ge \\mu v_0(x)",
    '$$',
  ].join('\n'), {})

  assert.equal(issues.some(issue => /does not support \\\(/.test(issue)), false)
  assert.equal(issues.some(issue => /^LaTeX parse error/.test(issue)), false)
  assert.deepEqual(issues, [])
  assert.deepEqual(blockingChatLintIssues(issues), [])
})

test('chat lint does not warn on supported dollar math delimiters', () => {
  const issues = lintChatMessage('The object is $z^\\dagger$, not the comparator.', {})

  assert.equal(issues.some(issue => /does not support/.test(issue)), false)
  assert.deepEqual(blockingChatLintIssues(issues), [])
})

test('chat lint treats KaTeX parse errors as advisory warnings', () => {
  const issues = lintChatMessage('Broken math $\\frac{1}{$ should not send.', {})

  assert.ok(issues.some(issue => /^LaTeX parse error/.test(issue)))
  assert.deepEqual(blockingChatLintIssues(issues), [])
})

test('chat lint no longer gates on completion-style wording (Skip: never a gate)', () => {
  // "done / fixed / handled / passing" in ordinary prose must NOT be flagged.
  const issues = lintChatMessage('Fixed the thing. The test was passing and it is all handled now — done.', {})

  assert.equal(issues.some(issue => /Completion-style claim/.test(issue)), false)
  assert.deepEqual(issues, [])
  assert.deepEqual(blockingChatLintIssues(issues), [])
})

test('checkChatRender separates render-validity from style hints', () => {
  // Multiple display blocks with prose between is a STYLE hint, never validity.
  const { validity, style } = checkChatRender('$$a^2$$\nthen some text\n$$b^2$$', {})
  assert.equal(validity.length, 0)
  assert.ok(style.some(s => /separate display blocks/.test(s)))
})

test('chat lint flags an unclosed code fence as a render-validity issue', () => {
  const issues = lintChatMessage('Here is the code:\n```js\nconst x = 1\n', {})
  assert.ok(issues.some(i => /Unclosed code fence/.test(i)))
})

test('chat lint flags an unclosed $$ display block as a render-validity issue', () => {
  const issues = lintChatMessage('The bound is $$ a^2 + b^2 and then we stop.', {})
  assert.ok(issues.some(i => /Unclosed `\$\$` display-math block/.test(i)))
})

test('chat lint does not false-flag balanced $$ blocks', () => {
  const { validity } = checkChatRender('A bound: $$a^2 + b^2 = c^2$$ and that is all.', {})
  assert.equal(validity.some(i => /Unclosed/.test(i)), false)
})
