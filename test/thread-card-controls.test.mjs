import assert from 'node:assert/strict'
import test from 'node:test'

import { renderActivityGroup } from '../src/fleet/activity-render.mjs'

function threadMessages(from, to, start, count) {
  return Array.from({ length: count }, (_, i) => {
    const n = start + i
    return `[7/30/2026, 9:${String(n).padStart(2, '0')}:00 AM EDT] ${from} → ${to}\nmessage ${n}`
  }).join('\n\n---\n\n')
}

const ctx = {
  agentLabel: id => id,
  getNickClass: () => 'nick-agent-0',
  getAgents: () => [],
  getTasks: () => [],
  renderMarkdown: html => html,
}

test('paginated thread pretty results merge into one old-style expandable card', () => {
  const html = renderActivityGroup([
    {
      from: 'fleet:pretty',
      timestamp: '2026-07-30T13:33:41.000Z',
      _toolName: 'mcp__tlda__thread',
      _toolArg: 'agent:pretty',
      _toolInput: { agent: 'pretty', page_size: 8 },
      _prettyResult: threadMessages('skip', 'pretty', 1, 8),
    },
    {
      from: 'fleet:pretty',
      timestamp: '2026-07-30T13:33:50.000Z',
      _toolName: 'mcp__tlda__thread',
      _toolArg: 'agent:pretty',
      _toolInput: { agent: 'pretty', page_size: 8, cursor: 'next-page' },
      _prettyResult: threadMessages('skip', 'pretty', 9, 8),
    },
  ], ctx)

  assert.match(html, /tool-pretty-thread/)
  assert.match(html, /message 1/)
  assert.match(html, /message 16/)
  assert.match(html, /pretty-more-rows/)
  assert.equal((html.match(/pretty-expand-btn/g) || []).length, 1)
  assert.equal((html.match(/semantic-operation-more/g) || []).length, 0)
  assert.equal((html.match(/semantic-chat-operation/g) || []).length, 0)
})
