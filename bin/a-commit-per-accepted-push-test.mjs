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

fs.rmSync(root, { recursive: true, force: true })
console.log('a commit per accepted push: passed')
