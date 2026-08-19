#!/usr/bin/env node
//
// **The return direction: an accept must MIRROR, not merely be able to.**
//
// `mirrorAcceptedRevision` had no caller at all. Both of its call sites lived
// inside `processProjectPush` and died with it in `a51b2505e`; the build tail's
// copy was deleted separately — correctly — on the reasoning that the accept
// drives the mirror, and the accept did not.
//
// So server-to-checkout was off for every project on the box. Pushes landed and
// nothing came back, while every grep for the symbol found three healthy
// occurrences: its definition, its internal delegation, and a test.
//
// **And that test is why this one is written the way it is.**
// `bin/mirror-failure-visible-test.mjs` calls `mirrorAcceptedRevision` DIRECTLY
// and asserts what it does. It passed throughout. `AGENTS.md` §"Prove the wire":
// calling the sender's function and the receiver's function from one test proves
// both functions and nothing about whether they are connected — and the
// connection is the only part that can be missing.
//
// So this never names the mirror. It performs an ACCEPT, through the real
// accept entry point, and asserts the mirror happened as a consequence.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acceptSourceSnapshot, setAcceptedRevisionMirrorHandler, setSourceBindingTargetProvider,
} from '../server/routes/projects.mjs'
import { closeProjectStore, createProject, initProjectStore } from '../server/lib/project-store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-mirrors-'))
await initProjectStore(path.join(root, 'projects'))
const project = 'a-fresh-project'
await createProject({ name: project, format: 'svg', mainFile: 'main.tex' })

// A checkout bound to this project, which is what the mirror exists to reach.
setSourceBindingTargetProvider(async () => ([
  { bindingId: 'a-binding', daemonKey: 'mini:testing', sourceDir: path.join(root, 'checkout') },
]))

const mirrored = []
setAcceptedRevisionMirrorHandler(async message => {
  mirrored.push(message)
  return { ok: true }
})

// ---------------------------------------------------------------------------
// An ordinary accept. Nothing here mentions mirroring.

const first = await acceptSourceSnapshot(project, {
  expectedRevision: null,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'the paper\n' }],
})
assert.equal(first.status, 200, `the accept succeeded: ${JSON.stringify(first.body).slice(0, 200)}`)

// **A patient bound, on purpose.** The accept path takes seconds on a loaded
// box, and the first version of this waited two and reported the mirror as not
// firing -- an instrument set too tight, reported as the defect it was written
// to catch. See docs/the-instrument-or-the-code.md, shape 1.
for (let i = 0; i < 1500 && mirrored.length === 0; i += 1) await new Promise(r => setTimeout(r, 20))

// **THE WIRE.** Not "the mirror works" — "the accept caused it".
assert.equal(mirrored.length, 1,
  'THE RETURN DIRECTION: an accept mirrors to the bound checkouts, without anybody calling the mirror')
assert.equal(mirrored[0].name, project, 'and it names the project that moved')
assert.ok(mirrored[0].sourceRevision, 'carrying the revision it is mirroring')
assert.equal(mirrored[0].sourceRevision, first.body.sourceRevision,
  'which is the revision the accept just took, not a stale head')

// ---------------------------------------------------------------------------
// A SECOND accept mirrors too. One mirror on a first push and silence
// afterwards would be the same outage with a longer fuse.

const second = await acceptSourceSnapshot(project, {
  expectedRevision: first.body.sourceRevision,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'the paper, revised\n' }],
})
assert.equal(second.status, 200, `the second accept succeeded: ${JSON.stringify(second.body).slice(0, 200)}`)

for (let i = 0; i < 1500 && mirrored.length < 2; i += 1) await new Promise(r => setTimeout(r, 20))
assert.equal(mirrored.length, 2, 'every accept mirrors, not only the first')
assert.equal(mirrored[1].sourceRevision, second.body.sourceRevision,
  'and the second one carries the second revision')
assert.notEqual(mirrored[1].sourceRevision, mirrored[0].sourceRevision,
  'which is a different revision, so this is not the first mirror counted twice')

setAcceptedRevisionMirrorHandler(null)
setSourceBindingTargetProvider(null)
await closeProjectStore()
fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
console.log('an accept that actually mirrors: the return direction fires from the accept itself, on every revision')
process.exit(0)
