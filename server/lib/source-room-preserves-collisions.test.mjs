/**
 * The room preserves a colliding file rather than failing to stand — and the
 * file it moves is still on disk afterwards.
 *
 * **Why this test exists.** The preserve step had NO coverage. My tests drove
 * `standOnWorkBranch` directly and never went through the room helper that
 * wraps it, so silencing git entirely still left them green — the counterfactual
 * could not go red. I then rewrote that helper from `spawnSync` to async under
 * release-gate pressure with nothing checking it.
 *
 * **What it protects.** Measured on the live box: 13 of 15 existing room trees
 * hold their edited file untracked, and `git checkout <branch>` refuses
 * outright for exactly that. Without the preserve step those rooms accept every
 * keystroke and silently publish nothing.
 *
 * **And nothing is deleted.** The moved file is asserted to still exist, because
 * this app does not delete things and a preserve step that lost the buffer would
 * be worse than the bug.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSourceRoomDaemon } from './source-room-daemon.mjs'

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

/** A room working tree holding an UNTRACKED file that its branch also carries. */
function roomTreeWithCollision(root, project) {
  const working = join(root, project, '.source-room', 'working')
  mkdirSync(working, { recursive: true })
  git(working, 'init', '-q', '-b', 'main')
  git(working, 'config', 'user.email', 'test@tlda')
  git(working, 'config', 'user.name', 'test')
  // A branch that carries main.md...
  writeFileSync(join(working, 'main.md'), 'from the project\n')
  git(working, 'add', '-A')
  git(working, 'commit', '-qm', 'project content')
  git(working, 'branch', `tlda/${project}`)
  // ...and a working copy where it is untracked, which is the state every room
  // tree created before this change is in.
  git(working, 'checkout', '-q', '--orphan', 'scratch')
  git(working, 'rm', '-q', '--cached', 'main.md')
  writeFileSync(join(working, 'main.md'), 'the live buffer\n')
  return working
}

test('a colliding file is moved aside, the stand is retried, and nothing is lost', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-room-preserve-'))
  const working = roomTreeWithCollision(root, 'paper')
  const attempts = []
  try {
    const manager = {
      bindSource: () => {},
      sync: async () => {},
      queuePaths: () => {},
      headChanged: async () => ({ ok: true }),
      // Refuses the first time with git's real sentence, succeeds once the
      // collision is out of the way — which is exactly what git does.
      standOnWorkBranch: async () => {
        attempts.push(existsSync(join(working, 'main.md')))
        return attempts.length === 1
          ? { ok: false, status: 'checkout-refused', reason: 'error: The following untracked working tree files would be overwritten by checkout:\n\tmain.md' }
          : { ok: true, status: 'moved' }
      },
    }
    const daemon = createSourceRoomDaemon({
      projectDir: project => join(root, project),
      readProject: async name => ({ name, mainFile: 'main.md' }),
      sourceLifecycleStore: async () => ({
        gitRepository: async () => ({ head: async () => null }),
        readCurrentFile: async () => ({ content: Buffer.from('the live buffer\n') }),
        readRevisionFile: async () => Buffer.from(''),
      }),
      readClientSourceManifest: async () => ['main.md'],
      gitSyncManagerForProject: () => manager,
      pushDelayMs: 5,
      log: { info() {}, warn() {}, error() {} },
    })

    await daemon.getRoom('paper', 'main.md')

    assert.equal(attempts.length, 2, 'it retried after clearing the collision rather than giving up')
    assert.equal(attempts[0], true, 'the colliding file was present on the first attempt')
    assert.equal(attempts[1], false, 'and out of the way on the second')

    // NOTHING IS DELETED. The buffer is somewhere on disk.
    const preserved = readdirSync(join(root, 'paper', '.source-room')).filter(name => name.startsWith('working-preserved-'))
    assert.equal(preserved.length, 1, `the colliding file was preserved, not removed (saw ${preserved.join(', ') || 'nothing'})`)
    assert.ok(existsSync(join(root, 'paper', '.source-room', preserved[0], 'main.md')),
      'and it is the file itself, readable, not an empty directory')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
