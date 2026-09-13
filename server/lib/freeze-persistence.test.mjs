// Quarto's `_freeze` is what makes a build replay stored results instead of
// re-running R. Until now it did not survive a build: it lives in the render
// directory, and `retainNativeTldaRender` deletes everything there except the
// book. So the cache only ever improved when Skip committed records a LOCAL
// build produced — a build on the server threw its own away.
//
// The property under test is that, and not the plumbing: a record written
// during build N is present AND USABLE at the start of build N+1. Usable means
// its `hash` still matches the md5 of the source document, because that is the
// only thing Quarto checks before deciding to re-execute. A test that proves a
// directory moved proves nothing about whether the next build reuses it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  stageFreezeIntoRender,
  retainFreezeOutsideRender,
  retainNativeTldaRender,
} from './build-qmd.mjs'

const md5 = buffer => createHash('md5').update(buffer).digest('hex')

const freezeRecord = (root, doc, hash, marker) => {
  const dir = join(root, '_freeze', doc, 'execute-results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'html.json'), JSON.stringify({ hash, result: { marker } }))
}

const readRecord = (root, doc) =>
  JSON.parse(readFileSync(join(root, '_freeze', doc, 'execute-results', 'html.json'), 'utf8'))

// One build instance: `<project>/output` is the render root, and anything
// persisted lives beside it under `<project>/`.
const instance = () => {
  const project = mkdtempSync(join(tmpdir(), 'freeze-instance-'))
  const outDir = join(project, 'output')
  mkdirSync(outDir, { recursive: true })
  return { project, outDir }
}

test('a record written during a build is present and usable at the start of the next', () => {
  const source = Buffer.from('---\ntitle: Ch\n---\n\n```{r}\nrnorm(1)\n```\n')
  const sourceHash = md5(source)

  // --- build N -----------------------------------------------------------
  const one = instance()
  try {
    // Quarto executes and writes a freeze record into the render directory.
    freezeRecord(one.outDir, 'lectures/ch', sourceHash, 'computed-in-build-N')
    // The book, so the sweep has something to keep.
    mkdirSync(join(one.outDir, '_book'), { recursive: true })
    writeFileSync(join(one.outDir, '_book', 'tlda-manifest.json'), '{}')
    // The build's own copy of the source, which the sweep removes.
    mkdirSync(join(one.outDir, 'scratch'), { recursive: true })
    writeFileSync(join(one.outDir, 'scratch', 'internal.md'), 'copied source')

    retainFreezeOutsideRender(one.outDir)
    retainNativeTldaRender(one.outDir, join(one.outDir, '_book', 'tlda-manifest.json'))

    // The sweep still does its job, and the freeze is not in what it kept.
    assert.equal(existsSync(join(one.outDir, 'scratch')), false, 'sweep must still remove the copied source tree')
    assert.equal(existsSync(join(one.outDir, '_freeze')), false, 'freeze must not remain in the published tree')
    assert.ok(existsSync(join(one.project, '_freeze')), 'freeze must survive beside the output')

    // --- what publish/seed carry between builds: the sibling directory ----
    const two = instance()
    try {
      // seed: the persisted directory arrives beside the new instance's output
      const carried = join(two.project, '_freeze')
      mkdirSync(dirname(carried), { recursive: true })
      cpSync(join(one.project, '_freeze'), carried, { recursive: true })

      // the revision's own (STALE) copy of the same record lands via the
      // source copy, before staging
      freezeRecord(two.outDir, 'lectures/ch', 'stale-committed-hash', 'from-the-revision')

      stageFreezeIntoRender(two.outDir)

      const record = readRecord(two.outDir, 'lectures/ch')
      assert.equal(record.result.marker, 'computed-in-build-N',
        'the record build N computed must be the one build N+1 sees')
      assert.equal(record.hash, sourceHash,
        'and it must still match the source md5, or Quarto re-executes anyway')
    } finally { rmSync(two.project, { recursive: true, force: true }) }
  } finally { rmSync(one.project, { recursive: true, force: true }) }
})

test('a chapter the server has never built keeps the record from the revision', () => {
  // Persisted must win where they collide, but must not erase what it lacks:
  // a chapter only ever built on his machine has no server-side record.
  const one = instance()
  try {
    freezeRecord(one.project, 'lectures/served', 'hash-a', 'persisted')
    freezeRecord(one.outDir, 'lectures/served', 'hash-old', 'from-the-revision')
    freezeRecord(one.outDir, 'lectures/never-built-here', 'hash-b', 'from-the-revision')

    stageFreezeIntoRender(one.outDir)

    assert.equal(readRecord(one.outDir, 'lectures/served').result.marker, 'persisted')
    assert.equal(readRecord(one.outDir, 'lectures/never-built-here').result.marker, 'from-the-revision',
      'staging must overlay, not replace the tree')
  } finally { rmSync(one.project, { recursive: true, force: true }) }
})

test('a project with no persisted freeze is untouched', () => {
  const one = instance()
  try {
    freezeRecord(one.outDir, 'lectures/ch', 'hash-a', 'from-the-revision')
    assert.equal(stageFreezeIntoRender(one.outDir), false)
    assert.equal(readRecord(one.outDir, 'lectures/ch').result.marker, 'from-the-revision')
  } finally { rmSync(one.project, { recursive: true, force: true }) }
})

test('a build that rendered no freeze leaves nothing behind', () => {
  const one = instance()
  try {
    assert.equal(retainFreezeOutsideRender(one.outDir), false)
    assert.equal(existsSync(join(one.project, '_freeze')), false)
  } finally { rmSync(one.project, { recursive: true, force: true }) }
})

test('DELIBERATE RED: the property fails if the freeze is not retained before the sweep', () => {
  const one = instance()
  try {
    freezeRecord(one.outDir, 'lectures/ch', 'hash-a', 'computed-in-build-N')
    mkdirSync(join(one.outDir, '_book'), { recursive: true })
    writeFileSync(join(one.outDir, '_book', 'tlda-manifest.json'), '{}')

    // retainFreezeOutsideRender deliberately NOT called — this is the old
    // behaviour, and it must fail. If this test ever passes, the sweep has
    // stopped deleting and the whole mechanism is unnecessary.
    retainNativeTldaRender(one.outDir, join(one.outDir, '_book', 'tlda-manifest.json'))

    assert.ok(existsSync(join(one.project, '_freeze')),
      'expected to fail: without the retain step the sweep destroys the freeze')
  } finally { rmSync(one.project, { recursive: true, force: true }) }
})
