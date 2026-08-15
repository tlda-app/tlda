import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { completeRemoteDeletedPaths, gitCommitRecords } from './overleaf-sync.mjs'

const execFile = promisify(execFileCallback)
const gitEnv = { ...process.env }
for (const key of Object.keys(gitEnv)) {
  if (key.startsWith('GIT_AUTHOR_') || key.startsWith('GIT_COMMITTER_')) {
    delete gitEnv[key]
  }
}

async function git(cwd, ...args) {
  const { stdout } = await execFile('git', args, { cwd, encoding: 'utf8', env: gitEnv })
  return stdout.trim()
}

test('git commit records keep record boundaries across multiple authors', async t => {
  const repo = await mkdtemp(path.join(tmpdir(), 'tlda-overleaf-history-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await git(repo, 'init', '--initial-branch=main')
  await git(repo, 'config', 'user.name', 'first author')
  await git(repo, 'config', 'user.email', 'first@example.test')
  await writeFile(path.join(repo, 'main.tex'), 'first\n')
  await git(repo, 'add', 'main.tex')
  await git(repo, 'commit', '--author', 'first author <first@example.test>', '-m', 'first')
  const first = await git(repo, 'rev-parse', 'HEAD')

  await git(repo, 'config', 'user.name', 'chieffff')
  await git(repo, 'config', 'user.email', 'chief@example.test')
  await writeFile(path.join(repo, 'main.tex'), 'second\n')
  await writeFile(path.join(repo, 'refs.bib'), 'entry\n')
  await git(repo, 'add', 'main.tex', 'refs.bib')
  await git(repo, 'commit', '-m', 'second')
  const second = await git(repo, 'rev-parse', 'HEAD')

  const records = await gitCommitRecords(repo, 'HEAD')
  assert.deepEqual(records.map(record => record.hash), [first, second])
  assert.deepEqual(records.map(record => record.author.name), ['first author', 'chieffff'])
  assert.deepEqual(records[0].changed_paths, ['main.tex'])
  assert.deepEqual(records[1].changed_paths.sort(), ['main.tex', 'refs.bib'])
})

test('ordinary remote poll deletes both git removals and prior-authority files already absent upstream', () => {
  assert.deepEqual(
    completeRemoteDeletedPaths(
      ['refs.bib'],
      ['.bak-before-deletion.tex', 'main.tex', 'refs.bib'],
      ['main.tex'],
    ),
    ['refs.bib', '.bak-before-deletion.tex'],
  )
})
