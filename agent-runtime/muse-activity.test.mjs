import assert from 'node:assert/strict'
import test from 'node:test'

import { createMuseRecordParser, museLoginMarkerFromRecord } from './muse-activity.mjs'
import { createActivityExtractor } from './jsonl-event-extract.mjs'

function record(payloadType, payload, recordedAt = 1789273076102828) {
  return { id: 'record-id', recorded_at: recordedAt, payload_type: payloadType, payload }
}

test('a tool call ingests one row: started records are dropped, the terminal carries the outcome', () => {
  const parse = createMuseRecordParser()
  assert.equal(parse(record('runtime.session', {
    kind: 'run',
    event: {
      kind: 'assistant_tool_calls_committed',
      tool_calls: [{ call_id: 'call-1', name: 'read_file', args: '{"path":"AGENTS.md"}' }],
    },
  })), null)

  assert.equal(parse(record('tool_batch.effect.started', {
    record: { kind: 'started', call_id: 'call-1', tool_name: 'read_file' },
  })), null)

  const completed = parse(record('tool_batch.effect.terminal', {
    record: { kind: 'terminal', call_id: 'call-1', outcome: { kind: 'completed' } },
  }))
  assert.deepEqual(completed.blocks[0], {
    type: 'tool_use',
    name: 'Read',
    input: { path: 'AGENTS.md' },
    id: 'call-1',
    status: 'completed',
    correlationId: 'call-1',
  })
})

test('commit, started, terminal, and result batch extract to exactly one activity event', () => {
  const parse = createMuseRecordParser()
  const extractor = createActivityExtractor()
  const records = [
    record('runtime.session', {
      kind: 'run',
      event: {
        kind: 'assistant_tool_calls_committed',
        tool_calls: [{ call_id: 'call-chain', name: 'read_file', args: '{"path":"AGENTS.md"}' }],
      },
    }),
    record('tool_batch.effect.started', {
      record: { kind: 'started', call_id: 'call-chain', tool_name: 'read_file' },
    }),
    record('tool_batch.effect.terminal', {
      record: { kind: 'terminal', call_id: 'call-chain', outcome: { kind: 'completed' } },
    }),
    record('runtime.session', {
      kind: 'run',
      event: {
        kind: 'tool_result_batch_committed',
        results: [{ tool_call_id: 'call-chain', tool_call_index: 0, text: 'file contents here' }],
      },
    }),
  ]
  const events = []
  for (const rec of records) {
    const ev = parse(rec)
    if (ev) events.push(...extractor.extractActivityEvents([ev]))
  }
  assert.equal(events.length, 1)
  assert.equal(events[0].tool, 'Read')
  assert.equal(events[0].status, 'completed')
  assert.equal(events[0].correlationId, 'call-chain')
})

test('the shared Muse record vocabulary parses in both observed versions', () => {
  for (const version of ['1.1.1', '1.2.1']) {
    const parse = createMuseRecordParser()
    const user = parse(record('runtime.user_intent.accepted', {
      refill_blocks: [{ kind: 'text', text: `prompt from ${version}` }],
    }))
    assert.equal(user.blocks[0].text, `prompt from ${version}`)
    const assistant = parse(record('runtime.session', {
      kind: 'run',
      event: { kind: 'assistant_message_committed', text: `answer from ${version}` },
    }))
    assert.equal(assistant.blocks[0].text, `answer from ${version}`)
  }
})

test('a failed terminal record emits an error update', () => {
  const parse = createMuseRecordParser()
  const failed = parse(record('tool_batch.effect.terminal', {
    record: { call_id: 'call-failed', tool_name: 'bash', outcome: { kind: 'failed', reason: 'bad command' } },
  }))
  assert.equal(failed.blocks[0].name, 'Bash')
  assert.equal(failed.blocks[0].status, 'error')
})

test('an unpaired terminal record is not mislabeled as an unknown tool', () => {
  const parse = createMuseRecordParser()
  assert.equal(parse(record('tool_batch.effect.terminal', {
    record: { call_id: 'pre-restart-call', outcome: { kind: 'completed' } },
  })), null)
})

test('result batches emit tool_result blocks keyed by call id', () => {
  const parse = createMuseRecordParser()
  const out = parse(record('runtime.session', {
    kind: 'run',
    event: {
      kind: 'tool_result_batch_committed',
      results: [
        { tool_call_id: 'call-9', tool_call_index: 0, text: 'file contents here' },
        { tool_call_index: 1, text: 'orphan without id' },
      ],
    },
  }))
  assert.equal(out.type, 'user')
  assert.deepEqual(out.blocks, [
    { type: 'tool_result', id: 'call-9', text: 'file contents here', is_error: false },
  ])
})

test('historical ownership requires a committed Muse login result', () => {
  const marker = 'TLDA_LOGIN_MARKER {"type":"tlda-login-marker","version":1,"fleet_id":"fleet:historical","harness_kind":"muse"}'
  assert.equal(museLoginMarkerFromRecord(record('runtime.user_intent.accepted', {
    refill_blocks: [{ kind: 'text', text: marker }],
  })), null)
  assert.equal(museLoginMarkerFromRecord(record('runtime.session', {
    kind: 'run',
    event: { kind: 'assistant_message_committed', text: marker },
  })), null)
  assert.equal(museLoginMarkerFromRecord(record('runtime.session', {
    kind: 'run',
    event: { kind: 'tool_result_batch_committed', results: [{ text: marker }] },
  }))?.fleet_id, 'fleet:historical')
})
