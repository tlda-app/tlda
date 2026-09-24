/**
 * **An accepted head the checkout shares no history with must be NAMED, not thrown.**
 *
 * Measured on testing 2026-09-24: the slides project's server head and its
 * work-branch head had no merge base (a relink preserved server history the
 * checkout never descended from), so every auto-settle died the same way —
 * push rejected as WrongHead, `merge-tree --write-tree` refusing `unrelated
 * histories` with exit 128, `combineWithAcceptedHead` throwing, `proposal
 * failed` in the log, nothing submitted, forever.
 *
 * A throw is the wrong shape for a state that persists across settles: the
 * watcher logs it and retries identically. The recovery is an operator act
 * (relink adopting local history), so what the person needs is the NAME of
 * the state — `unrelated-histories` through the ordinary refusal channel,
 * with its all-clear when sync flows again — and never a commit built from
 * a merge that refused to happen.
 *
 * Driven through `runGit` stubs: real git will not produce unrelated
 * histories on demand without fixtures, and the thing under test is the
 * shape of the answer, not git's exit code (measured separately, in the
 * teaching checkout, as 128 with `refusing to merge unrelated histories`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createGitProjectSync } from './git-project-sync.mjs'

const ACCEPTED = 'c'.repeat(40)
const REVISION = 'e'.repeat(40)

function syncWithUnrelatedHeads(calls) {
  return createGitProjectSync({
    sourceDir: '/nonexistent-on-purpose',
    project: 'paper',
    daemonId: 'daemon-a',
    bindingId: 'paper',
    remote: '/nonexistent-remote',
    log: { info() {}, warn() {}, error() {} },
    runGit: async (args) => {
      calls.push(args.join(' '))
      if (args[0] === 'push') {
        const error = new Error('rejected')
        error.stderr = `remote: WrongHead ${ACCEPTED}\n`
        throw error
      }
      if (args[0] === 'fetch') return { stdout: '', stderr: '' }
      if (args[0] === 'rev-parse') return { stdout: `${ACCEPTED}\n`, stderr: '' }
      if (args[0] === 'merge-tree') {
        const error = new Error('Command failed: git merge-tree --write-tree')
        error.code = 128
        error.stderr = 'fatal: refusing to merge unrelated histories\n'
        throw error
      }
      return { stdout: '', stderr: '' }
    },
  })
}

test('unrelated accepted history resolves as a named refusal, not a throw', async () => {
  const sync = syncWithUnrelatedHeads([])

  const result = await sync.pushRevision(REVISION)

  assert.equal(result?.ok, false, `it resolves not-ok: ${JSON.stringify(result)}`)
  assert.equal(result?.status, 'unrelated-histories', `it names the state: ${JSON.stringify(result)}`)
  assert.match(result?.reason || '', /relink/i, 'and it points at the recovery')
})

test('no commit is built from a merge that refused to happen', async () => {
  const calls = []
  const sync = syncWithUnrelatedHeads(calls)

  await sync.pushRevision(REVISION)

  assert.equal(calls.some(call => call.startsWith('commit-tree')), false,
    'nothing was committed from the refused merge')
  assert.equal(calls.some(call => call.startsWith('push')), true,
    'the control still attempted the push first')
})

test('a real merge-tree failure still throws as itself', async () => {
  const sync = createGitProjectSync({
    sourceDir: '/nonexistent-on-purpose',
    project: 'paper',
    daemonId: 'daemon-a',
    bindingId: 'paper',
    remote: '/nonexistent-remote',
    log: { info() {}, warn() {}, error() {} },
    runGit: async (args) => {
      if (args[0] === 'push') {
        const error = new Error('rejected')
        error.stderr = `remote: WrongHead ${ACCEPTED}\n`
        throw error
      }
      if (args[0] === 'fetch') return { stdout: '', stderr: '' }
      if (args[0] === 'rev-parse') return { stdout: `${ACCEPTED}\n`, stderr: '' }
      // 128 WITHOUT the unrelated-histories signature: corruption, a bad
      // object, something genuinely broken. That must still throw.
      if (args[0] === 'merge-tree') {
        const error = new Error('Command failed: git merge-tree --write-tree')
        error.code = 128
        error.stderr = 'fatal: bad object 0000000000000000000000000000000000000000\n'
        throw error
      }
      return { stdout: '', stderr: '' }
    },
  })

  await assert.rejects(
    () => sync.pushRevision(REVISION),
    /merge-tree failed \(128\)/,
    'a non-unrelated fatal still throws',
  )
})
