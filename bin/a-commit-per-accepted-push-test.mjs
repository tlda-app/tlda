#!/usr/bin/env node
//
// The story: somebody writes, the server accepts it, and a commit appears in
// their checkout. No build anywhere in it.
//
// That last clause is the whole point. Before this, the only caller of the
// mirror was the tail of a successful build (`build-runner.mjs`, which records
// `mirror: not_reached` when the version phase fails), so a paper that did not
// build was a paper whose author's disk was never committed. On 2026-08-18 that
// left three hours of somebody's prose living only in a working directory.
//
// What this crosses, stated plainly rather than claimed as "the feature works":
//
// - the ACCEPT PATH producing a revision and a bundle for it — real lifecycle
//   store, real git objects;
// - the BUNDLE FORMAT between the two halves — the bytes the server produces
//   are fetched by the daemon's own code, not by a re-implementation here;
// - the DAEMON RECEIVER applying it to a real checkout — real
//   `createShadowMirror`, real repository, and the assertion is on
//   `git log` afterwards.
//
// What it does NOT cross is the WebSocket hop, which is unchanged: the accept
// path hands the same payload to the same `mirror-shadow-ref` sender the build
// path already used, and that transport is covered by
// `bin/shadow-mirror-rpc-adapter-test.mjs`. The new thing here is the trigger,
// and the trigger is what this exercises.
import assert from 'assert/strict'
import { execFile as execFileCb } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'
import { createShadowMirror } from '../daemon/shadow-mirror.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, timeout: 20000 })

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-commit-per-push-'))
const checkout = path.join(root, 'checkout')
const lifecycleRoot = path.join(root, 'lifecycle')
fs.mkdirSync(checkout, { recursive: true })
fs.mkdirSync(lifecycleRoot, { recursive: true })

// The author's checkout: an ordinary git repository with their paper in it.
await git(checkout, ['init', '-b', 'main'])
await git(checkout, ['config', 'user.name', 'author'])
await git(checkout, ['config', 'user.email', 'author@example.test'])
fs.writeFileSync(path.join(checkout, 'main.tex'), 'first draft\n')
await git(checkout, ['add', 'main.tex'])
await git(checkout, ['commit', '-m', 'First draft'])
const { stdout: startRaw } = await git(checkout, ['rev-parse', 'HEAD'])
const start = startRaw.trim()

const log = { info() {}, warn() {} }
const mirror = createShadowMirror({ getSourceDir: () => checkout, log })
const lifecycle = createSourceLifecycleStore({
  root: lifecycleRoot,
  project: 'paper',
  context: { format: 'svg', mainFile: 'main.tex' },
})

// One accepted push, standing in for the author saving their file. Nothing here
// builds anything.
async function acceptAndMirror(content) {
  const authority = await lifecycle.readAuthority()
  const submission = {
    expectedRevision: authority.currentRevision,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content }],
  }
  const result = authority.currentRevision
    ? await lifecycle.submit(submission)
    : await lifecycle.bootstrap({ ...submission, expectedRevision: null })
  assert.equal(result.ok, true, `push of ${JSON.stringify(content)} was not accepted: ${result.status}`)
  const revision = result.authority.currentRevision
  const payload = await lifecycle.mirrorPayload(revision)
  const applied = await mirror.mirrorShadowRef({ project: 'paper', ...payload, sourceRevision: revision })
  await lifecycle.markMirrored(revision)
  return { revision, payload, applied }
}

const first = await acceptAndMirror('second draft\n')

// The assertion that is the whole story: the author's branch moved, and the
// commit on it carries what they wrote.
const { stdout: afterFirstRaw } = await git(checkout, ['rev-parse', 'HEAD'])
assert.notEqual(afterFirstRaw.trim(), start, 'accepting a push did not commit anything in the checkout')
const { stdout: committed } = await git(checkout, ['show', 'HEAD:main.tex'])
assert.equal(committed, 'second draft\n')
assert.equal(first.applied.preservation.committed, true)

// The file on disk is theirs, not ours. Preservation commits through a
// temporary index and never writes the working tree.
assert.equal(fs.readFileSync(path.join(checkout, 'main.tex'), 'utf8'), 'first draft\n')

// A second accepted push, to prove the mirror is incremental. The first bundle
// carried the project's whole history; this one carries only what the checkout
// does not already have, because refs/tlda/mirrored records what it took. That
// difference is the 53-second RPC timeout on 2026-08-17 that stopped mirroring
// bregman altogether.
const second = await acceptAndMirror('third draft\n')

// Read as prerequisites rather than as bytes. A bundle's header lists what the
// recipient must already have as `-<sha>` lines, and that is the property under
// test: the first bundle demands nothing because the checkout had nothing, and
// the second demands the revision the checkout took, so it carries only what
// came after. Byte size does not show this -- on a two-commit repository the
// prerequisite line costs more than the commit it saves, and the difference
// only becomes the 53-second timeout at the scale of a real paper's history.
const prerequisites = bundle => Buffer.from(bundle, 'base64')
  .toString('binary')
  .split('\n')
  .filter(line => /^-[0-9a-f]{40}/.test(line))
  .map(line => line.slice(1, 41))

assert.deepEqual(prerequisites(first.payload.bundleBase64), [], 'the first mirror into a checkout must carry the whole history')
assert.deepEqual(
  prerequisites(second.payload.bundleBase64),
  [first.revision],
  'the second mirror must carry only what the checkout does not already have',
)

const { stdout: historyRaw } = await git(checkout, ['log', '--format=%s', `${start}..HEAD`])
const history = historyRaw.trim().split('\n').filter(Boolean)
assert.equal(history.length, 2, `expected one commit per accepted push, got ${history.length}: ${history.join(' | ')}`)

// The scope a mirror carries is THIS revision's manifest. The build-era mirror
// sent the union of every path the project had ever held, which put files in
// scope that the revision did not contain and left the daemon deciding what a
// missing file meant.
assert.deepEqual(second.payload.sourceScope, ['main.tex'])

// And the mirrored ref is the record that a checkout took it, so it is what the
// next bundle subtracts.
assert.equal(await lifecycle.lastMirrored(), second.revision)

// ---------------------------------------------------------------------------
// What happens when the author's tree is dirty.
//
// This is the case that decides whether re-pointing the trigger at the accept
// is safe, because it makes the mirror fire far more often than a build did,
// and the mirror compare-and-swaps the author's real branch. The switch in
// front of it exists because this half "damages history rather than merely
// lagging".

// An unstaged edit the server has never seen -- the ordinary state of a paper
// somebody is writing.
fs.writeFileSync(path.join(checkout, 'main.tex'), 'what the author is typing right now\n')
const third = await acceptAndMirror('fourth draft\n')

// HEAD advanced and the commit records the accepted version. Skip ruled on
// exactly this on 2026-08-11, asked whether the snapshot should record the
// version that was built or skip the file: "The version that was built,
// please."
const { stdout: committedThird } = await git(checkout, ['show', 'HEAD:main.tex'])
assert.equal(committedThird, 'fourth draft\n')

// And this is the line that matters: their unsaved text is still on disk,
// untouched. Preservation commits through a temporary index and never writes
// the working tree, so what they were typing reads afterwards as an
// uncommitted modification -- which is the truth, because they changed it
// after the revision was accepted.
assert.equal(
  fs.readFileSync(path.join(checkout, 'main.tex'), 'utf8'),
  'what the author is typing right now\n',
  'mirroring an accepted revision overwrote the author\'s uncommitted text',
)
const { stdout: dirtyStatus } = await git(checkout, ['status', '--porcelain'])
assert.match(dirtyStatus, /^ M main\.tex$/m, 'the author\'s edit should survive as an uncommitted modification')

// A STAGED conflicting change is refused outright rather than committed over.
// The author has said something about this file with the index, and the mirror
// does not get to answer for them.
fs.writeFileSync(path.join(checkout, 'main.tex'), 'staged by the author\n')
await git(checkout, ['add', 'main.tex'])
const { stdout: headBeforeRefusal } = await git(checkout, ['rev-parse', 'HEAD'])

const authorityBefore = await lifecycle.readAuthority()
const refusedResult = await lifecycle.submit({
  expectedRevision: authorityBefore.currentRevision,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'fifth draft\n' }],
})
assert.equal(refusedResult.ok, true)
const refusedRevision = refusedResult.authority.currentRevision
const refusedPayload = await lifecycle.mirrorPayload(refusedRevision)
await assert.rejects(
  () => mirror.mirrorShadowRef({ project: 'paper', ...refusedPayload, sourceRevision: refusedRevision }),
  /staged .* differs from shadow/,
  'a staged conflicting change must refuse the mirror rather than commit over it',
)

// Refused means refused: the branch did not move and the staged content stands.
const { stdout: headAfterRefusal } = await git(checkout, ['rev-parse', 'HEAD'])
assert.equal(headAfterRefusal.trim(), headBeforeRefusal.trim(), 'a refused mirror must not move HEAD')
assert.equal(fs.readFileSync(path.join(checkout, 'main.tex'), 'utf8'), 'staged by the author\n')

// And because the mirror refused, refs/tlda/mirrored still names the last
// revision a checkout actually took -- so the next attempt bundles from there
// and carries the refused revision along, rather than assuming it landed.
assert.equal(await lifecycle.lastMirrored(), third.revision)

fs.rmSync(root, { recursive: true, force: true })
console.log('a commit per accepted push: passed')
