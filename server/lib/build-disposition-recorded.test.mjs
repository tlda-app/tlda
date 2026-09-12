import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBuildQueue } from './build-queue.mjs'
import { BuildQueueStore } from './build-queue-store.mjs'
import { closeProjectStore, createProject, extractBuildErrors, initProjectStore, readProject } from './project-store.mjs'
import { createDispatcherWithOptions } from './build-dispatch.mjs'

// A worker that dies without running its own catch — SIGKILL, the OOM killer,
// its parent going away — records nothing itself. `onExit` settles the queue
// row, and before this was wired that was ALL that happened: the project kept
// the `building` that build-runner set at start, and no log was written. A live
// box showed exactly that for six days.
//
// This drives the real queue with a transport whose worker exits non-zero
// without sending anything, so the disposition path is reached the way it is in
// production rather than by calling the hook directly. Calling recordDisposition
// itself would prove the function and not the wiring, and the wiring is what was
// missing — nothing had ever supplied this hook.
function exitingTransport(code = 137) {
  return {
    start(_job, { onExit }) {
      setImmediate(() => onExit(code))
      return { cancel() {} }
    },
  }
}

async function settledProjectAfterWorkerDeath(root, name) {
  const dispatcher = createDispatcherWithOptions(exitingTransport(), {
    store: new BuildQueueStore(':memory:'),
  })
  await dispatcher.admitBuild(name, { revision: 'r1', daemonId: 'd1', branch: 'main' })
  // Let onExit -> settle -> recordDisposition run to completion.
  for (let i = 0; i < 50 && (await readProject(name))?.buildStatus === 'building'; i++) {
    await new Promise(r => setTimeout(r, 20))
  }
  return readProject(name)
}

test('a worker that dies without recording leaves the project failed, with a readable reason', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-disposition-'))
  await initProjectStore(root)
  t.after(async () => {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'doc', mainFile: 'index.qmd', format: 'qmd' })
  // The state build-runner leaves when it starts a build, which is where a
  // killed worker abandons the project.
  const { updateProject } = await import('./project-store.mjs')
  await updateProject('doc', { buildStatus: 'building' })

  const project = await settledProjectAfterWorkerDeath(root, 'doc')

  assert.notEqual(project.buildStatus, 'building', 'a dead worker must not leave the project reading as building')
  assert.equal(project.buildStatus, 'error')

  // And the reason has to be READABLE by the thing that reports it, not merely
  // written somewhere: this is the command that said "left no log".
  assert.ok(existsSync(join(root, 'doc', 'build.log')), 'the disposition must leave a log')
  const reported = await extractBuildErrors('doc')
  assert.equal(reported.logMissing, false, 'the reader must not report the log as missing')
  assert.ok(reported.errors.length > 0, 'the reader must surface a reason')
  assert.match(readFileSync(join(root, 'doc', 'build.log'), 'utf8'), /exited with code 137/)
})

// The guard, and it is the half that could do damage. A row settles to `killed`
// for `superseded`, `needs-rebase` and `cancelled` — a newer revision replacing
// this build is not a build that went wrong. If this ever goes red, the test
// above is passing because the code marks projects broken indiscriminately.
test('a superseded or cancelled build does not mark the project broken', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-disposition-killed-'))
  await initProjectStore(root)
  t.after(async () => {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'doc', mainFile: 'index.qmd', format: 'qmd' })

  const settled = []
  const queue = createBuildQueue({
    transport: exitingTransport(0),
    getProjectsDir: () => root,
    store: new BuildQueueStore(':memory:'),
    recordDisposition: async (job, state, result) => { settled.push({ state, result }) },
  })
  await queue.admitBuild('doc', { revision: 'r1', daemonId: 'd1', branch: 'main' })
  await queue.killBuild('doc')
  await new Promise(r => setTimeout(r, 100))

  // Whatever else it does, a cancellation must never arrive as `failed`, which
  // is the only state the recorder acts on.
  for (const s of settled) {
    assert.notEqual(s.state, 'failed', `a cancelled build settled as ${s.state}, which must not be failed`)
  }
  assert.equal((await readProject('doc')).buildStatus, 'none', 'a cancelled build must not change the project status')
})
