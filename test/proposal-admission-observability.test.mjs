import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('proposal confirmation exposes the durable row state and daemon records it', () => {
  const server = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const daemon = readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')
  for (const field of ['submissionId', 'state', 'startedOnce', 'terminalReason', 'lifecyclePresent']) {
    assert.match(server, new RegExp(`\\b${field}\\b`))
    assert.match(daemon, new RegExp(`admitted\\.${field}`))
  }
})
