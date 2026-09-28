import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MUSE_HISTORY_YIELD_EVERY_RECORDS, collectMuseHistoricalSessions, extractRecordOutputs, museHistoryOperationStamper } from './fleet-jsonl-ingester.mjs'
import { activityEventMessage } from '../agent-runtime/activity-send.mjs'
import { sessionIdForJsonlPath } from '../daemon/jsonl-ingestor.mjs'

const opts = {
  agentId: 'fleet:muse-test',
  sessionId: '01900000-0000-7000-8000-000000000001',
  harnessKind: 'muse',
  terminalChat: false,
  backfillSearch: false,
}

test('the JSONL child ingests one Muse activity row per tool call', () => {
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
  assert.deepEqual(extractRecordOutputs(opts, started), [])

  const terminal = {
    recorded_at: 1789273076102828,
    payload_type: 'tool_batch.effect.terminal',
    payload: { record: { call_id: 'muse-wire-call', tool_name: 'bash', outcome: { kind: 'completed' } } },
  }
  const activity = extractRecordOutputs(opts, terminal).find(output => output.type === 'activity')
  assert.ok(activity)
  assert.equal(activity.events.length, 1)
  assert.deepEqual(activity.events[0], {
    tool: 'Bash',
    arg: 'git status --short',
    ts: '2026-09-13T04:17:56.102Z',
    id: 'muse-wire-call',
    status: 'completed',
    correlationId: 'muse-wire-call',
    input: { command: 'git status --short' },
  })
})

test('the JSONL child emits the login identity from a live Muse tool result', () => {
  const marker = {
    type: 'tlda-login-marker',
    version: 1,
    fleet_id: 'fleet:muse-test',
    harness_kind: 'muse',
    daemon_key: 'mini:testing',
  }
  const record = {
    recorded_at: 1789273076000000,
    payload_type: 'runtime.session',
    payload: {
      kind: 'run',
      event: {
        kind: 'tool_result_batch_committed',
        results: [{ text: `TLDA_LOGIN_MARKER ${JSON.stringify(marker)}\nLogged in fleet:muse-test.` }],
      },
    },
  }

  assert.deepEqual(
    extractRecordOutputs(opts, record).find(output => output.type === 'identity'),
    { type: 'identity', identity: { marker } },
  )
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

const LIVE_SESSION_ID = '01900000-0000-7000-8000-000000000001'
const liveOpts = {
  ...opts,
  jsonlPath: `/Users/example/.local/share/muse/sessions/2026/09/13/${LIVE_SESSION_ID}/session.jsonl`,
}

function committedRecord(id, callId, name, args) {
  return {
    id,
    recorded_at: 1789273076000000,
    payload_type: 'runtime.session',
    payload: {
      kind: 'run',
      event: {
        kind: 'assistant_tool_calls_committed',
        tool_calls: [{ call_id: callId, name, args }],
      },
    },
  }
}

function terminalRecord(id, callId, toolName) {
  return {
    id,
    recorded_at: 1789273076102828,
    payload_type: 'tool_batch.effect.terminal',
    payload: { record: { call_id: callId, tool_name: toolName, outcome: { kind: 'completed' } } },
  }
}

function resultBatchRecord(id, callId, text) {
  return {
    id,
    recorded_at: 1789273076200000,
    payload_type: 'runtime.session',
    payload: {
      kind: 'run',
      event: { kind: 'tool_result_batch_committed', results: [{ tool_call_id: callId, text }] },
    },
  }
}

function liveActivityFor(records) {
  let activity = null
  for (const record of records) {
    activity = extractRecordOutputs(liveOpts, record).find(output => output.type === 'activity') || activity
  }
  return activity
}

test('a live Muse tail stamps the same operation identity the backfill derives', () => {
  const activity = liveActivityFor([
    committedRecord('live-stamp-commit', 'live-stamp-call', 'bash', '{"command":"echo hi"}'),
    terminalRecord('live-stamp-terminal', 'live-stamp-call', 'bash'),
  ])
  assert.ok(activity)
  assert.equal(activity.events.length, 1)
  assert.equal(
    activity.events[0].operationId,
    `muse-history:${LIVE_SESSION_ID}:live-stamp-terminal:0`,
  )
})

test('the live tail and the backfill stamp one record with one identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muse-history-parity-'))
  const marker = 'TLDA_LOGIN_MARKER {"type":"tlda-login-marker","version":1,"fleet_id":"fleet:parity","harness_kind":"muse"}'
  try {
    const dir = join(root, '2026', '09', '13', LIVE_SESSION_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), [
      museRecord('parity-commit', 'runtime.session', {
        kind: 'run',
        event: {
          kind: 'assistant_tool_calls_committed',
          tool_calls: [{ call_id: 'parity-call', name: 'bash', args: '{"command":"echo parity"}' }],
        },
      }),
      museRecord('parity-terminal', 'tool_batch.effect.terminal', {
        record: { call_id: 'parity-call', tool_name: 'bash', outcome: { kind: 'completed' } },
      }),
      museRecord('parity-marker', 'runtime.session', {
        kind: 'run', event: { kind: 'tool_result_batch_committed', results: [{ text: marker }] },
      }),
    ].join('\n') + '\n')
    const { batches } = await collectMuseHistoricalSessions({ sessionsRoot: root, sessionIndexPath: null })
    assert.equal(batches.length, 1)
    assert.equal(batches[0].events.length, 1)
    const backfillId = batches[0].events[0].operationId

    const live = liveActivityFor([
      committedRecord('parity-commit', 'parity-live-call', 'bash', '{"command":"echo parity"}'),
      terminalRecord('parity-terminal', 'parity-live-call', 'bash'),
    ])
    assert.ok(live)
    assert.equal(live.events.length, 1)
    assert.equal(live.events[0].operationId, backfillId)
    assert.equal(backfillId, `muse-history:${LIVE_SESSION_ID}:parity-terminal:0`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a deferred pretty card keeps the tool-use record identity on both paths', async () => {
  const live = liveActivityFor([
    committedRecord('pretty-commit', 'pretty-stamp-call', 'mcp__tlda__screenshot', '{}'),
    terminalRecord('pretty-terminal', 'pretty-stamp-call', 'mcp__tlda__screenshot'),
    resultBatchRecord('pretty-result', 'pretty-stamp-call', 'screenshot body'),
  ])
  assert.ok(live)
  assert.equal(live.events.length, 1)
  assert.equal(
    live.events[0].operationId,
    `muse-history:${LIVE_SESSION_ID}:pretty-terminal:0`,
  )
  assert.match(live.events[0].prettyResult || '', /screenshot body/)

  const root = mkdtempSync(join(tmpdir(), 'muse-history-deferred-'))
  const marker = 'TLDA_LOGIN_MARKER {"type":"tlda-login-marker","version":1,"fleet_id":"fleet:deferred","harness_kind":"muse"}'
  try {
    const dir = join(root, '2026', '09', '13', LIVE_SESSION_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), [
      museRecord('pretty-commit', 'runtime.session', {
        kind: 'run',
        event: {
          kind: 'assistant_tool_calls_committed',
          tool_calls: [{ call_id: 'pretty-backfill-call', name: 'mcp__tlda__screenshot', args: '{}' }],
        },
      }),
      museRecord('pretty-terminal', 'tool_batch.effect.terminal', {
        record: { call_id: 'pretty-backfill-call', tool_name: 'mcp__tlda__screenshot', outcome: { kind: 'completed' } },
      }),
      museRecord('pretty-result', 'runtime.session', {
        kind: 'run',
        event: { kind: 'tool_result_batch_committed', results: [{ tool_call_id: 'pretty-backfill-call', text: 'screenshot body' }] },
      }),
      museRecord('deferred-marker', 'runtime.session', {
        kind: 'run', event: { kind: 'tool_result_batch_committed', results: [{ text: marker }] },
      }),
    ].join('\n') + '\n')
    const { batches } = await collectMuseHistoricalSessions({ sessionsRoot: root, sessionIndexPath: null })
    assert.equal(batches.length, 1)
    assert.equal(batches[0].events.length, 1)
    assert.equal(batches[0].events[0].operationId, live.events[0].operationId)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the muse stamper stays silent without a harness, path, or record key', () => {
  assert.equal(
    museHistoryOperationStamper({ harnessKind: 'claude', jsonlPath: liveOpts.jsonlPath, recordKey: 'r1' }),
    undefined,
  )
  assert.equal(museHistoryOperationStamper({ harnessKind: 'muse', recordKey: 'r1' }), undefined)
  assert.equal(
    museHistoryOperationStamper({ harnessKind: 'muse', jsonlPath: liveOpts.jsonlPath }),
    undefined,
  )
  const stamper = museHistoryOperationStamper({
    harnessKind: 'muse', jsonlPath: liveOpts.jsonlPath, recordKey: 'r1',
  })
  assert.equal(stamper.operationIdFor(0), `muse-history:${LIVE_SESSION_ID}:r1:0`)
  assert.equal(stamper.operationIdFor(2), `muse-history:${LIVE_SESSION_ID}:r1:2`)
})

test('Muse history imports only self-identifying parents and reports every skipped class', async () => {
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
    const first = await collectMuseHistoricalSessions({ sessionsRoot: root, indexRows })
    const second = await collectMuseHistoricalSessions({ sessionsRoot: root, indexRows })
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

test('the muse history walk yields to the event loop instead of wedging the child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muse-history-yield-'))
  try {
    const dir = join(root, '2026', '09', '13', 'yield-session')
    mkdirSync(dir, { recursive: true })
    const records = []
    for (let i = 0; i < MUSE_HISTORY_YIELD_EVERY_RECORDS + 50; i += 1) {
      records.push(museRecord(`yield-commit-${i}`, 'runtime.session', {
        kind: 'run',
        event: {
          kind: 'assistant_tool_calls_committed',
          tool_calls: [{ call_id: `yield-call-${i}`, name: 'bash', args: '{}' }],
        },
      }))
      records.push(museRecord(`yield-terminal-${i}`, 'tool_batch.effect.terminal', {
        record: { call_id: `yield-call-${i}`, tool_name: 'bash', outcome: { kind: 'completed' } },
      }))
    }
    writeFileSync(join(dir, 'session.jsonl'), `${records.join('\n')}\n`)
    let ticked = false
    const pending = collectMuseHistoricalSessions({ sessionsRoot: root, sessionIndexPath: null })
    setImmediate(() => { ticked = true })
    const { census } = await pending
    assert.equal(census.sessionsWalked, 1)
    assert.ok(ticked, 'a setImmediate scheduled mid-walk must run before the walk finishes')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
