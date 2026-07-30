import assert from 'node:assert/strict'

import { renderActivityGroup } from '../src/fleet/activity-render.mjs'

const ctx = {
  agentLabel: id => id,
  getNickClass: () => '',
  getAgents: () => [],
  renderMarkdown: value => value,
}

const html = renderActivityGroup([{
  from: 'fleet:test',
  timestamp: '2026-07-30T00:00:00.000Z',
  _toolName: 'mcp__tlda__thread',
  _toolArg: 'pretty',
  _toolInput: { agent: 'pretty', types: ['chat'], page_size: 20 },
}], ctx)

assert.match(html, /Open thread/)
assert.match(html, /SemanticChatOperationDescriptor/)
assert.match(html, /&quot;agent&quot;:&quot;pretty&quot;/)
assert.doesNotMatch(html, /pretty-more-rows/)
assert.doesNotMatch(html, /\[truncated/)

console.log('semantic-operation-render-test: ok')
