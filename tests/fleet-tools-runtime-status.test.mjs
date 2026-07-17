import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentSetLabelsForChat,
  classifyTaskAgentHealth,
} from '../mcp-server/fleet-tools.mjs'
import { evalExpr, parseFilter } from '../shared/fleet-labels.mjs'

test('MCP chat awake pseudo-label comes from runtime_status, not removed status alias', () => {
  const agent = {
    id: 'fleet:reviewer',
    runtime_status: { status: 'awake' },
    labels: ['reviewers'],
  }

  const labels = agentSetLabelsForChat(agent)

  assert.equal(evalExpr(parseFilter('awake & reviewers'), labels), true)
  assert.equal(Object.hasOwn(agent, 'status'), false)
})

test('MCP task health uses runtime_status for hibernating active-task warning', () => {
  const health = classifyTaskAgentHealth(
    { id: 'task:1', agent: 'fleet:worker', status: 'in-progress', delegated_at: new Date().toISOString() },
    {
      id: 'fleet:worker',
      friendly_name: 'worker',
      runtime_status: { status: 'hibernating' },
      last_seen: new Date().toISOString(),
    },
    { nowMs: Date.now() },
  )

  assert.equal(health.code, 'hibernating-agent')
})
