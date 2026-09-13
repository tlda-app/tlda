import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectMuseHistoricalSessions, extractRecordOutputs } from './fleet-jsonl-ingester.mjs'
import { activityEventMessage } from '../agent-runtime/activity-send.mjs'
import { sessionIdForJsonlPath } from '../daemon/jsonl-ingestor.mjs'

const opts = {
  agentId: 'fleet:muse-test',
  sessionId: '01900000-0000-7000-8000-000000000001',
  harnessKind: 'muse',
  terminalChat: false,
  backfillSearch: false,
}

test('the JSONL child sends Muse tool records through the shared activity extractor', () => {
  const committed = {
    recorded_at: 1789273076000000,
    payload_type: 'runtime.session',
    payload: {
      kind: 'run',
      event: {
        kind: 'assistant_tool_calls_committed',
        tool_calls: [{ call_id: 'muse-wire-call', name: 'bash', args: '{"command":"git status --short"}' }],
      },
    },
  }
  assert.deepEqual(extractRecordOutputs(opts, committed), [])

  const started = {
    recorded_at: 1789273076102828,
    payload_type: 'tool_batch.effect.started',
    payload: { record: { call_id: 'muse-wire-call', tool_name: 'bash' } },
  }
  const activity = extractRecordOutputs(opts, started).find(output => output.type === 'activity')
  assert.ok(activity)
  assert.deepEqual(activity.events[0], {
    tool: 'Bash',
    arg: 'git status --short',
    ts: '2026-09-13T04:17:56.102Z',
    id: 'muse-wire-call',
    status: 'started',
    correlationId: 'muse-wire-call',
    input: { command: 'git status --short' },
  })
})

test('a Muse session tail keys identity from its session directory, never the common filename', () => {
  const sessionId = '01900000-0000-7000-8000-000000000001'
  assert.equal(
    sessionIdForJsonlPath('/Users/example/.local/share/muse/sessions/2026/09/13/01900000-0000-7000-8000-000000000001/session.jsonl', {
      session_id: sessionId,
    }),
    sessionId,
  )
  assert.equal(
    sessionIdForJsonlPath('/Users/example/.local/share/muse/sessions/2026/09/13/01900000-0000-7000-8000-000000000001/session.jsonl', null, 'muse'),
    sessionId,
  )
  assert.notEqual(
    sessionIdForJsonlPath('/Users/example/.local/share/muse/sessions/2026/09/13/01900000-0000-7000-8000-000000000001/session.jsonl', null, 'muse'),
    'session',
  )
})

function museRecord(id, payloadType, payload) {
  return JSON.stringify({ id, recorded_at: 1789273076102828, payload_type: payloadType, payload })
}

test('Muse history imports only self-identifying parents and reports every skipped class', () => {
  const root = mkdtempSync(join(tmpdir(), 'muse-history-'))
  const writeSession = (id, records, suffix = '') => {
    const dir = join(root, '2026', '09', '13', id, suffix)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), `${records.join('\n')}\n`)
  }
  const marker = 'TLDA_LOGIN_MARKER {"type":"tlda-login-marker","version":1,"fleet_id":"fleet:historical","harness_kind":"muse"}'
  try {
    writeSession('identified', [
      museRecord('prompt-record', 'runtime.user_intent.accepted', { refill_blocks: [{ kind: 'text', text: 'real work' }] }),
      museRecord('marker-record', 'runtime.session', { kind: 'run', event: { kind: 'tool_result_batch_committed', results: [{ text: marker }] } }),
      museRecord('answer-record', 'runtime.session', { kind: 'run', event: { kind: 'assistant_message_committed', text: 'historical answer' } }),
    ])
    writeSession('probe', [museRecord('probe-record', 'runtime.user_intent.accepted', { refill_blocks: [{ kind: 'text', text: 'MUSE_ECHO_CONTROL' }] })])
    writeSession('no-prompt', [])
    writeSession('unidentified-launch', [museRecord('launch-record', 'runtime.user_intent.accepted', { refill_blocks: [{ kind: 'text', text: '💻 Call mcp__tlda__login exactly once' }] })])
    writeSession('child', [museRecord('child-record', 'runtime.user_intent.accepted', { refill_blocks: [{ kind: 'text', text: 'child' }] })], join('subagent', 'child-id'))
    const indexRows = [
      { session_id: 'identified', prompt_count: 1, first_user_prompt: 'real work' },
      { session_id: 'probe', prompt_count: 1, first_user_prompt: 'MUSE_ECHO_CONTROL' },
      { session_id: 'no-prompt', prompt_count: 0, first_user_prompt: null },
      { session_id: 'unidentified-launch', prompt_count: 1, first_user_prompt: '💻 Call mcp__tlda__login exactly once' },
    ]
    const first = collectMuseHistoricalSessions({ sessionsRoot: root, indexRows })
    const second = collectMuseHistoricalSessions({ sessionsRoot: root, indexRows })
    assert.deepEqual(first.census, {
      sessionsWalked: 5,
      ingested: 1,
      skippedSubagent: 1,
      skippedProbe: 1,
      skippedNoPrompt: 1,
      skippedAgentLaunchWithoutIdentity: 1,
      activityEvents: 1,
    })
    assert.equal(first.batches[0].agentId, 'fleet:historical')
    assert.equal(first.batches[0].events[0].operationId, 'muse-history:identified:answer-record:0')
    assert.deepEqual(
      Object.fromEntries(Object.entries(activityEventMessage('fleet:historical', {
        ...first.batches[0].events[0], historical: true,
      })).filter(([key]) => ['agent_id', 'operation_id', 'historical'].includes(key))),
      { agent_id: 'fleet:historical', operation_id: 'muse-history:identified:answer-record:0', historical: true },
    )
    assert.deepEqual(second, first, 'rerunning derives the same events and operation identities')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
