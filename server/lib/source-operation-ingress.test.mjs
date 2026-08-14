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
import { processProjectPush, setAcceptedSourceMutationHandler } from '../routes/projects.mjs'

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
    setAcceptedSourceMutationHandler(async () => { fanoutCount += 1 })
    const request = {
      requestId: 'a034aee3-4916-43e8-b80e-7a76c83a88c0',
      expectedRevision: null,
      files: [{ path: 'main.tex', content: 'Durable\n' }],
      deletedFiles: [],
      sourceManifest: ['main.tex'],
      editedBy: 'wire-test',
    }

    const first = await processProjectPush(name, request)
    assert.equal(first.ok, true, JSON.stringify(first))
    const firstWireResult = first.sourceOperationResult
    assert.equal(firstWireResult.sourceRevision, first.sourceRevision)
    assert.equal(firstWireResult.acceptSeq, 1)

    const replay = await processProjectPush(name, request)
    assert.equal(replay.operationReplay, true)
    assert.deepEqual(replay.sourceOperationResult, firstWireResult)
    assert.equal(fanoutCount, 1)
    assert.equal(readSourceFile(name, 'main.tex'), 'Durable\n')

    const restartedStore = await sourceLifecycleStore(name)
    assert.deepEqual(restartedStore.readOperationByRequestId(name, request.requestId).terminalResult, firstWireResult)

    const reuse = await processProjectPush(name, {
      ...request,
      files: [{ path: 'main.tex', content: 'Different\n' }],
    })
    assert.equal(reuse.status, 400)
    assert.equal(reuse.lifecycleStatus, 'invalid-request-id-reuse')
    assert.deepEqual(restartedStore.readOperationByRequestId(name, request.requestId).terminalResult, firstWireResult)
  } finally {
    setAcceptedSourceMutationHandler(null)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
