import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDispatcherWithOptions, publishBuildInstance } from './build-dispatch.mjs'
import { BuildQueueStore } from './build-queue-store.mjs'
import { closeProjectStore, createProject, initProjectStore, sourceLifecycleStore } from './project-store.mjs'

/**
 * What a build worker says about ITSELF, and why it stopped being free.
 *
 * The relay has always taken the project and the revision out of the worker's
 * own message and acted on them. Under `fork` that was safe by construction: the
 * worker is the server's child, started with this job and nothing else, so its
 * account of itself could not disagree with the job. Nothing compared them,
 * because nothing could differ.
 *
 * A remote transport is what turns that into a boundary. The renderer is another
 * machine with a persistent workspace, so "what the worker says it built" and
 * "what this job is" become two values, and the compare-and-swap inside
 * `publishBuildInstance` cannot close the gap — it checks the worker's revision
 * against the published HEAD, which is a different question and answers it
 * correctly for the wrong project.
 *
 * These are POSITIVE CONTROLS in the strict sense: each one first shows that the
 * operation being refused is an operation that otherwise succeeds. A refusal
 * test against something that could never have happened measures nothing.
 */

function instanceTree(root, name, text) {
  const project = join(root, name)
  mkdirSync(join(project, 'source'), { recursive: true })
  mkdirSync(join(project, 'output'), { recursive: true })
  writeFileSync(join(project, 'source', 'main.md'), `${text} source`)
  writeFileSync(join(project, 'output', 'artifact.txt'), text)
  return project
}

/**
 * Drive the REAL dispatcher with a worker that sends one publish RPC, and hand
 * back what the server answered. The RPC's arguments are the test's, which is
 * the whole point: this is the message a compromised or confused executor is
 * able to put on the wire.
 */
function publishAttempt(args) {
  let settle
  const answered = new Promise(resolve => { settle = resolve })
  const transport = {
    start(_job, { onMessage, onExit }) {
      setImmediate(() => {
        onMessage({ t: 'rpc', id: 1, m: 'publishBuildInstance', a: args }, {
          // Answered on a LATER TICK, which is not a detail. The queue relays on
          // a serialized promise chain and `onExit` awaits that chain, so a
          // transport that finishes the build from inside the reply deadlocks:
          // the chain is waiting on the continuation that is running. A forked
          // worker cannot do that — its exit arrives from another process — so
          // the hazard is one a fake transport invents for itself.
          send(reply) {
            settle(reply)
            setImmediate(() => {
              onMessage({ t: 'done', ok: reply.ok })
              setImmediate(() => { void onExit(reply.ok ? 0 : 1) })
            })
          },
        })
      })
      return { cancel() {} }
    },
  }
  return { transport, answered }
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-rpc-job-binding-'))
  const instances = mkdtempSync(join(tmpdir(), 'tlda-rpc-job-instances-'))
  await initProjectStore(root)
  t.after(async () => {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
    rmSync(instances, { recursive: true, force: true })
  })
  createProject({ name: 'paper', mainFile: 'main.md', format: 'markdown' })
  createProject({ name: 'other', mainFile: 'main.md', format: 'markdown' })

  const lifecycle = await sourceLifecycleStore('paper', { context: { referencedRoots: ['main.md'] } })
  const git = await lifecycle.gitRepository()
  const base = await git.acceptRevision({ project: 'paper', files: [{ path: 'main.md', content: 'base' }], message: 'base' })
  await git.advanceHead('paper', base, null)
  const next = await git.acceptRevision({ project: 'paper', parent: base, files: [{ path: 'main.md', content: 'next' }], message: 'next' })

  const otherLifecycle = await sourceLifecycleStore('other', { context: { referencedRoots: ['main.md'] } })
  const otherGit = await otherLifecycle.gitRepository()
  const otherBase = await otherGit.acceptRevision({ project: 'other', files: [{ path: 'main.md', content: 'other base' }], message: 'base' })
  await otherGit.advanceHead('other', otherBase, null)

  return { root, instances, git, otherGit, base, next }
}

test('a build cannot publish a project that is not its own', async t => {
  const { root, instances, otherGit, base, next } = await fixture(t)

  // THE CONTROL. Publishing `other` from a tree of our choosing is an operation
  // that works — so the refusal below is refusing something real, not something
  // the system was never going to do anyway.
  const proof = await publishBuildInstance('other', await otherGit.head('other'), null, instanceTree(instances, 'control', 'seized'), [])
  assert.equal(proof.published, true, 'control: publishing another project must be possible, or the refusal proves nothing')
  assert.equal(readFileSync(join(root, 'other', 'output', 'artifact.txt'), 'utf8'), 'seized')

  const seizure = instanceTree(instances, 'seizure', 'seized again')
  const { transport, answered } = publishAttempt(['other', await otherGit.head('other'), null, seizure, []])
  const dispatcher = createDispatcherWithOptions(transport, { store: new BuildQueueStore(':memory:') })
  await dispatcher.admitBuild('paper', { revision: next, daemonId: 'd1', branch: 'main' })

  const reply = await answered
  assert.equal(reply.ok, false, 'a build for paper must not be able to publish other')
  assert.match(reply.error, /sent publishBuildInstance for other/)
  assert.match(reply.error, /may only act on its own project/)
  // And it must not have happened anyway: the guard runs BEFORE the publication.
  assert.equal(readFileSync(join(root, 'other', 'output', 'artifact.txt'), 'utf8'), 'seized')
  assert.notEqual(base, next)
})

test('a build cannot publish its own project at a revision it was not given', async t => {
  const { root, instances, git, base, next } = await fixture(t)

  const stale = instanceTree(instances, 'stale', 'wrong revision')
  const { transport, answered } = publishAttempt(['paper', base, null, stale, []])
  const dispatcher = createDispatcherWithOptions(transport, { store: new BuildQueueStore(':memory:') })
  await dispatcher.admitBuild('paper', { revision: next, daemonId: 'd1', branch: 'main' })

  const reply = await answered
  assert.equal(reply.ok, false, 'a build of `next` must not be able to publish `base`')
  assert.match(reply.error, new RegExp(`for revision ${base}`))
  assert.equal(await git.head('paper'), base, 'the head must not have moved')
  // The tree it offered must not have landed either.
  assert.equal(existsSync(join(root, 'paper', 'output', 'artifact.txt')), false, 'the offered tree must not have been published')
})

test('an RPC that simply omits its project is refused, not skipped', async t => {
  const { root, instances, git, base, next } = await fixture(t)

  // The hole a `!== undefined` escape would leave, and it is invisible: `null`
  // is caught because `null !== undefined`, while an argument that is not there
  // at all yields `undefined` and would compare itself out of existence. `a: []`
  // is the shortest message that reaches the publish path.
  const { transport, answered } = publishAttempt([])
  const dispatcher = createDispatcherWithOptions(transport, { store: new BuildQueueStore(':memory:') })
  await dispatcher.admitBuild('paper', { revision: next, daemonId: 'd1', branch: 'main' })

  const reply = await answered
  assert.equal(reply.ok, false, 'an absent project name must be refused rather than skipped')
  assert.match(reply.error, /may only act on its own project/)
  assert.equal(await git.head('paper'), base, 'the head must not have moved')
  assert.equal(existsSync(join(root, 'paper', 'output', 'artifact.txt')), false, 'nothing may have been published')
  assert.ok(instances)
})

test('a revision the head does not descend to never reaches the publish path at all', async t => {
  const { instances, git, base, next } = await fixture(t)
  // Move the head forward, so `base` is now behind it.
  const published = await publishBuildInstance('paper', next, null, instanceTree(instances, 'ahead', 'ahead'), [])
  assert.equal(published.published, true)
  assert.equal(await git.head('paper'), next)

  // MEASURED RATHER THAN ASSUMED, and it came out one layer earlier than
  // expected. A build for a revision behind the head is not refused when it
  // tries to publish — it is never dispatched: admission compares the head to
  // the revision and settles the row `killed` with `needs-rebase`, so no worker
  // starts and no publish RPC exists to refuse. This test was first written to
  // wait for that RPC and timed out at 120s waiting for a message the system is
  // right not to produce.
  const { transport, answered } = publishAttempt(['paper', base, null, instanceTree(instances, 'behind', 'behind'), []])
  const dispatcher = createDispatcherWithOptions(transport, { store: new BuildQueueStore(':memory:') })
  const row = await dispatcher.admitBuild('paper', { revision: base, daemonId: 'd1', branch: 'main' })

  assert.equal(row.state, 'killed', 'a build behind the head must not be dispatched')
  assert.equal(row.terminal_reason, 'needs-rebase', 'and refused for the reason this control is about')
  assert.equal(await git.head('paper'), next, 'the head must still be the newer revision')
  // And the RPC genuinely never happened, rather than happening and being lost.
  const raced = await Promise.race([answered, new Promise(resolve => setTimeout(() => resolve('never sent'), 500))])
  assert.equal(raced, 'never sent')

  // The compare-and-swap itself still refuses the same revision when it IS
  // reached — the layers are independent and this control keeps both honest.
  const stale = await publishBuildInstance('paper', base, null, instanceTree(instances, 'behind-direct', 'behind'), [])
  assert.equal(stale.published, false)
  assert.equal(stale.stale, true)
  assert.equal(await git.head('paper'), next)
})
