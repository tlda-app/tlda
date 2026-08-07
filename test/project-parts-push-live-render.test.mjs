/**
 * Project membership, and whether a shared Markdown file stays live.
 *
 * Skip's rule: a file belongs to a project because something refers to it.
 * Two seeds — the main file, and anything referenced in chat — closed under
 * references, recursively. Not by extension, not by sitting in the directory.
 *
 * This is tested rather than left to direct verification because the failure is
 * silent in both directions. Nothing built, so nothing errored, so nothing
 * surfaced: he read a stale outline for eleven minutes with no indication it
 * was stale. And the opposite mistake is just as quiet — 1290 Markdown files
 * sit beside `bregman-lower-bound.tex`, and a rule that admits them all reads
 * as "working" until the pushes are counted.
 *
 * Every test asserts the precondition its verdict depends on. The first version
 * of the probe behind this file reported both arms "stale" when in fact the
 * push had been rejected and the code under test was never reached.
 */

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { isSourceFilePath, normalizeSourceManifest } from '../shared/source-manifest.mjs'
import { collectProjectSourceHashes } from '../cli/lib/source-files.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'
import { realizeProjectMarkdownArtifact } from '../server/lib/project-artifact-materializer.mjs'
import {
  createProject,
  initProjectStore,
  hashSourceFiles,
  projectPartsRoot,
  readProjectPartsManifest,
  sourceDir,
  closeProjectStore,
} from '../server/lib/project-store.mjs'
import { initSyncRooms, closeAllRooms } from '../server/lib/sync-rooms.mjs'
import { createSourceSync } from '../daemon/source-sync.mjs'

const LATEX = { format: 'svg', mainFile: 'bregman-lower-bound.tex' }

afterEach(() => {
  closeAllRooms()
})

async function setupSvgProject(name) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-md-liveness-'))
  const projectsDir = join(root, 'projects')
  const authorDir = join(root, 'author')
  mkdirSync(projectsDir, { recursive: true })
  mkdirSync(authorDir, { recursive: true })
  await initProjectStore(projectsDir)
  initSyncRooms(projectsDir)
  createProject({ name, mainFile: LATEX.mainFile, format: 'svg', sourceDir: authorDir })
  return { root, authorDir }
}

test('a chat reference makes a file a member; sitting beside the paper does not', () => {
  const referenced = { ...LATEX, referencedRoots: ['b4-outline.md'] }

  // The regression. This is the file Skip was reading.
  assert.equal(isSourceFilePath('b4-outline.md', referenced), true)

  // The other half of the rule, and the reason restoring the pre-f6ffdae9d
  // behaviour was wrong: a Markdown file nothing refers to is not a member.
  assert.equal(isSourceFilePath('anticoncentration.md', referenced), false)
  assert.equal(isSourceFilePath('b4-outline.md', LATEX), false, 'no reference, no membership')

  // Precondition: the predicate can still say no for the ordinary reasons, so
  // the trues above are the reference doing the work and not a blanket yes.
  assert.equal(isSourceFilePath('bregman-lower-bound.aux', referenced), false, 'build junk is never a member')
  assert.equal(
    isSourceFilePath('bregman-lower-bound.aux', { ...LATEX, referencedRoots: ['bregman-lower-bound.aux'] }),
    false,
    'not even when referenced — build output is the server\'s, not the author\'s',
  )

  assert.deepEqual(
    normalizeSourceManifest(['b4-outline.md', 'anticoncentration.md', 'main.aux'], referenced),
    ['b4-outline.md'],
  )
})

test('a reference outside the project tree is not a member, and says so by absence', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-md-reference-boundary-'))
  const outside = mkdtempSync(join(tmpdir(), 'tlda-md-reference-outside-'))
  try {
    writeFileSync(join(root, LATEX.mainFile), '\\documentclass{article}\n')
    writeFileSync(join(root, 'b4-outline.md'), '# inside\n')
    writeFileSync(join(outside, 'scratch.md'), '# outside\n')

    const hashes = collectProjectSourceHashes(root, {
      ...LATEX,
      referencedSourcePaths: [join(root, 'b4-outline.md'), join(outside, 'scratch.md')],
    })
    assert.equal('b4-outline.md' in hashes, true)
    // No project-relative coordinate and no watcher over it. Dropped here rather
    // than half-supported — there is nothing downstream that could keep it live.
    assert.equal('scratch.md' in hashes, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('membership is recursive: a referenced file drags in what it references', () => {
  // The case a two-rule implementation gets wrong. `b4-outline.md` is a root by
  // the chat reference; the figure it embeds is a member because the root
  // refers to it, not because anyone referenced it in chat.
  const root = mkdtempSync(join(tmpdir(), 'tlda-md-closure-'))
  try {
    // The reached file is a `.md` deliberately. An `.svg` would pass by
    // extension whatever the closure did, so the test would say "recursive
    // membership works" on an implementation that has none — which is what the
    // first version of this test did.
    writeFileSync(join(root, 'b4-outline.md'), '# outline\n\nSee [the tail bound](notes/tails.md).\n')
    mkdirSync(join(root, 'notes'), { recursive: true })
    writeFileSync(join(root, 'notes', 'tails.md'), '# tails\n')
    writeFileSync(join(root, 'notes', 'unreferenced.md'), '# nobody points here\n')

    const hashes = collectProjectSourceHashes(root, {
      ...LATEX,
      referencedSourcePaths: [join(root, 'b4-outline.md')],
    })
    assert.equal('b4-outline.md' in hashes, true, 'precondition: the root is a member')
    assert.equal(
      'notes/tails.md' in collectProjectSourceHashes(root, LATEX),
      false,
      'precondition: nothing but the closure could admit this path',
    )

    assert.equal('notes/tails.md' in hashes, true, 'reached from the root')
    assert.equal('notes/unreferenced.md' in hashes, false, 'sits beside it, reached by nothing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the daemon adds a new chat root and its closure to the live watcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-md-daemon-reference-'))
  const bindings = join(root, 'source-bindings.json')
  const sent = []
  const watchers = []
  const watch = paths => {
    watchers.push(paths)
    return { on() { return this }, close() {} }
  }
  const sync = createSourceSync({
    sourceBindingsFile: bindings,
    log: { info() {}, warn() {}, error() {} },
    sendMsg(message) { sent.push(message); return true },
    isConnected() { return true },
    resolveEditor() { return null },
    reconcileIntervalMs: 60_000,
    watch,
  })

  try {
    mkdirSync(join(root, 'notes'), { recursive: true })
    writeFileSync(join(root, LATEX.mainFile), '\\documentclass{article}\n')
    writeFileSync(join(root, 'b4-outline.md'), '# outline\n\nSee [the tail bound](notes/tails.md).\n')
    writeFileSync(join(root, 'notes/tails.md'), '# tails\n')
    writeFileSync(join(root, 'notes/unreferenced.md'), '# nobody points here\n')

    sync.bindSource('daemon-live-reference', root)
    sync.sync([{ name: 'daemon-live-reference', ...LATEX, sourceRevision: null, sourceManifest: [LATEX.mainFile] }])
    assert.equal(watchers.at(-1).length, 1, 'precondition: before the chat reference only the main file is watched')

    sync.sync([{
      name: 'daemon-live-reference',
      ...LATEX,
      sourceRevision: null,
      sourceManifest: [LATEX.mainFile],
      referencedSourcePaths: [join(root, 'b4-outline.md')],
    }])
    await new Promise(resolve => setTimeout(resolve, 350))

    assert.equal(sent.length, 1, 'adding the reference schedules its initial source push')
    const pushed = sent[0]
    assert.deepEqual(pushed.files.map(file => file.path).sort(), ['b4-outline.md', 'notes/tails.md'])
    assert.equal(pushed.sourceManifest.includes('b4-outline.md'), true)
    assert.equal(pushed.sourceManifest.includes('notes/tails.md'), true)
    assert.equal(pushed.sourceManifest.includes('notes/unreferenced.md'), false)
    assert.equal(watchers.at(-1).some(file => file.endsWith('/b4-outline.md')), true)
    assert.equal(watchers.at(-1).some(file => file.endsWith('/notes/tails.md')), true)
    assert.equal(watchers.at(-1).some(file => file.endsWith('/notes/unreferenced.md')), false)
  } finally {
    sync.closeAll()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file the client never pushed is still not adopted as source', async () => {
  // The ownership property f6ffdae9d exists for. It is enforced by the client
  // manifest, not by the extension test, so widening membership does not touch
  // it — and this is the assertion that proves that rather than asserting it.
  const name = 'ownership-check'
  const { root } = await setupSvgProject(name)
  try {
    const pushed = await processProjectPush(name, {
      expectedRevision: null,
      files: [{ path: LATEX.mainFile, content: '\\documentclass{article}\n' }],
      sourceManifest: [LATEX.mainFile],
    })
    // Precondition: the walk does pick a declared file up, so an empty result
    // below is ownership and not an empty directory walk.
    assert.equal(pushed.ok, true, pushed.error)
    assert.deepEqual(Object.keys(await hashSourceFiles(name)), [LATEX.mainFile])

    // Now put files on disk that no client ever declared. Neither is source,
    // whatever its extension — this is the property f6ffdae9d exists for, and
    // it is enforced by the client manifest rather than by the extension test,
    // which is why widening membership does not weaken it.
    writeFileSync(join(sourceDir(name), 'README.md'), '# legacy unowned file\n')
    writeFileSync(join(sourceDir(name), 'stray.tex'), 'unowned too\n')

    assert.deepEqual(Object.keys(await hashSourceFiles(name)), [LATEX.mainFile])
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('pushing a chat-referenced file rematerializes the column made from it', async () => {
  const name = 'column-follows-file'
  const { root, authorDir } = await setupSvgProject(name)
  try {
    // Production shape: the chip carries the path on the AUTHOR'S machine, and
    // that is what gets recorded. Using the server's own path here would make
    // the comparison trivially succeed and prove nothing about the real one.
    const sourcePath = join(authorDir, 'b4-outline.md')
    const created = await realizeProjectMarkdownArtifact({
      project: name,
      markdown: '# Lemma B.4 outline\n\nOld body.\n',
      sourcePath,
      idFactory: () => '11111111-2222-4333-8444-555555555555',
    })
    assert.equal(created.ready, true, 'precondition: the artifact materialized')

    const roots = (await readProjectPartsManifest(name)).parts.map(part => part.metadata?.sourcePath).filter(Boolean)
    assert.deepEqual(roots, [sourcePath], 'precondition: the reference is recorded as an author-machine path')
    assert.notEqual(
      sourcePath,
      resolve(sourceDir(name), 'b4-outline.md'),
      'precondition: the two namespaces really are different, or this test proves nothing',
    )

    const manifest = [LATEX.mainFile, 'b4-outline.md', 'notes/tails.md']
    const boot = await processProjectPush(name, {
      expectedRevision: null,
      files: [
        { path: LATEX.mainFile, content: '\\documentclass{article}\n\\begin{document}\nPaper.\n\\end{document}\n' },
        { path: 'b4-outline.md', content: '# Lemma B.4 outline\n\nOld body.\n\nSee [the tail bound](notes/tails.md).\n' },
        { path: 'notes/tails.md', content: '# Tail bound\n' },
      ],
      sourceManifest: manifest,
    })
    assert.equal(boot.ok, true, `precondition: the referenced .md is accepted as source — ${boot.error}`)
    const serverHashes = await hashSourceFiles(name)
    assert.equal('b4-outline.md' in serverHashes, true, 'the chat root remains server-owned source after the push')
    assert.equal('notes/tails.md' in serverHashes, true, 'the recursive dependency remains server-owned source')

    const unreferenced = await processProjectPush(name, {
      expectedRevision: boot.sourceRevision,
      files: [{ path: 'notes/unreferenced.md', content: '# nobody points here\n' }],
      sourceManifest: [...manifest, 'notes/unreferenced.md'],
    })
    assert.equal(unreferenced.ok, false, 'a file reached by nothing is not a member')
    assert.match(unreferenced.error, /not an authored source path/)

    const result = await processProjectPush(name, {
      expectedRevision: boot.sourceRevision,
      files: [{ path: 'b4-outline.md', content: '# Lemma B.4 outline\n\nNew body.\n\nSee [the tail bound](notes/tails.md).\n' }],
      sourceManifest: manifest,
    })
    assert.equal(result.ok, true, `precondition: the push landed — a rejected push reaches none of the below: ${result.error}`)

    const materialized = readFileSync(join(projectPartsRoot(name), created.projectPath), 'utf8')
    assert.match(materialized, /New body\./)
    assert.doesNotMatch(materialized, /Old body\./)

    // One column, not two. Rematerializing through the create path would mint a
    // duplicate for the same file, and the duplicate would go stale in its turn.
    assert.equal((await readProjectPartsManifest(name)).parts.length, 1)
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
