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
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  closeProjectStore, createProject, initProjectStore, outputDir,
  projectDir, sourceLifecycleStore, updateProject,
} from '../server/lib/project-store.mjs'

// The old accept (`processProjectPush` -> `lifecycle.bootstrap`/`.submit`,
// manifest-diff bookkeeping over a directory-per-revision store) is being
// deleted. Seeding now goes the way a real checkout does: build the files as
// a real git commit and hand the lifecycle a bundle, exactly like
// `bin/a-checkout-proposes-a-commit-test.mjs` proves the wire for. This test's
// subject -- reading one file's bytes without touching any other file's --
// is unaffected by the switch: `readRevisionFile` already reads git objects
// for a commit-id revision (`gitRevision` in source-lifecycle.mjs), so only
// how the revision gets created changes here, not what is asserted about it.

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

  const files = [
    { path: 'main.tex', content: 'the book\n' },
    { path: TARGET, content: TARGET_TEXT },
  ]
  for (let i = 0; i < CHAPTERS; i++) {
    files.push({ path: `chapters/ch-${i}.tex`, content: OTHER_TEXT })
  }

  // Build the book as a real git commit, the way a checkout proposes one --
  // see bin/a-checkout-proposes-a-commit-test.mjs for the reference pattern.
  const checkout = mkdtempSync(join(tmpdir(), 'tlda-one-file-checkout-'))
  const git = (args, opts = {}) => {
    const r = spawnSync('git', args, { cwd: checkout, encoding: 'utf8', ...opts })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
    return r.stdout.trim()
  }
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'the author'])
  git(['config', 'user.email', 'author@example.test'])
  const indexInfo = files.map(file => {
    const sha = git(['hash-object', '-w', '--stdin'], { input: file.content })
    return `100644 blob ${sha}\t${file.path}`
  }).join('\n') + '\n'
  git(['update-index', '--index-info'], { input: indexInfo })
  const tree = git(['write-tree'])
  const commit = git(['commit-tree', tree, '-m', 'the book'])
  const bundlePath = join(checkout, 'seed.bundle')
  git(['update-ref', 'refs/heads/main', commit])
  git(['bundle', 'create', bundlePath, 'main'])

  const lifecycle = await sourceLifecycleStore(NAME)
  const accepted = await lifecycle.acceptBundle(bundlePath)
  assert.equal(accepted.ok, true, `the book had to exist first: ${JSON.stringify(accepted)}`)

  const revision = (await lifecycle.readAuthority()).currentRevision

  // ### The book is stored as blobs, not as one document
  const snapshot = await lifecycle.readRevision(revision)
  const inlined = snapshot.files.filter(file => file.content !== undefined)
  assert.equal(
    inlined.length, 0,
    'the revision — every entry is a reference, not content',
  )
  const target = snapshot.files.find(file => file.path === TARGET)
  assert.ok(target?.sha256, 'the revision — the file we open is named by a hash; otherwise there is no blob to read and the story below is about nothing')

  // ### Reading one file does not read any other file's bytes
  const before = String(await lifecycle.readRevisionFile(revision, TARGET))
  assert.equal(before, TARGET_TEXT, 'the file we open — its own text; otherwise the read is already wrong before we prove anything about it')

  // Take every other chapter's bytes away. If the read still works, it never
  // needed them. Blobs now live as git loose objects under the lifecycle's own
  // bare repo (`.source-lifecycle/git/objects/<sha[0:2]>/<sha[2:]>`), not the
  // old `blobs/<sha>` directory — the sha itself is a git blob sha (40 hex)
  // rather than the old 64-hex sha256, per readManifest in source-git-store.mjs.
  // `acceptBundle` ingests via `git fetch` from a bundle, which packs the
  // incoming objects rather than leaving them loose -- so there is no
  // single per-blob file to delete straight off. Unpack the bare repo's own
  // pack into loose objects first; this only changes how the objects are
  // *stored* on disk, not what `readBlobBytes` does to read one (`git
  // cat-file blob <sha>`, which does not care whether its target is loose or
  // packed), so it does not weaken what the deletion-and-control below proves.
  const gitDir = join(projectDir(NAME), '.source-lifecycle', 'git')
  const packFile = spawnSync('sh', ['-c', 'ls objects/pack/*.pack'], { cwd: gitDir, encoding: 'utf8' }).stdout.trim()
  assert.ok(packFile, 'the ingest — produced a pack to unpack; otherwise this setup step needs a different approach')
  const packBytes = readFileSync(join(gitDir, packFile))
  // `unpack-objects` skips writing an object it can already find -- which,
  // with the pack still present, is every object in it. Remove the pack
  // first so unpacking the same bytes actually lands loose copies.
  spawnSync('sh', ['-c', 'rm -f objects/pack/*.pack objects/pack/*.idx objects/pack/*.rev'], { cwd: gitDir })
  const unpack = spawnSync('git', ['unpack-objects'], {
    cwd: gitDir, env: { ...process.env, GIT_DIR: gitDir },
    input: packBytes,
  })
  assert.equal(unpack.status, 0, `git unpack-objects: ${unpack.stderr}`)

  const keep = new Set([target.sha256, snapshot.files.find(f => f.path === 'main.tex')?.sha256])
  let removed = 0
  for (const file of snapshot.files) {
    if (!file.sha256 || keep.has(file.sha256)) continue
    const path = join(gitDir, 'objects', file.sha256.slice(0, 2), file.sha256.slice(2))
    if (existsSync(path)) { rmSync(path); removed++ }
  }
  assert.ok(removed > 0, 'the book — other chapters had blobs to remove; otherwise nothing was deleted and the assertion below proves nothing')

  const after = String(await lifecycle.readRevisionFile(revision, TARGET))
  assert.equal(
    after, TARGET_TEXT,
    "the file we open — still its own text with other chapters' bytes deleted",
  )

  // ### The control: the deletion was real
  // Without this, an inlined or cached read passes the assertion above while
  // reading everything — a green that means nothing.
  // `readBlobBytes` catches a failing `git cat-file` and returns null rather
  // than throwing, and `entryContent` turns that null into the same
  // "Corrupt revision file entry" it always has -- a blob a revision's tree
  // names but the object store does not have is a corrupt revision, a
  // different fact from "no such path" and it must not wear the same value.
  const gone = snapshot.files.find(file => file.sha256 && !keep.has(file.sha256))
  await assert.rejects(
    () => lifecycle.readRevisionFile(revision, gone.path),
    /Corrupt revision file entry/,
    'the deleted chapter — unreadable now its blob is deleted',
  )

  // ### And a path that was never in the book is absent, not corrupt
  assert.equal(
    await lifecycle.readRevisionFile(revision, 'chapters/never-written.tex'), null,
    'a file nobody wrote — absent',
  )

  console.log('one file out of a big book: reading it does not read the book')
} finally {
  await closeProjectStore()
}
