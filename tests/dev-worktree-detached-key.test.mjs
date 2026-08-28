// `tlda-dev serve` keys all of its per-worktree state — pid file, manifest,
// log, projects dir, fleet DB, config name, preview lease — on the string
// `worktreeBranch()` returns. In a DETACHED worktree `git rev-parse
// --abbrev-ref HEAD` answers the literal "HEAD", which is the same answer in
// every detached worktree on the box, so they shared one state dir and
// `serve status` reported whichever worktree wrote last.
//
// This exercises the real CLI (`serve status --json`) rather than the key
// function, because the key alone is not the defect — the defect is one
// worktree's status answering with another worktree's server. HOME is
// redirected at a temp dir so nothing here can see or touch real preview state.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../cli/tlda-dev.mjs', import.meta.url))

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  }).trim()
}

// Each `serve status` is a node process start, so the independent ones run
// concurrently — sequentially this test takes most of the suite's per-file cap.
const execFileAsync = promisify(execFile)
async function serveStatus(cwd, home) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, 'serve', 'status', '--json'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
  return JSON.parse(stdout)
}

test('detached worktrees get distinct preview state; a named branch is unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-worktree-key-'))
  try {
    const home = join(root, 'home')
    mkdirSync(home)

    const repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-b', 'main', '-q'])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'one'])
    const first = git(repo, ['rev-parse', 'HEAD'])
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    git(repo, ['commit', '-qam', 'two'])
    const second = git(repo, ['rev-parse', 'HEAD'])

    const wtA = join(root, 'wt-a')
    const wtB = join(root, 'wt-b')
    const wtNamed = join(root, 'wt-named')
    git(repo, ['worktree', 'add', '-q', '--detach', wtA, second])
    git(repo, ['worktree', 'add', '-q', '--detach', wtB, second])
    git(repo, ['worktree', 'add', '-q', '-b', 'feature', wtNamed, second])

    const [a, b, named] = await Promise.all([
      serveStatus(wtA, home), serveStatus(wtB, home), serveStatus(wtNamed, home),
    ])

    // The collision itself.
    assert.notEqual(a.branch, 'HEAD', 'detached worktree must not key on the literal HEAD')
    assert.notEqual(b.branch, 'HEAD', 'detached worktree must not key on the literal HEAD')
    assert.notEqual(a.branch, b.branch, 'two detached worktrees must key on distinct state')

    // Control: a named branch keys on its branch name, exactly as before.
    assert.equal(named.branch, 'feature')

    // The key is a fact about the worktree, not about HEAD: checking out a
    // different commit must not strand the running preview's state.
    git(wtA, ['checkout', '-q', first])
    assert.equal((await serveStatus(wtA, home)).branch, a.branch, 'key must survive a checkout in the same worktree')
    git(wtA, ['checkout', '-q', second])

    // The wire: plant a preview state for worktree A, then ask worktree B.
    // Before the fix both resolve to .../dev-worktree/HEAD and B answers with
    // A's worktreeDir, base, project and port.
    const stateA = join(home, '.config', 'tlda', 'dev-worktree', a.branch)
    mkdirSync(stateA, { recursive: true })
    writeFileSync(join(stateA, 'server.pid'), '1\n')
    writeFileSync(join(stateA, 'manifest.json'), JSON.stringify({
      branch: a.branch, worktreeDir: wtA, base: 'https://127.0.0.1:5199', project: 'scratch-a', port: 5199,
    }))

    // A's own read is the positive control: it proves this instrument can see
    // planted state at all, so B's empty answer is a fact and not a broken query.
    const [bAfter, aAfter] = await Promise.all([serveStatus(wtB, home), serveStatus(wtA, home)])
    assert.equal(aAfter.worktreeDir, wtA, 'planted state must be visible from the worktree that owns it')
    assert.equal(bAfter.worktreeDir, undefined, `worktree B reported worktree A's preview: ${JSON.stringify(bAfter)}`)
    assert.equal(bAfter.port, undefined)
    assert.equal(bAfter.status, 'down')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
