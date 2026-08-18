#!/usr/bin/env node
//
// The server accepted the revision and told the pusher it failed.
//
// `submit()` moves the ref, then writes `authority.json`, then returns. A write
// failure between the first and the second leaves the project **accepted** —
// the ref is the head and `readAuthority` reads the ref — while the caller is
// handed an error.
//
// For the daemon that is terminal rather than untidy. Its push base is the
// revision it was *told* was accepted, so a push the server took but reported as
// failed leaves the base behind the head permanently: every push after it is
// stale against a revision the daemon has never been given. One writer, no
// collaborator, no merge, and nothing that ever moves it back.
//
// **This is my own ordering and I reasoned about it wrongly when I wrote it.**
// The comment on `state()` says a crash between the two leaves the ref advanced
// and `acceptSeq` stale, which is "recoverable". It is recoverable for the
// server and terminal for the daemon, because the daemon is not reading the ref
// — it is reading the answer.
//
// What this covers: the SERVER-side window, in process, driven by the store's
// own fault hook. What it does not cover: a daemon actually pinning behind it,
// which needs the two processes and is the next thing to prove.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'never-told-'))
const context = { format: 'svg', mainFile: 'main.tex' }

// Fail only the authority write, and only once. Every other write on the path —
// the blobs, the commit, the ref — succeeds, which is what makes this the narrow
// window rather than a general write failure. Both of my earlier injections
// failed a write BEFORE the ref moved, the server rejected cleanly, and the
// daemon retried from an unchanged base; that is why they both recovered and
// this one does not.
let failAuthorityWrite = false
const store = createSourceLifecycleStore({
  root,
  project: 'paper',
  context,
  fault(stage, info) {
    if (stage === 'before-rename' && failAuthorityWrite && String(info?.path || '').endsWith('authority.json')) {
      throw new Error('ENOSPC: no space left on device')
    }
  },
})

const push = content => ({ sourceManifest: ['main.tex'], files: [{ path: 'main.tex', content }] })

const first = await store.bootstrap({ ...push('draft one\n'), expectedRevision: null })
assert.equal(first.ok, true)
const acceptedRevision = first.authority.currentRevision

// The push the server takes and reports as failed.
failAuthorityWrite = true
let reportedToTheDaemon = null
try {
  await store.submit({ ...push('draft two\n'), expectedRevision: acceptedRevision })
  assert.fail('the authority write was supposed to fail')
} catch (error) {
  reportedToTheDaemon = error.message
}
failAuthorityWrite = false

assert.match(reportedToTheDaemon, /no space left on device/, 'the pusher is told the push failed')

// **And the project accepted it anyway.** The ref moved before the write that
// failed, and the ref is what `readAuthority` reads.
const authorityAfter = await store.readAuthority()
assert.notEqual(
  authorityAfter.currentRevision,
  acceptedRevision,
  'THE WINDOW: the project advanced to a revision whose pusher was told it failed',
)
const gitDir = path.join(root, 'git')
const ref = spawnSync('git', ['--git-dir', gitDir, 'rev-parse', 'refs/tlda/source/paper'], { encoding: 'utf8' }).stdout.trim()
assert.equal(authorityAfter.currentRevision, ref, 'the ref is the head the project now holds')

// The stored JSON still names the older revision, which is the artifact found in
// the stuck store: refs/tlda/source ahead of authority.json, with nothing else
// to explain it.
const storedJson = JSON.parse(fs.readFileSync(path.join(root, 'authority.json'), 'utf8'))
assert.equal(storedJson.currentRevision, acceptedRevision, 'the JSON never learned about the accepted revision')

// **Now the consequence.** A pusher that believed its own error keeps pushing
// against the revision it was last told about — and every one of those is
// stale-base, forever, because the head has moved and nothing will tell it.
for (let attempt = 0; attempt < 3; attempt++) {
  const stale = await store.submit({ ...push(`draft three, attempt ${attempt}\n`), expectedRevision: acceptedRevision })
  assert.equal(stale.ok, false, 'a push against the last revision it was told about is refused')
  assert.equal(stale.status, 'stale-base')
}

// And it is not a merge, a collaborator, or a second writer: there is one
// pusher in this whole file.
console.log('an accept the daemon is never told about: reproduced')
fs.rmSync(root, { recursive: true, force: true })
