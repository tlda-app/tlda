#!/usr/bin/env node
//
// The accept path builds a replica payload; the daemon's materializer applies
// it. **Nothing checks that the two agree**, and they disagreed in two ways at
// once — each of which fails silently or on the far side, after the accept has
// been reported as successful.
//
//   - `readRevision` is async since revisions became commits. Unawaited, both
//     manifests arrive as `[]`, the materializer plans a union of two empty
//     sets, finds no paths, and applies nothing. The response still says
//     `replicas`.
//   - The blobs were keyed by sha256 while the manifest names git blob ids, so
//     the lookup misses and the apply throws `Missing blob` on the daemon.
//
// Both are the shape this replacement exists to remove: a green path with the
// work silently not happening. So this asserts the JOIN rather than either end
// — a payload built the way the route builds it, planned by the real
// materializer, with every blob it asks for actually findable.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'
import { createSourceMaterializer } from '../daemon/source-materializer.mjs'
import { gitBlobId } from '../shared/git-blob-id.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-payload-'))
const gitDir = path.join(root, 'git')
spawnSync('git', ['init', '--bare', '--quiet', gitDir])
const store = createSourceGitStore({ gitDir })

const first = await store.acceptRevision({
  project: 'paper',
  replaceTree: true,
  message: 'first',
  files: [
    { path: 'main.tex', content: 'the paper\n' },
    { path: 'gone.tex', content: 'a section about to go\n' },
  ],
})
const second = await store.acceptRevision({
  project: 'paper',
  parent: first,
  replaceTree: true,
  message: 'second',
  files: [{ path: 'main.tex', content: 'the paper, revised\n' }],
})

// What the route derives, and it must be derived rather than declared: a bundle
// carries a tree and no list of what moved.
const { changed, deleted } = await store.diffRevisions(first, second)
assert.deepEqual(changed, ['main.tex'])
assert.deepEqual(deleted, ['gone.tex'])

// The payload, built exactly as the accept path builds it.
const targetRevision = await store.readManifest(second)
const baseRevision = await store.readManifest(first)
const blobs = {}
for (const rel of changed) {
  const bytes = await store.readRevisionFile(second, rel)
  blobs[gitBlobId(bytes)] = bytes.toString('base64')
}

// **The manifests must not be empty.** Unawaited reads produce exactly this
// shape with `[]` on both sides, and every assertion about the plan below still
// "passes" in the sense of not throwing — it simply plans nothing.
assert.ok(targetRevision.length > 0, 'the target manifest is not empty')
assert.ok(baseRevision.length > 0, 'the base manifest is not empty')

const checkout = path.join(root, 'checkout')
fs.mkdirSync(checkout, { recursive: true })
fs.writeFileSync(path.join(checkout, 'main.tex'), 'the paper\n')
fs.writeFileSync(path.join(checkout, 'gone.tex'), 'a section about to go\n')

const materializer = createSourceMaterializer({ journalPath: path.join(root, 'materializations.json') })
const record = materializer.plan({
  bindingId: 'a-binding',
  sourceDir: checkout,
  sourceRevision: second,
  previousRevision: first,
  baseManifest: baseRevision,
  targetManifest: targetRevision,
  blobs,
})

// The far side planned real work rather than an empty union.
const actions = Object.fromEntries(record.paths.map(entry => [entry.path, entry.action]))
assert.deepEqual(actions, { 'main.tex': 'change', 'gone.tex': 'delete' },
  'the materializer plans exactly what the diff said moved')

// **And every blob it will ask for is findable.** This is the half that was
// keyed wrong: the manifest names git blob ids, so the payload must too, or the
// apply throws on the daemon after the server has already reported success.
for (const entry of record.paths) {
  if (!entry.targetHash) continue
  assert.ok(blobs[entry.targetHash],
    `the payload carries the bytes the materializer asks for (${entry.path} → ${entry.targetHash.slice(0, 8)})`)
  assert.equal(gitBlobId(Buffer.from(blobs[entry.targetHash], 'base64')), entry.targetHash,
    'and they hash to what the manifest named')
}

fs.rmSync(root, { recursive: true, force: true })
console.log('a replica payload the far side can apply: the join holds')
