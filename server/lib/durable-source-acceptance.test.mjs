import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDaemonWsControlPlane } from './daemon-ws-control-plane.mjs'
import { closeProjectStore, createProject, initProjectStore, readSourceFile, sourceLifecycleStore, updateProject } from './project-store.mjs'
import { processProjectPush, setAcceptedSourceMutationHandler, setPendingSourceReplicaHandler, setSourceBindingTargetProvider } from '../routes/projects.mjs'

async function createTestProject(root, name) {
  createProject({ name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success' })
  mkdirSync(join(root, name, 'output'), { recursive: true })
  writeFileSync(join(root, name, 'output', 'relevant-files.json'), JSON.stringify(['other.tex']))
}

function request(name, suffix) {
  const operation = { operation_id: `O-${suffix}`, kind: 'edit', files: [{ path: 'main.tex' }] }
  return {
    project: name, requestId: `R-${suffix}`, deliveryId: `D-${suffix}`,
    expectedRevision: null, files: [{ path: 'main.tex', content: `content-${suffix}\n` }],
    deletedFiles: [], sourceManifest: ['main.tex'], editedBy: 'agent', editOperations: [{ agentId: 'agent', operation }],
  }
}

for (const boundary of ['simulateCrashAfterSourceMutation', 'simulateCrashAfterTerminalResult']) {
  test(`real source handler recovers ${boundary} and replays the canonical D/R result`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tlda-source-handler-crash-'))
    const name = `paper-${boundary}`
    const input = request(name, boundary)
    try {
      await initProjectStore(root)
      await createTestProject(root, name)
      setAcceptedSourceMutationHandler(async () => {})
      const crashed = await processProjectPush(name, input, { [boundary]: true })
      assert.equal(crashed.simulatedCrash, true)
      await closeProjectStore()

      await initProjectStore(root)
      const accepted = await processProjectPush(name, input)
      assert.equal(accepted.ok, true, JSON.stringify(accepted))
      assert.equal(readSourceFile(name, 'main.tex'), `content-${boundary}\n`)
      const lifecycle = await sourceLifecycleStore(name)
      const byRequest = lifecycle.readOperationByRequestId(name, input.requestId)
      const byDelivery = lifecycle.readOperationByDeliveryId(name, input.deliveryId)
      assert.deepEqual(byDelivery, byRequest)
      assert.deepEqual(byRequest.terminalResult.operationIds, [`O-${boundary}`])
      assert.deepEqual(byRequest.orderedEffects[0].editOperations.map(record => record.operation.operation_id), [`O-${boundary}`])

      const replay = await processProjectPush(name, input)
      assert.equal(replay.operationReplay, true)
      assert.deepEqual(replay.sourceOperationResult, accepted.sourceOperationResult)
    } finally {
      setAcceptedSourceMutationHandler(null)
      await closeProjectStore()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('processed source envelope replays its stored result before ACK', async () => {
  const sent = []
  const ws = { readyState: 1, send(value) { sent.push(JSON.parse(value)) } }
  const stored = { type: 'source-change-result', requestId: 'R1', project: 'paper', ok: true, status: 'accepted', sourceRevision: 'rev-2' }
  const control = createDaemonWsControlPlane({
    daemonConnections: new Map(), serverDaemonOutboxInflight: new Map(), socketCanAcceptMore: () => true,
    fleetStore: { daemonOutboxWasProcessed: async () => true },
    replayProcessedDaemonMessage: async socket => socket.send(JSON.stringify(stored)),
  })
  let invoked = false
  const result = await control.handleDaemonOutboxEnvelope(ws, { type: 'source-change', __daemon_outbox_id: 'D1' }, async () => { invoked = true })
  assert.equal(invoked, false)
  assert.equal(result.kind, 'duplicate-daemon-outbox')
  assert.deepEqual(sent, [stored, { type: 'daemon-outbox-ack', outbox_id: 'D1' }])
})

test('accepted replica commands survive a crash before dispatch and same-id replay resumes them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-source-replica-crash-'))
  const name = 'paper-replica-crash'
  const input = request(name, 'replica-crash')
  try {
    await initProjectStore(root)
    await createTestProject(root, name)
    setSourceBindingTargetProvider(() => [{ bindingId: 'binding-target', daemonKey: 'target:test' }])
    setAcceptedSourceMutationHandler(null)

    const accepted = await processProjectPush(name, input)
    assert.equal(accepted.ok, true)
    const lifecycle = await sourceLifecycleStore(name)
    const revision = lifecycle.readRevisionLifecycle(name, accepted.sourceRevision)
    assert.equal(revision.replicas['binding-target'].state, 'pending')
    assert.equal(revision.replicas['binding-target'].operationId, `materialize:binding-target:${accepted.sourceRevision}`)
    assert.equal(revision.replicas['binding-target'].command.bindingId, 'binding-target')

    await closeProjectStore()
    await initProjectStore(root)
    const resumed = new Promise(resolve => setPendingSourceReplicaHandler(resolve))
    const replay = await processProjectPush(name, input)
    assert.equal(replay.operationReplay, true)
    assert.deepEqual(await resumed, { project: name, sourceRevision: accepted.sourceRevision, resumeOnly: true })
  } finally {
    setAcceptedSourceMutationHandler(null)
    setPendingSourceReplicaHandler(null)
    setSourceBindingTargetProvider(null)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
