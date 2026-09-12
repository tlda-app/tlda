import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRemoteGitBridge } from './remote-git-bridge.mjs'
import {
  listProposalRefs,
  parseDaemonProposalRef,
  proposalRef,
  validateProposalUpdates,
} from '../server/lib/git-proposals.mjs'
import { historySeedRef } from '../shared/history-seed-ref.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30000 })
const ZERO = '0000000000000000000000000000000000000000'

test('remote bridge suppresses its own publication and merges a later remote edit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-remote-bridge-'))
  const remote = join(root, 'remote.git')
  const checkout = join(root, 'checkout')
  const peer = join(root, 'peer')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'origin', remote])
  writeFileSync(join(checkout, 'main.tex'), 'one\n')
  await git(checkout, ['add', 'main.tex'])
  await git(checkout, ['commit', '-m', 'one'])
  const first = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  const settled = []
  const bridge = createRemoteGitBridge({ sourceDir: checkout, onRemoteSettled: event => settled.push(event) })
  assert.equal((await bridge.publish(first)).status, 'published')
  assert.equal((await bridge.poll()).status, 'publication-acknowledged')
  assert.equal(settled.length, 0)

  await git(root, ['clone', '-b', 'main', remote, peer])
  await git(peer, ['config', 'user.name', 'peer'])
  await git(peer, ['config', 'user.email', 'peer@example.test'])
  writeFileSync(join(peer, 'other.tex'), 'remote\n')
  await git(peer, ['add', 'other.tex'])
  await git(peer, ['commit', '-m', 'remote'])
  await git(peer, ['push', 'origin', 'HEAD:main'])
  const result = await bridge.poll()
  assert.equal(result.status, 'merged')
  assert.equal(settled.length, 1)
})

test('tlda project mode publishes an exact immutable proposal and retries idempotently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-bridge-'))
  const remote = join(root, 'remote.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'preview', remote])
  writeFileSync(join(checkout, 'main.tex'), 'one\n')
  await git(checkout, ['add', 'main.tex'])
  await git(checkout, ['commit', '-m', 'one'])
  const revision = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  const bridge = createRemoteGitBridge({
    sourceDir: checkout, remote: 'preview', branch: 'tlda/qtm285-course',
    mode: 'tlda-project', project: 'qtm285-course', daemonId: 'mini:pic-dev',
    onRemoteSettled: async () => {},
    execFile: async (command, args, options) => {
      const result = await execFile(command, args, options)
      return args[0] === 'push'
        ? { ...result, stderr: `${result.stderr || ''}\nSubmittedToBuildQueue ${revision}\n` }
        : result
    },
  })
  const first = await bridge.publish(revision)
  assert.equal(first.status, 'proposal-accepted')
  assert.match(first.ref, /^refs\/tlda\/proposals\/mini-pic-dev\/tlda\/qtm285-course\//)
  assert.equal((await git(remote, ['rev-parse', first.ref])).stdout.trim(), revision)
  assert.equal((await bridge.publish(revision)).status, 'proposal-present')
})

test('tlda project mode rejects a push without a proposal-acceptance receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-unacknowledged-bridge-'))
  const remote = join(root, 'remote.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'preview', remote])
  writeFileSync(join(checkout, 'main.tex'), 'one\n')
  await git(checkout, ['add', 'main.tex'])
  await git(checkout, ['commit', '-m', 'one'])
  const revision = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  let visible = null
  const bridge = createRemoteGitBridge({
    sourceDir: checkout, remote: 'preview', branch: 'tlda/qtm285-course',
    mode: 'tlda-project', project: 'qtm285-course', daemonId: 'mini:pic-dev',
    onRemoteSettled: async () => {}, onPublishFailed: event => { visible = event },
  })
  await assert.rejects(bridge.publish(revision), /did not return a proposal-acceptance receipt/)
  assert.equal(visible.revision, revision)
})

test('tlda project mode reports a durable proposal only as present', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-present-bridge-'))
  const remote = join(root, 'remote.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'preview', remote])
  writeFileSync(join(checkout, 'main.tex'), 'one\n')
  await git(checkout, ['add', 'main.tex'])
  await git(checkout, ['commit', '-m', 'one'])
  const revision = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  const ref = `refs/tlda/proposals/mini-pic-dev/work/${revision}`
  await git(checkout, ['push', 'preview', `${revision}:${ref}`])
  const bridge = createRemoteGitBridge({
    sourceDir: checkout, remote: 'preview', branch: 'work',
    mode: 'tlda-project', project: 'course', daemonId: 'mini:pic-dev',
    onRemoteSettled: async () => {},
  })
  assert.equal((await bridge.publish(revision)).status, 'proposal-present')
})

test('a rejected branch publication with no remote branch stays failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-rejected-bridge-'))
  const remote = join(root, 'remote.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.tex'), 'one\n')
  await git(checkout, ['add', 'main.tex'])
  await git(checkout, ['commit', '-m', 'one'])
  await git(checkout, ['remote', 'add', 'preview', remote])
  writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const revision = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  let visible = null
  const bridge = createRemoteGitBridge({
    sourceDir: checkout, remote: 'preview', branch: 'missing', project: 'course',
    onRemoteSettled: async () => {}, onPublishFailed: event => { visible = event },
    log: { warn() {} },
  })
  await assert.rejects(bridge.publish(revision))
  assert.equal(visible.revision, revision)
})

test('proposal refs share the authenticated namespace used by history seeds', () => {
  const revision = 'a'.repeat(40)
  const ref = proposalRef({ daemonId: 'mini:pic-dev', branch: 'work', revision })
  assert.equal(ref, `refs/tlda/proposals/mini-pic-dev/work/${revision}`)
  assert.deepEqual(parseDaemonProposalRef(ref, 'mini:pic-dev'), { daemonId: 'mini:pic-dev', branch: 'work', revision })
  assert.equal(parseDaemonProposalRef(ref, 'mini:pic-preview'), null)
  assert.match(historySeedRef({ daemonId: 'mini:pic-dev', revision }), /\/mini-pic-dev\//)
})

test('proposal validation and listing preserve canonical authority and legacy refs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-proposal-protocol-'))
  const remote = join(root, 'remote.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.tex'), 'one\n')
  await git(checkout, ['add', 'main.tex'])
  await git(checkout, ['commit', '-m', 'one'])
  const first = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  writeFileSync(join(checkout, 'main.tex'), 'two\n')
  await git(checkout, ['commit', '-am', 'two'])
  const second = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(checkout, ['remote', 'add', 'origin', remote])
  await git(checkout, ['push', 'origin', 'main'])

  const canonical = proposalRef({ daemonId: 'mini:pic-dev', branch: 'work', revision: second })
  await assert.doesNotReject(validateProposalUpdates({
    gitDir: remote, project: 'course', daemonId: 'mini:pic-dev', input: `${ZERO} ${second} ${canonical}\n`,
  }))
  await assert.rejects(validateProposalUpdates({
    gitDir: remote, project: 'course', daemonId: 'mini:pic-dev', input: `${first} ${second} ${canonical}\n`,
  }), /new immutable ref/)
  await assert.rejects(validateProposalUpdates({
    gitDir: remote, project: 'course', daemonId: 'mini:pic-dev',
    input: `${ZERO} ${second} ${proposalRef({ daemonId: 'mini:other', branch: 'work', revision: second })}\n`,
  }), /authenticated daemon namespace/)
  await git(remote, ['update-ref', 'refs/tlda/source/course', second])
  await assert.rejects(validateProposalUpdates({
    gitDir: remote, project: 'course', daemonId: 'mini:pic-dev',
    input: `${ZERO} ${first} ${proposalRef({ daemonId: 'mini:pic-dev', branch: 'work', revision: first })}\n`,
  }), /WrongHead/)

  const canonicalStored = proposalRef({ daemonId: 'mini:pic-dev', branch: 'stored', revision: first })
  const legacyStored = `refs/tlda/proposals/mini%3Apic-dev/legacy/${second}`
  await git(remote, ['update-ref', canonicalStored, first])
  await git(remote, ['update-ref', legacyStored, second])
  const rows = await listProposalRefs(remote)
  assert.deepEqual(rows.map(row => row.ref).sort(), [canonicalStored, legacyStored].sort())
  assert.equal(rows.find(row => row.ref === legacyStored).daemonId, 'mini:pic-dev')
})
