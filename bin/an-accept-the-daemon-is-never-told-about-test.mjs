#!/usr/bin/env node
//
// The server must never accept a revision and tell the pusher it failed.
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
// The fix is not a reordering. Writing the JSON first would have it claim a
// revision the ref does not hold — the same defect pointing the other way.
// There is no correct order between two records, which is the argument for
// there being one.
//
// What this covers: the SERVER-side window, in process, driven by the store's
// own fault hook. What it does not cover: a daemon pinning behind it across two
// processes. Verified by counterfactual rather than assumed — with the accept
// no longer surviving the failed write, this file goes red.
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
// **THE FIX: the pusher is told the truth.** The ref has already moved and the
// ref is what readAuthority believes, so the revision IS accepted. Losing the
// acceptSeq increment is recoverable; reporting a failure for a push the
// project has taken is not, because the pusher's next base is what it was told.
const result = await store.submit({ ...push('draft two\n'), expectedRevision: acceptedRevision })
failAuthorityWrite = false

assert.equal(result.ok, true, 'an accept survives a failed authority write')
assert.equal(result.status, 'accepted')
const secondRevision = result.authority.currentRevision

// The project advanced, and the pusher was told which revision it advanced to —
// which is the whole difference between recoverable and terminal.
const authorityAfter = await store.readAuthority()
assert.equal(authorityAfter.currentRevision, secondRevision, 'the pusher was told the revision the project actually holds')
assert.notEqual(authorityAfter.currentRevision, acceptedRevision, 'and the project did advance')
const gitDir = path.join(root, 'git')
const ref = spawnSync('git', ['--git-dir', gitDir, 'rev-parse', 'refs/tlda/source/paper'], { encoding: 'utf8' }).stdout.trim()
assert.equal(authorityAfter.currentRevision, ref, 'the ref is the head the project now holds')

// The stored JSON still names the older revision, which is the artifact found in
// the stuck store: refs/tlda/source ahead of authority.json, with nothing else
// to explain it.
const storedJson = JSON.parse(fs.readFileSync(path.join(root, 'authority.json'), 'utf8'))
assert.equal(storedJson.currentRevision, acceptedRevision, 'the JSON never learned about the accepted revision')

// **And the pusher is not pinned.** Pushing against the revision it was told
// about is accepted, because that is the revision the project holds. Before the
// fix this was stale-base forever: the pusher believed its own error, kept
// pushing against a revision the head had moved past, and nothing existed that
// would ever tell it otherwise -- one writer, no collaborator, no way out.
const next = await store.submit({ ...push('draft three\n'), expectedRevision: secondRevision })
assert.equal(next.ok, true, 'the pusher carries on from what it was told')

// The stale JSON is the only residue, and it is harmless because nothing reads
// it for currentRevision. That is the two-records problem surviving as an
// inconsistency rather than as a deadlock -- and it is why the record should go
// rather than be ordered more carefully.

// And it is not a merge, a collaborator, or a second writer: there is one
// pusher in this whole file.
console.log('an accept the daemon is never told about: fixed')
fs.rmSync(root, { recursive: true, force: true })
