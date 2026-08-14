import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDispatcherWithOptions, recordBuildResult, recordRevisionPhase, resumeDurableBuildIntents } from './build-dispatch.mjs'
import { ForkTransport } from './build-transport.mjs'
import {
  closeProjectStore,
  createProject,
  initProjectStore,
  sourceLifecycleStore,
  updateProject,
  updateClientSourceManifest,
} from './project-store.mjs'

test('real worker records exact durable build, version, and mirror disposition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-lifecycle-wire-'))
  const name = 'paper'
  const sourceRevision = 'sha256:accepted-source-revision'
  const acceptSeq = 41
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'main.md', format: 'markdown' })
    writeFileSync(join(root, name, 'source', 'main.md'), '# Durable build\n')
    await updateClientSourceManifest(name, [{ path: 'main.md' }])
    const lifecycle = await sourceLifecycleStore(name)
    lifecycle.recordAcceptedRevision(name, sourceRevision, acceptSeq)
    lifecycle.recordRevisionPhase(name, sourceRevision, 'build', 'leased', { beforeRestart: true })
    const dispatcher = createDispatcherWithOptions(ForkTransport, {
      maxConcurrency: 1,
      sinks: {
        broadcastSignal() {}, putShape() {}, patchShape() {}, writeSentinel() { return { skipped: false } }, emitGlobalEvent() {},
        updateProject,
        recordBuildResult,
        recordRevisionPhase,
        mirrorShadow: async (_name, _hash, mirroredSourceRevision, mirroredAcceptSeq) => ({
          ok: true, machine_id: 'test', sourceRevision: mirroredSourceRevision, acceptSeq: mirroredAcceptSeq,
        }),
      },
    })
    const completedPromise = new Promise((resolve, reject) => {
      resumeDurableBuildIntents({
        dispatch: (...args) => dispatcher.dispatchBuild(...args).then(resolve, reject),
      }).catch(reject)
    })
    await completedPromise

    const completed = lifecycle.readRevisionLifecycle(name, sourceRevision)
    assert.equal(completed.acceptSeq, acceptSeq)
    assert.equal(completed.build.state, 'built')
    assert.equal(completed.version.state, 'versioned')
    assert.equal(completed.mirror.state, 'mirrored')
    assert.equal(completed.mirror.result.result.sourceRevision, sourceRevision)
    assert.equal(completed.mirror.result.result.acceptSeq, acceptSeq)
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('terminal build failure explicitly settles version and mirror', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-terminal-wire-'))
  const name = 'failed-paper'
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'main.md', format: 'markdown' })
    const lifecycle = await sourceLifecycleStore(name)
    lifecycle.recordAcceptedRevision(name, 'failed-revision', 7)
    await recordBuildResult(name, 'failed-revision', 7, 'build_failed', { error: 'renderer failed' })
    const failed = lifecycle.readRevisionLifecycle(name, 'failed-revision')
    assert.equal(failed.build.state, 'build_failed')
    assert.equal(failed.version.state, 'not_reached')
    assert.equal(failed.mirror.state, 'not_reached')
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
