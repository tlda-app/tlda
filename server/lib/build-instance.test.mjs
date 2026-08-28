import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { materializeBuildInstance } from './build-instance.mjs'
import { closeProjectStore, createProject, initProjectStore, setProjectPathOverride, sourceDir, sourceLifecycleStore } from './project-store.mjs'
import { commitSnapshot, shadowRepoDir } from './shadow-repo.mjs'

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

test('materializes tracked symbolic links as links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-instance-symlink-test-'))
  let instance
  try {
    const lifecycle = {
      async readRevision() {
        return { files: [{ path: '_quarto.yml', mode: '120000' }] }
      },
      async readRevisionFile() {
        return Buffer.from('_quarto_book.yml')
      },
    }
    instance = await materializeBuildInstance({
      name: 'course',
      sourceRevision: 'revision',
      lifecycle,
      temporaryRoot: root,
    })
    const link = join(instance.source, '_quarto.yml')
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.equal(readlinkSync(link), '_quarto_book.yml')
  } finally {
    if (instance) rmSync(instance.root, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('version snapshots keep a build instance relative symlink relative', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-shadow-relative-link-test-'))
  let instance
  const name = 'course'
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'index.qmd', format: 'qmd' })
    const lifecycle = await sourceLifecycleStore(name)
    const git = await lifecycle.gitRepository()
    const revision = await git.acceptRevision({
      project: name,
      files: [
        { path: 'index.qmd', content: 'placeholder' },
        { path: 'lectures/lecture.qmd', content: '# Lecture' },
      ],
      message: 'relative-link snapshot',
    })
    instance = await materializeBuildInstance({ name, sourceRevision: revision, lifecycle, temporaryRoot: root })
    unlinkSync(join(instance.source, 'index.qmd'))
    mkdirSync(join(instance.source, 'lectures'), { recursive: true })
    symlinkSync('lectures/lecture.qmd', join(instance.source, 'index.qmd'))
    setProjectPathOverride(name, instance.project)

    const result = await commitSnapshot(name, revision)

    assert.equal(result.status, 'committed')
    assert.equal(readlinkSync(join(shadowRepoDir(name), 'index.qmd')), 'lectures/lecture.qmd')
  } finally {
    setProjectPathOverride(name, null)
    await closeProjectStore()
    if (instance) rmSync(instance.root, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
