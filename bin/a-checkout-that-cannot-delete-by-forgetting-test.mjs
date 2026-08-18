#!/usr/bin/env node
//
// The daemon half of the accept path, and the two things it must not do.
//
// **It must not delete a file by failing to mention it.** The reference closure
// that decides what the daemon watches cannot tell *deleted* from *mid-rename*,
// or a failed read from a file with no references — demonstrated on fixtures one
// permission bit apart. Every one of those is an inability to observe, and on
// the old path they go straight into `deletedFiles`.
//
// **And it must not clobber the server when it rebases.** A refusal means
// somebody else's work is in the head. Re-proposing the tree we already built
// would hand back our whole view of the project and silently drop theirs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSourceProposal } from '../daemon/source-proposal.mjs'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cannot-delete-'))
const checkout = path.join(root, 'checkout')
fs.mkdirSync(checkout, { recursive: true })
const git = args => {
  const r = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}
git(['init', '-b', 'main'])
git(['config', 'user.name', 'the author'])
git(['config', 'user.email', 'author@example.test'])

const write = (rel, text) => fs.writeFileSync(path.join(checkout, rel), text)
write('main.tex', 'the paper\n')
write('intro.tex', 'the introduction\n')
write('figure.tex', 'a figure nobody is editing\n')

const proposal = createSourceProposal({ sourceDir: checkout, project: 'paper' })
const store = createSourceGitStore({ gitDir: path.join(checkout, '.git') })
const manifest = async commit => (await store.readManifest(commit)).map(entry => entry.path).sort()

// The first proposal carries everything, because the checkout holds nothing yet.
const first = await proposal.proposeCommit({ changed: ['main.tex', 'intro.tex', 'figure.tex'] })
assert.deepEqual(await manifest(first.commit), ['figure.tex', 'intro.tex', 'main.tex'])

// ---------------------------------------------------------------------------
// **A scan that misses a file does not delete it.**
//
// The author edits one file. The closure — for whatever reason it has today —
// reports only that one. Under `replaceTree` this proposal would carry a tree
// of one file and delete the other two. Inheriting the parent's tree means the
// omission costs nothing.

write('main.tex', 'the paper, revised\n')
const partial = await proposal.proposeCommit({ changed: ['main.tex'] })
assert.deepEqual(
  await manifest(partial.commit),
  ['figure.tex', 'intro.tex', 'main.tex'],
  'a proposal that mentions one file does not remove the others',
)
assert.equal(
  (await store.readRevisionFile(partial.commit, 'main.tex')).toString(),
  'the paper, revised\n',
  'and the file it did mention carries the new bytes',
)

// A deletion is expressible, and only from an observation.
fs.rmSync(path.join(checkout, 'intro.tex'))
const removed = await proposal.proposeCommit({ changed: [], deleted: ['intro.tex'] })
assert.deepEqual(
  await manifest(removed.commit),
  ['figure.tex', 'main.tex'],
  'an observed deletion removes exactly the path that went',
)

// ---------------------------------------------------------------------------
// **A rebase re-applies our delta over their head; it does not hand back our
// tree.**
//
// The server has accepted somebody else's change to a file we are not touching.
// Our proposal is refused. Re-proposing must keep their work.

const theirCommit = await store.acceptRevision({
  project: 'paper',
  parent: removed.commit,
  message: 'somebody else, on the server',
  files: [{ path: 'figure.tex', content: 'a figure THEY edited\n' }],
})

write('main.tex', 'the paper, revised again\n')
const refused = await proposal.proposeCommit({ changed: ['main.tex'] })
assert.ok(refused.changed)

const rebased = await proposal.rebaseOnto(theirCommit, { changed: ['main.tex'] })
assert.equal(
  (await store.readRevisionFile(rebased.commit, 'figure.tex')).toString(),
  'a figure THEY edited\n',
  'THE CLOBBER TEST: rebasing keeps what the server accepted from somebody else',
)
assert.equal(
  (await store.readRevisionFile(rebased.commit, 'main.tex')).toString(),
  'the paper, revised again\n',
  'and still carries our own change',
)

// And it fast-forwards, which is the whole point of having rebased.
assert.ok(await store.isAncestor(theirCommit, rebased.commit), 'the re-proposal descends from the head it was refused against')

// ---------------------------------------------------------------------------
// The bundle carries what the server lacks and no more.

const bundle = await proposal.bundleSince(theirCommit)
const prerequisites = bundle.toString('binary').split('\n')
  .filter(line => /^-[0-9a-f]{40}/.test(line))
  .map(line => line.slice(1, 41))
assert.deepEqual(prerequisites, [theirCommit], 'the bundle asks the server for what it already has')

fs.rmSync(root, { recursive: true, force: true })
console.log('a checkout that cannot delete by forgetting: passed')
