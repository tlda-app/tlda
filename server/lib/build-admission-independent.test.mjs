// Admission must never wait on the per-project publication chain.
//
// Regression pin for the 2026-09-25 silent build wedge: admission chained
// behind serializedPublication, so one unsettled publication op for a project
// silenced every later save for it (no daemon ack, buildStatus stuck at
// `building`) until a restart cleared the in-memory chain. If the trigger
// path is ever re-chained behind a marker, this test goes red: admission
// hangs and the bounded race below reports the timeout instead of hanging
// the suite.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BuildQueueStore } from './build-queue-store.mjs'
import {
  createDispatcherWithOptions, serializedPublication,
} from './build-dispatch.mjs'
import {
  closeProjectStore, createProject, initProjectStore,
} from './project-store.mjs'

const fakeTransport = {
  start(_job, _handlers) { return { cancel() {} } },
}

test('admission resolves to pending despite an unsettled publication op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-admission-independent-'))
  await initProjectStore(root)
  try {
    createProject({ name: 'doc', mainFile: 'main.tex', format: 'svg' })
    const dispatcher = createDispatcherWithOptions(fakeTransport, {
      store: new BuildQueueStore(':memory:'),
    })
    // A publication op for this project that never settles.
    serializedPublication('doc', () => new Promise(() => {}))
    const out = await Promise.race([
      dispatcher.admitBuild('doc', { revision: 'r1', daemonId: 'd1', branch: 'main' })
        .then(value => ({ settled: true, value })),
      new Promise(resolve => setTimeout(() => resolve({ settled: false }), 5000)),
    ])
    assert.equal(out.settled, true, 'admission hung behind the publication chain')
    assert.equal(out.value.state, 'pending')
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
