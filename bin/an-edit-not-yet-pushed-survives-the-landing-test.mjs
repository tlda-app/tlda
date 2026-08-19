#!/usr/bin/env node
//
// **Gate 3: an edit typed and not pushed is still there afterwards.**
//
// Skip, 05:14: *"when their accepted revision lands on your disc, like, if you
// have to do a merge, into a working copy that isn't committed, commit the
// fucking working copy and do a fucking merge."*
//
// Before this, the landing path REFUSED to touch a file whose bytes had moved.
// That was safe — his text survived — but it left the checkout stranded between
// two revisions, so his edit was safe and the other person's never arrived.
//
// Now: commit first, then merge. Committing is what makes the merge safe rather
// than brave — whatever was on disk is recoverable from a commit before a byte
// is touched.
//
// **What does not change is the conflicted case.** A three-way that comes back
// with markers still leaves the file alone. Writing both copies in destroyed
// text being dictated into three times on 2026-08-17, once turning a 282KB
// document into a 564KB whole-file conflict. Merge when it is mechanical;
// refuse when it is a judgement.
//
// Fresh project, created by this test.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSourceMaterializer } from '../daemon/source-materializer.mjs'
import { classifyThreeWay } from '../server/lib/source-lifecycle.mjs'
import { gitBlobId } from '../shared/git-blob-id.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-merge-'))
const checkout = path.join(root, 'checkout')
fs.mkdirSync(checkout, { recursive: true })
for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'the author'], ['config', 'user.email', 'a@test']]) {
  const r = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
}

// The three sides, by blob id, as the daemon holds them.
const blobStore = new Map()
const keep = buffer => { blobStore.set(gitBlobId(buffer), buffer); return gitBlobId(buffer) }

const commits = []
const materializer = createSourceMaterializer({
  journalPath: path.join(root, 'journal.json'),
  baseBytes: sha => blobStore.get(sha) || null,
  // Onto the daemon's own ref, never the author's branch: we are a guest in
  // that repository. Recorded here so the test can assert it happened BEFORE
  // any byte was written.
  commitWorkingCopy: (dir, why) => {
    commits.push({ dir, why, bytes: fs.readFileSync(path.join(checkout, 'main.tex'), 'utf8') })
  },
  mergeIntoWorkingCopy: ({ base, ours, theirs }) => {
    if (!base || !ours || !theirs) return null
    const result = classifyThreeWay({
      base: base.toString('utf8'),
      current: theirs.toString('utf8'),
      incoming: ours.toString('utf8'),
    })
    return result.status === 'clean-rebase-candidate' ? Buffer.from(result.merged) : null
  },
})

const PROSE = ['opening line', '', 'the middle', '', 'closing line'].join('\n') + '\n'
const THEIRS = PROSE.replace('opening line', 'opening line, as THEY revised it')
const HIS_UNPUSHED = PROSE.replace('closing line', 'closing line, HIS UNPUSHED SENTENCE')

fs.writeFileSync(path.join(checkout, 'main.tex'), PROSE)
const baseSha = keep(Buffer.from(PROSE))
const theirSha = keep(Buffer.from(THEIRS))

materializer.seedBinding('binding-a', checkout, null)

// ---------------------------------------------------------------------------
// He types something and has not pushed it. Their revision lands underneath.

fs.writeFileSync(path.join(checkout, 'main.tex'), HIS_UNPUSHED)

materializer.plan({
  bindingId: 'binding-a',
  sourceDir: checkout,
  sourceRevision: 'their-revision',
  previousRevision: 'the-base',
  baseManifest: [{ path: 'main.tex', sha256: baseSha, size: PROSE.length }],
  targetManifest: [{ path: 'main.tex', sha256: theirSha, size: THEIRS.length }],
  blobs: { [theirSha]: Buffer.from(THEIRS).toString('base64') },
  outboundPending: [],
})
const applied = materializer.apply('binding-a', 'their-revision')

// ---------------------------------------------------------------------------
// **THE GATE.** His sentence is still there, and so is theirs.

const after = fs.readFileSync(path.join(checkout, 'main.tex'), 'utf8')

assert.ok(after.includes('HIS UNPUSHED SENTENCE'),
  `DOES NOT DESTROY CODE: the sentence he typed and never pushed is still on disk — got ${JSON.stringify(after.slice(0, 160))}`)
assert.ok(after.includes('as THEY revised it'),
  'AND IT LANDED: the other person\'s accepted edit arrived, so the checkout is not stranded between revisions')
assert.equal(applied.state, 'materialized', 'the revision completed rather than sitting conflicted')

// **Committed BEFORE anything was written**, which is what makes it recoverable
// rather than merely likely to work.
assert.equal(commits.length, 1, 'the working copy was committed exactly once')
assert.ok(commits[0].bytes.includes('HIS UNPUSHED SENTENCE'),
  'and the commit captured HIS bytes, taken before the merge touched the file')

// ---------------------------------------------------------------------------
// The judgement case is unchanged: same lines, both sides. Leave it alone.

const CONTESTED_THEIRS = PROSE.replace('closing line', 'closing line, THEIR final word')
const contestedSha = keep(Buffer.from(CONTESTED_THEIRS))
fs.writeFileSync(path.join(checkout, 'main.tex'), PROSE.replace('closing line', 'closing line, HIS final word'))
const before = fs.readFileSync(path.join(checkout, 'main.tex'), 'utf8')

materializer.plan({
  bindingId: 'binding-a',
  sourceDir: checkout,
  sourceRevision: 'contested-revision',
  previousRevision: 'the-base',
  baseManifest: [{ path: 'main.tex', sha256: baseSha, size: PROSE.length }],
  targetManifest: [{ path: 'main.tex', sha256: contestedSha, size: CONTESTED_THEIRS.length }],
  blobs: { [contestedSha]: Buffer.from(CONTESTED_THEIRS).toString('base64') },
  outboundPending: [],
})
const contested = materializer.apply('binding-a', 'contested-revision')

assert.equal(contested.state, 'conflicted', 'two people on the same line is a judgement, not a merge')
assert.equal(fs.readFileSync(path.join(checkout, 'main.tex'), 'utf8'), before,
  'NO MARKERS IN HIS PROSE: a file we cannot merge is left exactly as he left it')

fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
console.log('an edit not yet pushed survives the landing: his sentence and theirs both present, committed first, and a real conflict left untouched')
process.exit(0)
