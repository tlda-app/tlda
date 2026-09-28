import assert from 'node:assert/strict'
import test from 'node:test'

import { extractRecordOutputs } from './fleet-jsonl-ingester.mjs'

const TS = '2026-09-28T04:00:25.907Z'
const opts = {
  agentId: 'fleet:codex-test',
  sessionId: '01a0e629-f3ce-7de3-b930-ec240a2fa809',
  harnessKind: 'codex',
  terminalChat: false,
  backfillSearch: false,
}

function codexStatusOutputs(record, options = opts) {
  return extractRecordOutputs(options, record).filter(output => output.type === 'codexStatus')
}

test('a task_started record emits one codexStatus turn-open', () => {
  const outputs = codexStatusOutputs({
    timestamp: TS, type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1', root_turn_id: 'turn-1' },
  })
  assert.equal(outputs.length, 1)
  assert.deepEqual(outputs[0].facts, {
    ts: TS, turnId: 'turn-1', turn: 'open', tool: null, callId: null, toolName: null,
  })
})

test('a task_complete record emits one codexStatus turn-close', () => {
  const outputs = codexStatusOutputs({
    timestamp: TS, type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done' },
  })
  assert.equal(outputs.length, 1)
  assert.equal(outputs[0].facts.turn, 'close')
})

test('a tool call emits one codexStatus tool-open; other records emit none', () => {
  const open = codexStatusOutputs({
    timestamp: TS, type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec_command', call_id: 'call-1' },
  })
  assert.equal(open.length, 1)
  assert.equal(open[0].facts.tool, 'open')

  for (const record of [
    { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
    { timestamp: TS, type: 'response_item', payload: { type: 'reasoning' } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { timestamp: TS, type: 'turn_context', payload: { turn_id: 'turn-1' } },
  ]) {
    assert.equal(codexStatusOutputs(record).length, 0, JSON.stringify(record.payload))
  }
})

test('non-codex harnesses emit no codexStatus output', () => {
  const record = {
    timestamp: TS, type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1' },
  }
  assert.equal(codexStatusOutputs(record, { ...opts, harnessKind: 'claude' }).length, 0)
})
