import assert from 'node:assert/strict'
import test from 'node:test'

import { createSourceRoomDaemon, sourceRoomDaemonKey } from './source-room-daemon.mjs'

test('source-room requests submit the accepted revision under the canonical daemon key', async () => {
  const submissions = []
  const heads = []
  const lifecycle = {
    async readAuthority() { return { currentRevision: 'revision:accepted', acceptSeq: 9 } },
    readRevisionLifecycle() { return { acceptSeq: 9 } },
  }
  const daemon = createSourceRoomDaemon({
    projectDir: () => '/unused',
    readProject: async () => ({ name: 'paper' }),
    sourceLifecycleStore: async () => lifecycle,
    readClientSourceManifest: async () => [],
    acceptSourceSnapshot: async () => ({ status: 200, body: { ok: true } }),
    projectHeadChanged: async (project, head) => heads.push({ project, head }),
    dispatchBuild: async (project, submission) => submissions.push({ project, submission }),
  })

  await daemon.requestBuild('paper', { kind: 'parts' })

  assert.deepEqual(heads, [{ project: 'paper', head: 'revision:accepted' }])
  assert.deepEqual(submissions, [{
    project: 'paper',
    submission: {
      kind: 'parts',
      sourceRevision: 'revision:accepted',
      acceptSeq: 9,
      basedOnRevision: 'revision:accepted',
      daemonId: sourceRoomDaemonKey('paper'),
    },
  }])
})

test('source-room snapshot ignores forged payload daemon identity', async () => {
  const calls = []
  const daemon = createSourceRoomDaemon({
    projectDir: () => '/unused',
    readProject: async () => ({ name: 'paper' }),
    sourceLifecycleStore: async () => ({}),
    readClientSourceManifest: async () => [],
    acceptSourceSnapshot: async (...args) => {
      calls.push(args)
      return { status: 200, body: { ok: true } }
    },
  })

  await daemon.submitSnapshot('paper', { sourceDaemonKey: 'daemon:forged', expectedRevision: null })
  assert.equal(calls[0][2].daemonId, sourceRoomDaemonKey('paper'))
})
