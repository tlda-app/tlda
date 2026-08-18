#!/usr/bin/env node
//
// **Two carriers, one accept.**
//
// A browser has no git objects and never will, so the client callers send a
// complete snapshot as JSON. That is a different carrier, not a different
// accept — and the whole value of saying so is that the rules do not fork.
//
// Three things asserted, each of which accepts cleanly while being wrong:
//
//   1. **base64 is decoded.** `writeBlob` is
//      `Buffer.isBuffer(c) ? c : Buffer.from(String(c))` — it does not decode.
//      A base64 body reaching it unnormalised writes THE BASE64 TEXT as the
//      file contents: not a lost byte, a corrupted document that accepts
//      cleanly and reports preserved. Two of the three client callers send
//      base64 and one sends raw UTF-8.
//   2. **The refusal refuses, and carries the merge.** A client writing against
//      a revision somebody else has replaced is refused — and the refusal
//      carries `evidence.classifications[]` with a real three-way merge, which
//      is what the source editor turns into conflict markers. A refusal that
//      returns only a status is a lost resolution path, not a lost byte.
//   3. **Both carriers reach the same history.** The JSON accept and the
//      bundle accept produce commits on one ref, not two parallel worlds.
//
// It drives `bootstrap` and `submit` directly, because those ARE the accept.
// An `acceptFiles` written beside them was a second implementation of the thing
// this cut exists to stop having two of, and it has been deleted.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'second-carrier-'))
const project = 'paper'
const lifecycle = createSourceLifecycleStore({ project, root })

const utf8 = 'his prose, typed\n'
const base64Text = 'his prose, pasted\n'

// **`expectedRevision: null` is the ordinary first write, not an edge case.**
//
// Twelve of the seventeen HTTP callers send it on first contact with a project
// they just created: every `tlda project create` / `init` / `scratch`, and every
// drop-to-book chapter. They read it from `GET /:name/source-authority`, which
// reports `currentRevision: null` on an uninitialized project — so `null` is
// what an honest caller has to send.
//
// The old path distinguished it with a sentinel (`expectedRevision === undefined`
// → 428), which is why normalising `null` to absent would 428 the first write to
// every new project — the caller having satisfied the precondition, the server
// having enforced it correctly, and the document simply never appearing.
//
// **The carrier routes on the authority's state rather than on a sentinel**: an
// uninitialized project goes to `bootstrap`, which requires `expectedRevision`
// to be null and is exactly the first-write case; anything else goes to
// `submit`. So `null` and absent both reach `bootstrap` on a fresh project and
// cannot produce different answers. Both spellings are asserted, because the
// callers use both.
const first = await lifecycle.bootstrap({
  expectedRevision: null,
  sourceManifest: ['main.tex', 'notes.md'],
  files: [
    { path: 'main.tex', content: utf8 },
    { path: 'notes.md', content: Buffer.from(base64Text).toString('base64'), encoding: 'base64' },
  ],
})
assert.equal(first.ok, true, 'the bootstrap snapshot is accepted')
const firstId = first.revision?.id ?? first.revision

// **1. The bytes.** The base64 file must hold its DECODED text.
assert.equal((await lifecycle.readRevisionFile(firstId, 'main.tex')).toString(), utf8,
  'the utf8 file carries its bytes')
assert.equal((await lifecycle.readRevisionFile(firstId, 'notes.md')).toString(), base64Text,
  'THE DECODE: the base64 file carries its decoded bytes, not its base64 text')

// **2. The refusal.** Somebody else lands, and a client writing against the
// revision they had is refused rather than overwriting them.
const second = await lifecycle.submit({
  expectedRevision: firstId,
  sourceManifest: ['main.tex', 'notes.md'],
  files: [
    { path: 'main.tex', content: 'somebody else got here first\n' },
    { path: 'notes.md', sha256: (await lifecycle.readRevision(firstId)).files.find(f => f.path === 'notes.md').sha256 },
  ],
})
assert.equal(second.ok, true, 'the second accept lands')
const secondId = second.revision?.id ?? second.revision

const stale = await lifecycle.submit({
  expectedRevision: firstId, // stale on purpose: the head has moved to `secondId`
  sourceManifest: ['main.tex', 'notes.md'],
  files: [
    { path: 'main.tex', content: 'a client that never saw their change\n' },
    { path: 'notes.md', content: base64Text },
  ],
})
assert.equal(stale.ok, false, 'THE REFUSAL: a stale base is refused, not silently overwritten')
assert.equal(stale.status, 'stale-base')
assert.ok(stale.refusedRevision, 'and the refused commit is named, so it is reachable rather than lost')

// **The refusal carries the MERGE, not just the rejection.**
//
// The source editor — the surface Skip edits his paper on — turns
// `evidence.classifications[]` into conflict markers a person resolves in
// place. A refusal that returns only a status turns "resolve the markers and it
// syncs" into "sync 409", which is a lost resolution path rather than a lost
// byte: the write correctly refused, the caller correctly reported failure, and
// nothing in any log says the merge went missing.
assert.ok(stale.evidence, 'the refusal carries evidence')
assert.equal(stale.evidence.status, 'stale-base')
const conflicted = stale.evidence.classifications.find(entry => entry.path === 'main.tex')
assert.ok(conflicted, 'and names the path that actually differed')
assert.equal(conflicted.status, 'conflict', 'as a conflict, which is what the editor branches on')
assert.ok(conflicted.merged, 'with a real three-way merge for the person to resolve')

// The head did not move, so nobody was overwritten.
assert.equal((await lifecycle.readAuthority()).currentRevision, secondId,
  'the refused push left the accepted revision alone')
assert.equal((await lifecycle.readRevisionFile(secondId, 'main.tex')).toString(),
  'somebody else got here first\n', 'and their work is intact')

// **3. One history.** The second commit descends from the first: both accepts
// are on the same ref, in the order they happened.
assert.ok(await lifecycle.diffRevisions(firstId, secondId), 'the two accepts are comparable revisions')
const { changed } = await lifecycle.diffRevisions(firstId, secondId)
assert.deepEqual(changed, ['main.tex'], 'and the unchanged file cost nothing, carried by sha')

// ---------------------------------------------------------------------------
// **A caller that sends one file does not delete the others.**
//
// The accept needs the whole project; callers know only what changed. The room
// checkpoint sends exactly one file with a manifest of the whole project, and
// four CLI sites send `files: []` with a manifest wider still. `carryForward`
// fills every unnamed manifest path from the current revision BY REFERENCE,
// which is what keeps an incremental push incremental — without it the only
// compliant push is the entire project on every flush.

const complete = await lifecycle.carryForward(
  ['main.tex', 'notes.md'],
  [{ path: 'main.tex', content: 'one file, changed on its own\n' }],
)
assert.deepEqual(complete.map(f => f.path), ['main.tex', 'notes.md'], 'the snapshot covers the manifest')
assert.ok(complete[1].sha256, 'and the untouched file is carried by reference, not by bytes')
assert.equal(complete[1].content, undefined, 'so an unchanged file costs nothing to push')

const partial = await lifecycle.submit({
  expectedRevision: secondId,
  sourceManifest: ['main.tex', 'notes.md'],
  files: complete,
})
assert.equal(partial.ok, true, 'a one-file push is accepted')
const partialId = partial.revision?.id ?? partial.revision
assert.equal((await lifecycle.readRevisionFile(partialId, 'notes.md')).toString(), base64Text,
  'THE CARRY-FORWARD: the file nobody mentioned still holds its bytes')
assert.equal((await lifecycle.readRevisionFile(partialId, 'main.tex')).toString(),
  'one file, changed on its own\n', 'and the one they did mention changed')

// A path declared but neither sent nor held is an error, not an empty file —
// that is a caller declaring something it never sent, which is the shape that
// cost bregman four refused pushes in 2.5 hours.
await assert.rejects(
  () => lifecycle.carryForward(['main.tex', 'never-existed.tex'], []),
  /neither sent nor already held/,
  'a path that was never sent and is not held is refused rather than invented',
)

// ---------------------------------------------------------------------------
// **A project too big for one body: upload the bytes, then reference them.**
//
// A snapshot is atomic, so it cannot be split the way the old batched push
// could — and a bootstrap carries nothing forward, so every byte is content.
// The classroom book is 1492 files and ~525MB, which is not a JSON body.
//
// Uploading blobs first turns one enormous request into many bounded ones plus
// a small manifest of references. The reference is the SAME `{path, sha256}`
// shape `carryForward` emits, so the accept needs no new case — which is the
// whole reason this is a few lines rather than a second ingest path.

const uploaded = await lifecycle.putBlob(Buffer.from('a chapter uploaded on its own\n'))
assert.ok(uploaded.sha256, 'the blob upload returns an id')

const byReference = await lifecycle.submit({
  expectedRevision: partialId,
  sourceManifest: ['chapter.tex', 'main.tex', 'notes.md'],
  files: await lifecycle.carryForward(
    ['chapter.tex', 'main.tex', 'notes.md'],
    [{ path: 'chapter.tex', sha256: uploaded.sha256, size: uploaded.size }],
  ),
})
assert.equal(byReference.ok, true, 'a snapshot referencing a pre-uploaded blob is accepted')
assert.equal(
  (await lifecycle.readRevisionFile(byReference.revision?.id ?? byReference.revision, 'chapter.tex')).toString(),
  'a chapter uploaded on its own\n',
  'THE TWO-PHASE PUSH: bytes that never travelled in the snapshot body are in the revision',
)

// **The same first write with the field OMITTED**, in a fresh project of its
// own — because a caller that leaves it out and a caller that sends `null` must
// not get different answers, and the old sentinel gave them different answers
// on purpose.
const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'second-carrier-fresh-'))
const fresh = createSourceLifecycleStore({ project: 'fresh', root: freshRoot })
const bootstrapped = await fresh.bootstrap({
  expectedRevision: null,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'the first write of a new project\n' }],
})
assert.equal(bootstrapped.ok, true,
  'THE FIRST WRITE: a fresh project accepts a push with no expectedRevision at all')
assert.equal(
  (await fresh.readRevisionFile(bootstrapped.revision?.id ?? bootstrapped.revision, 'main.tex')).toString(),
  'the first write of a new project\n',
  'and the document actually exists afterwards',
)
fs.rmSync(freshRoot, { recursive: true, force: true })

fs.rmSync(root, { recursive: true, force: true })
console.log('a second carrier onto one accept: decode, refusal, first write and one history hold')
