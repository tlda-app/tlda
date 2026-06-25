import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyNonClaudeRolePack,
  crossLaneBlock,
  inferAgentLane,
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

test('leaves delegate task body unchanged for all harnesses', () => {
  const original = 'Implement guidance contract and skill routing.'
  assert.equal(applyNonClaudeRolePack(original, { harnessKind: 'codex' }), original)
  assert.equal(applyNonClaudeRolePack(original, { harnessKind: 'goose' }), original)
  assert.equal(applyNonClaudeRolePack(original, { harnessKind: 'claude' }), original)
})

test('math templates do not inject reading packs for goose delegates', () => {
  const routed = applyNonClaudeRolePack('Rewrite the proof of Lemma 2.', {
    harnessKind: 'goose',
    template: 'math-edit',
  })
  assert.equal(routed, 'Rewrite the proof of Lemma 2.')
  assert.doesNotMatch(routed, /role pack/i)
  assert.doesNotMatch(routed, /Read these skills first/i)
})

test('infers broad agent lanes from cwd and labels', () => {
  assert.equal(inferAgentLane({ cwd: '/Users/skip/work/dot-claude', friendly_name: 'gpt-guidance' }), 'guidance')
  assert.equal(inferAgentLane({ cwd: '/Users/skip/work/tlda/.worktrees/foo', friendly_name: 'impl' }), 'app')
  assert.equal(inferAgentLane({ labels: ['math'], friendly_name: 'math pool one' }), 'math')
  assert.equal(inferAgentLane({ human: true, friendly_name: 'skip' }), 'human')
})

test('blocks cross-lane management but allows direct replies and guidance-app coordination', () => {
  const guidance = { id: 'fleet:g', friendly_name: 'gpt-guidance', cwd: '/Users/skip/work/dot-claude' }
  const app = { id: 'fleet:a', friendly_name: 'app-impl', cwd: '/Users/skip/work/tlda' }
  const math = { id: 'fleet:m', friendly_name: 'math pool one', labels: ['math'] }

  assert.equal(crossLaneBlock({
    fromAgent: guidance,
    toAgent: app,
    action: 'delegate',
    message: 'Implement this guardrail.',
  }), null)

  assert.match(crossLaneBlock({
    fromAgent: guidance,
    toAgent: math,
    action: 'delegate',
    message: 'Fix this proof.',
  })?.text || '', /Cross-lane delegate blocked/)

  assert.equal(crossLaneBlock({
    fromAgent: guidance,
    toAgent: math,
    action: 'chat',
    message: 'Right, answering your direct question.',
    directReply: true,
  }), null)

  assert.equal(crossLaneBlock({
    fromAgent: guidance,
    toAgent: math,
    action: 'chat',
    message: 'cross-lane-ok: Skip asked me to coordinate this proof handoff.',
  }), null)

  assert.equal(crossLaneBlock({
    fromAgent: guidance,
    toAgent: math,
    action: 'chat',
    message: 'This is just a note about the weather.',
  }), null)

  assert.match(crossLaneBlock({
    fromAgent: guidance,
    toAgent: math,
    action: 'chat',
    message: 'You need to stop and fix that proof report.',
  })?.text || '', /Cross-lane chat blocked/)
})
