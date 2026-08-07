import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { gitCommitRecords } from './overleaf-sync.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

test('git commit records keep record boundaries across multiple authors', async t => {
  const repo = mkdtempSync(path.join(tmpdir(), 'tlda-overleaf-history-'))
  t.after(() => execFileSync('rm', ['-rf', repo]))
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.name', 'first author')
  git(repo, 'config', 'user.email', 'first@example.test')
  writeFileSync(path.join(repo, 'main.tex'), 'first\n')
  git(repo, 'add', 'main.tex')
  git(repo, 'commit', '--author', 'first author <first@example.test>', '-m', 'first')
  const first = git(repo, 'rev-parse', 'HEAD')

  git(repo, 'config', 'user.name', 'chieffff')
  git(repo, 'config', 'user.email', 'chief@example.test')
  writeFileSync(path.join(repo, 'main.tex'), 'second\n')
  writeFileSync(path.join(repo, 'refs.bib'), 'entry\n')
  git(repo, 'add', 'main.tex', 'refs.bib')
  git(repo, 'commit', '-m', 'second')
  const second = git(repo, 'rev-parse', 'HEAD')

  const records = await gitCommitRecords(repo, 'HEAD')
  assert.deepEqual(records.map(record => record.hash), [first, second])
  assert.deepEqual(records.map(record => record.author.name), ['first author', 'chieffff'])
  assert.deepEqual(records[0].changed_paths, ['main.tex'])
  assert.deepEqual(records[1].changed_paths.sort(), ['main.tex', 'refs.bib'])
})
