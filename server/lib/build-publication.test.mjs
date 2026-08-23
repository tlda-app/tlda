import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { publishBuildInstance } from './build-dispatch.mjs'
import { closeProjectStore, createProject, initProjectStore, sourceLifecycleStore } from './project-store.mjs'
import { projectRevisionStatus } from './source-lifecycle.mjs'

function instance(root, name, text) {
  const project = join(root, name)
  mkdirSync(join(project, 'source'), { recursive: true })
  mkdirSync(join(project, 'output'), { recursive: true })
  writeFileSync(join(project, 'source', 'main.md'), `${text} source`)
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
    const git = await lifecycle.gitRepository()
    const oldRevision = await git.acceptRevision({
      project: name,
      files: [{ path: 'main.md', content: 'old source' }],
      message: 'shared base',
    })
    await git.advanceHead(name, oldRevision, null)
    const newerRevision = await git.acceptRevision({
      project: name,
      parent: oldRevision,
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
    assert.equal(readFileSync(join(root, name, 'source', 'main.md'), 'utf8'), 'new artifact source')

    const stale = await publishBuildInstance(name, oldRevision, null, oldProject, [])
    assert.equal(stale.published, false)
    assert.equal(stale.stale, true)
    assert.equal(readFileSync(join(root, name, 'output', 'artifact.txt'), 'utf8'), 'new artifact')
    assert.equal(readFileSync(join(root, name, 'source', 'main.md'), 'utf8'), 'new artifact source')
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
    rmSync(oldRoot, { recursive: true, force: true })
    rmSync(newRoot, { recursive: true, force: true })
  }
})

// A build whose changed files are outside the tree the render reads never runs
// the render, so its instance has the EMPTY `output/` that
// materializeBuildInstance creates. Publishing that instance with the default
// item set copies the empty directory over the live one and blanks the
// document — and takes `relevant-files.json` with it, so the NEXT push reads
// `no-relevant-files-yet`, renders, and puts everything back. That self-repair
// is what would have made this intermittent instead of obvious.
//
// The second half of this test is the counterfactual: it does the same publish
// with the default set and asserts the destruction actually happens, so the
// first half cannot pass for a reason other than the one claimed.
test('a source-only publication advances the head without touching the published render', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-source-only-'))
  const builtRoot = mkdtempSync(join(tmpdir(), 'tlda-build-so-built-'))
  const skippedRoot = mkdtempSync(join(tmpdir(), 'tlda-build-so-skipped-'))
  const wipeRoot = mkdtempSync(join(tmpdir(), 'tlda-build-so-wipe-'))
  const name = 'paper'
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'main.md', format: 'markdown' })
    const lifecycle = await sourceLifecycleStore(name)
    const git = await lifecycle.gitRepository()

    const rendered = await git.acceptRevision({
      project: name, files: [{ path: 'main.md', content: 'rendered source' }], message: 'rendered',
    })
    await publishBuildInstance(name, rendered, 1, instance(builtRoot, name, 'the render'), [])
    assert.equal(readFileSync(join(root, name, 'output', 'artifact.txt'), 'utf8'), 'the render')

    // The next revision changes only a file the render never reads.
    const notes = await git.acceptRevision({
      project: name,
      parent: rendered,
      files: [{ path: 'main.md', content: 'rendered source' }, { path: 'notes.md', content: 'unread' }],
      message: 'edit outside the tree',
    })
    // No render ran, so the instance carries source and an empty output.
    const skipped = join(skippedRoot, name)
    mkdirSync(join(skipped, 'source'), { recursive: true })
    mkdirSync(join(skipped, 'output'), { recursive: true })
    writeFileSync(join(skipped, 'source', 'main.md'), 'rendered source')
    writeFileSync(join(skipped, 'source', 'notes.md'), 'unread')

    const result = await publishBuildInstance(name, notes, 2, skipped, [], ['source'])
    assert.equal(result.published, true)
    assert.equal(await git.head(name), notes, 'the head must advance or the push is stranded')
    assert.equal(readFileSync(join(root, name, 'source', 'notes.md'), 'utf8'), 'unread',
      'the pushed file must reach the live source tree')
    assert.equal(readFileSync(join(root, name, 'output', 'artifact.txt'), 'utf8'), 'the render',
      'the published render must survive a build that did not render')
    assert.equal(lifecycle.listRevisionLifecycles(name).find(item => item.sourceRevision === notes)?.build?.state,
      'not_required', 'a revision that did not render must not record itself as built')

    // Counterfactual: the same publication with the default item set is exactly
    // the bug, and it must still be reachable — otherwise the assertion above
    // proves nothing about which argument saved the render.
    const wiped = join(wipeRoot, name)
    mkdirSync(join(wiped, 'source'), { recursive: true })
    mkdirSync(join(wiped, 'output'), { recursive: true })
    writeFileSync(join(wiped, 'source', 'main.md'), 'rendered source')
    const after = await git.acceptRevision({
      project: name, parent: notes, files: [{ path: 'main.md', content: 'rendered source' }], message: 'default set',
    })
    await publishBuildInstance(name, after, 3, wiped, [])
    assert.equal(existsSync(join(root, name, 'output', 'artifact.txt')), false,
      'the default item set replaces output wholesale — if this stops being true the test above is vacuous')
  } finally {
    await closeProjectStore()
    for (const dir of [root, builtRoot, skippedRoot, wipeRoot]) rmSync(dir, { recursive: true, force: true })
  }
})

// The swap moves every replaced item aside whether or not it was staged, so an
// item missing from the instance is a silent deletion rather than a no-op.
// `source` and `output` have no other copy, so their absence must stop the
// publication. This is unreachable today — materializeBuildInstance always
// creates both — and is asserted so it stays that way.
test('an instance missing source or output refuses to publish rather than deleting it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-absent-'))
  const partialRoot = mkdtempSync(join(tmpdir(), 'tlda-build-partial-'))
  const name = 'paper'
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'main.md', format: 'markdown' })
    const lifecycle = await sourceLifecycleStore(name)
    const git = await lifecycle.gitRepository()
    const first = await git.acceptRevision({
      project: name, files: [{ path: 'main.md', content: 'source' }], message: 'first',
    })
    await publishBuildInstance(name, first, 1, instance(partialRoot, name, 'the render'), [])
    assert.equal(readFileSync(join(root, name, 'output', 'artifact.txt'), 'utf8'), 'the render')

    const next = await git.acceptRevision({
      project: name, parent: first, files: [{ path: 'main.md', content: 'edited' }], message: 'next',
    })
    // An instance carrying source but no output, published with the default set.
    const noOutput = join(mkdtempSync(join(tmpdir(), 'tlda-build-no-output-')), name)
    mkdirSync(join(noOutput, 'source'), { recursive: true })
    writeFileSync(join(noOutput, 'source', 'main.md'), 'edited')
    await assert.rejects(
      () => publishBuildInstance(name, next, 2, noOutput, []),
      /has no output to publish/)
    assert.equal(readFileSync(join(root, name, 'output', 'artifact.txt'), 'utf8'), 'the render',
      'the refused publication must leave the render where it was')

    // And the same for source.
    const noSource = join(mkdtempSync(join(tmpdir(), 'tlda-build-no-source-')), name)
    mkdirSync(join(noSource, 'output'), { recursive: true })
    await assert.rejects(
      () => publishBuildInstance(name, next, 2, noSource, []),
      /has no source to publish/)
    // What the first publication installed — the INSTANCE's source, not the
    // revision's, which is why this is the helper's text rather than 'source'.
    assert.equal(readFileSync(join(root, name, 'source', 'main.md'), 'utf8'), 'the render source',
      'the refused publication must leave the source where it was')
  } finally {
    await closeProjectStore()
    for (const dir of [root, partialRoot]) rmSync(dir, { recursive: true, force: true })
  }
})

test('first publication installs public source and records its authoritative revision status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-first-publish-'))
  const instanceRoot = mkdtempSync(join(tmpdir(), 'tlda-build-first-instance-'))
  const name = 'new-paper'
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'main.md', format: 'markdown' })
    const lifecycle = await sourceLifecycleStore(name)
    const git = await lifecycle.gitRepository()
    const revision = await git.acceptRevision({
      project: name,
      files: [{ path: 'main.md', content: '# visible' }],
      message: 'first proposal',
    })
    const built = instance(instanceRoot, name, 'first artifact')
    writeFileSync(join(built, 'source', 'main.md'), '# visible')
    writeFileSync(join(built, 'output', 'index.html'), '<h1>visible</h1>')

    const result = await publishBuildInstance(name, revision, 1, built, [])
    assert.equal(result.published, true)
    assert.equal(readFileSync(join(root, name, 'source', 'main.md'), 'utf8'), '# visible')
    assert.equal(readFileSync(join(root, name, 'output', 'index.html'), 'utf8'), '<h1>visible</h1>')
    assert.deepEqual(projectRevisionStatus(lifecycle.listRevisionLifecycles(name)), {
      status: 'success', phase: null, sourceRevision: revision, acceptSeq: 1,
      build: lifecycle.listRevisionLifecycles(name)[0].build,
      version: undefined, mirror: undefined,
    })
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
    rmSync(instanceRoot, { recursive: true, force: true })
  }
})
