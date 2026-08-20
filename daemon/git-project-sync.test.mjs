import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createGitProjectSync } from './git-project-sync.mjs'

const execFile = promisify(execFileCb)
async function git(cwd, args) { return execFile('git', args, { cwd, encoding: 'utf8', timeout: 30000 }) }

test('settle submits an immutable daemon proposal and HeadChanged fetches exact head', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-git-sync-'))
  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'tlda', remote])
  writeFileSync(join(checkout, 'main.tex'), '\\input{chapter}\n')
  writeFileSync(join(checkout, 'chapter.tex'), 'one\n')
  writeFileSync(join(checkout, 'notes.txt'), 'not project source\n')
  await git(checkout, ['add', 'main.tex', 'chapter.tex', 'notes.txt'])
  await git(checkout, ['commit', '-m', 'base'])
  const base = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(checkout, ['push', 'tlda', `${base}:refs/tlda/source/paper`])
  await git(checkout, ['update-ref', 'refs/tlda/applied/binding-a', base])
  await git(checkout, ['fetch', 'tlda', '+refs/tlda/source/paper:refs/tlda/fetched/paper'])

  const submitted = []
  const arrived = []
  const sync = createGitProjectSync({ sourceDir: checkout, project: 'paper', daemonId: 'daemon-a', bindingId: 'binding-a', onSubmitted: value => submitted.push(value), onMirrorArrived: value => arrived.push(value) })
  writeFileSync(join(checkout, 'chapter.tex'), 'two\n')
  const proposal = await sync.editClusterSettled()
  assert.equal(proposal.status, 'SubmittedToBuildQueue')
  assert.equal(submitted.length, 1)
  assert.match(proposal.proposalRef, new RegExp(`^refs/tlda/proposals/daemon-a/main/${proposal.revision}$`))
  assert.equal((await git(remote, ['rev-parse', proposal.proposalRef])).stdout.trim(), proposal.revision)
  assert.deepEqual((await git(remote, ['ls-tree', '-r', '--name-only', proposal.revision])).stdout.trim().split('\n'), ['chapter.tex', 'main.tex'])
  await assert.rejects(git(remote, ['cat-file', '-e', `${proposal.revision}:notes.txt`]))
  assert.equal((await git(remote, ['rev-parse', 'refs/tlda/source/paper'])).stdout.trim(), base, 'submission does not advance shared head')

  await git(remote, ['update-ref', 'refs/tlda/source/paper', proposal.revision, base])
  const mirrored = await sync.headChanged(proposal.revision)
  assert.equal(arrived.at(-1).revision, proposal.revision)
  assert.equal(mirrored.status, 'already-applied')
  assert.equal((await git(checkout, ['rev-parse', 'refs/tlda/applied/binding-a'])).stdout.trim(), proposal.revision)
})
