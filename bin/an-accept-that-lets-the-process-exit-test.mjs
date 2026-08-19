#!/usr/bin/env node
//
// **An accept must not leave the process unable to exit.**
//
// Nothing has ever asserted it, and a harness waiting for the process or the
// event loop to drain reads a process that cannot exit as a hang — which is how
// most of a night got spent on a "hang" that was a deadline.
//
// **What this test does NOT do, stated because I checked rather than assumed:
// it does not discriminate the build decision.** It was written expecting to —
// the theory was that an unconditional `dispatchBuild` leaves a worker holding
// the loop. Removing the decision and re-running, the child still exits, so
// that theory is unsupported and this test would not have caught it.
//
// What actually held the loop open in the run that prompted this was the
// PROJECT STORE, which runs in a worker thread and is released by
// `closeProjectStore`. That is by design and is the caller's job, which is why
// the child below closes it: the question here is whether the ACCEPT leaves
// anything behind, not whether a store someone opened is still open.
//
// So this guards a real invariant that nothing else asserts, and it is not the
// guard for the build decision. Keeping the distinction visible matters more
// than the test looking load-bearing.
//
// It runs the accept in a CHILD process with no `process.exit` in it, and
// asserts the child terminates on its own. That is the only way to assert
// "the event loop drained" — a test that calls `process.exit` cannot observe
// it, and a test in the same process cannot either.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-exits-'))

// The child: create a project, accept a push, print, and END. No exit call.
const childSource = `
import fs from 'node:fs'
import path from 'node:path'
import { acceptSourceSnapshot } from ${JSON.stringify(path.join(here, '..', 'server', 'routes', 'projects.mjs'))}
import { closeProjectStore, createProject, initProjectStore, outputDir } from ${JSON.stringify(path.join(here, '..', 'server', 'lib', 'project-store.mjs'))}

await initProjectStore(${JSON.stringify(path.join(root, 'projects'))})
await createProject({ name: 'paper', format: 'svg', mainFile: 'main.tex' })

// Declare a relevant-files set this push does not touch, so the build is
// suppressed as \`outside-tree\`. WITHOUT THIS the fixture dispatches a real
// build and a lingering worker is correct behaviour rather than the defect --
// the assertion would be measuring the wrong thing. An earlier version of this
// file claimed the suppression in a comment and did not set it up.
fs.mkdirSync(outputDir('paper'), { recursive: true })
fs.writeFileSync(path.join(outputDir('paper'), 'relevant-files.json'),
  JSON.stringify({ files: ['not-this-push.tex'] }))

const result = await acceptSourceSnapshot('paper', {
  expectedRevision: null,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [
    { path: 'main.tex', content: 'the paper\\n' },
    { path: 'notes.tex', content: 'some notes\\n' },
  ],
})
process.stdout.write('ACCEPT ' + result.status + ' ' + JSON.stringify(result.body.postAcceptEffects) + '\\n')

// The project store runs in a WORKER THREAD, so a process that opened one holds
// the loop open until it is closed. That is by design and is not what this test
// is about -- it is about whether the ACCEPT leaves anything behind. Closing the
// store is the caller's job; the server does it on shutdown.
await closeProjectStore()
process.stdout.write('STORE CLOSED\\n')
`

const childPath = path.join(root, 'child.mjs')
fs.writeFileSync(childPath, childSource)

const DEADLINE_MS = 90_000
const child = spawn(process.execPath, [childPath], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', chunk => { out += chunk })
child.stderr.on('data', () => {})

const outcome = await new Promise(resolve => {
  const timer = setTimeout(() => resolve({ exited: false }), DEADLINE_MS)
  child.on('exit', code => { clearTimeout(timer); resolve({ exited: true, code }) })
})

if (!outcome.exited) child.kill('SIGKILL')

// **The accept has to have happened**, or a child that exited proves nothing —
// a fixture that never started and one that drained look identical from here.
assert.match(out, /ACCEPT 200 /, `the accept ran and succeeded (saw: ${out.trim() || 'nothing'})`)
assert.match(out, /STORE CLOSED/, 'and the child reached the end of its own work')

assert.equal(outcome.exited, true,
  'THE PROCESS EXITS: nothing the accept started is still holding the event loop open')
assert.equal(outcome.code, 0, 'and it exited cleanly')

fs.rmSync(root, { recursive: true, force: true })
console.log('an accept that lets the process exit: the loop drains')
