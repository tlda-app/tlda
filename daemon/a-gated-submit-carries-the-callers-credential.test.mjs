/**
 * **A classroom link carries the caller's credential on the proposal push —
 * as a one-shot target, never a stored remote.**
 *
 * Observed on the gated sandbox: after the history-seed repair, the
 * immediately subsequent proposal push of project 1 used a passwordless URL
 * (`refs/tlda/proposals/...`) and failed with `could not read Password ...
 * Device not configured`. The boundary is that the sync's `remote` is fixed
 * at `initialize` from the daemon's values, while the seed push takes a
 * per-call override — so the caller's server and token (`project-source-link`
 * carries both) never reached the submit path.
 *
 * The repair adds a per-call `pushTarget` to `pushRevision` (forwarded
 * through `submitCurrent`), which the manager builds per call from the
 * caller's server/token via the same `projectRemoteUrl` the seed push uses.
 *
 * These tests drive `submitCurrent` on real checkouts with a recording
 * `runGit` seam: every git call runs for real except the proposal push
 * itself, whose remote argument is recorded (the proof) and redirected at a
 * local bare repo. So the test observes the exact remote the one-shot push
 * would hand git — credential and all — while the proposal lands locally,
 * and nothing touches the network. The manager half (override options map
 * to the one-shot target; absent options leave the daemon values alone) is
 * pinned against `projectRemoteUrl`, which is the same function the seed
 * repair's tests already cover. Each sync uses a fresh binding id so no
 * two share serialized chains or on-disk state.
 *
 * The control is the ordinary case: with no `pushTarget`, the push still
 * goes to the daemon-built remote, unchanged.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createGitProjectSync } from './git-project-sync.mjs'
import { createGitSyncManager } from './git-sync-manager.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })
const quiet = { info() {}, warn() {}, error() {} }

// A checkout with one document commit, standing on its work branch with an
// edit waiting — so `submitCurrent` has a proposal to push. The `tlda`
// remote points at a local bare repo only so the non-push git calls behave;
// the proposal push itself is intercepted below and never reaches it.
async function checkoutWithProposal(project) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-submit-credential-'))
  const remote = join(root, 'server.git')
  const dir = join(root, 'work')
  await git(root, ['init', '--bare', '-b', 'main', remote])
  await git(root, ['init', '-b', 'main', dir])
  await git(dir, ['config', 'user.email', 'me@tlda'])
  await git(dir, ['config', 'user.name', 'me'])
  writeFileSync(join(dir, 'main.tex'), 'paper one\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'paper'])
  await git(dir, ['remote', 'add', 'tlda', remote])
  const sync = createGitProjectSync({
    sourceDir: dir,
    project,
    daemonId: 'mini-testing',
    bindingId: 'binding-a',
    remote: 'https://daemon-default.example.test/git/paper',
    documentRoots: ['main.tex'],
    log: quiet,
  })
  await sync.standOnWorkBranch()
  writeFileSync(join(dir, 'main.tex'), 'paper two\n')
  return { root, dir, remote, sync }
}

// The sync's `runGit` seam with real git behind it: every git call runs for
// real except the proposal push, whose remote argument is recorded (the
// proof) and redirected at a local bare repo (which accepts any ref).
function pushRecorder(remote, pushTargets) {
  // `pushRevision` runs `git push --porcelain <target> <rev>:<proposal-ref>`,
  // so the target is the argument before the refspec, not a fixed index.
  return async (args, options = {}) => {
    const refspecIndex = args.findIndex(arg => typeof arg === 'string' && arg.includes('refs/tlda/proposals/'))
    if (args[0] === 'push' && refspecIndex > 1) {
      pushTargets.push(args[refspecIndex - 1])
      await git(options.cwd || process.cwd(), ['push', remote, args[refspecIndex]])
      return { stdout: '', stderr: '' }
    }
    return execFile('git', args, { encoding: 'utf8', timeout: 30_000, ...options })
  }
}

async function syncOver({ dir, bare, remote }) {
  const pushTargets = Object.assign([], { bare })
  const submitted = []
  const sync = createGitProjectSync({
    sourceDir: dir,
    project: 'paper',
    daemonId: 'mini-testing',
    bindingId: 'binding-b',
    remote,
    documentRoots: ['main.tex'],
    log: quiet,
    onSubmitted: value => submitted.push(value),
    runGit: pushRecorder(bare, pushTargets),
  })
  return { sync, pushTargets, submitted }
}

test('without a push target the proposal push uses the daemon-built remote', async () => {
  // THE DEFECT, pinned: the sync's remote is fixed at construction from the
  // daemon's values, so with no per-call target the proposal push carries
  // the daemon's passwordless URL.
  const { dir, remote: bare } = await checkoutWithProposal('paper')
  const { sync, pushTargets, submitted } = await syncOver({ dir, bare, remote: 'https://daemon-default.example.test/git/paper' })
  const proposal = await sync.submitCurrent()
  assert.equal(proposal.status, 'SubmittedToBuildQueue')
  assert.equal(pushTargets.length, 1, 'exactly one proposal push')
  const pushed = new URL(pushTargets[0])
  assert.equal(pushed.hostname, 'daemon-default.example.test')
  assert.equal(pushed.password, '', `passwordless — the observed failing shape: ${pushTargets[0]}`)
  assert.equal((await git(bare, ['rev-parse', proposal.proposalRef])).stdout.trim(), proposal.revision,
    'the proposal still lands')
  assert.equal(submitted.length, 1)
})

test('a per-call push target reaches the proposal push and persists nothing', async () => {
  // The repair: the caller-named server and credential win for this push
  // only, as the remote argument — no stored remote is touched.
  const { dir, remote: bare } = await checkoutWithProposal('paper')
  const { sync, pushTargets, submitted } = await syncOver({ dir, bare, remote: 'https://daemon-default.example.test/git/paper' })
  const before = readFileSync(join(dir, '.git/config'), 'utf8')
  const proposal = await sync.submitCurrent({ pushTarget: 'https://mini-testing:caller-rw-token@gated-preview.example.test/git/paper' })
  assert.equal(proposal.status, 'SubmittedToBuildQueue')
  assert.equal(pushTargets.length, 1, 'exactly one one-shot proposal push')
  const pushed = new URL(pushTargets[0])
  assert.equal(pushed.hostname, 'gated-preview.example.test',
    `pushed to the caller server: ${pushTargets[0]}`)
  assert.equal(pushed.password, 'caller-rw-token',
    `the push carried the caller credential: ${pushed.username}@...`)
  assert.match(proposal.proposalRef, /^refs\/tlda\/proposals\//, 'still a proposal ref')
  assert.equal((await git(bare, ['rev-parse', proposal.proposalRef])).stdout.trim(), proposal.revision,
    'the proposal still lands')
  assert.equal(readFileSync(join(dir, '.git/config'), 'utf8'), before,
    'no stored remote was created or rewritten for a one-shot push')
})

test('MANAGER: per-call overrides build the one-shot target; absent options leave the daemon URL', () => {
  // The manager half of the seam: `submit` maps the caller's server/token to
  // a `projectRemoteUrl` one-shot target, and with no override the daemon's
  // own values still build the URL.
  const root = mkdtempSync(join(tmpdir(), 'tlda-submit-credential-'))
  const plain = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'),
    daemonId: 'mini-testing',
    server: 'https://daemon-default.example.test',
    log: quiet,
  })
  const daemonUrl = new URL(plain.projectRemoteUrl('paper'))
  assert.equal(daemonUrl.hostname, 'daemon-default.example.test')
  assert.equal(daemonUrl.password, '', 'tokenless daemon URL is passwordless — the observed failing shape')

  const overrideUrl = new URL(plain.projectRemoteUrl('paper', 'https://gated-preview.example.test', 'caller-rw-token'))
  assert.equal(overrideUrl.hostname, 'gated-preview.example.test',
    `the caller server wins: ${overrideUrl}`)
  assert.equal(overrideUrl.password, 'caller-rw-token',
    `the caller credential reaches the URL: ${overrideUrl.username}@...`)

  const governed = createGitSyncManager({
    bindingsFile: join(root, 'governed.json'),
    daemonId: 'mini-testing',
    server: 'https://daemon-default.example.test',
    token: 'daemon-token',
    log: quiet,
  })
  const governedUrl = new URL(governed.projectRemoteUrl('paper'))
  assert.equal(governedUrl.password, 'daemon-token',
    `CONTROL: the daemon's own token still governs: ${governedUrl.username}@...`)
})
