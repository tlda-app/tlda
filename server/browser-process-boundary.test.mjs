import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createLocalArtifacts } from '../daemon/local-artifacts.mjs'

test('server and daemon expose no browser process-management path', async () => {
  const artifacts = createLocalArtifacts({
    getServerUrl: () => 'http://example.test',
    getFleetServerUrl: () => 'http://example.test',
    resolveAgentCwd: () => null,
  })
  assert.equal('kill-orphan-chromium' in artifacts.handlers, false)

  const server = await readFile(new URL('./unified-server.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(server, /kill-orphan-chromium|reapZombies|REAPER_ZOMBIE_MS/)
  assert.match(server, /ws\.on\('close', cleanup\)/)
  assert.match(server, /ws\.on\('error', cleanup\)/)
  assert.match(server, /\[heartbeat\] terminating unresponsive/)
})
