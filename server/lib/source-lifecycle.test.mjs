import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceLifecycleStore } from './source-lifecycle.mjs'

function payload(overrides = {}) {
  return {
    project: 'paper',
    requestId: '792b4a90-75f7-4b82-b94e-729fb20d0061',
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'first' }],
    dependencyPins: [],
    editedBy: 'editor',
    ...overrides,
  }
}

test('source operation fate survives store reconstruction and exact replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-source-operation-'))
  try {
    const first = createSourceLifecycleStore({ root, context: { referencedRoots: ['main.tex'] } })
    const prepared = first.prepareOperation(payload())
    assert.equal(prepared.operation.state, 'prepared')
    const terminal = first.finishOperation(payload().requestId, 'accepted', {
      ok: true,
      requestId: payload().requestId,
      sourceRevision: 'sha256:revision',
      acceptSeq: 1,
      disposition: 'accepted',
    }, { acceptSeq: 1 })
    assert.equal(terminal.state, 'accepted')

    const restarted = createSourceLifecycleStore({ root, context: { referencedRoots: ['main.tex'] } })
    const replay = restarted.prepareOperation(payload())
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.result, terminal.terminalResult)
    assert.equal(restarted.readOperation(payload().requestId).acceptSeq, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('request id reuse with a different payload preserves the original fate', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-source-operation-reuse-'))
  try {
    const store = createSourceLifecycleStore({ root, context: { referencedRoots: ['main.tex'] } })
    store.prepareOperation(payload())
    store.finishOperation(payload().requestId, 'rejected', { ok: false, status: 'stale-base' })
    const original = store.readOperation(payload().requestId)

    const reuse = store.prepareOperation(payload({ files: [{ path: 'main.tex', content: 'different' }] }))
    assert.equal(reuse.invalidReuse, true)
    assert.equal(reuse.result.status, 'invalid-request-id-reuse')
    assert.deepEqual(store.readOperation(payload().requestId), original)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
