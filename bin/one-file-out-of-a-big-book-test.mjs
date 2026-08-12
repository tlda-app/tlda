#!/usr/bin/env node
// Opening one file from a big book.
//
// The classroom book is 1492 files. Before the blob store, opening any one of
// them read and parsed the whole project snapshot — 525 MB — which is not slow
// but impossible: it exceeds V8's maximum string length and throws.
//
// ---------------------------------------------------------------------------
// What this asserts, and what it deliberately does not
//
// NOT that reading one file is O(1) in project size. It isn't, today:
// `revision(id)` re-reads and re-parses the whole `snapshot.json` and then does
// a linear `.find()` over its entries, uncached. So the cost still grows with
// how MANY files exist. A story asserting O(1) would go red on merge and would
// be asserting a promise nobody made.
//
// What the blob store actually bought is the thing worth guarding:
// **reading one file's bytes does not read any other file's bytes.** A v2
// snapshot entry carries a hash, not content, so the parse is one line per file
// rather than one file's worth per file. That is 525 MB to 259 KB on the
// classroom book — a cliff turned into an affordable slope.
//
// ---------------------------------------------------------------------------
// The instrument: no clock, no counter, no monkeypatching
//
// Delete every other file's blob and read the target anyway. If it still
// returns the right bytes, it demonstrably did not need them — that is the
// property, proven by making the alternative impossible rather than by timing
// it.
//
// The control matters as much as the assertion: after the deletion, reading a
// file whose blob is gone must fail. Without that, a cached or inlined read
// would pass this vacuously, which is the shape of every green that means
// nothing.
import assert from 'assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  closeProjectStore, createProject, initProjectStore, outputDir,
  projectDir, sourceLifecycleStore, updateProject,
} from '../server/lib/project-store.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-one-file-'))
await initProjectStore(root)

const NAME = 'a-big-book'
const CHAPTERS = 40
const TARGET = 'chapters/the-one-we-open.tex'
const TARGET_TEXT = 'the paragraph a person came here to read\n'
// Long enough that inlining it would be visible, short enough to stay cheap.
const OTHER_TEXT = 'a chapter of prose that nobody is opening right now.\n'.repeat(50)

try {
  // ## Opening one file out of a big book
  createProject({ name: NAME, title: NAME, mainFile: 'main.tex', format: 'svg' })
  await updateProject(NAME, { pages: 1, buildStatus: 'success' })
  mkdirSync(outputDir(NAME), { recursive: true })
  writeFileSync(join(outputDir(NAME), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))

  const manifest = ['main.tex', TARGET]
  const files = [
    { path: 'main.tex', content: 'the book\n' },
    { path: TARGET, content: TARGET_TEXT },
  ]
  for (let i = 0; i < CHAPTERS; i++) {
    manifest.push(`chapters/ch-${i}.tex`)
    files.push({ path: `chapters/ch-${i}.tex`, content: OTHER_TEXT })
  }

  const pushed = await processProjectPush(NAME, { expectedRevision: null, sourceManifest: manifest, files })
  assert.equal(pushed.status, 200, `the book had to exist first: ${pushed.error}`)

  const lifecycle = await sourceLifecycleStore(NAME)
  const revision = lifecycle.readAuthority().currentRevision

  // ### The book is stored as blobs, not as one document
  const snapshot = lifecycle.readRevision(revision)
  const inlined = snapshot.files.filter(file => file.content !== undefined)
  assert.equal(
    inlined.length, 0,
    'the revision — every entry is a reference, not content',
  )
  const target = snapshot.files.find(file => file.path === TARGET)
  assert.ok(target?.sha256, 'the revision — the file we open is named by a hash; otherwise there is no blob to read and the story below is about nothing')

  // ### Reading one file does not read any other file's bytes
  const before = String(lifecycle.readRevisionFile(revision, TARGET))
  assert.equal(before, TARGET_TEXT, 'the file we open — its own text; otherwise the read is already wrong before we prove anything about it')

  // Take every other chapter's bytes away. If the read still works, it never
  // needed them.
  const keep = new Set([target.sha256, snapshot.files.find(f => f.path === 'main.tex')?.sha256])
  let removed = 0
  for (const file of snapshot.files) {
    if (!file.sha256 || keep.has(file.sha256)) continue
    const path = join(projectDir(NAME), '.source-lifecycle', 'blobs', file.sha256.slice(0, 2), file.sha256)
    if (existsSync(path)) { rmSync(path); removed++ }
  }
  assert.ok(removed > 0, 'the book — other chapters had blobs to remove; otherwise nothing was deleted and the assertion below proves nothing')

  const after = String(lifecycle.readRevisionFile(revision, TARGET))
  assert.equal(
    after, TARGET_TEXT,
    "the file we open — still its own text with other chapters' bytes deleted",
  )

  // ### The control: the deletion was real
  // Without this, an inlined or cached read passes the assertion above while
  // reading everything — a green that means nothing.
  // It throws rather than returning null, and that is 19c033441: a sha256
  // naming a blob that is not there is a corrupt revision, which is a
  // different fact from "no such path" and no longer wears the same value.
  const gone = snapshot.files.find(file => file.sha256 && !keep.has(file.sha256))
  assert.throws(
    () => lifecycle.readRevisionFile(revision, gone.path),
    /Corrupt revision file entry/,
    'the deleted chapter — unreadable now its blob is deleted',
  )

  // ### And a path that was never in the book is absent, not corrupt
  assert.equal(
    lifecycle.readRevisionFile(revision, 'chapters/never-written.tex'), null,
    'a file nobody wrote — absent',
  )

  console.log('one file out of a big book: reading it does not read the book')
} finally {
  await closeProjectStore()
}
