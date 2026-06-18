import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyNonClaudeRolePack,
  inferHarnessKind,
  inferTaskRole,
} from '../shared/task-role-routing.mjs'

test('infers non-Claude harnesses from explicit kind or model aliases', () => {
  assert.equal(inferHarnessKind({ kind: 'codex', model: 'deepseek' }), 'codex')
  assert.equal(inferHarnessKind({ model: 'gpt-5.5' }), 'codex')
  assert.equal(inferHarnessKind({ model: 'deepseek' }), 'goose')
  assert.equal(inferHarnessKind({ model: 'deepseek/deepseek-v4-pro' }), 'goose')
  assert.equal(inferHarnessKind({ kind: 'claude', model: 'gpt-5.5' }), 'claude')
  assert.equal(inferHarnessKind({ model: 'opus48' }), null)
})

test('routes task text to compact role packs', () => {
  assert.equal(inferTaskRole({ template: 'math-edit', message: 'Fix this' }), 'math')
  assert.equal(inferTaskRole({ message: 'Verify the Playwright screenshot artifact in the viewer' }), 'app')
  assert.equal(inferTaskRole({ message: 'Implement guidance contract and skill routing' }), 'guidance')
  assert.equal(inferTaskRole({ message: 'Summarize the meeting notes' }), null)
})

test('prepends role pack only for non-Claude targets without replacing task body', () => {
  const original = 'Implement guidance contract and skill routing.'
  const routed = applyNonClaudeRolePack(original, { harnessKind: 'codex' })
  assert.match(routed, /<!-- fleet-role-pack:v1 -->/)
  assert.match(routed, /Non-Claude Guidance\/process role pack/)
  assert.match(routed, /`point-dont-paraphrase`, `read-to-the-end`, `investigate-dont-narrate`/)
  assert.match(routed, /Implement guidance contract and skill routing\./)

  assert.equal(applyNonClaudeRolePack(original, { harnessKind: 'claude' }), original)
  assert.equal(applyNonClaudeRolePack(routed, { harnessKind: 'goose' }), routed)
})

test('routes math templates to math skills for goose delegates', () => {
  const routed = applyNonClaudeRolePack('Rewrite the proof of Lemma 2.', {
    harnessKind: 'goose',
    template: 'math-edit',
  })
  assert.match(routed, /Non-Claude Math\/proof role pack/)
  assert.match(routed, /`argument-outline`, `proof-smells`, `math-commit-gate`/)
  assert.match(routed, /tlda push\/build feedback path/)
  assert.match(routed, /do not run repeated local LaTeX build loops/)
})
