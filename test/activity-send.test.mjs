import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendActivityEvents } from '../bin/lib/activity-send.mjs'

test('sends each activity immediately in order', () => {
  const sent = []
  const ok = sendActivityEvents('fleet:a', [
    { tool: 'Read', arg: 'a', ts: '2026-06-22T00:00:00.000Z' },
    { tool: 'Edit', input: { file: 'x' }, ts: '2026-06-22T00:00:01.000Z', prettyResult: 'changed' },
  ], msg => { sent.push(msg); return true })

  assert.equal(ok, true)
  assert.deepEqual(sent.map(msg => msg.tool), ['Read', 'Edit'])
  assert.equal(sent[0].type, 'activity-event')
  assert.equal(sent[0].agent_id, 'fleet:a')
  assert.equal(sent[1].prettyResult, 'changed')
})

test('returns false on first failed send so JSONL cursor is not advanced', () => {
  const sent = []
  const ok = sendActivityEvents('fleet:a', [
    { tool: 'Read', ts: '2026-06-22T00:00:00.000Z' },
    { tool: 'Edit', ts: '2026-06-22T00:00:01.000Z' },
    { tool: 'Bash', ts: '2026-06-22T00:00:02.000Z' },
  ], msg => {
    sent.push(msg)
    return msg.tool !== 'Edit'
  })

  assert.equal(ok, false)
  assert.deepEqual(sent.map(msg => msg.tool), ['Read', 'Edit'])
})
