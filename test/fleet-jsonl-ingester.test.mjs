import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fork } from 'child_process'
import { fileURLToPath } from 'url'

import {
  extractRecordOutputs,
  searchEntriesFromRecord,
  terminalChatFromRecord,
} from '../bin/fleet-jsonl-ingester.mjs'

const INGESTER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fleet-jsonl-ingester.mjs')

function waitFor(predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = predicate()
      if (value) return resolve(value)
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for predicate'))
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

function assistantToolRecord(id, command) {
  return {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      content: [
        { type: 'text', text: `running ${command}` },
        { type: 'tool_use', id, name: 'Bash', input: { command } },
      ],
      usage: { input_tokens: 1000, output_tokens: 10 },
    },
  }
}

test('extractRecordOutputs preserves activity/context/search/terminal event payloads', () => {
  const base = { agentId: 'fleet:a1', sessionId: 'sess1', harnessKind: 'claude', terminalChat: true, backfillSearch: true }
  const assistant = assistantToolRecord('tool-1', 'date')
  const outputs = extractRecordOutputs(base, assistant)
  assert.deepEqual(outputs.map(o => o.type), ['activity', 'context', 'qualification', 'searchIndex'])
  const bashEvent = outputs[0].events.find(e => e.tool === 'Bash')
  assert.equal(bashEvent.arg, 'date')
  assert.equal(outputs[1].contextPercent, 100)
  assert.equal(outputs[3].entries[0].agent_id, 'fleet:a1')

  const user = {
    type: 'user',
    timestamp: '2026-07-04T12:00:00.000Z',
    message: { content: 'hello from terminal' },
  }
  assert.deepEqual(terminalChatFromRecord(user), { text: 'hello from terminal', ts: '2026-07-04T12:00:00.000Z' })
  assert.equal(searchEntriesFromRecord('fleet:a1', 'sess1', user)[0].text, 'hello from terminal')
})

test('forked ingester holds one live-tail batch in flight until parent ack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-jsonl-ingester-'))
  const file = path.join(dir, 'sess1.jsonl')
  const initial = JSON.stringify({ type: 'user', timestamp: '2026-07-04T12:00:00.000Z', message: { content: 'old' } }) + '\n'
  fs.writeFileSync(file, initial)

  const child = fork(INGESTER, [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, TLDA_JSONL_TAIL_POLL_MS: '20' },
  })
  const messages = []
  child.on('message', (m) => messages.push(m))

  try {
    await waitFor(() => messages.find(m => m.type === 'ready'))
    child.send({
      type: 'watch',
      watchId: 'watch-1',
      jsonlPath: file,
      sessionId: 'sess1',
      agentId: 'fleet:a1',
      harnessKind: 'claude',
      startOffset: Buffer.byteLength(initial),
      terminalChat: true,
      backfillSearch: true,
    })
    await waitFor(() => messages.find(m => m.type === 'started'))
    fs.appendFileSync(file, JSON.stringify(assistantToolRecord('tool-1', 'one')) + '\n')
    fs.appendFileSync(file, JSON.stringify(assistantToolRecord('tool-2', 'two')) + '\n')

    const first = await waitFor(() => messages.find(m => m.type === 'batch'))
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(messages.filter(m => m.type === 'batch').length, 1)
    assert.equal(first.outputs.find(o => o.type === 'activity').events.find(e => e.tool === 'Bash').arg, 'one')

    child.send({ type: 'ack', watchId: 'watch-1', seq: first.seq, ok: true })
    const second = await waitFor(() => messages.filter(m => m.type === 'batch').length >= 2 && messages.filter(m => m.type === 'batch')[1])
    assert.equal(second.outputs.find(o => o.type === 'activity').events.find(e => e.tool === 'Bash').arg, 'two')
    child.send({ type: 'ack', watchId: 'watch-1', seq: second.seq, ok: true })
    await waitFor(() => messages.find(m => m.type === 'flush' && m.offset >= fs.statSync(file).size))
  } finally {
    child.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('forked ingester runs search backfill off-main and waits for parent ack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-jsonl-backfill-'))
  const file = path.join(dir, 'sess-backfill.jsonl')
  fs.writeFileSync(file, [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-04T12:00:00.000Z',
      cwd: '/work/tlda',
      toolUseResult: { content: [{ type: 'text', text: 'Registered fleet:abc123. Your name: "daemon-impl".' }] },
      message: { content: 'registration complete' },
    }),
    JSON.stringify({ type: 'user', timestamp: '2026-07-04T12:01:00.000Z', message: { content: 'find this line' } }),
  ].join('\n') + '\n')

  const child = fork(INGESTER, [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const messages = []
  child.on('message', (m) => {
    messages.push(m)
    if (m.type === 'job-batch') child.send({ type: 'job-ack', jobId: m.jobId, seq: m.seq, ok: true })
  })

  try {
    await waitFor(() => messages.find(m => m.type === 'ready'))
    child.send({
      type: 'job',
      jobId: 'search-test',
      jobKind: 'search',
      agentId: 'fleet:abc123',
      sessionId: 'sess-backfill',
      harnessKind: 'claude',
      jsonlPath: file,
    })

    const batch = await waitFor(() => messages.find(m => m.type === 'job-batch'))
    assert.equal(batch.jobId, 'search-test')
    assert.equal(batch.entries.length, 2)
    assert.equal(batch.entries[1].text, 'find this line')

    const complete = await waitFor(() => messages.find(m => m.type === 'job-complete'))
    assert.equal(complete.jobId, 'search-test')
    assert.equal(complete.result.entries, 2)
    assert.deepEqual(complete.result.identities, [{
      session_id: 'sess-backfill',
      harness_kind: 'claude',
      jsonl_path: file,
      fleet_id: 'fleet:abc123',
      friendly_name: 'daemon-impl',
      cwd: '/work/tlda',
    }])
  } finally {
    child.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
