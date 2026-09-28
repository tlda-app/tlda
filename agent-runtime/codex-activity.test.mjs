import assert from 'node:assert/strict'
import test from 'node:test'

import { extractCodexStatusFacts } from './codex-activity.mjs'

const TS = '2026-09-28T04:00:25.907Z'

test('task_started opens a turn with its id', () => {
  assert.deepEqual(
    extractCodexStatusFacts({
      timestamp: TS, type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1', root_turn_id: 'turn-1' },
    }),
    { ts: TS, turnId: 'turn-1', turn: 'open', tool: null, callId: null, toolName: null },
  )
})

test('task_complete closes a turn with its id', () => {
  assert.deepEqual(
    extractCodexStatusFacts({
      timestamp: TS, type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done' },
    }),
    { ts: TS, turnId: 'turn-1', turn: 'close', tool: null, callId: null, toolName: null },
  )
})

test('all three tool-call shapes open a tool', () => {
  for (const callType of ['custom_tool_call', 'function_call', 'tool_search_call']) {
    assert.deepEqual(
      extractCodexStatusFacts({
        timestamp: TS, type: 'response_item',
        payload: { type: callType, name: 'exec_command', call_id: 'call-1' },
      }),
      { ts: TS, turnId: null, turn: null, tool: 'open', callId: 'call-1', toolName: 'exec_command' },
    )
  }
})

test('all three tool-output shapes close a tool', () => {
  for (const outType of ['custom_tool_call_output', 'function_call_output', 'tool_search_output']) {
    assert.deepEqual(
      extractCodexStatusFacts({
        timestamp: TS, type: 'response_item',
        payload: { type: outType, call_id: 'call-1', output: 'ok' },
      }),
      { ts: TS, turnId: null, turn: null, tool: 'close', callId: 'call-1', toolName: null },
    )
  }
})

test('non-edge records carry no status signal', () => {
  const records = [
    { timestamp: TS, type: 'session_meta', payload: { id: 'thread-1' } },
    { timestamp: TS, type: 'turn_context', payload: { turn_id: 'turn-1' } },
    { timestamp: TS, type: 'world_state', payload: {} },
    { timestamp: TS, type: 'token_usage_record', payload: {} },
    { timestamp: TS, type: 'compacted', payload: { message: '' } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'thread_settings_applied' } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'McpToolCall' } } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
    { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
    { timestamp: TS, type: 'response_item', payload: { type: 'reasoning' } },
  ]
  for (const record of records) {
    assert.equal(extractCodexStatusFacts(record), null, JSON.stringify(record.payload))
  }
})

test('task edges without a turn id are not edges', () => {
  assert.equal(extractCodexStatusFacts({ timestamp: TS, type: 'event_msg', payload: { type: 'task_started' } }), null)
  assert.equal(extractCodexStatusFacts({ timestamp: TS, type: 'event_msg', payload: { type: 'task_complete' } }), null)
})

test('string input parses; garbage returns null', () => {
  assert.deepEqual(
    extractCodexStatusFacts(JSON.stringify({
      timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-9' },
    })),
    { ts: TS, turnId: 'turn-9', turn: 'open', tool: null, callId: null, toolName: null },
  )
  assert.equal(extractCodexStatusFacts('not json'), null)
  assert.equal(extractCodexStatusFacts(null), null)
  assert.equal(extractCodexStatusFacts(42), null)
  assert.equal(extractCodexStatusFacts({ timestamp: TS, type: 'event_msg' }), null)
})
