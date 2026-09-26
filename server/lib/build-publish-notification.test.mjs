import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDispatcherWithOptions } from './build-dispatch.mjs'
import { closeProjectStore, createProject, initProjectStore, sourceLifecycleStore } from './project-store.mjs'
import { projectRevisionStatus } from './source-lifecycle.mjs'

function instance(root, name, { output = true } = {}) {
  const project = join(root, name)
  mkdirSync(join(project, 'source'), { recursive: true })
  writeFileSync(join(project, 'source', 'main.md'), '# built')
  if (output) {
    mkdirSync(join(project, 'output'), { recursive: true })
    writeFileSync(join(project, 'output', 'index.html'), '<h1>built</h1>')
  }
  return project
}

async function run({ notificationFails = false, output = true }) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-dispatch-status-'))
  const instanceRoot = mkdtempSync(join(tmpdir(), 'tlda-dispatch-instance-'))
  const name = 'paper'
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'main.md', format: 'markdown' })
    const lifecycle = await sourceLifecycleStore(name)
    const revision = await (await lifecycle.gitRepository()).acceptRevision({
      project: name,
      files: [{ path: 'main.md', content: '# built' }],
      message: 'proposal',
    })

    let handlers
    const replies = new Map()
    const transport = {
      start(_job, nextHandlers) {
        handlers = nextHandlers
        return { cancel() {} }
      },
    }
    const queue = createDispatcherWithOptions(transport, {
      notifyHeadChanged: notificationFails ? async () => { throw new Error('git fetch failed') } : undefined,
    })
    await queue.admitBuild(name, { revision, daemonId: 'mini:testing', branch: 'main' })

    const rpc = (id, method, args) => new Promise(resolve => {
      replies.set(id, resolve)
      handlers.onMessage({ t: 'rpc', id, m: method, a: args }, {
        send(message) {
          if (message.t === 'rpc-result') replies.get(message.id)?.(message)
        },
      })
    })
    const publishReply = await rpc('publish', 'publishBuildInstance', [
      name, revision, 1, instance(instanceRoot, name, { output }), [], null,
    ])

    if (!publishReply.ok) {
      await rpc('failed', 'recordBuildResult', [name, revision, 1, 'build_failed', { error: publishReply.error }])
      handlers.onMessage({ t: 'done', ok: false, error: publishReply.error })
      await handlers.onExit(1)
    } else {
      handlers.onMessage({ t: 'done', ok: true })
      await handlers.onExit(0)
    }

    return {
      publishReply,
      queueState: queue.store.get(name, revision).state,
      status: projectRevisionStatus(lifecycle.listRevisionLifecycles(name)),
    }
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
    rmSync(instanceRoot, { recursive: true, force: true })
  }
}

test('a source-room notification failure leaves the published dispatcher job successful', async () => {
  const result = await run({ notificationFails: true })

  assert.equal(result.publishReply.ok, true)
  assert.equal(result.queueState, 'complete')
  assert.equal(result.status.status, 'success')
  assert.equal(result.status.build.state, 'built')
})

test('a genuine publication failure still fails the dispatcher job and build status', async () => {
  const result = await run({ output: false })

  assert.equal(result.publishReply.ok, false)
  assert.match(result.publishReply.error, /has no output to publish/)
  assert.equal(result.queueState, 'failed')
  assert.equal(result.status.status, 'error')
  assert.equal(result.status.build.state, 'build_failed')
})

// A build that rendered fine but publishes second is STALE, not failed: the
// publication is refused as superseded, with its reason, and that refusal is
// a result the worker acts on -- not an error it reports. Throwing here used
// to route the loser into the worker's failure catch, which announced a build
// failure (card, signals, build_failed lifecycle) for a build that rendered
// fine, while its sentinel write was skipped as stale-seq -- a failure
// notification with nothing behind it.
async function runStaleLoser() {
  const root = mkdtempSync(join(tmpdir(), 'tlda-dispatch-stale-'))
  const newRoot = mkdtempSync(join(tmpdir(), 'tlda-dispatch-stale-new-'))
  const oldRoot = mkdtempSync(join(tmpdir(), 'tlda-dispatch-stale-old-'))
  const name = 'paper'
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'main.md', format: 'markdown' })
    const lifecycle = await sourceLifecycleStore(name)
    const git = await lifecycle.gitRepository()
    const older = await git.acceptRevision({
      project: name, files: [{ path: 'main.md', content: 'old' }], message: 'base',
    })
    await git.advanceHead(name, older, null)
    const newer = await git.acceptRevision({
      project: name, parent: older, files: [{ path: 'main.md', content: 'new' }], message: 'next',
    })

    const captured = {}
    const transport = {
      start(job, nextHandlers) {
        captured[job.sourceRevision] = nextHandlers
        return { cancel() {} }
      },
    }
    const queue = createDispatcherWithOptions(transport, {})
    await queue.admitBuild(name, { revision: older, daemonId: 'mini:testing', branch: 'main' })
    await queue.admitBuild(name, { revision: newer, daemonId: 'mini:testing', branch: 'main' })

    const rpc = (handlers, id, method, args) => new Promise(resolve => {
      handlers.onMessage({ t: 'rpc', id, m: method, a: args }, {
        send(message) {
          if (message.t === 'rpc-result') resolve(message)
        },
      })
    })
    // The winner publishes first, through the real relay.
    const winReply = await rpc(captured[newer], 'publish-new', 'publishBuildInstance', [
      name, newer, 2, instance(newRoot, name), [], null,
    ])
    assert.equal(winReply.ok, true)
    // The loser publishes second: refused as stale, returned -- not thrown.
    const staleReply = await rpc(captured[older], 'publish-old', 'publishBuildInstance', [
      name, older, 1, instance(oldRoot, name), [], null,
    ])

    // The fixed worker on a stale result: no recordBuildResult (the
    // 'superseded' record stands), no failure report -- a quiet done.
    captured[older].onMessage({ t: 'done', ok: true })
    await captured[older].onExit(0)
    captured[newer].onMessage({ t: 'done', ok: true })
    await captured[newer].onExit(0)

    const loserRow = lifecycle.listRevisionLifecycles(name).find(r => r.sourceRevision === older)
    return {
      staleReply,
      loserBuild: loserRow.build,
      loserQueueState: queue.store.get(name, older).state,
      status: projectRevisionStatus(lifecycle.listRevisionLifecycles(name)),
    }
  } finally {
    await closeProjectStore()
    for (const dir of [root, newRoot, oldRoot]) rmSync(dir, { recursive: true, force: true })
  }
}

test('a stale publication resolves as superseded, never as a failure', async () => {
  const result = await runStaleLoser()

  assert.equal(result.staleReply.ok, true, 'stale is a result, not an RPC error')
  assert.equal(result.staleReply.result?.published, false)
  assert.equal(result.staleReply.result?.stale, true)
  assert.equal(result.loserBuild.state, 'superseded', 'the refusal record stands; nothing clobbers it to build_failed')
  assert.notEqual(result.loserQueueState, 'failed', 'a superseded attempt never settles failed')
  assert.equal(result.status.status, 'success', 'the winner is the latest revision and it built')
})
