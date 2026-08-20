import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDaemonWsControlPlane } from './daemon-ws-control-plane.mjs'
import { closeProjectStore, createProject, initProjectStore, readSourceFile, sourceLifecycleStore, updateProject } from './project-store.mjs'
import { acceptSourceSnapshot, setAcceptedSourceMutationHandler, setPendingSourceReplicaHandler, setSourceBindingTargetProvider } from '../routes/projects.mjs'

// Repointed from `processProjectPush` onto the new accept. The guarantee is
// unchanged — a crash at either boundary loses no work and the retry is
// answerable — but the mechanism is not, and three things will bite whoever
// edits this next:
//
//   1. **`crashAt` is the THIRD ARGUMENT, not a request field.** Passing it in
//      the body silently does nothing, and the failure looks like the boundary
//      not firing — which sends you to debug the accept rather than your call.
//      It is an argument on purpose: a test hook reachable over the wire is the
//      sort of thing that ships.
//   2. **The boundaries are named for what is durable at each**, not for a
//      transaction that no longer exists. `after-accept` = the revision is
//      durable and the journal is not; `after-terminal-result` = the journal is
//      durable and the effects have not run.
//   3. **`deepEqual`, never `JSON.stringify`.** The replay's result is rebuilt
//      from the journal, so its key order differs and a serialized comparison
//      reports a difference that is not there.
//
// One deliberate semantic change from the old path, asserted below rather than
// described: the revision is durable at the ref move, so a retry after a crash
// re-accepts as a CLEAN REBASE onto the revision it created — a second commit
// with identical content. No work lost, history one entry longer. Do not
// "fix" that by rolling the ref back; un-moving a durable ref is the defect
// that produced five separate reproductions.

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

for (const boundary of ['after-accept', 'after-terminal-result']) {
  test(`real source handler recovers ${boundary} and replays the canonical D/R result`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tlda-source-handler-crash-'))
    const name = `paper-${boundary}`
    const input = request(name, boundary)
    try {
      await initProjectStore(root)
      await createTestProject(root, name)
      setAcceptedSourceMutationHandler(async () => {})
      const crashed = await acceptSourceSnapshot(name, input, { crashAt: boundary, daemonId: 'daemon:test' })
      assert.equal(crashed.body.simulatedCrash, true)
      assert.equal(crashed.body.crashedAt, boundary, 'and the response names which boundary stopped it')
      await closeProjectStore()

      await initProjectStore(root)
      const accepted = await acceptSourceSnapshot(name, input, { daemonId: 'daemon:test' })
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
      assert.equal(readSourceFile(name, 'main.tex'), `content-${boundary}\n`)
      const lifecycle = await sourceLifecycleStore(name)
      const byRequest = lifecycle.readOperationByRequestId(name, input.requestId)
      const byDelivery = lifecycle.readOperationByDeliveryId(name, input.deliveryId)
      assert.deepEqual(byDelivery, byRequest)
      assert.deepEqual(byRequest.terminalResult.operationIds, [`O-${boundary}`])
      assert.deepEqual(byRequest.orderedEffects[0].editOperations.map(record => record.operation.operation_id), [`O-${boundary}`])

      const replay = await acceptSourceSnapshot(name, input, { daemonId: 'daemon:test' })
      assert.equal(replay.body.operationReplay, true)
      // deepEqual — see note 3 above.
      assert.deepEqual(replay.body.sourceOperationResult, accepted.body.sourceOperationResult)
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

    const accepted = await acceptSourceSnapshot(name, input, { daemonId: 'daemon:test' })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    const lifecycle = await sourceLifecycleStore(name)
    const revision = lifecycle.readRevisionLifecycle(name, accepted.body.sourceRevision)
    assert.equal(revision.replicas['binding-target'].state, 'pending')
    assert.equal(revision.replicas['binding-target'].operationId, `materialize:binding-target:${accepted.body.sourceRevision}`)
    assert.equal(revision.replicas['binding-target'].command.bindingId, 'binding-target')

    await closeProjectStore()
    await initProjectStore(root)
    const resumed = new Promise(resolve => setPendingSourceReplicaHandler(resolve))
    const replay = await acceptSourceSnapshot(name, input, { daemonId: 'daemon:test' })
    assert.equal(replay.body.operationReplay, true)
    assert.deepEqual(await resumed, { project: name, sourceRevision: accepted.body.sourceRevision, resumeOnly: true })
  } finally {
    setAcceptedSourceMutationHandler(null)
    setPendingSourceReplicaHandler(null)
    setSourceBindingTargetProvider(null)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
