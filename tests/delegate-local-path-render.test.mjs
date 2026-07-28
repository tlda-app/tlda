import assert from 'node:assert/strict'
import test from 'node:test'

import { esc, renderChatLine } from '../src/fleet/chat-render.mjs'

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
