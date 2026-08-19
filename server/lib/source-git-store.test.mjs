import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSourceGitStore } from './source-git-store.mjs'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-git-store-'))
  const gitDir = join(dir, 'repo.git')
  execFileSync('git', ['init', '--bare', '--quiet', gitDir])
  return { dir, gitDir, store: createSourceGitStore({ gitDir }) }
}

test('a revision round-trips: accept, manifest, read one file', async () => {
  const { dir, store } = repo()
  try {
    const first = await store.acceptRevision({
      project: 'paper',
      files: [
        { path: 'main.tex', content: 'one\n' },
        { path: 'figures/a.svg', content: '<svg/>' },
      ],
    })
    const manifest = await store.readManifest(first)
    assert.deepEqual(manifest.map(entry => entry.path), ['figures/a.svg', 'main.tex'])
    assert.equal((await store.readRevisionFile(first, 'main.tex')).toString(), 'one\n')
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
})

test('an unchanged file is not stored again', async () => {
  // The property the previous store lacked: 397 revisions of a project held 397
  // copies of every unchanged file, 13GB for a history git holds in 22MB.
  const { dir, gitDir, store } = repo()
  try {
    const big = 'x'.repeat(200_000)
    let head = await store.acceptRevision({ project: 'paper', files: [{ path: 'big.tex', content: big }, { path: 'main.tex', content: 'v1' }] })
    const afterFirst = Number(execFileSync('git', ['--git-dir', gitDir, 'count-objects', '-v'], { encoding: 'utf8' }).match(/^count: (\d+)/m)[1])

    // **Every revision names BOTH files**, because the tree is the manifest and
    // a member nobody names is a member that left the paper. That is what makes
    // this test the sharper version of itself: the unchanged file is sent every
    // single time and is still stored exactly once, because git addresses blobs
    // by content. Dedup was never a property of sending deltas.
    for (let i = 2; i <= 20; i += 1) {
      head = await store.acceptRevision({
        project: 'paper',
        parent: head,
        files: [{ path: 'big.tex', content: big }, { path: 'main.tex', content: `v${i}` }],
      })
    }
    const afterTwenty = Number(execFileSync('git', ['--git-dir', gitDir, 'count-objects', '-v'], { encoding: 'utf8' }).match(/^count: (\d+)/m)[1])

    // 19 further revisions add a blob, a tree and a commit each — never a
    // second copy of big.tex.
    assert.ok(afterTwenty - afterFirst <= 19 * 3, `objects grew by ${afterTwenty - afterFirst}`)
    assert.equal((await store.readRevisionFile(head, 'big.tex')).toString(), big, 'the unchanged file is still readable at the tip')
    assert.equal((await store.readRevisionFile(head, 'main.tex')).toString(), 'v20')
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
})

test('a ref move is a compare-and-swap, so a lost race fails instead of half-applying', async () => {
  const { dir, store } = repo()
  try {
    const first = await store.acceptRevision({ project: 'paper', files: [{ path: 'main.tex', content: 'one' }] })
    const second = await store.acceptRevision({ project: 'paper', parent: first, files: [{ path: 'main.tex', content: 'two' }] })

    assert.equal(await store.head('paper'), null)
    await store.advanceHead('paper', first, null)
    assert.equal(await store.head('paper'), first)

    await store.advanceHead('paper', second, first)
    assert.equal(await store.head('paper'), second)

    // A writer still holding the old value loses, loudly. This is the case that
    // previously left activeTargetRevision set with nothing to clear it.
    await assert.rejects(() => store.advanceHead('paper', first, first))
    assert.equal(await store.head('paper'), second, 'the head did not move on a failed swap')
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
})

test('stale-base detection is ancestry', async () => {
  const { dir, store } = repo()
  try {
    const base = await store.acceptRevision({ project: 'paper', files: [{ path: 'main.tex', content: 'one' }] })
    const head = await store.acceptRevision({ project: 'paper', parent: base, files: [{ path: 'main.tex', content: 'two' }] })
    const fork = await store.acceptRevision({ project: 'paper', parent: base, files: [{ path: 'main.tex', content: 'other' }] })

    assert.equal(await store.isAncestor(base, head), true, 'an edit based on the head is current')
    assert.equal(await store.isAncestor(fork, head), false, 'an edit based on a fork is stale')
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
})

test('applied, built and mirrored are refs and are independent', async () => {
  const { dir, store } = repo()
  try {
    const one = await store.acceptRevision({ project: 'paper', files: [{ path: 'main.tex', content: 'one' }] })
    const two = await store.acceptRevision({ project: 'paper', parent: one, files: [{ path: 'main.tex', content: 'two' }] })

    await store.markApplied('mini:paper', two, null)
    await store.markBuilt('paper', one, null)

    assert.equal(await store.applied('mini:paper'), two)
    assert.equal(await store.built('paper'), one)
    assert.equal(await store.mirrored('paper'), null)

    // "has this been built" without a status field that can latch
    assert.equal(await store.isAncestor(await store.built('paper'), two), true)
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
})

test('a deletion is a path nobody named, not a path someone listed as deleted', async () => {
  // **Removal used to need its own parameter** — `deleted: ['scratch.tex']` —
  // because the tree was built over the parent's, so a path the caller forgot
  // was inherited rather than dropped. That was safe and it is why a file could
  // outlive its own removal: forgetting looked identical to keeping.
  //
  // Under a complete tree there is nothing to name. Absence IS the removal.
  const { dir, store } = repo()
  try {
    const one = await store.acceptRevision({
      project: 'paper',
      files: [{ path: 'main.tex', content: 'one' }, { path: 'scratch.tex', content: 'notes' }],
    })
    const two = await store.acceptRevision({ project: 'paper', parent: one, files: [{ path: 'main.tex', content: 'one' }] })

    assert.deepEqual((await store.readManifest(two)).map(entry => entry.path), ['main.tex'])
    assert.equal(await store.readRevisionFile(two, 'scratch.tex'), null)
    assert.equal((await store.readRevisionFile(one, 'scratch.tex')).toString(), 'notes', 'the old revision still has it')
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
})
