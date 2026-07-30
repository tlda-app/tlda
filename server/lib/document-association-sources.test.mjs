import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readSharedDocumentThroughOwner } from './document-association-sources.mjs'
import { createLocalArtifacts } from '../../daemon/local-artifacts.mjs'

test('shared document route absence fails without reading a server-local lookalike', async () => {
  let daemonCalls = 0
  await assert.rejects(
    readSharedDocumentThroughOwner({
      fleetStore: { getAgentDaemonRoute: async () => null },
      sendDaemonEphemeral: async () => { daemonCalls += 1 },
      document: { id: 'shared-1', authorId: 'fleet:missing', path: '/same/name.md' },
    }),
    error => error.code === 'NO_ROUTE',
  )
  assert.equal(daemonCalls, 0)
})

test('owning daemon reads shared text relative to the routed agent cwd', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tlda-document-owner-'))
  try {
    writeFileSync(join(cwd, 'note.md'), 'daemon-owned spectral note')
    const artifacts = createLocalArtifacts({
      getServerUrl: () => 'http://unused',
      getFleetServerUrl: () => 'http://unused',
      resolveAgentCwd: agentId => agentId === 'fleet:owner' ? cwd : null,
    })
    assert.deepEqual(
      await artifacts.handlers['read-document-text']({ agent_id: 'fleet:owner', path: 'note.md' }),
      { text: 'daemon-owned spectral note' },
    )
    await assert.rejects(
      artifacts.handlers['read-document-text']({ agent_id: 'fleet:other', path: 'note.md' }),
      /agent cwd unavailable/,
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('shared document text is requested from the owning daemon route', async () => {
  const calls = []
  const result = await readSharedDocumentThroughOwner({
    fleetStore: { getAgentDaemonRoute: async () => ({ daemon_key: 'mini:testing' }) },
    sendDaemonEphemeral: async (...args) => {
      calls.push(args)
      return { text: 'daemon-owned text' }
    },
    document: { id: 'shared-1', authorId: 'fleet:owner', path: 'notes/local.md' },
  })
  assert.deepEqual(result, { text: 'daemon-owned text' })
  assert.deepEqual(calls, [[
    'mini:testing',
    'read-document-text',
    { agent_id: 'fleet:owner', path: 'notes/local.md' },
  ]])
})

test('a recorded owner route does not fall back when its daemon is absent', async () => {
  const unavailable = new Error('No fleet-daemon connected for mini:testing')
  unavailable.code = 'NO_DAEMON'
  await assert.rejects(
    readSharedDocumentThroughOwner({
      fleetStore: { getAgentDaemonRoute: async () => ({ daemon_key: 'mini:testing' }) },
      sendDaemonEphemeral: async () => { throw unavailable },
      document: { id: 'shared-1', authorId: 'fleet:owner', path: 'note.md' },
    }),
    error => error.code === 'NO_DAEMON',
  )
})
