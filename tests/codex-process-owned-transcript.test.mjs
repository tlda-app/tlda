import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTranscript } from '../agent-runtime/resolve-transcript.mjs'

test('fresh same-cwd Codex resolution never claims another launch-window rollout', async () => {
  let fallbackCalls = 0
  const sharedNewestRollout = '/tmp/rollout-shared-session.jsonl'
  const resolveFresh = () => resolveTranscript({
    pid: 123,
    kind: 'codex',
    agent: { id: 'fleet:fresh', cwd: '/same/cwd' },
    launchTs: Date.now(),
    processOwnedOnly: true,
    findOpenTranscript: async () => null,
    findFallbackTranscript: () => {
      fallbackCalls += 1
      return sharedNewestRollout
    },
  })

  const [first, second, third] = await Promise.all([resolveFresh(), resolveFresh(), resolveFresh()])
  assert.deepEqual([first, second, third], [null, null, null])
  assert.equal(fallbackCalls, 0)
})

test('non-fresh recovery may still use the launch-window fallback', async () => {
  const path = await resolveTranscript({
    pid: 123,
    kind: 'codex',
    agent: { id: 'fleet:recovery', cwd: '/same/cwd' },
    launchTs: Date.now(),
    findOpenTranscript: async () => null,
    findFallbackTranscript: () => '/tmp/rollout-recovery.jsonl',
  })
  assert.equal(path, '/tmp/rollout-recovery.jsonl')
})
