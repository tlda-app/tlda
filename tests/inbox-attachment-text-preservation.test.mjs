import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveInboxMessage } from '../mcp-server/fleet-tools.mjs'

const resolvers = {
  resolveChipTokens: async text => ({ text, images: [] }),
  resolveTheoremRefs: text => text,
  resolveImages: async text => ({ text, images: [] }),
}

function messageWithRef(ref) {
  return {
    id: 1398080,
    from: 'fleet:sender',
    to: 'fleet:recipient',
    type: 'chat',
    text: 'Read AGENTS.md at {{att:0}} before continuing.',
    metadata: {
      inline_attachments: [{
        id: 0,
        type: 'file',
        name: 'AGENTS.md',
        url: '/api/uploads/agents-md',
      }],
      recipient_refs: {
        'fleet:recipient': { attachments: { '0': ref } },
      },
    },
  }
}

test('failed materialization preserves authored attachment text in inbox messages', async () => {
  const result = await resolveInboxMessage(messageWithRef({
    state: 'failed',
    error: 'agent has no daemon address (op=materialize-attachment)',
  }), resolvers)

  assert.match(result.line, /Read AGENTS\.md at AGENTS\.md before continuing\./)
  assert.doesNotMatch(result.line, /materialization failed|daemon address/)
})

test('pending materialization preserves authored attachment text in inbox messages', async () => {
  const result = await resolveInboxMessage(messageWithRef({ state: 'pending' }), resolvers)

  assert.match(result.line, /Read AGENTS\.md at AGENTS\.md before continuing\./)
  assert.doesNotMatch(result.line, /materializing on this machine/)
})

test('available materialization still resolves to the durable local path', async () => {
  const result = await resolveInboxMessage(messageWithRef({
    state: 'available',
    localPath: '/materialized/AGENTS.md',
  }), resolvers)

  assert.match(result.line, /Read AGENTS\.md at \/materialized\/AGENTS\.md before continuing\./)
})
