import assert from 'node:assert/strict'
import test from 'node:test'

import { renderChatLine } from '../src/fleet/chat-render.mjs'

const ctx = {
  agentLabel: id => String(id || '').replace('fleet:', ''),
  getNickClass: () => 'nick-agent-0',
  isHumanId: id => id === 'fleet:skip',
  getAgents: () => [],
  getTasks: () => [],
  tldaToken: null,
  renderMarkdown: html => html,
  sendTargets: [],
}

function delegate(overrides = {}) {
  return {
    _evType: 'delegate',
    timestamp: '2026-09-26T12:00:00.000Z',
    from: 'fleet:alice',
    recipients: ['fleet:skip'],
    _description: 'Review the q3 outline',
    _taskId: 'task-123',
    _criteria: ['outline reads end to end', 'no placeholder sections'],
    _message: 'Please review the attached outline.',
    _dbId: '99',
    ...overrides,
  }
}

// Skip, 2026-09-26: the delegate card wrapped its title a letter per line on
// his phone. The header is the readable summary — description, routing,
// schedule — and the full message + criteria sit behind an expand toggle.
test('a delegate card header carries description, routing, and drag affordance', () => {
  const html = renderChatLine(delegate(), ctx)
  assert.match(html, /lifecycle-card lc-delegate/)
  assert.match(html, /data-task-id="task-123"/)
  assert.match(html, /data-lc-type="delegate"/)
  assert.match(html, /class="drag-handle"/)
  assert.match(html, /<span class="lc-title">Review the q3 outline<\/span>/)
  assert.match(html, /alice/)
  assert.match(html, /skip/)
})

test('the full message and criteria hide behind the expand toggle by default', () => {
  const html = renderChatLine(delegate(), ctx)
  assert.match(html, /<button type="button" class="lc-expand-btn"[^>]*>show full task<\/button>/)
  const more = html.slice(html.indexOf('class="lc-more"'))
  assert.match(html, /<div class="lc-more" style="display:none">/)
  assert.match(more, /Please review the attached outline\./)
  assert.match(more, /outline reads end to end/)
  assert.match(more, /no placeholder sections/)
})

test('a delegate card with no message and no criteria has no toggle and no body', () => {
  const html = renderChatLine(delegate({ _message: '', _criteria: [] }), ctx)
  assert.doesNotMatch(html, /lc-expand-btn/)
  assert.doesNotMatch(html, /lc-more/)
  assert.match(html, /Review the q3 outline/)
})

test('criteria alone still get a toggle and a body', () => {
  const html = renderChatLine(delegate({ _message: '' }), ctx)
  assert.match(html, /lc-expand-btn/)
  assert.match(html, /<div class="lc-more" style="display:none">/)
})

test('the schedule stays visible outside the collapsed body', () => {
  const html = renderChatLine(delegate({
    _taskNextFireAt: '2026-09-27T12:00:00.000Z',
    _taskRepeatSeconds: 3600,
  }), ctx)
  const scheduleAt = html.indexOf('lc-task-schedule')
  const moreAt = html.indexOf('class="lc-more"')
  assert.ok(scheduleAt !== -1 && moreAt !== -1 && scheduleAt < moreAt)
  assert.match(html, /every 1h/)
})

// Counterfactuals: the sibling task cards keep their header-only shape.
test('a task_done card has no toggle and no collapsible body', () => {
  const html = renderChatLine({
    _evType: 'task_done',
    timestamp: '2026-09-26T12:00:00.000Z',
    from: 'fleet:alice',
    recipients: ['fleet:skip'],
    _agent: 'fleet:alice',
    _description: 'Review the q3 outline',
    _taskId: 'task-123',
  }, ctx)
  assert.match(html, /lifecycle-card lc-done/)
  assert.match(html, /Review the q3 outline/)
  assert.doesNotMatch(html, /lc-expand-btn/)
  assert.doesNotMatch(html, /lc-more/)
})

test('a bounced task card has no toggle and no collapsible body', () => {
  const html = renderChatLine({
    timestamp: '2026-09-26T12:00:00.000Z',
    from: 'fleet:alice',
    recipients: ['fleet:skip'],
    text: '**Task bounced back:** needs a clearer scope',
  }, ctx)
  assert.match(html, /lifecycle-card lc-bounced/)
  assert.match(html, /needs a clearer scope/)
  assert.doesNotMatch(html, /lc-expand-btn/)
  assert.doesNotMatch(html, /lc-more/)
})
