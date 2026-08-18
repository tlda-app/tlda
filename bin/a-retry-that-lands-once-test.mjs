#!/usr/bin/env node
//
// **A retried push must land once.**
//
// The operation journal — `prepareOperation` / `finishOperation`, `requestId`
// and `deliveryId` dedup, crash-safe replay — had exactly one production
// caller, inside `processProjectPushSerialized`. So the new carriers had none
// of it, and deleting the old path without moving it is the single way this
// strip ends worse than it started: the app looks fine, and a guarantee that
// survived a crash quietly no longer exists.
//
// This is not a hypothetical failure. A client that times out and resends is
// the ordinary case, and landing it twice means two revisions where the author
// made one edit — with the mirror and a build fired for each.
//
// Three things, and the second is the one a naive dedup gets wrong:
//
//   1. The same requestId twice lands ONE revision, and the second call is
//      answered from the journal rather than re-run.
//   2. The same requestId with a DIFFERENT payload is REFUSED, not answered
//      with the first result. Answering it would silently discard the second
//      edit — a retry and a caller bug are not the same thing.
//   3. Crash-safety: the record survives being re-read from disk, because the
//      point is a process that died mid-accept.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-once-'))
const project = 'paper'
const lifecycle = createSourceLifecycleStore({ project, root })

const payload = (content = 'his prose\n') => ({
  project,
  requestId: 'the-same-request',
  files: [{ path: 'main.tex', content }],
  sourceManifest: ['main.tex'],
  expectedRevision: null,
})

// The first attempt is not a replay, so the caller proceeds to the accept.
const first = lifecycle.prepareOperation(payload())
assert.equal(first.replay, false, 'the first attempt runs')

const accepted = await lifecycle.bootstrap({
  expectedRevision: null,
  files: payload().files,
  sourceManifest: ['main.tex'],
})
assert.equal(accepted.ok, true)
const revisionId = accepted.revision?.id ?? accepted.revision

lifecycle.finishOperation(project, 'the-same-request', 'accepted', {
  ok: true, httpStatus: 200, lifecycleStatus: 'accepted',
  requestId: 'the-same-request', sourceRevision: revisionId, disposition: 'accepted',
}, { acceptSeq: 1, acceptedRevision: revisionId })

// **1. The retry is answered from the journal and does not re-run.**
const retry = lifecycle.prepareOperation(payload())
assert.equal(retry.replay, true, 'THE RETRY: the same requestId replays instead of accepting again')
assert.equal(retry.invalidReuse, false, 'and it is a legitimate replay, not a reuse error')
assert.equal(retry.result.sourceRevision, revisionId,
  'answered with the SAME revision — one edit, one revision')

// **2. The same id with different bytes is a caller bug, and is refused.**
const reused = lifecycle.prepareOperation(payload('DIFFERENT prose\n'))
assert.equal(reused.replay, true)
assert.equal(reused.invalidReuse, true,
  'THE REUSE: the same requestId with a different payload is refused, not answered with the first result')
assert.equal(reused.result.status, 'invalid-request-id-reuse')
assert.equal(reused.result.ok, false,
  'because answering it would silently discard the second edit')

// **3. It survives the process.** A journal that only lives in memory answers
// nothing after the crash it exists for.
const restarted = createSourceLifecycleStore({ project, root })
const afterRestart = restarted.prepareOperation(payload())
assert.equal(afterRestart.replay, true,
  'THE CRASH: the journal is on disk, so a restarted process still knows the push landed')
assert.equal(afterRestart.result.sourceRevision, revisionId)

// And the project really does hold exactly one revision's worth of that edit.
assert.equal((await restarted.readAuthority()).currentRevision, revisionId,
  'the head is the single accepted revision')

fs.rmSync(root, { recursive: true, force: true })
console.log('a retry that lands once: dedup, reuse refusal and crash-safety hold')
