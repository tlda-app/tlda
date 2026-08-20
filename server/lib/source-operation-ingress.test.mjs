import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  readSourceFile,
  sourceLifecycleStore,
  updateProject,
} from './project-store.mjs'
import {
  acceptSourceSnapshot,
  setAcceptedSourceMutationHandler,
  setSourceBindingTargetProvider,
} from '../routes/projects.mjs'

// Repointed from `processProjectPush` onto the new accept. The guarantee is
// unchanged — one durable terminal result, replayed rather than re-run — and
// three things about the new surface will bite whoever edits this next:
//
//   1. **`deepEqual`, never `JSON.stringify`.** The replay's result is REBUILT
//      from the journal, so its keys come back in a different order. Comparing
//      serialized forms reports a difference that does not exist, and it reads
//      as a real defect in the accept.
//   2. **The reuse case asserts `status`, not `lifecycleStatus`.** On this path
//      `status` IS the lifecycle status; there is no second one. Asserting the
//      old name would require a field that exists only to keep this test happy.
//   3. **The fan-out only dispatches when there is somebody to tell**, so this
//      registers a binding target. Without one the handler never fires and
//      `fanoutCount` stays 0 — which looks like the dispatch being broken.
test('source ingress replays one durable terminal result after reconnect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-source-ingress-'))
  const name = `source-operation-ingress-${process.pid}-${Date.now()}`
  let fanoutCount = 0
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'main.tex', format: 'svg' })
    await updateProject(name, { pages: 1, buildStatus: 'success' })
    mkdirSync(join(root, name, 'output'), { recursive: true })
    writeFileSync(join(root, name, 'output', 'relevant-files.json'), JSON.stringify(['other.tex']))
    setSourceBindingTargetProvider(async () => ([
      { bindingId: 'a-binding', daemonKey: 'a-machine', sourceDir: '/somewhere/checkout' },
    ]))
    setAcceptedSourceMutationHandler(async () => { fanoutCount += 1 })
    const request = {
      requestId: 'a034aee3-4916-43e8-b80e-7a76c83a88c0',
      expectedRevision: null,
      files: [{ path: 'main.tex', content: 'Durable\n' }],
      deletedFiles: [],
      sourceManifest: ['main.tex'],
      editedBy: 'wire-test',
      sourceDaemonKey: 'daemon:forged-payload',
    }

    const daemonContext = { daemonId: 'daemon:wire-test' }
    const rejected = await acceptSourceSnapshot(name, request)
    assert.equal(rejected.status, 400)

    const first = await acceptSourceSnapshot(name, request, daemonContext)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const firstWireResult = first.body.sourceOperationResult
    assert.equal(firstWireResult.sourceRevision, first.body.sourceRevision)
    assert.equal(firstWireResult.acceptSeq, 1)
    const acceptedLifecycle = (await sourceLifecycleStore(name)).readRevisionLifecycle(name, first.body.sourceRevision)
    assert.equal(acceptedLifecycle.queueSubmission.daemonId, daemonContext.daemonId)
    assert.notEqual(acceptedLifecycle.queueSubmission.daemonId, request.sourceDaemonKey)

    const replay = await acceptSourceSnapshot(name, request, daemonContext)
    assert.equal(replay.body.operationReplay, true)
    // deepEqual — see note 1 above.
    assert.deepEqual(replay.body.sourceOperationResult, firstWireResult)
    // The dispatch is fire-and-forget, so let the tick it lands on run before
    // counting. Counting immediately would read 0 and look like a replay that
    // fanned out zero times for the wrong reason.
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(fanoutCount, 1, 'the replay answered from the journal instead of fanning out again')
    assert.equal(readSourceFile(name, 'main.tex'), 'Durable\n')

    const restartedStore = await sourceLifecycleStore(name)
    assert.deepEqual(restartedStore.readOperationByRequestId(name, request.requestId).terminalResult, firstWireResult)

    const reuse = await acceptSourceSnapshot(name, {
      ...request,
      files: [{ path: 'main.tex', content: 'Different\n' }],
    }, daemonContext)
    assert.equal(reuse.status, 400)
    // `status`, not `lifecycleStatus` — see note 2 above.
    assert.equal(reuse.body.status, 'invalid-request-id-reuse')
    assert.deepEqual(restartedStore.readOperationByRequestId(name, request.requestId).terminalResult, firstWireResult)
  } finally {
    setAcceptedSourceMutationHandler(null)
    setSourceBindingTargetProvider(null)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
