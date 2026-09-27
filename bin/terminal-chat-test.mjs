import assert from 'node:assert/strict'
import test from 'node:test'

import { terminalChatForTail } from '../daemon/jsonl-ingestor.mjs'
import { extractRecordOutputs, terminalChatFromRecord } from './fleet-jsonl-ingester.mjs'

// Typed-text capture defaults on: a harness opts out with an explicit false,
// it is never silently off by omission.
test('terminalChatForTail defaults to capturing typed text', () => {
  assert.equal(terminalChatForTail({}, null), true)
  assert.equal(terminalChatForTail({ terminalChat: true }, null), true)
  assert.equal(terminalChatForTail({ terminalChat: false }, null), false)
  assert.equal(terminalChatForTail({}, { agentId: 'child' }), false)
})

const museOpts = {
  agentId: 'fleet:muse-test',
  sessionId: '01900000-0000-7000-8000-000000000001',
  harnessKind: 'muse',
  terminalChat: true,
  backfillSearch: false,
}

function museUserIntent(text, recordedAt = 1789273076102828) {
  return {
    id: 'user-intent-1',
    recorded_at: recordedAt,
    payload_type: 'runtime.user_intent.accepted',
    payload: { refill_blocks: [{ kind: 'text', text }] },
  }
}

// A typed line in a muse transcript reaches chat, end to end through the
// child ingester's real record path.
test('a typed muse line emits terminalChat', () => {
  const outputs = extractRecordOutputs(museOpts, museUserIntent('hi. i am in config hell'))
  const chat = outputs.find(output => output.type === 'terminalChat')
  assert.ok(chat)
  assert.equal(chat.text, 'hi. i am in config hell')
  assert.equal(chat.ts, '2026-09-13T04:17:56.102Z')
})

// Machine-injected lines are not typed text, whatever the flag says.
test('marked muse lines stay out of terminalChat', () => {
  for (const text of [
    '💻 Call login() with the tlda MCP server.',
    '📬 Check your inbox(). You have a message.',
    '<system-reminder source="x">do the thing',
  ]) {
    const outputs = extractRecordOutputs(museOpts, museUserIntent(text))
    assert.equal(outputs.find(output => output.type === 'terminalChat'), undefined)
  }
})

// Codex user input arrives as event_msg user_message; the parser already
// isolates it from scaffolding, and the flag now lets it through.
test('a codex user message emits terminalChat', () => {
  const outputs = extractRecordOutputs(
    { ...museOpts, harnessKind: 'codex' },
    { type: 'event_msg', timestamp: '2026-09-13T04:17:56.102Z', payload: { type: 'user_message', message: 'why nothing committed?' } },
  )
  const chat = outputs.find(output => output.type === 'terminalChat')
  assert.ok(chat)
  assert.equal(chat.text, 'why nothing committed?')
})

// The Claude path keeps reading the raw record: authorship fields the
// parsed event loses still exclude sidechain briefs and short lines.
test('claude terminalChat behavior is unchanged', () => {
  const rec = (over = {}) => ({
    type: 'user',
    timestamp: '2026-09-13T04:17:56.102Z',
    message: { content: [{ type: 'text', text: 'hello there, ship it' }] },
    ...over,
  })
  assert.equal(terminalChatFromRecord(rec()).text, 'hello there, ship it')
  assert.equal(terminalChatFromRecord(rec({ isSidechain: true })), null)
  assert.equal(terminalChatFromRecord(rec({ message: { content: 'hi' } })), null)
  assert.equal(terminalChatFromRecord(rec({ message: { content: '📬 Check your inbox().' } })), null)
})
