#!/usr/bin/env node
//
// **The wire, not the two ends.**
//
// Calling the daemon's propose function and the server's accept function from
// one process proves both functions and nothing about whether they are
// connected — and the connection is the only part that can be missing. So this
// runs a real HTTP server, over a real socket, through the same
// `express.raw({ type: () => true, limit: '500mb' })` the route declares, and
// makes the daemon's own client carry the bytes.
//
// What it exercises, stated exactly, because the commit message repeats it:
//
//   sender   — real (`daemon/source-push.mjs`, `daemon/source-proposal.mjs`)
//   wire     — real (loopback HTTP, real body parser, real 409 round trip)
//   receiver — the real `lifecycle.acceptBundle` / `proposerBundle`, but NOT
//              the mounted router: bearer auth and route registration are not
//              crossed here.
//
// Three things it settles, each of which reads as working when it is broken:
//
//   1. A multi-megabyte body actually crosses. The server declares 500mb; the
//      client was unmeasured, and an unmeasured client is exactly the kind of
//      zero that reads as working.
//   2. A refusal is recoverable. The 409 names a commit the proposer does not
//      have, so without the fetch the rebase cannot happen at all.
//   3. Recovering does not clobber. The commit that beat us must survive our
//      re-proposal.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createSourceProposal } from '../daemon/source-proposal.mjs'
import { createSourcePush } from '../daemon/source-push.mjs'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-wire-'))
const serverGit = path.join(root, 'server.git')
const checkout = path.join(root, 'checkout')
const project = 'paper'
spawnSync('git', ['init', '--bare', '--quiet', serverGit])
fs.mkdirSync(checkout, { recursive: true })
for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'the author'], ['config', 'user.email', 'a@example.test']]) {
  const r = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
}

const store = createSourceGitStore({ gitDir: serverGit })

// ---------------------------------------------------------------------------
// A server that is the real accept, behind the real body parser.

const accepts = []
const app = express()
app.post('/api/projects/:name/source-bundle', express.raw({ type: () => true, limit: '500mb' }), async (req, res) => {
  const bundlePath = path.join(root, `proposed-${accepts.length}.bundle`)
  fs.writeFileSync(bundlePath, req.body)
  accepts.push({ bytes: req.body.length, editedBy: req.get('x-tlda-edited-by') || null })
  try {
    const proposed = await store.ingestBundle(project, bundlePath)
    if (!proposed) return res.status(400).json({ ok: false, error: 'empty bundle' })
    const result = await store.fastForward(project, proposed)
    if (!result.ok) {
      await store.markRefused(project, proposed, await store.refused(project))
      return res.status(409).json({ ok: false, status: result.status, currentRevision: result.revision, refusedRevision: proposed })
    }
    res.json({ ok: true, status: result.status, sourceRevision: result.revision, postAcceptEffects: ['journal'] })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})
app.get('/api/projects/:name/source-bundle', async (req, res) => {
  const head = await store.head(project)
  if (!head) return res.status(404).json({ ok: false, error: 'no accepted revision' })
  res.json({
    ok: true,
    currentRevision: head,
    bundleBase64: await store.bundleSince(project, head, { includeRefused: true, have: req.query.have || null }),
    refusedRevision: await store.refused(project),
  })
})

const listening = await new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server))
})
const origin = `http://127.0.0.1:${listening.address().port}`

const proposal = createSourceProposal({ sourceDir: checkout, project })
const pusher = createSourcePush({ proposal, project, server: origin, token: null })

// ---------------------------------------------------------------------------
// 1. An ordinary push crosses and is accepted.

fs.writeFileSync(path.join(checkout, 'main.tex'), 'the paper\n')
fs.writeFileSync(path.join(checkout, 'figure.tex'), 'a figure nobody is editing\n')
const first = await pusher.push({ changed: ['main.tex', 'figure.tex'], editedBy: 'the author' })
assert.equal(first.ok, true, 'the first proposal is accepted')
assert.equal(await store.head(project), first.sourceRevision, 'the server head is the commit we sent')
assert.equal(accepts[0].editedBy, 'the author', 'the headers cross the wire too')

// ---------------------------------------------------------------------------
// 2. **A multi-megabyte body.** Measured, not reasoned about.
//
// Incompressible bytes, because a bundle deflates and a file of spaces would
// measure the compressor rather than the transport. The first version of this
// filled the buffer with `(i * 2654435761) & 0xff`, which LOOKS like noise and
// is periodic with period 256 — zlib took 6MB down to under 50KB and the
// assertion below caught it. Hence `randomBytes`, and hence asserting on the
// body that actually crossed rather than on the size of the file.
const bigBytes = 6 * 1024 * 1024
const big = randomBytes(bigBytes)
fs.writeFileSync(path.join(checkout, 'data.bin'), big)
const large = await pusher.push({ changed: ['data.bin'] })
assert.equal(large.ok, true, 'a multi-megabyte proposal is accepted')
assert.ok(large.bytes > 5 * 1024 * 1024,
  `the body really was multi-megabyte (${(large.bytes / 1024 / 1024).toFixed(1)}MB crossed)`)
assert.equal(
  Buffer.compare(await store.readRevisionFile(large.sourceRevision, 'data.bin'), big), 0,
  'and every byte of it arrived intact',
)

// ---------------------------------------------------------------------------
// 3. Somebody else lands while we are writing. The refusal must be recoverable
//    **and must not clobber them.**

const theirs = await store.acceptRevision({
  project,
  parent: await store.head(project),
  message: 'somebody else, on the server',
  files: [{ path: 'figure.tex', content: 'a figure THEY edited\n' }],
})
await store.advanceHead(project, theirs, large.sourceRevision)
assert.equal(await proposal.hasCommit(theirs), false,
  'the proposer does not have their commit — which is why the 409 alone is a dead end')

fs.writeFileSync(path.join(checkout, 'main.tex'), 'the paper, revised\n')
const contended = await pusher.push({ changed: ['main.tex'] })
assert.equal(contended.ok, true, 'the refusal was recovered from without anyone intervening')
assert.equal(contended.attempts, 2, 'and it took exactly one rebase')

assert.equal(
  (await store.readRevisionFile(contended.sourceRevision, 'figure.tex')).toString(),
  'a figure THEY edited\n',
  'THE CLOBBER TEST, over the wire: their accepted work survived our recovery',
)
assert.equal(
  (await store.readRevisionFile(contended.sourceRevision, 'main.tex')).toString(),
  'the paper, revised\n',
  'and our own change landed',
)
assert.ok(await store.isAncestor(theirs, contended.sourceRevision), 'the accepted commit descends from theirs')

// The big file is still there, because nothing in this path rebuilt a tree from
// a list of files somebody remembered to mention.
assert.equal((await store.readManifest(contended.sourceRevision)).map(e => e.path).sort().join(','),
  'data.bin,figure.tex,main.tex', 'and nothing was dropped along the way')

listening.close()
fs.rmSync(root, { recursive: true, force: true })
console.log(`a proposal that crosses the wire: passed (${(large.bytes / 1024 / 1024).toFixed(1)}MB body, ${accepts.length} requests)`)
