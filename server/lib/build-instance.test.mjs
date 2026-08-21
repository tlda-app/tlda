import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { materializeBuildInstance } from './build-instance.mjs'
import { closeProjectStore, createProject, initProjectStore, sourceDir, sourceLifecycleStore } from './project-store.mjs'

test('concurrent same-project instances read immutable revisions and cannot share private writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-instance-test-'))
  const instances = []
  try {
    await initProjectStore(root)
    createProject({ name: 'paper', mainFile: 'main.md', format: 'markdown' })
    const lifecycle = await sourceLifecycleStore('paper', { context: { referencedRoots: ['main.md'] } })
    const old = await lifecycle.bootstrap({
      expectedRevision: null,
      sourceManifest: ['main.md'],
      files: [{ path: 'main.md', content: 'old revision' }],
    })
    const newer = await lifecycle.submit({
      expectedRevision: old.authority.currentRevision,
      sourceManifest: ['main.md'],
      files: [{ path: 'main.md', content: 'new revision' }],
    })
    writeFileSync(join(sourceDir('paper'), 'main.md'), 'mutable working copy')

    instances.push(...await Promise.all([
      materializeBuildInstance({ name: 'paper', sourceRevision: old.authority.currentRevision, lifecycle }),
      materializeBuildInstance({ name: 'paper', sourceRevision: newer.authority.currentRevision, lifecycle }),
    ]))
    assert.notEqual(instances[0].project, instances[1].project)
    assert.equal(readFileSync(join(instances[0].source, 'main.md'), 'utf8'), 'old revision')
    assert.equal(readFileSync(join(instances[1].source, 'main.md'), 'utf8'), 'new revision')

    writeFileSync(join(instances[0].output, 'private.txt'), 'old output')
    assert.throws(() => readFileSync(join(instances[1].output, 'private.txt')), /ENOENT/)
    assert.equal(readFileSync(join(sourceDir('paper'), 'main.md'), 'utf8'), 'mutable working copy')
  } finally {
    await closeProjectStore()
    for (const instance of instances) rmSync(instance.root, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
