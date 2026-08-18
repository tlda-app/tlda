#!/usr/bin/env node
//
// **A write that fails after the ref moves must not leave them disagreeing.**
//
// Every accept moves `refs/tlda/source/<project>` and THEN writes
// `authority.json`. Anything failing between the two left the two saying
// different things — and reading the JSON first made the disagreement decide
// the answer.
//
// This reproduced five ways across two test files (plain manifest failure,
// Overleaf after-remote failure, clone-restore, journal crash, snapshot-ready
// crash) and was thought to belong to the old transaction. **It does not.** The
// window is inside `bootstrap` and `submit` themselves, which survive the
// strip, so it is *a rejected write leaves nothing behind* failing in the git
// layer we are keeping — the promise the whole cut is judged on.
//
// The worst shape is bootstrap: the ref points at a real commit while the
// project reads as UNINITIALIZED, so the project appears to have no history and
// **the next push bootstraps over it.**
//
// Two rules, both asserted:
//   1. The ref is the accepted revision. If a commit is on it, the project is
//      at that commit, whatever the JSON says.
//   2. An accept must not report failure once the ref has moved — the work
//      landed, and reporting a rejection over a moved ref is the same
//      violation from the other direction.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-record-'))
const project = 'paper'

// Fail exactly the authority record, exactly once — the window between the ref
// moving and the record landing.
let failAuthority = true
const fault = (stage, { path: target }) => {
  if (failAuthority && String(target).endsWith('authority.json')) {
    failAuthority = false
    throw new Error('injected: the authority record could not be written')
  }
}

const lifecycle = createSourceLifecycleStore({ project, root, fault })

// **A failed record leaves NOTHING behind — including the ref.**
//
// The temptation is to report the accept as standing, because the ref already
// says so. That is the wrong way round: it turns a failed write into an accept
// nobody was told about, and the caller then runs the post-accept effects —
// mirror, build, replicas — for a revision its own record does not have.
// Rolling the ref back keeps failure meaning failure.
await assert.rejects(
  () => lifecycle.bootstrap({
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'his prose\n' }],
  }),
  /injected/,
  'a failed authority record is a failed accept, not a silent one',
)

const afterFailure = await lifecycle.readAuthority()
assert.equal(afterFailure.state, 'uninitialized',
  'NOTHING BEHIND: the ref was put back, so the project is where it started')
assert.equal(afterFailure.currentRevision, null, 'and names no revision')

// **The next push is an ordinary first push, not a recovery.** This is the
// damage the old behaviour actually did: a ref moved past a record left the
// project readable as uninitialized OR current depending on which was believed,
// and the following push either bootstrapped over real history or was refused
// against a base nobody could see.
const accepted = await lifecycle.bootstrap({
  expectedRevision: null,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'his prose\n' }],
})
assert.equal(accepted.ok, true, 'the retry is an ordinary bootstrap')
const revisionId = accepted.revision?.id ?? accepted.revision

const authority = await lifecycle.readAuthority()
assert.equal(authority.state, 'current', 'and now the project is current')
assert.equal(authority.currentRevision, revisionId, 'at the revision it accepted')
assert.equal((await lifecycle.readRevisionFile(revisionId, 'main.tex')).toString(), 'his prose\n',
  'with his bytes in it')

// **The ref is what makes that true, not the record.** A store that reads the
// record first reported UNINITIALIZED while a commit sat on the ref — so the
// project looked historyless and the next push would bootstrap over it.
const next = await lifecycle.submit({
  expectedRevision: revisionId,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'his prose, revised\n' }],
})
assert.equal(next.ok, true, 'the following push is an ordinary accept')
const nextId = next.revision?.id ?? next.revision
const { changed } = await lifecycle.diffRevisions(revisionId, nextId)
assert.deepEqual(changed, ['main.tex'],
  'THE HISTORY: the second revision builds on the first instead of starting over')

const reopened = createSourceLifecycleStore({ project, root })
assert.equal((await reopened.readAuthority()).currentRevision, nextId,
  'and a process that reopens the store reads the same head')

fs.rmSync(root, { recursive: true, force: true })
console.log('a ref that does not outrun its record: the ref is the accepted revision')
