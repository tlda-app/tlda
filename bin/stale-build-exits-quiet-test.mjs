// A build that loses the publish race exits quietly -- it rendered fine, so
// there is nothing to report.
//
// The wire, not the two ends: this forks the REAL build worker and services
// its RPCs with the REAL publishBuildInstance, because the defect is what the
// worker does with a stale refusal. Two workers render concurrently; the
// winner publishes first; the loser's publication is refused as superseded.
// That refusal is a result, not an error: the loser must send no failure
// report, no build_failed, and exit done -- leaving the 'superseded' record
// (and its reason) exactly as the publisher wrote it.
//
// Both halves run the same fixture and differ in ONE thing: publish order.
// The winner half is the counterfactual -- a check that only ever saw the
// quiet exit could not tell "stale is silent" from "the worker never reports".
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeProjectStore, createProject, initProjectStore, outputDir,
  sourceLifecycleStore, updateProject,
} from '../server/lib/project-store.mjs'
import { PUBLISH_REPLACED_ITEMS, publishBuildDiagnostics, publishBuildInstance } from '../server/lib/build-dispatch.mjs'
import { projectRevisionStatus } from '../server/lib/source-lifecycle.mjs'
import { failedBuildRpcResult } from '../server/lib/build-queue.mjs'
import { closeAllRooms, initSyncRooms } from '../server/lib/sync-rooms.mjs'

const NAME = 'race-book'
const QMD = '---\ntitle: Race\n---\n\nThe racing render.\n'

async function runWorker({ root, sourceRevision, acceptSeq }) {
  const child = fork(new URL('./build-worker.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const seen = []
  let done = null
  child.on('message', async (message) => {
    if (message?.t === 'done') { done = message; return }
    if (message?.t !== 'rpc') return
    seen.push({ method: message.m, args: message.a })
    // The real publisher, not a stub -- and exactly what the real dispatcher
    // relay does with its answer: a stale refusal resolves (it is already
    // recorded as superseded, with its reason), while a thrown failure
    // rejects into the worker's failure catch.
    try {
      let result = {}
      if (message.m === 'publishBuildInstance') {
        const [pName, pRevision, pSeq, pInstance, pReports, pReplaced] = message.a || []
        result = await publishBuildInstance(
          pName, pRevision, pSeq, pInstance, pReports, pReplaced || PUBLISH_REPLACED_ITEMS)
      } else if (message.m === 'recordBuildResult') {
        const [rName, rRevision, , rState, rResult] = message.a || []
        const lifecycle = await sourceLifecycleStore(rName)
        result = lifecycle.recordRevisionPhase(rName, rRevision, 'build', rState, rResult)
      } else if (message.m === 'publishBuildDiagnostics') result = publishBuildDiagnostics(...message.a)
      else if (message.m === 'updateProject') result = await updateProject(...message.a)
      child.send({ t: 'rpc-result', id: message.id, ok: true, result })
    } catch (e) {
      child.send(failedBuildRpcResult(message.id, e))
    }
  })
  child.send({ t: 'build', name: NAME, projectsDir: root, kind: 'build', sourceRevision, acceptSeq })
  const exitCode = await new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  return { seen, done, exitCode }
}

const root = mkdtempSync(join(tmpdir(), 'tlda-stale-quiet-'))
await initProjectStore(root)
initSyncRooms(root)
createProject({ name: NAME, mainFile: 'index.qmd', format: 'qmd' })
await updateProject(NAME, { documentRoots: ['index.qmd'], pages: 1 })
mkdirSync(outputDir(NAME), { recursive: true })

const lifecycle = await sourceLifecycleStore(NAME)
const git = await lifecycle.gitRepository()
const base = await git.acceptRevision({
  project: NAME, files: [{ path: 'index.qmd', content: QMD }], message: 'base',
})
await git.advanceHead(NAME, base, null)
const winner = await git.acceptRevision({
  project: NAME, parent: base,
  files: [{ path: 'index.qmd', content: `${QMD}\nWinner.\n` }], message: 'winner',
})
// A sibling of the winner: behind the head once the winner publishes, so its
// publication is refused as stale. Admitted after (higher seq), so it is the
// latest revision -- the order in which a clobber would reach the wheel.
const loser = await git.acceptRevision({
  project: NAME, parent: base,
  files: [{ path: 'index.qmd', content: `${QMD}\nLoser.\n` }], message: 'loser',
})

// The counterfactual first: a build that publishes records built and is done.
const won = await runWorker({ root, sourceRevision: winner, acceptSeq: 2 })
assert.equal(won.exitCode, 0, 'a publishing build exits 0')
assert.equal(won.done?.ok, true, 'a publishing build is done-ok')
assert.equal(
  won.seen.find((entry) => entry.method === 'recordBuildResult')?.args?.[3], 'built',
  'a publishing build records itself built',
)
assert.ok(
  !won.seen.some((entry) => entry.method === 'reportBuildFailure'),
  'a publishing build sends no failure report',
)

// The requirement: the loser rendered the same fixture successfully -- its
// only sin is publishing second.
const lost = await runWorker({ root, sourceRevision: loser, acceptSeq: 3 })
assert.equal(lost.exitCode, 0, 'a stale build exits 0: nothing failed')
assert.equal(lost.done?.ok, true, 'a stale build is done-ok, not done-failed')
assert.ok(
  lost.seen.some((entry) => entry.method === 'publishBuildInstance'),
  'the stale build attempted its publication',
)
assert.ok(
  !lost.seen.some((entry) => entry.method === 'reportBuildFailure'),
  'a stale build sends no failure report -- no card, no signals, no sentinel write for a build that rendered fine',
)
assert.ok(
  !lost.seen.some((entry) => entry.method === 'recordBuildResult'),
  'a stale build sends no build disposition -- the superseded record stands',
)
const journal = (await sourceLifecycleStore(NAME)).listRevisionLifecycles(NAME)
const loserRow = journal.find((row) => row.sourceRevision === loser)
assert.equal(loserRow.build.state, 'superseded',
  'the refusal record stands; nothing clobbers it to build_failed (or built)')
assert.match(loserRow.build.result?.reason || '', /not an ancestor|head moved/,
  'and it still carries the reason it was refused')
assert.equal(projectRevisionStatus(journal).status, 'superseded',
  'even as the latest revision, a superseded build is never an error')
assert.match(readFileSync(join(outputDir(NAME), 'index.html'), 'utf8'), /Winner/,
  'the winner it lost to is still the published render')

await closeProjectStore()
await closeAllRooms()
console.log('a stale build exits quietly; a publishing build still records built')
