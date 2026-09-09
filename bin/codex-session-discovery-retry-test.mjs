#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolveLiveSessionIdentityUntil } from '../agent-launch/harness/codex.mjs'

{
  let time = 0
  let calls = 0
  const sleeps = []
  const exact = { sessionId: 'session-exact', jsonlPath: '/sessions/exact.jsonl' }
  const result = await resolveLiveSessionIdentityUntil({
    deadlineMs: 500,
    intervalMs: 100,
    now: () => time,
    sleep: async ms => { sleeps.push(ms); time += ms },
    isProcessAlive: async () => true,
    resolve: async () => (++calls < 3 ? null : exact),
  })
  assert.deepEqual(result, exact)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [100, 100])
}

{
  let time = 0
  let calls = 0
  const result = await resolveLiveSessionIdentityUntil({
    deadlineMs: 200,
    intervalMs: 100,
    now: () => time,
    sleep: async ms => { time += ms },
    isProcessAlive: async () => true,
    resolve: async () => { calls += 1; return null },
  })
  assert.equal(result, null)
  assert.equal(calls, 3)
  time += 1000
  assert.equal(calls, 3, 'deadline completion must not record later')
}

{
  let calls = 0
  const result = await resolveLiveSessionIdentityUntil({
    deadlineMs: 500,
    isProcessAlive: async () => false,
    resolve: async () => { calls += 1; return { sessionId: 'must-not-record' } },
  })
  assert.equal(result, null)
  assert.equal(calls, 0)
}

console.log('codex session discovery retry: ok')
