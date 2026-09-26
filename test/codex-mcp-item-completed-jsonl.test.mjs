import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCodexRecord, mcpItemCompletedEvent } from '../agent-runtime/codex-activity.mjs'
import { mcpEndEvent } from '../agent-runtime/functions-exec-activity.mjs'

// Current CLI emits fleet MCP calls as PascalCase McpToolCall item_completed
// records (shape lifted verbatim from the real ba-advocate-2 rollout,
// 2026-09-26). The legacy snake_case mcp_tool_call_end form no longer appears.
const chatItemCompleted = {
  timestamp: '2026-09-26T08:25:03.014Z',
  ordinal: 143,
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    item: {
      type: 'McpToolCall',
      id: 'exec-bef1bee7-7b36-42b8-a263-467017766077',
      server: 'tlda',
      tool: 'chat',
      arguments: {
        to: 'fleet:c12d1194',
        file: 'scratch/ba-advocate-watch.md',
        selector: 'figure-check-2026-09-26-0422-edt',
      },
      status: 'failed',
      result: {
        content: [{ type: 'text', text: 'No markdown elements match CSS selector "#figure-check-2026-09-26-0422-edt".' }],
        isError: true,
      },
      duration: { secs: 1, nanos: 98881584 },
    },
  },
}

test('item_completed McpToolCall projects tool_use + tool_result like legacy mcp_tool_call_end', () => {
  const viaBranch = parseCodexRecord(chatItemCompleted)
  assert.ok(viaBranch, 'branch must not return NULL for the fleet-tool stream')
  assert.equal(viaBranch.type, 'assistant')
  assert.equal(viaBranch.blocks.length, 2)

  const [toolUse, toolResult] = viaBranch.blocks
  assert.equal(toolUse.type, 'tool_use')
  assert.equal(toolUse.name, 'mcp__tlda__chat')
  assert.deepEqual(toolUse.input, chatItemCompleted.payload.item.arguments)
  assert.equal(toolUse.id, 'exec-bef1bee7-7b36-42b8-a263-467017766077')
  assert.equal(toolUse.status, 'failed')
  assert.deepEqual(toolUse.duration, { secs: 1, nanos: 98881584 })
  assert.equal(toolUse.correlationId, toolUse.id)
  assert.equal(toolResult.type, 'tool_result')
  assert.equal(toolResult.id, toolUse.id)
  assert.equal(toolResult.is_error, true)
  assert.match(toolResult.text, /No markdown elements match/)

  // Same shape the legacy end-record path produces: identical block skeleton.
  const legacy = mcpEndEvent(
    {
      invocation: { server: 'tlda', tool: 'chat', arguments: { to: 'x' } },
      result: { Ok: { content: [{ text: 'y' }] } },
      call_id: 'legacy-id',
      duration: { secs: 0, nanos: 1 },
    },
    '2026-09-26T08:25:03.014Z',
  )
  assert.deepEqual(
    viaBranch.blocks.map(b => b.type),
    legacy.blocks.map(b => b.type),
  )
  assert.deepEqual(Object.keys(viaBranch.blocks[0]).sort(), Object.keys(legacy.blocks[0]).sort())
})

test('completed McpToolCall maps status and unwraps joined text', () => {
  const ev = mcpItemCompletedEvent(
    {
      server: 'tlda',
      tool: 'search',
      id: 'exec-abc',
      status: 'completed',
      arguments: { query: 'q' },
      result: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      duration: { secs: 0, nanos: 5 },
    },
    '2026-09-26T08:36:24.509Z',
  )
  assert.equal(ev.blocks[0].name, 'mcp__tlda__search')
  assert.equal(ev.blocks[0].status, 'completed')
  assert.equal(ev.blocks[1].text, 'ab')
  assert.equal(ev.blocks[1].is_error, false)
})

test('McpToolCall without server or tool is skipped', () => {
  assert.equal(mcpItemCompletedEvent({ tool: 'chat' }, '2026-09-26T08:25:03.014Z'), null)
  assert.equal(mcpItemCompletedEvent({ server: 'tlda' }, '2026-09-26T08:25:03.014Z'), null)
})
