import assert from 'node:assert/strict'
import test from 'node:test'
import { mspViewNotificationToParserRecords } from './muse-serve-events.mjs'
import { createMuseRecordParser } from './muse-activity.mjs'
import { extractActivityEvents } from '../daemon/activity-events.mjs'

const completed = item => ({
  jsonrpc: '2.0',
  method: 'item/completed',
  params: { sessionId: 's', item },
})

test('agentMessage completion maps to assistant text the parser keeps', () => {
  const parse = createMuseRecordParser()
  const records = mspViewNotificationToParserRecords(completed({
    itemId: 'i1', kind: 'agentMessage', status: 'completed',
    recordedAt: '2026-09-23T03:12:37Z', text: 'done, file written',
  }))
  assert.equal(records.length, 1)
  const ev = parse(records[0])
  assert.equal(ev.type, 'assistant')
  assert.equal(ev.blocks[0].text, 'done, file written')
  const activity = extractActivityEvents([ev])
  assert.deepEqual(activity.map(a => a.tool), ['_text'])
})

test('toolCall completion maps to a tool_use event with name, input, status', () => {
  const parse = createMuseRecordParser()
  const records = mspViewNotificationToParserRecords(completed({
    itemId: 'i2', kind: 'toolCall', status: 'completed',
    recordedAt: '2026-09-23T03:12:37Z',
    tool: 'write_file', callId: 'call_1',
    args: '{"content":"done","path":"/tmp/x/probe-out.txt"}',
    visibleOutput: 'wrote 4 bytes to /tmp/x/probe-out.txt',
  }))
  assert.equal(records.length, 3)
  const parsed = records.map(r => parse(r)).filter(Boolean)
  const toolUses = parsed.flatMap(ev => ev.blocks.filter(b => b.type === 'tool_use'))
  assert.equal(toolUses.length, 1)
  assert.equal(toolUses[0].name, 'Write')
  assert.equal(toolUses[0].input.file_path, '/tmp/x/probe-out.txt')
  assert.equal(toolUses[0].status, 'completed')
  const results = parsed.flatMap(ev => ev.blocks.filter(b => b.type === 'tool_result'))
  assert.equal(results.length, 1)
  assert.match(results[0].text, /wrote 4 bytes/)
})

test('failed toolCall maps to error status and keeps the failure text', () => {
  const parse = createMuseRecordParser()
  const records = mspViewNotificationToParserRecords(completed({
    itemId: 'i3', kind: 'toolCall', status: 'failed',
    recordedAt: '2026-09-23T03:12:19Z',
    tool: 'read_file', callId: 'call_2',
    args: '{"path":"/tmp/missing.txt"}',
    failureReason: 'No such file or directory (os error 2)',
    visibleOutput: 'tool failed: No such file or directory (os error 2)',
  }))
  const parsed = records.map(r => parse(r)).filter(Boolean)
  const toolUse = parsed.flatMap(ev => ev.blocks.filter(b => b.type === 'tool_use'))[0]
  assert.equal(toolUse.name, 'Read')
  assert.equal(toolUse.status, 'error')
  const result = parsed.flatMap(ev => ev.blocks.filter(b => b.type === 'tool_result'))[0]
  assert.match(result.text, /No such file/)
  assert.equal(result.is_error, true)
})

test('only completions map: started/updated/turn/userMessage/child rows drop', () => {
  assert.deepEqual(mspViewNotificationToParserRecords({ method: 'item/started', params: { item: { kind: 'toolCall' } } }), [])
  assert.deepEqual(mspViewNotificationToParserRecords({ method: 'item/updated', params: { item: { kind: 'toolCall' } } }), [])
  assert.deepEqual(mspViewNotificationToParserRecords({ method: 'turn/completed', params: { terminal: 'completed' } }), [])
  assert.deepEqual(mspViewNotificationToParserRecords(completed({ itemId: 'u', kind: 'userMessage', text: 'our own turn input' })), [])
  assert.deepEqual(mspViewNotificationToParserRecords(completed({ itemId: 'r', kind: 'reminderChild', fallbackText: 'Reminder child session' })), [])
})
