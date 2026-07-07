import assert from 'node:assert/strict'
import test from 'node:test'
import { createActivityExtractor } from '../bin/lib/jsonl-event-extract.mjs'

test('inbox tool_result is captured as a pretty result for activity cards', () => {
  const extractor = createActivityExtractor()
  const prettyText = [
    'INBOX MODE: current-task',
    '',
    'TASK',
    '[task:fleet:b03b-mracxf3i] Inbox visible pretty-printer fix',
    '',
    'DIRECT MESSAGES',
    '[1] [from fleet:releast] Please fix the visible inbox surface',
  ].join('\n')

  const events = extractor.extractActivityEvents([{
    type: 'assistant',
    timestamp: '2026-07-07T08:00:00.000Z',
    blocks: [{
      type: 'tool_use',
      id: 'call-inbox-1',
      name: 'mcp__tlda__inbox',
      input: { view: 'current-task' },
    }],
  }, {
    type: 'user',
    timestamp: '2026-07-07T08:00:01.000Z',
    blocks: [{
      type: 'tool_result',
      id: 'call-inbox-1',
      text: JSON.stringify([{ type: 'text', text: prettyText }]),
    }],
  }])

  assert.equal(events.length, 1)
  assert.equal(events[0].tool, 'tlda/inbox')
  assert.deepEqual(events[0].input, { view: 'current-task' })
  assert.match(events[0].prettyResult, /INBOX MODE: current-task/)
  assert.match(events[0].prettyResult, /Inbox visible pretty-printer fix/)
  assert.doesNotMatch(events[0].prettyResult, /\[\{"type":"text"/)
})

test('slash-form tlda/inbox is also eligible for pretty result capture', () => {
  const extractor = createActivityExtractor()
  const events = extractor.extractActivityEvents([{
    type: 'assistant',
    timestamp: '2026-07-07T08:00:00.000Z',
    blocks: [{
      type: 'tool_use',
      id: 'call-inbox-2',
      name: 'tlda/inbox',
      input: {},
    }, {
      type: 'tool_result',
      id: 'call-inbox-2',
      text: 'INBOX MODE: default\n\nNo unread items.',
    }],
  }])

  assert.equal(events.length, 1)
  assert.equal(events[0].tool, 'tlda/inbox')
  assert.match(events[0].prettyResult, /INBOX MODE: default/)
})
