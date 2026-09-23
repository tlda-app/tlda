import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createMuseServeIngest, museServeOperationStamper } from './muse-serve-ingest.mjs'
import { serveStateDir } from './muse-serve-host.mjs'
import { extractActivityEvents } from '../daemon/activity-events.mjs'
import { activityEventMessage } from './activity-send.mjs'

const completed = item => ({
  jsonrpc: '2.0',
  method: 'item/completed',
  params: { sessionId: 's', item },
})

function toolItem(itemId, callId, tool = 'write_file', extra = {}) {
  return completed({
    itemId, kind: 'toolCall', status: 'completed',
    recordedAt: '2026-09-23T03:12:37Z',
    tool, callId,
    args: '{"content":"done","path":"/tmp/x/probe-out.txt"}',
    visibleOutput: 'wrote 4 bytes to /tmp/x/probe-out.txt',
    ...extra,
  })
}

function rmServeDir(tmuxSession) {
  try {
    rmSync(serveStateDir(tmuxSession), { recursive: true, force: true })
  } catch {
    // Best-effort test cleanup: a leftover tmp serve dir is harmless and
    // must not fail the test that created it.
  }
}

function serveAgent(tmuxSession, id = 'fleet:serve-test') {
  return {
    id,
    tmux_session: tmuxSession,
    metadata: { kind: 'muse' },
  }
}

function writeView(tmuxSession, lines) {
  const dir = serveStateDir(tmuxSession)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'view.jsonl'), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
}

test('the serve stamper stays silent without an agent or record key', () => {
  assert.equal(museServeOperationStamper({ recordKey: 'r1' }), undefined)
  assert.equal(museServeOperationStamper({ agentId: 'fleet:x' }), undefined)
  assert.equal(museServeOperationStamper({ agentId: 'fleet:x', recordKey: '' }), undefined)
  const stamper = museServeOperationStamper({ agentId: 'fleet:x', recordKey: 'msp:terminal:call_1' })
  assert.equal(stamper.operationIdFor(0), 'muse-serve:fleet:x:msp:terminal:call_1:0')
  assert.equal(stamper.operationIdFor(2), 'muse-serve:fleet:x:msp:terminal:call_1:2')
})

test('one view.jsonl tool call ingests one stamped activity row', () => {
  const tmux = `serve-ingest-stamp-${process.pid}-${Date.now()}`
  const agentId = `fleet:serve-stamp-${Date.now()}`
  writeView(tmux, [toolItem('i1', `stamp-call-${Date.now()}`)])
  const buffered = []
  const ingest = createMuseServeIngest({
    bufferActivity: (id, evts) => buffered.push([id, evts]),
    log: { warn() {} },
  })
  ingest.sync([serveAgent(tmux, agentId)])
  assert.equal(buffered.length, 1)
  assert.equal(buffered[0][0], agentId)
  assert.equal(buffered[0][1].length, 1)
  assert.match(buffered[0][1][0].operationId || '', /^muse-serve:/)
  assert.equal(buffered[0][1][0].tool, 'Write')
  rmServeDir(tmux)
})

test('re-reading the same view.jsonl bytes stamps the same identity (server dedupes)', () => {
  const tmux = `serve-ingest-replay-${process.pid}-${Date.now()}`
  const agentId = `fleet:serve-replay-${Date.now()}`
  const callId = `replay-call-${Date.now()}`
  writeView(tmux, [toolItem('i9', callId)])
  const first = []
  const ingestA = createMuseServeIngest({
    bufferActivity: (id, evts) => first.push([id, evts]),
    log: { warn() {} },
  })
  ingestA.sync([serveAgent(tmux, agentId)])
  assert.equal(first.length, 1)
  const firstId = first[0][1][0].operationId

  // A fresh ingest (restart: cursors reset) re-reads the same bytes and must
  // derive the same identity, so the server's activity duplicate guard
  // collapses the replay to the one stored row.
  const second = []
  const ingestB = createMuseServeIngest({
    bufferActivity: (id, evts) => second.push([id, evts]),
    log: { warn() {} },
  })
  ingestB.sync([serveAgent(tmux, agentId)])
  assert.equal(second.length, 1)
  assert.equal(second[0][1][0].operationId, firstId)

  // The wire carries the identity exactly as the backfill path does.
  const msg = activityEventMessage(agentId, second[0][1][0])
  assert.equal(msg.operation_id, firstId)
  rmServeDir(tmux)
})

test('counterfactual: without the stamper the same bytes carry no identity (server would store twice)', () => {
  const ev = {
    type: 'assistant',
    timestamp: '2026-09-23T03:12:37.000Z',
    blocks: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/x' }, id: 'call-cf', status: 'completed', correlationId: 'call-cf' }],
  }
  const unstamped = extractActivityEvents([structuredClone(ev)])
  assert.equal(unstamped.length, 1)
  assert.ok(!('operationId' in unstamped[0]))
  assert.ok(!('operation_id' in activityEventMessage('fleet:x', unstamped[0])))
  const stamped = extractActivityEvents([structuredClone(ev)], museServeOperationStamper({ agentId: 'fleet:x', recordKey: 'msp:terminal:call-cf' }))
  assert.equal(stamped[0].operationId, 'muse-serve:fleet:x:msp:terminal:call-cf:0')
  assert.equal(activityEventMessage('fleet:x', stamped[0]).operation_id, stamped[0].operationId)
})

test('a durable-tailed agent advances past serve bytes without emitting', () => {
  const tmux = `serve-ingest-suppress-${process.pid}-${Date.now()}`
  const agentId = `fleet:serve-suppress-${Date.now()}`
  const callId = `suppress-call-${Date.now()}`
  writeView(tmux, [toolItem('i5', callId)])
  const buffered = []
  let durableTailed = true
  const ingest = createMuseServeIngest({
    bufferActivity: (id, evts) => buffered.push([id, evts]),
    log: { warn() {} },
    isDurableTailed: () => durableTailed,
  })
  ingest.sync([serveAgent(tmux, agentId)])
  assert.deepEqual(buffered, [])

  // The cursor advanced past the suppressed bytes: dropping the suppression
  // (durable outage) with no new bytes stays silent rather than re-emitting
  // rows the durable tail already delivered.
  durableTailed = false
  ingest.sync([serveAgent(tmux, agentId)])
  assert.deepEqual(buffered, [])

  // New bytes after the outage emit exactly once, stamped.
  appendFileSync(path.join(serveStateDir(tmux), 'view.jsonl'), `${JSON.stringify(toolItem('i6', `${callId}-b`))}\n`)
  ingest.sync([serveAgent(tmux, agentId)])
  assert.equal(buffered.length, 1)
  assert.match(buffered[0][1][0].operationId || '', /^muse-serve:/)
  rmServeDir(tmux)
})

test('a deferred serve pretty card keeps the terminal creation identity', () => {
  const tmux = `serve-ingest-deferred-${process.pid}-${Date.now()}`
  const agentId = `fleet:serve-deferred-${Date.now()}`
  const callId = `deferred-call-${Date.now()}`
  writeView(tmux, [toolItem('i7', callId, 'mcp__tlda__screenshot', {
    args: '{}',
    visibleOutput: 'screenshot body',
  })])
  const buffered = []
  const ingest = createMuseServeIngest({
    bufferActivity: (id, evts) => buffered.push([id, evts]),
    log: { warn() {} },
  })
  ingest.sync([serveAgent(tmux, agentId)])
  const rows = buffered.flatMap(([, evts]) => evts)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].operationId, `muse-serve:${agentId}:msp:terminal:${callId}:0`)
  assert.match(rows[0].prettyResult || '', /screenshot body/)
  rmServeDir(tmux)
})

test('a failing predicate never suppresses the serve feed', () => {
  const tmux = `serve-ingest-predfail-${process.pid}-${Date.now()}`
  const agentId = `fleet:serve-predfail-${Date.now()}`
  writeView(tmux, [toolItem('i8', `predfail-call-${Date.now()}`)])
  const buffered = []
  const ingest = createMuseServeIngest({
    bufferActivity: (id, evts) => buffered.push([id, evts]),
    log: { warn() {} },
    isDurableTailed: () => { throw new Error('ownership lookup down') },
  })
  ingest.sync([serveAgent(tmux, agentId)])
  assert.equal(buffered.length, 1)
  rmServeDir(tmux)
})
