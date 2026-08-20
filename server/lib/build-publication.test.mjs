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

test('only the exact accepted revision can publish its private staged result', async () => {
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
    const newer = await lifecycle.submit({
      expectedRevision: old.authority.currentRevision,
      sourceManifest: ['main.md'],
      files: [{ path: 'main.md', content: 'new source' }],
    })
    const oldProject = instance(oldRoot, name, 'old artifact')
    const newProject = instance(newRoot, name, 'new artifact')

    await assert.rejects(
      publishBuildInstance(name, old.authority.currentRevision, old.authority.acceptSeq, oldProject, []),
      /not authorized/,
    )
    assert.equal(readFileSync(join(oldProject, 'output', 'artifact.txt'), 'utf8'), 'old artifact')
    assert.equal(readFileSync(join(newProject, 'output', 'artifact.txt'), 'utf8'), 'new artifact')

    await publishBuildInstance(name, newer.authority.currentRevision, newer.authority.acceptSeq, newProject, [])
    assert.equal(readFileSync(join(root, name, 'output', 'artifact.txt'), 'utf8'), 'new artifact')
    assert.equal(readFileSync(join(root, name, 'build.log'), 'utf8'), 'new artifact log')

    await assert.rejects(
      publishBuildInstance(name, old.authority.currentRevision, old.authority.acceptSeq, oldProject, []),
      /not authorized/,
    )
    assert.equal(readFileSync(join(root, name, 'output', 'artifact.txt'), 'utf8'), 'new artifact')
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
    rmSync(oldRoot, { recursive: true, force: true })
    rmSync(newRoot, { recursive: true, force: true })
  }
})
