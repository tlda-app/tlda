import assert from 'node:assert/strict'
import test from 'node:test'

import { esc, renderChatLine, taskCountdownLabel } from '../src/fleet/chat-render.mjs'

test('task countdown changes only at minute boundaries', () => {
  const now = Date.parse('2026-08-05T19:00:00Z')
  assert.equal(taskCountdownLabel('2026-08-05T19:11:21Z', now), '12m')
  assert.equal(taskCountdownLabel('2026-08-05T19:11:01Z', now), '12m')
  assert.equal(taskCountdownLabel('2026-08-05T19:11:00Z', now), '11m')
  assert.equal(taskCountdownLabel('2026-08-05T19:00:30Z', now), '1m')
  assert.equal(taskCountdownLabel('2026-08-05T19:00:00Z', now), 'due')
})
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

test('deferred recurring delegation renders one task card with call and schedule', () => {
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
      callArgs: {
        mint: { name: 'worker', cwd: '/Users/skip/worktrees/task', model: 'gpt-5.6-sol' },
        description: 'Check the build',
        message: 'Run the real command.',
        success_criteria: ['The build passes'],
        at: '2026-08-04T13:00:00.000Z',
        notify_every: 300,
      },
      at: '2026-08-04T13:00:00.000Z',
      next_fire_at: '2026-08-04T13:00:00.000Z',
      repeat_seconds: 300,
    },
  })

  const html = renderChatLine(event, ctx)

  assert.match(html, /delegate\(mint: \{&quot;name&quot;:&quot;worker&quot;,&quot;cwd&quot;:&quot;\/Users\/skip\/worktrees\/task&quot;,&quot;model&quot;:&quot;gpt-5\.6-sol&quot;\}, description: &quot;Check the build&quot;, message: &quot;Run the real command\.&quot;, success_criteria: \[&quot;The build passes&quot;\], at: &quot;2026-08-04T13:00:00\.000Z&quot;, notify_every: 300\)/)
  assert.match(html, /caller/)
  assert.match(html, /data-timer-until="2026-08-04T13:00:00\.000Z"/)
  assert.match(html, /every 5m/)
  assert.match(html, /Run the real command\./)
})

test('delegate call display does not invent omitted arguments', () => {
  const html = renderChatLine(convertChatEvent({
    id: 14,
    type: 'delegate',
    from: 'fleet:caller',
    recipients: ['fleet:worker'],
    text: 'Transfer task',
    timestamp: '2026-08-04T12:00:00.000Z',
    metadata: {
      taskId: 'task-14',
      callArgs: { agent: 'worker', task_id: 'existing-task', message: 'Take over.' },
    },
  }), ctx)

  assert.match(html, /delegate\(agent: &quot;worker&quot;, task_id: &quot;existing-task&quot;, message: &quot;Take over\.&quot;\)/)
  assert.doesNotMatch(html, /description:/)
  assert.doesNotMatch(html, /notify_every:/)
  assert.doesNotMatch(html, /mint:/)
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
