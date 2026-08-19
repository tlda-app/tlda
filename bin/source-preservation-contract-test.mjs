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
// ONE OF THEM IS RED -- `bootstrapAdoption` at the bottom -- and it is red
// against real behaviour rather than against the repoint. Left asserting the
// promise, unchanged.
//
// The escaping-path assertion that was also red has MOVED to its proper subject,
// `membershipExcludesReferencesOutsideTheProject`. It was asserting a route-level
// 400 that no caller can reach; the closure is where membership is decided and it
// already excludes an outside reference. See that function for the whole finding.

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
import { scanMarkdownDependencyClosure, scanMarkdownDeps } from '../shared/markdown-deps.mjs'

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

// **A rejected push leaves NOTHING behind.** Not the file it tried to write, and
// not any of the incidental fields it carried -- `sourceDir`, `session`,
// `editedBy`, `members`. "A rejected write does not stick" is not a manifest
// concern, so it survives the cut.
//
// The TRIGGER changed and the promise did not. It used to reject with an
// escaping path; that case moved to
// `membershipExcludesReferencesOutsideTheProject`, because the route no longer
// refuses escaping paths and no caller can emit one anyway. The trigger here is
// now the new carrier's own contract -- a manifest naming a file that was
// neither sent nor already held -- which is a real rejection on this path.
//
// The snapshot comparison is the whole assertion: it covers the project
// directory as well as the source tree, so a fingerprint anywhere fails it.
async function rejectedPushLeavesNothing() {
  createProject({ name: 'failed', title: 'Failed', mainFile: 'main.tex', format: 'svg' })
  await updateProject('failed', { pages: 1, buildStatus: 'success' })
  filterBuildsAway('failed')
  await updateClientSourceManifest('failed', ['main.tex'])
  write(path.join(sourceDir('failed'), 'main.tex'), 'kept\n')

  const before = await snapshotProject('failed')
  const result = await push('failed', {
    files: [{ path: 'main.tex', content: Buffer.from('sent\n').toString('base64'), encoding: 'base64' }],
    sourceManifest: ['main.tex', 'other.tex'],
    sourceDir: '/tmp/should-not-stick',
    session: 'bad-session', sessionAt: 123, editedBy: 'bad-editor',
    members: ['should-not-stick'],
  })
  assert.equal(result.status, 400)
  assert.equal(result.ok, false)
  await assertSnapshotEqual('failed', before)
}

// **An escaping path is not a member, and membership is where that is decided.**
//
// This assertion used to live at the route: push `../escape.tex` and get a 400.
// It moved here because the route is the wrong subject. Skip's ruling is that
// the closure is the single place a path can enter a project, so a second
// refusal downstream is a check on a fact this function already owns.
//
// Established while moving it, and the reason this is a characterisation test
// rather than a red: **no caller can emit an escaping path in the first place.**
// The closure drops it (below), `normalizeSourceManifest` drops `..` and
// absolute paths, and the CLI's Quarto collector checks the REALPATH so a
// symlink pointing out is caught too. The route's old 400 was unreachable.
//
// Note what the two calls below show together: the raw scanner DOES see the
// outside reference. It is not that the reference is invisible -- it is that
// membership excludes it. That distinction is the whole promise, which is why
// both are asserted.
//
// LaTeX has no equivalent. `shared/tex-deps.mjs` is 152 lines of pure comment
// left behind when `e9c3ba890` reverted `22fb6182b`, so LaTeX membership is
// still a directory walk plus an extension test. A walk cannot produce `..`, so
// nothing escapes there either -- but his rule is implemented for Markdown only,
// and that gap is live.
async function membershipExcludesReferencesOutsideTheProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-closure-'))
  try {
    const project = path.join(root, 'project')
    fs.mkdirSync(project)
    fs.mkdirSync(path.join(root, 'shared'))
    write(path.join(root, 'shared', 'macros.md'), '# shared preamble\n')
    write(path.join(project, 'inside.md'), '# inside\n')
    write(path.join(project, 'main.md'), 'up [macros](../shared/macros.md) and in [ok](inside.md)\n')

    const seen = scanMarkdownDeps(fs.readFileSync(path.join(project, 'main.md'), 'utf8'), project)
    assert.deepEqual(
      seen.map(dep => dep.ref).sort(),
      ['../shared/macros.md', 'inside.md'],
      'the scanner sees the outside reference; the control that makes the next assertion mean something',
    )

    const closure = scanMarkdownDependencyClosure('main.md', project)
    assert.deepEqual(
      closure.files.sort(),
      ['inside.md', 'main.md'],
      'a reference outside the project root is not a member',
    )
    assert.equal(
      closure.files.some(file => file.startsWith('..')),
      false,
      'no member escapes the project root',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
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

  // The other half of this test DID NOT COME ACROSS, and the reason is the
  // classification this file exists to make.
  //
  // It asserted that a members-only push -- `{ files: [], members: [...] }` with
  // no manifest -- returns 200 and updates the members. That is not a
  // preservation promise. It is an incidental capability of the old carrier,
  // where the push route doubled as a members updater. The new carrier refuses
  // it: "files[] and sourceManifest[] are required", because a snapshot IS the
  // project and a snapshot with no manifest is not a statement about anything.
  //
  // Nothing is lost. `PATCH /:name/members` (projects.mjs:685) is the route that
  // owns membership and it is untouched. So this half dies with the mechanism it
  // was testing, which is the correct outcome and not a regression -- and
  // rewriting it to expect 400 would be asserting the absence of a capability
  // rather than a promise.
  //
  // What survives is the assertion above it: a REJECTED push does not stick
  // members. That is preservation, and it still holds.
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
// assert the regression. Two files hold this promise, so it is one defect and
// not two.
//
// REACHABILITY, established 2026-08-19 and the reason this is not a deploy
// blocker: it needs source bytes on disk that were never accepted into any
// revision. Nothing produces that state -- `writeSourceFile`, the server-side
// direct write, has NO production callers, and every other route onto disk goes
// through the accept's working-copy effect, which by construction leaves a
// revision. With a revision present the same daemon shape returns 409
// stale-base instead, which is the ordinary refusal the retry path handles.
//
// So this is a test fixture reaching a state production cannot. It stays red
// rather than being deleted, because the promise is real and the day something
// does seed a project's disk ahead of its first accept, this is the assertion
// that says so.
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
    await membershipExcludesReferencesOutsideTheProject()
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
