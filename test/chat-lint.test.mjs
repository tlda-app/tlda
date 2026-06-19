import test from 'node:test'
import assert from 'node:assert/strict'

import { blockingChatLintIssues, lintChatMessage } from '../mcp-server/fleet-tools.mjs'

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

test('chat lint leaves completion style claims advisory', () => {
  const issues = lintChatMessage('Fixed the thing.', {})

  assert.ok(issues.some(issue => /Completion-style claim/.test(issue)))
  assert.deepEqual(blockingChatLintIssues(issues), [])
})
