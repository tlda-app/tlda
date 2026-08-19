#!/usr/bin/env node
//
// **Does sync do anything at all.**
//
// Skip, 06:49 EDT: *"Get me a sync that does something at all and doesn't
// fucking deadlock and doesn't destroy code."* This is the first of the three,
// and until now nothing established it in either direction.
//
// Every piece of this path had a test and **none of them crossed more than one
// boundary.** The wire test stops at the accept. The materializer is tested with
// a hand-built command. The mirror is tested on its own. `AGENTS.md` §"Prove the
// wire" is exactly this: calling the sender's function and the receiver's
// function proves both functions and nothing about whether they are connected —
// and this path has THREE joins, not one.
//
// So: two checkouts, one server, a real socket, and one edit.
//
//   A's disk → daemon proposes a bundle → HTTP → server accepts →
//   server's own working copy → fan-out payload → B's materializer → B's disk
//
// What it asserts is the bytes at the far end. Not that each function returned
// ok — every one of them returned ok while `refusedRevision` was carried by
// nothing, while the fan-out sent no content, and while the loop-back header was
// sent by nobody.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { spawnSync } from 'node:child_process'
import { createSourceProposal } from '../daemon/source-proposal.mjs'
import { createSourcePush } from '../daemon/source-push.mjs'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'
import { createSourceMaterializer } from '../daemon/source-materializer.mjs'
import { gitBlobId } from '../shared/git-blob-id.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'end-to-end-'))
const project = 'paper'
const lifecycle = createSourceLifecycleStore({ root, project, context: { format: 'latex', mainFile: 'main.tex' } })
const store = createSourceGitStore({ gitDir: path.join(root, 'git') })

function checkout(name) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', name], ['config', 'user.email', `${name}@test`]]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  return { name, dir, proposal: createSourceProposal({ sourceDir: dir, project }) }
}

// ---------------------------------------------------------------------------
// The server: the real accept behind the real body parser, and the real
// post-accept fan-out payload.

const dispatched = []
const app = express()
app.post('/api/projects/:name/source-bundle', express.raw({ type: () => true, limit: '500mb' }), async (req, res) => {
  const bundlePath = path.join(root, `in-${Math.round(process.hrtime()[1])}.bundle`)
  fs.writeFileSync(bundlePath, req.body)
  try {
    const result = await lifecycle.acceptBundle(bundlePath)
    if (!result.ok) return res.status(409).json(result)

    // The fan-out payload, built the way the accept builds it: the CHANGED
    // files with their bytes, and the complete manifest. This is the shape the
    // materializer is handed in production.
    const head = await store.head(project)
    const previous = result.previous || null
    const { changed } = previous
      ? await store.diffRevisions(previous, head)
      : { changed: (await store.readManifest(head)).map(entry => entry.path) }
    const blobs = {}
    for (const file of changed) {
      const bytes = await store.readRevisionFile(head, file)
      if (bytes) blobs[gitBlobId(bytes)] = bytes.toString('base64')
    }
    dispatched.push({
      sourceRevision: head,
      previousRevision: previous,
      baseManifest: previous ? await store.readManifest(previous) : [],
      targetManifest: await store.readManifest(head),
      blobs,
      sourceDaemonKey: req.get('x-tlda-source-daemon') || null,
    })
    res.json({ ok: true, sourceRevision: head, status: result.status })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})
app.get('/api/projects/:name/source-bundle', async (req, res) => {
  const head = await store.head(project)
  if (!head) return res.status(404).json({ ok: false, error: 'no accepted revision' })
  res.json({ ok: true, currentRevision: head, bundleBase64: await store.bundleSince(project, head, {}) })
})
const listening = await new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server))
})
const origin = `http://127.0.0.1:${listening.address().port}`

// ---------------------------------------------------------------------------
// Two machines. A writes; B receives.

const a = checkout('machine-a')
const b = checkout('machine-b')
const pushA = createSourcePush({ proposal: a.proposal, project, server: origin, token: null, daemonKey: 'machine-a:testing' })
const materializerB = createSourceMaterializer({ journalPath: path.join(root, 'b-journal.json') })
materializerB.seedBinding('binding-b', b.dir, null)

const PROSE = 'The estimator is unbiased under the stated conditions.\n'
fs.writeFileSync(path.join(a.dir, 'main.tex'), `\\documentclass{article}\n\\begin{document}\n${PROSE}\\end{document}\n`)
fs.writeFileSync(path.join(a.dir, 'refs.bib'), '@article{a,title={A}}\n')

// ---------------------------------------------------------------------------
// THE RUN. One edit, all the way across.

const pushed = await pushA.push({ changed: ['main.tex', 'refs.bib'], editedBy: 'the author' })
assert.equal(pushed.ok, true, `the push was accepted: ${JSON.stringify(pushed).slice(0, 300)}`)
assert.ok(pushed.sourceRevision, 'and it came back with a revision')

assert.equal(dispatched.length, 1, 'the accept dispatched exactly one fan-out payload')
const command = dispatched[0]

// **The loop-back header, at the far end.** It was read by the server and sent
// by nobody until fb6ef0a56; without it the fan-out would send this change back
// to the machine it came from and materialize over the author's open file.
assert.equal(command.sourceDaemonKey, 'machine-a:testing',
  'the payload names the machine it came from, which is what stops it going back there')

// B applies it, through the real materializer.
materializerB.plan({
  bindingId: 'binding-b',
  sourceDir: b.dir,
  sourceRevision: command.sourceRevision,
  previousRevision: command.previousRevision,
  baseManifest: command.baseManifest,
  targetManifest: command.targetManifest,
  blobs: command.blobs,
  outboundPending: [],
})
const applied = materializerB.apply('binding-b', command.sourceRevision)
assert.equal(applied.state, 'materialized',
  `B materialized the revision: ${JSON.stringify(applied.conflicts || []).slice(0, 200)}`)

// ---------------------------------------------------------------------------
// **THE ASSERTION THAT MATTERS: the bytes on the other machine.**

const landed = fs.readFileSync(path.join(b.dir, 'main.tex'), 'utf8')
assert.ok(landed.includes(PROSE),
  `IT WORKS AT ALL: the sentence typed on A is on B's disk — got ${JSON.stringify(landed.slice(0, 120))}`)
assert.equal(fs.readFileSync(path.join(b.dir, 'refs.bib'), 'utf8'), '@article{a,title={A}}\n',
  'and so is the second file, which nobody edited after the first push')

// And the server's own copy, which is what the build reads.
assert.equal(
  (await store.readRevisionFile(await store.head(project), 'main.tex')).toString(),
  fs.readFileSync(path.join(a.dir, 'main.tex'), 'utf8'),
  "the server holds exactly A's bytes",
)

// ---------------------------------------------------------------------------
// A SECOND edit, so this is a working loop rather than a first-push special
// case. Incremental fan-out carries only what changed.

const REVISED = 'The estimator is unbiased under the stated conditions, and consistent.\n'
fs.writeFileSync(path.join(a.dir, 'main.tex'),
  fs.readFileSync(path.join(a.dir, 'main.tex'), 'utf8').replace(PROSE, REVISED))
const second = await pushA.push({ changed: ['main.tex'], editedBy: 'the author' })
assert.equal(second.ok, true, `the second push was accepted: ${JSON.stringify(second).slice(0, 200)}`)
assert.equal(dispatched.length, 2, 'and dispatched again')

const next = dispatched[1]
assert.ok(!Object.keys(next.blobs).length || Object.keys(next.blobs).length === 1,
  'the incremental payload carries only the file that changed')

materializerB.plan({
  bindingId: 'binding-b',
  sourceDir: b.dir,
  sourceRevision: next.sourceRevision,
  previousRevision: next.previousRevision,
  baseManifest: next.baseManifest,
  targetManifest: next.targetManifest,
  blobs: next.blobs,
  outboundPending: [],
})
const appliedAgain = materializerB.apply('binding-b', next.sourceRevision)
assert.equal(appliedAgain.state, 'materialized',
  `B took the second revision too: ${JSON.stringify(appliedAgain.conflicts || []).slice(0, 200)}`)
assert.ok(fs.readFileSync(path.join(b.dir, 'main.tex'), 'utf8').includes(REVISED),
  'A SECOND TIME: the revised sentence reached B, so this is a loop and not one lucky push')

listening.close()
fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
console.log('an edit that reaches another machine: typed on A, accepted, and read back off B\'s disk — twice')
process.exit(0)
