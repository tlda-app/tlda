#!/usr/bin/env node
//
// **A refusal has to leave a trace.**
//
// `recordSourceSyncRefusal` had exactly one caller, inside the old push's
// catch — the function the deletion removes. The new accept's refusal branch
// did not call it.
//
// **The asymmetry is what made it invisible.** The CLEAR side had already moved
// to the shared effects (`cleared-conflicts` in `postAcceptEffects`), so the new
// path erased the trace on accept and never wrote it on refusal. Everything
// looked wired.
//
// What it costs, in the old code's own words, from a real paper on 2026-08-13:
//
//   > a person stuck outside the paper left no trace: the pusher learned from
//   > their HTTP status and nobody else learned ever.
//
// The 409 tells whoever pushed. Nothing told the surface that shows who is
// held, or another participant, or anyone looking afterwards.
//
// This asserts the trace, not the 409 — the 409 was never missing.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acceptSourceSnapshot } from '../server/routes/projects.mjs'
import { closeProjectStore, createProject, initProjectStore, readProject } from '../server/lib/project-store.mjs'
import { sourceSyncLedger } from '../server/lib/source-sync-conflicts.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-trace-'))
await initProjectStore(path.join(root, 'projects'))
const project = 'paper'
await createProject({ name: project, format: 'svg', mainFile: 'main.tex' })

// Somebody establishes the paper.
const first = await acceptSourceSnapshot(project, {
  expectedRevision: null,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'the paper\n' }],
  editedBy: 'the first author',
})
assert.equal(first.status, 200, `the first accept landed (${JSON.stringify(first.body).slice(0, 200)})`)

// Somebody else lands on top of it.
const second = await acceptSourceSnapshot(project, {
  expectedRevision: first.body.sourceRevision,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'somebody else got here first\n' }],
  editedBy: 'the second author',
})
assert.equal(second.status, 200, 'the second accept landed')

// And now a push against a base that has moved. This is a person becoming
// stuck outside the paper.
const refused = await acceptSourceSnapshot(project, {
  expectedRevision: first.body.sourceRevision,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'the edit that never lands\n' }],
  editedBy: 'the stuck author',
})
assert.equal(refused.status, 409, 'the stale push is refused')
assert.equal(refused.body.status, 'stale-base')

// **THE TRACE.** Somebody other than the pusher can see that a person is stuck.
// Read the same way the paper's own surface reads it -- the ledger over the
// project record -- rather than through an accessor invented for the test.
const stuck = sourceSyncLedger(await readProject(project), Date.now())
assert.equal(stuck.entries.length, 1,
  `THE TRACE: the paper knows somebody is stuck (${JSON.stringify(stuck).slice(0, 300)})`)

await closeProjectStore()
fs.rmSync(root, { recursive: true, force: true })
console.log('a refusal the rest of us can see: the trace is written, not only returned')
process.exit(0)
