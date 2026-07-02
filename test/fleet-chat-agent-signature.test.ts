import assert from 'node:assert/strict'
import test from 'node:test'

import { chatAgentSignature } from '../src/fleet/chat-agent-signature.ts'

const baseAgents = [
  {
    id: 'fleet:alpha',
    friendly_name: 'alpha',
    name: 'alpha',
    human: false,
    dead: false,
    status: 'awake',
    is_manager: false,
    labels: ['bot'],
    metadata: {
      inPlanMode: false,
      permission_mode: 'default',
      planModeType: null,
    },
  },
]

test('chat agent signature ignores status-only churn', () => {
  const nextAgents = [{
    ...baseAgents[0],
    status: 'hibernating',
  }]

  assert.equal(chatAgentSignature(baseAgents), chatAgentSignature(nextAgents))
})

test('chat agent signature changes for render-relevant identity fields', () => {
  const nextAgents = [{
    ...baseAgents[0],
    friendly_name: 'alpha:day',
  }]

  assert.notEqual(chatAgentSignature(baseAgents), chatAgentSignature(nextAgents))
})
