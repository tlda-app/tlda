#!/usr/bin/env node
//
// **An accept that runs no effects is the failure this replacement exists to
// remove**, so the effects are asserted by name rather than trusted.
//
// The route reports which ones ran, in `postAcceptEffects`. That field is an
// array of names and not a boolean precisely because *the accept worked* and
// *the work was preserved* are different facts, and a caller cannot see the
// second. This asserts the ones that are derivable without a server: the two
// that a bundle does not carry and this path has to compute.
//
//   - `changed` / `deleted`, derived from the trees, because a bundle declares
//     no file list.
//   - the edit event's line REGIONS, which the old push route is handed and
//     this one must diff for. Dropping them leaves the accept correct and the
//     attribution silently gone — quieter than a dropped mirror, not smaller.
//
// It exercises the receiver's derivation, not the route: sender and wire are
// covered by `a-proposal-that-crosses-the-wire-test.mjs`.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'
import { changedTextRegions } from '../server/lib/changed-text-regions.mjs'
import { createSourceEditEvent } from '../server/lib/source-edit-event.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-effects-'))
const gitDir = path.join(root, 'git')
spawnSync('git', ['init', '--bare', '--quiet', gitDir])
const store = createSourceGitStore({ gitDir })
const project = 'paper'

const before = await store.acceptRevision({
  project,
  message: 'his night, before',
  files: [
    { path: 'main.tex', content: 'one\ntwo\nthree\n' },
    { path: 'gone.tex', content: 'a section about to go\n' },
    { path: 'figure.png', content: 'not text\n' },
  ],
})
const after = await store.acceptRevision({
  project,
  parent: before,
  message: 'his night, after',
  files: [
    { path: 'main.tex', content: 'one\nTWO, revised\nthree\n' },
    { path: 'figure.png', content: 'not text\n' },
  ],
})

// What moved, derived from the trees rather than declared by the sender.
const { changed, deleted } = await store.diffRevisions(before, after)
assert.deepEqual(changed, ['main.tex'], 'the changed set is derived')
assert.deepEqual(deleted, ['gone.tex'], 'and so is the deleted set')

// The regions the edit event carries, computed the way the route computes them.
const editedFiles = []
for (const file of changed) {
  if (!file.endsWith('.tex') && !file.endsWith('.md')) continue
  const nextBytes = await store.readRevisionFile(after, file)
  const prevBytes = await store.readRevisionFile(before, file)
  const regions = changedTextRegions(prevBytes ? prevBytes.toString('utf8') : '', nextBytes ? nextBytes.toString('utf8') : '')
  if (regions.length) editedFiles.push({ path: file, regions })
}

assert.equal(editedFiles.length, 1, 'the .tex file produced an edit record')
assert.equal(editedFiles[0].path, 'main.tex')
assert.ok(editedFiles[0].regions.length > 0, 'with real line regions, not an empty array')
assert.ok(
  editedFiles[0].regions.some(region => region.content.includes('TWO, revised')),
  'and the region carries the line that actually changed',
)

// **The event only exists if the regions do.** An empty `regions` array yields
// null, so an effect that computed nothing would report itself as ran while
// emitting nothing — assert the event, not the intention.
const event = createSourceEditEvent({
  result: { ok: true, acceptedChangedFiles: editedFiles },
  project,
  editedBy: 'fleet:someone',
  requestId: 'a-request',
})
assert.ok(event, 'the edit event is emitted')
assert.equal(event.to, 'fleet:someone', 'attributed to whoever made the edit')
assert.deepEqual(event.metadata.files.map(f => f.path), ['main.tex'])

// The counterfactual that matters: filenames without regions produce NO event.
assert.equal(
  createSourceEditEvent({
    result: { ok: true, acceptedChangedFiles: changed.map(p => ({ path: p, regions: [] })) },
    project,
    editedBy: 'fleet:someone',
    requestId: 'a-request',
  }),
  null,
  'a path list with no regions emits nothing — which is why deriving them is the work',
)

fs.rmSync(root, { recursive: true, force: true })
console.log('an accept that preserves the work: the derived effects hold')
