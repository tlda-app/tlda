/**
 * **A browser edit must not lock a disk collaborator out of the project.**
 *
 * Measured on a disposable project on 2026-08-26, sampling the published source
 * and the revision identity every two seconds:
 *
 *     29s  browser edit made, socket held open
 *     36s  rev=79d2db9  <- the browser edit becomes a revision
 *     37s  disk edit made
 *     39s..81s  rev=79d2db9, unchanged for 45 seconds
 *
 * The disk edit never became a revision at all. The daemon log for the same
 * window says why, twice:
 *
 *     proposal not accepted: WrongHead
 *
 * The server requires the project head to be an ancestor of a proposal
 * (`server/lib/git-proposals.mjs`). Once the browser publishes, the checkout's
 * branch is no longer an ancestor, `pushRevision` takes the WrongHead branch,
 * `headChanged` PARKS the accepted head at `refs/tlda/fetched/<project>`
 * without applying it, and the branch never advances. So every later proposal
 * is rejected identically. **Not one edit is lost — every subsequent edit is**,
 * and the only trace is a log line the person never sees.
 *
 * **What must NOT be done to fix it, and why the constraint is tight.**
 * `d60d18573` removed five mutations of a repository the app does not own —
 * committing the person's dirty tree unasked, `checkout --force -B`, a
 * synthetic bridge commit on their HEAD, merging server history into their
 * checkout, and returning with that merge unresolved. None of that comes back.
 * Re-parenting the local tree unchanged is also wrong: it would carry the
 * checkout's older copies of files the browser has since changed, silently
 * reverting them.
 *
 * **So the requirement this test states is narrow.** Both sides'
 * non-conflicting changes survive, the result is acceptable to the server's
 * ancestry rule, and the person's checkout and index are untouched. On a real
 * conflict, the divergence is HELD and REPORTED — no winner is chosen here,
 * because that is merge semantics and not a test's to decide.
 *
 * The two cases are deliberately separate: LOSS and HELD-DIVERGENCE look
 * identical from outside (the edit is not in the document either way), and a
 * test that cannot tell them apart would pass on a fix that silently discarded
 * the conflicting side.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createGitProjectSync } from './git-project-sync.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })
const sha = async (cwd, ref) => (await git(cwd, ['rev-parse', ref])).stdout.trim()

/**
 * The server's ancestry rule, as a real pre-receive hook.
 *
 * `git-proposals.mjs` rejects a proposal unless the project head is an ancestor
 * of it, with the literal message this test depends on. Enforcing it here means
 * the test fails the way production fails, rather than the way a stub was
 * written to fail.
 */
function installAncestryRule(remote) {
  const hook = join(remote, 'hooks', 'pre-receive')
  writeFileSync(hook, `#!/bin/sh
head=$(git rev-parse --verify --quiet refs/tlda/source/paper)
[ -z "$head" ] && exit 0
while read old new ref; do
  case "$ref" in
    refs/tlda/source/*) continue ;;
  esac
  if ! git merge-base --is-ancestor "$head" "$new"; then
    echo "WrongHead $head" >&2
    exit 1
  fi
done
exit 0
`)
  chmodSync(hook, 0o755)
}

/**
 * A project whose BROWSER side has published a revision the checkout does not
 * have. Returns the pieces a test needs to drive one settle.
 */
async function projectWithABrowserEditAhead(root, { browserFile, browserText }) {
  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'tlda', remote])

  writeFileSync(join(checkout, 'main.md'), '# paper\n\nalpha\nbravo\ncharlie\n')
  writeFileSync(join(checkout, 'notes.md'), 'one\n')
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', 'base'])
  const base = await sha(checkout, 'HEAD')
  await git(checkout, ['push', 'tlda', `${base}:refs/tlda/source/paper`])
  await git(checkout, ['fetch', 'tlda', `+refs/tlda/source/paper:refs/tlda/fetched/paper`])
  await git(checkout, ['update-ref', 'refs/tlda/project/paper', base])
  await git(checkout, ['checkout', '-q', '-b', 'tlda/paper'])

  // THE BROWSER EDIT: a sibling of base, published as the project head. Built
  // in a scratch clone so the person's checkout plays no part in making it --
  // which is the real topology, and it is what makes the checkout stop being
  // an ancestor.
  const browserSide = join(root, 'browser')
  await git(root, ['clone', '-q', remote, browserSide])
  await git(browserSide, ['config', 'user.name', 'browser'])
  await git(browserSide, ['config', 'user.email', 'browser@example.test'])
  await git(browserSide, ['checkout', '-q', base])
  writeFileSync(join(browserSide, browserFile), browserText)
  await git(browserSide, ['add', '-A'])
  await git(browserSide, ['commit', '-m', 'browser edit'])
  const browserHead = await sha(browserSide, 'HEAD')
  await git(browserSide, ['push', '-f', 'origin', `${browserHead}:refs/tlda/source/paper`])

  installAncestryRule(remote)
  return { remote, checkout, base, browserHead }
}

function syncFor(checkout, remote) {
  return createGitProjectSync({
    sourceDir: checkout,
    project: 'paper',
    daemonId: 'daemon-a',
    bindingId: 'paper',
    remote,
    documentRoots: ['main.md', 'notes.md'],
    log: { info() {}, warn() {}, error() {} },
  })
}

/** Every proposal ref the remote is holding, newest first. */
async function proposalsOn(remote) {
  const out = (await git(remote, ['for-each-ref', '--format=%(objectname)', 'refs/tlda/proposals/'])).stdout
  return out.split('\n').filter(Boolean)
}

test('a disk edit still lands after the browser has published, and keeps both sides', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-lockout-'))
  // The browser changed notes.md; the disk changes main.md. DIFFERENT files,
  // so nothing here is a conflict -- both edits simply have to survive.
  const { remote, checkout, browserHead } = await projectWithABrowserEditAhead(root, {
    browserFile: 'notes.md',
    browserText: 'one-FROM-BROWSER\n',
  })

  writeFileSync(join(checkout, 'main.md'), '# paper\n\nalpha\nbravo-FROM-DISK\ncharlie\n')
  const sync = syncFor(checkout, remote)
  await sync.editClusterSettled()

  // WHAT THE SERVER WOULD SERVE. A proposal that the ancestry rule accepts is
  // the only thing that can become the next head, so an unaccepted proposal is
  // the same as no edit at all.
  const landed = []
  for (const proposal of await proposalsOn(remote)) {
    try {
      await git(remote, ['merge-base', '--is-ancestor', browserHead, proposal])
      landed.push(proposal)
    } catch { /* not a descendant of the published head: the server would reject it, so it is not a candidate */ }
  }
  assert.ok(landed.length > 0,
    'the disk edit produced a proposal the server would accept -- otherwise the checkout is locked out and every later edit is lost too')

  const [best] = landed
  const mainText = (await git(remote, ['show', `${best}:main.md`])).stdout
  const notesText = (await git(remote, ['show', `${best}:notes.md`])).stdout
  assert.match(mainText, /bravo-FROM-DISK/, 'the disk edit is in it')
  assert.match(notesText, /one-FROM-BROWSER/,
    'and the browser edit is still in it -- a fix that reverts the other side is not a fix')

  // The person's repository is not the app's to write.
  assert.equal((await git(checkout, ['status', '--porcelain'])).stdout.trim().length === 0, true,
    'the checkout has no leftover changes')
  assert.equal((await git(checkout, ['diff', '--cached', '--name-only'])).stdout.trim(), '',
    'and nothing was staged in the person\'s index')
})

test('when both sides changed the same line the divergence is HELD, not silently dropped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-lockout-conflict-'))
  // SAME file, SAME line. This one genuinely cannot be combined, and the
  // requirement is only that it is reported rather than vanishing.
  const { remote, checkout } = await projectWithABrowserEditAhead(root, {
    browserFile: 'main.md',
    browserText: '# paper\n\nalpha\nbravo-FROM-BROWSER\ncharlie\n',
  })

  writeFileSync(join(checkout, 'main.md'), '# paper\n\nalpha\nbravo-FROM-DISK\ncharlie\n')
  const sync = syncFor(checkout, remote)
  const result = await sync.editClusterSettled()

  // NOT a boolean. `ok: false` with no reason is what the current code returns
  // for a rejection nobody surfaces, and it is indistinguishable from the
  // silent loss this file exists to stop.
  assert.equal(result?.ok, false, 'a genuine conflict does not report success')
  assert.match(String(result?.status || ''), /conflict|held/i,
    `the divergence is named as a conflict that is being held, not reported as a push failure: ${JSON.stringify(result)}`)

  // AND THE WORK IS STILL THERE. Held means recoverable.
  assert.match((await git(checkout, ['show', 'HEAD:main.md'])).stdout, /bravo-FROM-DISK/,
    'the disk author\'s committed work is intact')
  assert.equal((await git(checkout, ['diff', '--cached', '--name-only'])).stdout.trim(), '',
    'and nothing was staged in the person\'s index')
})

test('CONTROL: with no browser edit ahead, the same harness lands the disk edit', async () => {
  // THE POSITIVE CONTROL, and it is not decoration. The two tests above are
  // both red, and a rig that cannot produce a green would fail them whatever
  // the code did -- a broken fixture and a real defect are the same colour.
  // This runs the identical path with the ONE difference that makes the defect:
  // the published head is still an ancestor of the checkout. It must pass on
  // today's code, unchanged.
  const root = mkdtempSync(join(tmpdir(), 'tlda-lockout-control-'))
  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'tlda', remote])
  writeFileSync(join(checkout, 'main.md'), '# paper\n\nalpha\nbravo\ncharlie\n')
  writeFileSync(join(checkout, 'notes.md'), 'one\n')
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', 'base'])
  const base = await sha(checkout, 'HEAD')
  await git(checkout, ['push', 'tlda', `${base}:refs/tlda/source/paper`])
  await git(checkout, ['fetch', 'tlda', '+refs/tlda/source/paper:refs/tlda/fetched/paper'])
  await git(checkout, ['update-ref', 'refs/tlda/project/paper', base])
  await git(checkout, ['checkout', '-q', '-b', 'tlda/paper'])
  installAncestryRule(remote)

  writeFileSync(join(checkout, 'main.md'), '# paper\n\nalpha\nbravo-FROM-DISK\ncharlie\n')
  const result = await syncFor(checkout, remote).editClusterSettled()

  assert.equal(result?.ok, true, `the harness can land an edit: ${JSON.stringify(result)}`)
  const landed = []
  for (const proposal of await proposalsOn(remote)) {
    try {
      await git(remote, ['merge-base', '--is-ancestor', base, proposal])
      landed.push(proposal)
    } catch { /* not a descendant: would be rejected, so not a candidate */ }
  }
  assert.ok(landed.length > 0, 'and the proposal is one the ancestry rule accepts')
  assert.match((await git(remote, ['show', `${landed[0]}:main.md`])).stdout, /bravo-FROM-DISK/,
    'carrying the disk edit')
})
