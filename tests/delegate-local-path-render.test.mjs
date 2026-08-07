import assert from 'node:assert/strict'
import test from 'node:test'

import { esc, renderChatLine } from '../src/fleet/chat-render.mjs'
import { convertChatEvent } from '../src/fleet/convert-chat-event.mjs'

const ctx = {
  agentLabel: id => id,
  getNickClass: () => '',
  isHumanId: id => id === 'fleet:skip',
  getAgents: () => [],
  getTasks: () => [],
  tldaToken: null,
  renderMarkdown: html => html,
}

test('delegate lifecycle card renders preserved local path as text, not attachment placeholder', () => {
  const localPath = '/Users/skip/work/tlda/AGENTS.md'
  const html = renderChatLine({
    _evType: 'delegate',
    _description: 'Read guidance',
    _taskId: 'task:local-path',
    _message: `Read ${esc(localPath)} directly before acting.`,
    from: 'fleet:chief',
    to: 'fleet:worker',
    timestamp: '2026-07-28T08:35:00.000Z',
    _dbId: 1983277,
  }, ctx)

  assert.match(html, /lc-delegate/)
  assert.match(html, /\/Users\/skip\/work\/tlda\/AGENTS\.md/)
  assert.doesNotMatch(html, /\{\{att:0\}\}/)
  assert.doesNotMatch(html, /ref-chip-pending/)
})

test('deferred recurring delegation renders one task card with its schedule', () => {
  const event = convertChatEvent({
    id: 12,
    type: 'delegate',
    from: 'fleet:caller',
    recipients: ['fleet:worker'],
    text: 'Check the build',
    timestamp: '2026-08-04T12:00:00.000Z',
    metadata: {
      taskId: 'task-12',
      fromLabel: 'caller',
      toLabel: 'worker',
      message: 'Run the real command.',
      at: '2026-08-04T13:00:00.000Z',
      next_fire_at: '2026-08-04T13:00:00.000Z',
      repeat_seconds: 300,
    },
  })

  const html = renderChatLine(event, ctx)

  // The header is a one-line title on every lifecycle card. It carries the task
  // description, never the delegate() call source — that filled a 385px panel
  // with the whole brief and was what made these cards unreadable.
  assert.match(html, /<span class="lc-title">Check the build<\/span>/)
  assert.doesNotMatch(html, /delegate\(/)
  assert.match(html, /caller/)
  assert.match(html, /data-timer-until="2026-08-04T13:00:00\.000Z"/)
  assert.match(html, /every 5m/)
  assert.match(html, /Run the real command\./)
})

test('task-linked timer is not rendered as a second row', () => {
  const timer = convertChatEvent({
    id: 13,
    type: 'timer',
    from: 'fleet:caller',
    recipients: ['fleet:worker'],
    timestamp: '2026-08-04T12:00:00.000Z',
    text: 'Task reminder: Check the build',
    metadata: {
      pending: true,
      fire_at: '2026-08-04T13:00:00.000Z',
      task_id: 'task-12',
    },
  })

  assert.equal(renderChatLine(timer, ctx), '')
})

test('message to the panel default target omits the recipient arrow', () => {
  const agents = [
    { id: 'fleet:skip', friendly_name: 'skip', human: true },
    { id: 'fleet:app-recovery', friendly_name: 'app-recovery', dead: 0 },
  ]
  const html = renderChatLine({
    from: 'fleet:skip',
    recipients: ['fleet:app-recovery'],
    text: 'status?',
    timestamp: '2026-08-06T15:13:00.000Z',
  }, {
    ...ctx,
    getAgents: () => agents,
    sendTargets: ['app-recovery'],
  })

  assert.match(html, />skip<\/span>:/)
  assert.doesNotMatch(html, /chat-arrow/)
  assert.doesNotMatch(html, /fleet:app-recovery<\/span>:/)
})
