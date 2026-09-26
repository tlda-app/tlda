import assert from 'node:assert/strict'
import test from 'node:test'

import { requireMatchingExecutorRevision } from './build-executor-protocol.mjs'
import { createRemoteTransport } from './build-transport.mjs'

test('remote builds require the executor to run the server revision', () => {
  assert.doesNotThrow(() => requireMatchingExecutorRevision('40eaab617', '40eaab617'))
  assert.throws(
    () => requireMatchingExecutorRevision('40eaab617', 'c7d0b01bef'),
    /executor revision c7d0b01bef does not match server revision 40eaab617/,
  )
  assert.throws(
    () => requireMatchingExecutorRevision('40eaab617', null),
    /did not report a revision/,
  )
})

test('remote transport refuses a stale executor before opening the build socket', async () => {
  let connected = false
  const exited = new Promise(resolve => {
    createRemoteTransport({
      executorUrl: 'ws://executor.example:7711',
      token: 'secret',
      expectedRevision: '40eaab617',
      // No retry here: this test asserts refusal, not the retry loop (which
      // would otherwise spend the whole health budget re-probing a stale host).
      healthRetryBudgetMs: 0,
      readProject: async () => ({ name: 'course', format: 'qmd' }),
      publishedHead: async () => 'published-revision',
      fetchImpl: async url => {
        assert.equal(url, 'http://executor.example:7711/health')
        return new Response(JSON.stringify({ ok: true, protocol: 1, revision: 'c7d0b01bef' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
      connect: () => { connected = true; throw new Error('socket must not open') },
    }).start(
      { name: 'course', kind: 'build', sourceRevision: 'source-revision', acceptSeq: 1 },
      {
        onMessage() {},
        onError() {},
        onExit: (code, signal, output) => resolve({ code, signal, output }),
      },
    )
  })

  const result = await exited
  assert.equal(connected, false)
  assert.equal(result.code, 1)
  assert.match(result.output, /executor revision c7d0b01bef does not match server revision 40eaab617/)
})
