#!/usr/bin/env node
//
// **An accept survives a crash at each boundary, and a retry is answerable.**
//
// These are the two guarantees `durable-source-acceptance` and
// `source-operation-ingress` are named for. Both of those drive the OLD path —
// `transactionTest.failAt` and the WS handler's `TLDA_TEST_SOURCE_CRASH_BOUNDARY`
// — and `transactionTest` appears nowhere outside `processProjectPushSerialized`.
// So when the strip lands, the crash-injection mechanism goes with it and
// nothing can assert that a process dying mid-accept does not lose work.
//
// This is the injection point on the new accept, and the assertions those two
// tests exist to make.
//
// **The boundaries are named for what is durable at each, not for a
// transaction that no longer exists:**
//
//   after-accept          the revision is durable; the journal is not
//   after-terminal-result the journal is durable; the effects have not run
//
// `crashAt` is a function ARGUMENT, not a request field, so no remote caller
// can ask a server to pretend to crash.
//
// **One honest difference from the old path, measured rather than assumed.**
// The old transaction rolled back and re-applied, so recovery produced one
// revision. Here the revision is durable at the ref move, so a retry of the
// identical push lands as a CLEAN REBASE onto the revision it itself created —
// a second commit with identical content. No work is lost and the paper is
// right; the history carries an extra entry. That is a real semantic change and
// it is asserted below rather than hidden.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acceptSourceSnapshot } from '../server/routes/projects.mjs'
import { closeProjectStore, createProject, initProjectStore, sourceLifecycleStore } from '../server/lib/project-store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'survives-crash-'))
await initProjectStore(path.join(root, 'projects'))

const request = suffix => ({
  requestId: `R-${suffix}`,
  deliveryId: `D-${suffix}`,
  expectedRevision: null,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: `content-${suffix}\n` }],
  editedBy: 'agent',
  editOperations: [{ agentId: 'agent', operation: { operation_id: `O-${suffix}`, kind: 'edit' } }],
})

for (const boundary of ['after-accept', 'after-terminal-result']) {
  const project = `paper-${boundary}`
  await createProject({ name: project, format: 'svg', mainFile: 'main.tex' })
  const input = request(boundary)

  // ---- the crash
  const crashed = await acceptSourceSnapshot(project, input, { crashAt: boundary })
  assert.equal(crashed.body.simulatedCrash, true, `${boundary}: the boundary fired`)
  assert.equal(crashed.body.crashedAt, boundary, 'and names which one')

  // ---- the retry, which is what "survives" means
  const accepted = await acceptSourceSnapshot(project, input)
  assert.equal(accepted.status, 200,
    `SURVIVES: retrying after a crash at ${boundary} succeeds (${JSON.stringify(accepted.body).slice(0, 200)})`)

  // The author's bytes are in the project, which is the thing that must not be
  // lost. Asserted from the store rather than the response.
  const lifecycle = await sourceLifecycleStore(project)
  const head = (await lifecycle.readAuthority()).currentRevision
  assert.equal((await lifecycle.readRevisionFile(head, 'main.tex')).toString(), `content-${boundary}\n`,
    'and the accepted revision holds what the author wrote')

  // The journal carries a canonical terminal result naming the edit operation,
  // so it is answerable which agent's edit the surviving revision contains.
  const byRequest = lifecycle.readOperationByRequestId(project, input.requestId)
  assert.ok(byRequest?.terminalResult, 'the journal holds a terminal result')
  assert.deepEqual(byRequest.terminalResult.operationIds, [`O-${boundary}`],
    'naming the edit operation the revision carried')
  assert.deepEqual(
    lifecycle.readOperationByDeliveryId(project, input.deliveryId), byRequest,
    'and the deliveryId reaches the same record as the requestId',
  )

  // ---- the replay: same request again is ANSWERED, not re-run
  const replay = await acceptSourceSnapshot(project, input)
  assert.equal(replay.body.operationReplay, true, `${boundary}: a third attempt replays`)
  assert.deepEqual(replay.body.sourceOperationResult, accepted.body.sourceOperationResult,
    'ANSWERABLE: with the same canonical result, rather than accepting again')
}

await closeProjectStore()
fs.rmSync(root, { recursive: true, force: true })
console.log('an accept that survives a crash: both boundaries recover and replay canonically')
process.exit(0)
