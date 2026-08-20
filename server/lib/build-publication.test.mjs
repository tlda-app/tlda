import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { publishBuildInstance } from './build-dispatch.mjs'
import { closeProjectStore, createProject, initProjectStore, sourceLifecycleStore } from './project-store.mjs'

function instance(root, name, text) {
  const project = join(root, name)
  mkdirSync(join(project, 'output'), { recursive: true })
  writeFileSync(join(project, 'output', 'artifact.txt'), text)
  writeFileSync(join(project, 'build.log'), `${text} log`)
  return project
}

test('publication advances the shared head monotonically and a late ancestor publishes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-publish-'))
  const oldRoot = mkdtempSync(join(tmpdir(), 'tlda-build-old-'))
  const newRoot = mkdtempSync(join(tmpdir(), 'tlda-build-new-'))
  const name = 'paper'
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'main.md', format: 'markdown' })
    const lifecycle = await sourceLifecycleStore(name, { context: { referencedRoots: ['main.md'] } })
    const old = await lifecycle.bootstrap({
      expectedRevision: null,
      sourceManifest: ['main.md'],
      files: [{ path: 'main.md', content: 'old source' }],
    })
    const git = await lifecycle.gitRepository()
    const newerRevision = await git.acceptRevision({
      project: name,
      parent: old.authority.currentRevision,
      files: [{ path: 'main.md', content: 'new source' }],
      message: 'new proposal',
    })
    const oldProject = instance(oldRoot, name, 'old artifact')
    const newProject = instance(newRoot, name, 'new artifact')

    assert.equal(readFileSync(join(oldProject, 'output', 'artifact.txt'), 'utf8'), 'old artifact')
    assert.equal(readFileSync(join(newProject, 'output', 'artifact.txt'), 'utf8'), 'new artifact')

    const published = await publishBuildInstance(name, newerRevision, null, newProject, [])
    assert.equal(published.published, true)
    assert.equal(await git.head(name), newerRevision)
    assert.equal(readFileSync(join(root, name, 'output', 'artifact.txt'), 'utf8'), 'new artifact')
    assert.equal(readFileSync(join(root, name, 'build.log'), 'utf8'), 'new artifact log')

    const stale = await publishBuildInstance(name, old.authority.currentRevision, null, oldProject, [])
    assert.equal(stale.published, false)
    assert.equal(stale.stale, true)
    assert.equal(readFileSync(join(root, name, 'output', 'artifact.txt'), 'utf8'), 'new artifact')
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
    rmSync(oldRoot, { recursive: true, force: true })
    rmSync(newRoot, { recursive: true, force: true })
  }
})
