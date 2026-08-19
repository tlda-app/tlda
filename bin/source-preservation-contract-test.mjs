#!/usr/bin/env node

// Extracted from bin/source-manifest-contract-test.mjs, 2026-08-19, and this is
// the check pm-sync's note asked for before that file is cut:
//
//   "check before deleting whether any assertion is about PRESERVATION rather
//    than manifests. A bundle carries a tree and no manifest, so most of it is
//    genuinely retired; some of it may not be."
//
// It may not be. Read by assertion rather than by what it calls, these four
// promises are not about the manifest mechanism at all -- they are about a
// rejected write leaving nothing behind, and about bytes already on the server
// surviving a push. Both survive the carrier change, so they come out rather
// than dying with the manifest contract.
//
// Repointed to `acceptSourceSnapshot` through the same normalizer the room
// daemon uses (`source-room-daemon.mjs:367-372`), so this tests the shape the
// production caller actually has.
//
// ONE OF THEM IS RED, and it is red against real behaviour rather than against
// the repoint -- see `bootstrapAdoption` at the bottom. Left asserting the
// promise.

import assert from 'assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  closeProjectStore,
  createProject,
  hashSourceFiles,
  initProjectStore,
  outputDir,
  projectDir,
  readClientSourceManifest,
  readProject,
  readSourceFile,
  sourceDir,
  updateClientSourceManifest,
  updateProject,
} from '../server/lib/project-store.mjs'
import { acceptSourceSnapshot } from '../server/routes/projects.mjs'

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function filterBuildsAway(name) {
  fs.mkdirSync(outputDir(name), { recursive: true })
  write(path.join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))
}

async function push(name, body) {
  const response = await acceptSourceSnapshot(name, body)
  return { ...response.body, status: response.status, lifecycleStatus: response.body.status ?? null }
}

// Carried over whole: the point of the snapshot is that it covers the project
// directory as well as the source tree, so a rejected push cannot leave a
// fingerprint anywhere -- not in project.json, not in the manifest DB.
async function snapshotProject(name) {
  const dir = sourceDir(name)
  const files = {}
  function walk(current, prefix = '') {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else files[rel] = fs.readFileSync(full).toString('base64')
    }
  }
  walk(dir)
  const projectFiles = {}
  function walkProject(current, prefix = '') {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (rel === '.source-transactions' || rel === 'overleaf-clone/.git') continue
      if (rel === '.source-lifecycle/revisions' || rel === '.source-lifecycle/evidence') continue
      if (rel === '.source-lifecycle/blobs') continue
      if (rel === '.source-lifecycle/git') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walkProject(full, rel)
      else projectFiles[rel] = fs.readFileSync(full).toString('base64')
    }
  }
  walkProject(projectDir(name))
  return {
    project: await readProject(name),
    files,
    projectFiles,
    manifest: await readClientSourceManifest(name),
  }
}

async function assertSnapshotEqual(name, before) {
  assert.deepEqual(await snapshotProject(name), before)
}

// **A rejected push leaves NOTHING behind.** Not the escaping path, and not any
// of the incidental fields it tried to carry -- `sourceDir`, `session`,
// `editedBy`, `members`. This is path containment plus "a rejected write does
// not stick", neither of which is a manifest concern; `AGENTS.md` keeps path
// containment in the list of limits that are not authorization.
//
// KNOWN RED on the second case, and it is the more serious of the two reds in
// this file. Same input, each tree's own code, fresh store:
//
//   main    400, ok:false, "Invalid file path", nothing written
//   here    200, ok:TRUE,  no error,            nothing written
//
// **Containment itself still holds** -- I checked the filesystem, and the file
// lands neither inside the project nor outside it. What changed is that the
// push is no longer REFUSED: it is accepted, reported successful, and the file
// is silently discarded.
//
// That is the shape this repo treats as worst -- an accept that reports success
// while the work was not preserved. `applyAcceptedSourceEffects`'s own docstring
// names the distinction ("*the accept worked* and *the work was preserved* are
// different facts and a caller cannot see the second"); this is a case where the
// caller is told the first and the second is false.
//
// NOT ESTABLISHED, and deliberately not claimed: whether any real client can
// emit a path that trips this. If none can, it is a latent contract break rather
// than a live data-loss path. That reachability question is what decides its
// severity and I have not answered it.
async function rejectedPushLeavesNothing() {
  createProject({ name: 'failed', title: 'Failed', mainFile: 'main.tex', format: 'svg' })
  await updateProject('failed', { pages: 1, buildStatus: 'success' })
  filterBuildsAway('failed')
  await updateClientSourceManifest('failed', ['main.tex'])
  write(path.join(sourceDir('failed'), 'main.tex'), 'kept\n')

  let before = await snapshotProject('failed')
  let result = await push('failed', {
    files: [{ path: '../escape.tex', content: 'bad\n' }],
    sourceManifest: ['main.tex', 'other.tex'],
    sourceDir: '/tmp/should-not-stick',
    session: 'bad-session', sessionAt: 123, editedBy: 'bad-editor',
    members: ['should-not-stick'],
  })
  assert.equal(result.status, 400)
  assert.equal(result.ok, false)
  await assertSnapshotEqual('failed', before)

  before = await snapshotProject('failed')
  result = await push('failed', {
    files: [{ path: '../escape.tex', content: 'bad\n' }],
    sourceManifest: ['../escape.tex'],
    sourceDir: '/tmp/should-not-stick',
    session: 'bad-session', sessionAt: 123, editedBy: 'bad-editor',
    members: ['should-not-stick'],
  })
  assert.equal(result.status, 400)
  await assertSnapshotEqual('failed', before)
}

// **A rejected push does not mutate membership; an accepted one does.** About
// authority over a project field, not about manifests.
async function rejectedPushDoesNotStickMembers() {
  createProject({ name: 'book-project', title: 'Book', format: 'book', members: ['original-book-member'] })
  const before = await snapshotProject('book-project')
  let result = await push('book-project', {
    files: [{ path: 'chapter.tex', content: 'chapter\n' }],
    members: ['should-not-stick'],
  })
  assert.equal(result.status, 400)
  await assertSnapshotEqual('book-project', before)

  result = await push('book-project', { files: [], members: ['accepted-book-member'] })
  assert.equal(result.status, 200)
  assert.deepEqual((await readProject('book-project')).members, ['accepted-book-member'])
}

// **A delete really removes the file.** The manifest half of this retires with
// the manifest; the half asserted here is that the bytes leave the disk, which
// is preservation's mirror image and survives the cut.
async function deleteRemovesTheBytes() {
  createProject({ name: 'markdown-readme', title: 'Markdown', mainFile: 'README.md', format: 'svg' })
  await updateProject('markdown-readme', { pages: 1, buildStatus: 'success' })
  filterBuildsAway('markdown-readme')
  let result = await push('markdown-readme', {
    expectedRevision: null,
    files: [{ path: 'README.md', content: '# authored\n' }],
    sourceManifest: ['README.md'],
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(readSourceFile('markdown-readme', 'README.md'), '# authored\n')

  result = await push('markdown-readme', {
    expectedRevision: result.sourceRevision,
    files: [],
    deletedFiles: ['README.md'],
    sourceManifest: [],
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(readSourceFile('markdown-readme', 'README.md'), null)
}

// **Bytes already on the server survive a push that does not send them.**
//
// KNOWN RED, and red against the behaviour rather than against the repoint.
// This is the same defect as the bootstrap case in
// `bin/source-lifecycle-http-test.mjs`, which is how it got noticed: the old
// accept ADOPTED a file already on disk, and the new one refuses the push with
// 400, "declared in sourceManifest but was neither sent nor already held" --
// because at bootstrap there is no revision, so bytes on disk are neither.
//
// Measured both ways on the same input: `main` 200 with the file preserved,
// this path 400.
//
// **Left asserting 200.** The promise is that pushing nothing does not endanger
// what is already there, and rewriting it to expect 400 would make the suite
// assert the regression. Two files now hold this promise, which is why it is
// worth saying it is one defect and not two.
async function bootstrapAdoption() {
  createProject({ name: 'zero-first', title: 'Zero', mainFile: 'main.tex', format: 'svg' })
  await updateProject('zero-first', { pages: 1, buildStatus: 'success' })
  filterBuildsAway('zero-first')
  write(path.join(sourceDir('zero-first'), 'main.tex'), 'already here\n')
  await updateClientSourceManifest('zero-first', ['main.tex'])
  const result = await push('zero-first', { files: [], sourceManifest: ['main.tex'] })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(Object.keys(await hashSourceFiles('zero-first')), ['main.tex'])
  assert.equal(readSourceFile('zero-first', 'main.tex'), 'already here\n')
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-source-preservation-'))
  await initProjectStore(root)
  try {
    await rejectedPushLeavesNothing()
    await rejectedPushDoesNotStickMembers()
    await deleteRemovesTheBytes()
    await bootstrapAdoption()
    console.log('PASS source preservation contract')
  } finally {
    await closeProjectStore()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
