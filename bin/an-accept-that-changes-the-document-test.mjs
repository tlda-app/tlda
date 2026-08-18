#!/usr/bin/env node
//
// **A push that is accepted must change the document on disk.**
//
// The new accept path recorded a revision, moved `acceptSeq` and reported the
// work preserved — and never wrote the server's own working copy. Both
// `writeSourceFileAsync` calls lived inside `processProjectPushSerialized`, the
// path being deleted; the six effects did not include one.
//
// The mirror does not cover it. That sends the revision to the DAEMON's
// checkout, on his machine. Everything that reads a project's source as FILES
// reads `sourceFilePath()`: the build pipeline, `listSourceFiles`,
// `hashSourceFiles`, and `GET /:name/source/:file` — the source editor's read.
//
// So without the write, he edits his paper, is told it synced, and the paper
// does not change: the build renders the previous revision and the editor reads
// it back. It would not have shown up in the deletion diff either, because the
// old path keeps writing the copy right up until it is removed — it would have
// surfaced the first time he saved afterwards.
//
// This asserts the bytes on disk, not the response. The response was always
// green.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acceptSourceSnapshot } from '../server/routes/projects.mjs'
import { createProject, initProjectStore, readClientSourceManifest, sourceDir } from '../server/lib/project-store.mjs'

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-writes-'))
await initProjectStore(path.join(store, 'projects'))

const project = 'paper'
await createProject({ name: project, format: 'latex', mainFile: 'main.tex' })

const onDisk = rel => path.join(sourceDir(project), rel)

// A first accept: the document must exist on disk afterwards.
const first = await acceptSourceSnapshot(project, {
  expectedRevision: null,
  sourceManifest: ['main.tex', 'intro.tex'],
  files: [
    { path: 'main.tex', content: 'the paper\n' },
    { path: 'intro.tex', content: 'the introduction\n' },
  ],
})
assert.equal(first.status, 200, `the first accept succeeds (${JSON.stringify(first.body).slice(0, 300)})`)
assert.ok(first.body.postAcceptEffects.includes('working-copy'),
  'and it reports having written the working copy')

assert.equal(fs.readFileSync(onDisk('main.tex'), 'utf8'), 'the paper\n',
  'THE DOCUMENT: the accepted bytes are on the server disk, where the build and the editor read')
assert.equal(fs.readFileSync(onDisk('intro.tex'), 'utf8'), 'the introduction\n')

// **And the file LIST**, which is a table rather than a scan of the disk — so
// correct bytes are not enough. A file missing from it is invisible to
// `listSourceFiles` and to anything that enumerates a project, which makes a
// new chapter that syncs and never appears indistinguishable from a sync that
// did nothing.
assert.deepEqual((await readClientSourceManifest(project)).sort(), ['intro.tex', 'main.tex'],
  'THE FILE LIST: the accepted paths appear in the project, not only on disk')

// An edit to one file: the disk must follow.
const second = await acceptSourceSnapshot(project, {
  expectedRevision: first.body.sourceRevision,
  sourceManifest: ['main.tex', 'intro.tex'],
  files: [{ path: 'main.tex', content: 'the paper, revised\n' }],
})
assert.equal(second.status, 200, 'a one-file push is accepted')
assert.equal(fs.readFileSync(onDisk('main.tex'), 'utf8'), 'the paper, revised\n',
  'the edited file changed on disk')
assert.equal(fs.readFileSync(onDisk('intro.tex'), 'utf8'), 'the introduction\n',
  'and the carried-forward file was not disturbed')

// A deletion: the file must actually leave the disk, or the build keeps
// rendering a section its author removed.
const third = await acceptSourceSnapshot(project, {
  expectedRevision: second.body.sourceRevision,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'the paper, alone\n' }],
})
assert.equal(third.status, 200, 'a push that drops a path is accepted')
assert.equal(fs.existsSync(onDisk('intro.tex')), false,
  'THE DELETION: a path that left the manifest left the disk too')
assert.deepEqual(await readClientSourceManifest(project), ['main.tex'],
  'and left the project file list, or it would keep appearing after being removed')
assert.equal(fs.readFileSync(onDisk('main.tex'), 'utf8'), 'the paper, alone\n')

fs.rmSync(store, { recursive: true, force: true })
console.log('an accept that changes the document: the working copy follows the revision')
// The accept dispatches a real build, whose worker keeps the process alive.
// The assertions are about the bytes on disk and they are done.
process.exit(0)
