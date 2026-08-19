#!/usr/bin/env node
//
// What changed between two revisions is derived from the tree, not declared.
//
// The old push route is handed `files: [{path, content}]` and builds every
// post-accept effect from that list — the replica payload, the manifests, the
// blob map. A bundle carries a tree and no list, so the effects have to ask git
// what moved. That derivation is the one piece of new machinery in the accept
// path, and it is silent when it is wrong: a path this misses is a path a bound
// checkout never hears changed, on the wire the author's paper travels.
//
// It runs against a real repository and boots nothing. There is no server here
// on purpose — the thing under test is a git question, and the wire above it is
// covered by a-checkout-proposes-a-commit-test.mjs.
//
// The case worth the file is the third one: an unchanged head must diff to
// nothing. A parser that mistakes the shape of `--root` output reports every
// path in the tree instead, which reads downstream as "the author replaced the
// whole paper" rather than as an error.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-diff-'))
const git = args => execFileSync('git', ['-C', root, ...args]).toString().trim()

git(['init', '-q', '.'])
git(['config', 'user.email', 'test@tlda'])
git(['config', 'user.name', 'test'])

fs.writeFileSync(path.join(root, 'paper.tex'), 'one\n')
fs.writeFileSync(path.join(root, 'appendix.tex'), 'x\n')
git(['add', '-A'])
git(['commit', '-qm', 'first'])
const first = git(['rev-parse', 'HEAD'])

fs.writeFileSync(path.join(root, 'paper.tex'), 'two\n')
// A space in the name: the reason the parser reads NUL-separated fields rather
// than splitting the line the way the manifest readers beside it do.
fs.writeFileSync(path.join(root, 'a new section.tex'), 'n\n')
fs.rmSync(path.join(root, 'appendix.tex'))
git(['add', '-A'])
git(['commit', '-qm', 'second'])
const second = git(['rev-parse', 'HEAD'])

const store = createSourceGitStore({ gitDir: path.join(root, '.git') })

// A first revision has no parent, so every path in it is a change. That is what
// a first revision means rather than an edge case to guard.
assert.deepEqual(
  await store.diffRevisions(null, first),
  { changed: ['appendix.tex', 'paper.tex'], deleted: [] },
  'first revision: every path is a change',
)

assert.deepEqual(
  await store.diffRevisions(first, second),
  { changed: ['a new section.tex', 'paper.tex'], deleted: ['appendix.tex'] },
  'a modify, an add whose name contains a space, and a delete',
)

// The one that matters. Wrong, this returns the whole tree.
assert.deepEqual(
  await store.diffRevisions(second, second),
  { changed: [], deleted: [] },
  'an unchanged head diffs to nothing, not to everything',
)

assert.deepEqual(
  await store.diffRevisions(first, null),
  { changed: [], deleted: [] },
  'no head is no diff',
)

fs.rmSync(root, { recursive: true, force: true })
console.log('ok — a bundle diff names what moved')
