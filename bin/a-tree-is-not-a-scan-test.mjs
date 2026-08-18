#!/usr/bin/env node
//
// **`replaceTree` deletes everything nobody named.** That is what it is for, and
// it is why a caller may never hand it a freshly-scanned set.
//
// The commit's tree is the manifest, so absence from it is how a path is
// deleted. `acceptRevision({ replaceTree: true })` therefore builds the tree
// from `files` alone and inherits nothing — exact, and a silent mass deletion in
// the hands of a caller that computed `files` by looking at the disk.
//
// This is not hypothetical and it is not about the replacement. On the code
// running tonight, `daemon/source-sync.mjs:1268` derives deletions from the
// reference closure:
//
//     if (!deps.has(rel) && state.authorityManifest.has(rel) && …) deleted.push(rel)
//
// so a path the scanner fails to reach — behind an unreadable `.tex`, absent for
// the instant of a rename, referenced through a macro — is pushed as deleted.
// `edits-dont-reach-the-file` demonstrated it with two fixture trees one
// permission bit apart, and a branch of the manuscript left the paper.
//
// **The invariant, for whoever writes the daemon half:**
//
//   The tree committed for a revision is the PREVIOUS tree, plus what was
//   added, minus what was OBSERVED being removed. A scan is evidence for
//   adding. It is never, on its own, evidence for removing.
//
// This file exists because the author of the accept path read that mechanism
// wrong three times in one hour, each time by stopping at the function that
// agreed with him. A test does not stop.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'

const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-not-scan-'))
spawnSync('git', ['init', '--bare', '--quiet', gitDir])
const store = createSourceGitStore({ gitDir })

const paper = [
  { path: 'main.tex', content: '\\input{intro}\n\\input{proof}\n' },
  { path: 'intro.tex', content: 'the introduction\n' },
  { path: 'proof.tex', content: 'the proof\n' },
]

const first = await store.acceptRevision({ project: 'paper', files: paper, replaceTree: true, message: 'the paper' })
assert.deepEqual(
  (await store.readManifest(first)).map(entry => entry.path).sort(),
  ['intro.tex', 'main.tex', 'proof.tex'],
)

// **The hazard, stated as a passing test rather than a warning comment.** A
// caller that recomputed membership and missed one file — for any of the reasons
// a filesystem probe can miss one — commits a tree without it, and the file is
// deleted from the paper. Nothing errors. The push succeeds.
const scanMissedProof = paper.filter(file => file.path !== 'proof.tex')
const afterMiss = await store.acceptRevision({
  project: 'paper',
  parent: first,
  files: scanMissedProof,
  replaceTree: true,
  message: 'a revision built from a scan that missed a file',
})
const manifestAfterMiss = (await store.readManifest(afterMiss)).map(entry => entry.path)
assert.deepEqual(manifestAfterMiss.sort(), ['intro.tex', 'main.tex'])
assert.ok(!manifestAfterMiss.includes('proof.tex'), 'a scan miss silently deletes the file from the paper')

// **And the same call is correct when the caller carries the previous tree
// forward.** The difference is entirely in what `files` contains — the store
// cannot tell the two apart, which is exactly why the invariant belongs to the
// caller and why it is written down here rather than enforced below.
const previous = await store.readManifest(first)
const carriedForward = [
  ...previous.map(entry => ({ path: entry.path, sha: entry.sha256 })),
  { path: 'lemma.tex', content: 'a new lemma\n' },
]
const afterAdd = await store.acceptRevision({
  project: 'paper',
  parent: first,
  files: carriedForward,
  replaceTree: true,
  message: 'the previous tree plus what was added',
})
assert.deepEqual(
  (await store.readManifest(afterAdd)).map(entry => entry.path).sort(),
  ['intro.tex', 'lemma.tex', 'main.tex', 'proof.tex'],
  'carrying the previous tree forward adds without deleting',
)

// A deletion is expressible and must be deliberate: the path is dropped from the
// carried-forward set because it was OBSERVED to go, not because a probe failed
// to see it.
const observedDeletion = previous
  .filter(entry => entry.path !== 'intro.tex')
  .map(entry => ({ path: entry.path, sha: entry.sha256 }))
const afterDelete = await store.acceptRevision({
  project: 'paper',
  parent: afterAdd,
  files: observedDeletion,
  replaceTree: true,
  message: 'an observed deletion',
})
assert.deepEqual(
  (await store.readManifest(afterDelete)).map(entry => entry.path).sort(),
  ['main.tex', 'proof.tex'],
  'an observed deletion removes exactly the path that went',
)

fs.rmSync(gitDir, { recursive: true, force: true })
console.log('a tree is not a scan: the invariant holds and the hazard is demonstrated')
