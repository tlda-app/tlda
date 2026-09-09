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
