import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBuildQueue } from './build-queue.mjs'
import { BuildQueueStore } from './build-queue-store.mjs'
import { deleteProjectAndBuildSubmissions } from './build-dispatch.mjs'
import { closeProjectStore, createProject, initProjectStore } from './project-store.mjs'

test('deleting and recreating a project can retry the same content-addressed revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-recreate-build-'))
  const projectsDir = join(root, 'projects')
  const starts = []
  const store = new BuildQueueStore(join(root, 'build-queue.sqlite'))
  const queue = createBuildQueue({
    store,
    getProjectsDir: () => projectsDir,
    transport: {
      start(job, handlers) {
        starts.push({ job, handlers })
        return { cancel() { void handlers.onExit(null) } }
      },
    },
  }, { maxConcurrency: 1 })

  try {
    await initProjectStore(projectsDir)
    createProject({ name: 'retry-project', title: 'Retry Project' })

    const first = await queue.admitBuild('retry-project', {
      revision: 'same-content-revision', daemonId: 'daemon-a', branch: 'main',
    })
    starts[0].handlers.onMessage({ t: 'done', ok: false, error: 'build failed' })
    await starts[0].handlers.onExit(1)
    assert.equal(store.get('retry-project', 'same-content-revision').state, 'failed')

    await deleteProjectAndBuildSubmissions('retry-project', queue)
    assert.equal(store.get('retry-project', 'same-content-revision'), null)

    createProject({ name: 'retry-project', title: 'Retry Project' })
    const retried = await queue.admitBuild('retry-project', {
      revision: 'same-content-revision', daemonId: 'daemon-a', branch: 'main',
    })

    assert.notEqual(retried.id, first.id)
    assert.equal(starts.length, 2)
    assert.equal(starts[1].job.sourceRevision, 'same-content-revision')
    await starts[1].handlers.onExit(0)
  } finally {
    await closeProjectStore()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing recreated-project lifecycle re-drives only a terminal identical admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-readmit-build-'))
  const starts = []
  const store = new BuildQueueStore(join(root, 'build-queue.sqlite'))
  const queue = createBuildQueue({
    store,
    getProjectsDir: () => join(root, 'projects'),
    transport: {
      start(job, handlers) {
        starts.push({ job, handlers })
        return { cancel() { void handlers.onExit(null) } }
      },
    },
  }, { maxConcurrency: 1 })
  try {
    const proposal = { revision: 'same-revision', daemonId: 'mini-testing', branch: 'main' }
    const first = await queue.admitBuild('paper', proposal)
    starts[0].handlers.onMessage({ t: 'done', ok: false, error: 'old project failed' })
    await starts[0].handlers.onExit(1)

    const retried = await queue.admitBuild('paper', proposal, { retryTerminal: true })
    assert.notEqual(retried.id, first.id)
    assert.equal(starts.length, 2)

    const activeReplay = await queue.admitBuild('paper', proposal, { retryTerminal: true })
    assert.equal(activeReplay.id, retried.id)
    assert.equal(starts.length, 2)
    await starts[1].handlers.onExit(0)

    const currentProjectReplay = await queue.admitBuild('paper', proposal)
    assert.equal(currentProjectReplay.id, retried.id)
    assert.equal(starts.length, 2)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
