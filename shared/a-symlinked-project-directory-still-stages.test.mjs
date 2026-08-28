/**
 * **A file reached through a symlinked project directory is still in the repository.**
 *
 * `repoPathFor` asked git for `--show-toplevel` and compared it to the caller's
 * path as a string. Git resolves symlinks; the caller's path usually does not.
 * So a project directory that is a symlink made the comparison false for a file
 * plainly inside the repository, and `trackPath` returned
 * `{ inRepo: false, tracked: false, path: null }` — refusing to stage the file
 * it exists to stage.
 *
 * **Measured on the deployed box.** `/app/server/projects/<p>` is a symlink to
 * `/app/server/persist/projects/<p>`, so `--show-toplevel` answered with the
 * `persist` path while the source room asked about the `projects` one. Every
 * room's save then failed:
 *
 *     POST /api/projects/<p>/source-room/files -> 409
 *       "…/.source-room/working/<file> was not staged
 *        ({"inRepo":false,"tracked":false,"path":null})"
 *
 * — for `sync-trio`, `sync-rootless`, `sync-watch` and `sync-proof` alike.
 *
 * **And before that 409 existed it was silent.** `trackRoomFile` warned and
 * carried on, so `submitFiles` answered `202 queued` while nothing was staged:
 * the edit was accepted, never committed, and disappeared with no signal
 * anywhere. That is what "the browser editor's edits are lost" was.
 *
 * The control matters as much as the case: a NON-symlinked path must still be
 * judged the same way, and a path genuinely outside the repository must still
 * be refused. Canonicalising is meant to widen this test by exactly one shape,
 * not to make it answer yes to everything.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGitRemotes } from './git-remotes.mjs'

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

/** A repository at its real location, plus a symlink standing in front of it. */
function repoBehindASymlink() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tlda-symlinked-project-')))
  const real = join(root, 'persist', 'projects', 'paper')
  const link = join(root, 'projects', 'paper')
  mkdirSync(real, { recursive: true })
  mkdirSync(join(root, 'projects'), { recursive: true })
  symlinkSync(real, link)

  git(real, 'init', '-q', '-b', 'main')
  git(real, 'config', 'user.email', 'test@tlda')
  git(real, 'config', 'user.name', 'test')
  writeFileSync(join(real, 'committed.md'), 'already tracked\n')
  git(real, 'add', '-A')
  git(real, 'commit', '-qm', 'base')
  return { root, real, link }
}

test('a new file reached through a symlinked project directory is staged', async () => {
  const { real, link } = repoBehindASymlink()

  // Confirm the fixture really is the reported shape before concluding
  // anything: git must resolve the toplevel to the REAL path while we ask
  // about the linked one, or this test is measuring nothing.
  assert.notEqual(link, real, 'the link and the real directory are different strings')
  assert.equal(git(link, 'rev-parse', '--show-toplevel'), real,
    'git answers with the canonical path even when run through the link')

  writeFileSync(join(real, 'typed-in-the-browser.md'), '# new\n')
  const remotes = createGitRemotes({ sourceDir: link })
  const answer = await remotes.trackPath(join(link, 'typed-in-the-browser.md'))

  assert.equal(answer.inRepo, true,
    `a file inside the repository is in the repository, however the caller spelled the path: ${JSON.stringify(answer)}`)
  assert.equal(answer.tracked, true, 'and it was staged')
  assert.match(git(real, 'diff', '--cached', '--name-only'), /typed-in-the-browser\.md/,
    'git agrees it is in the index')
})

test('an already-tracked file through the symlink reports tracked without re-adding', async () => {
  const { real, link } = repoBehindASymlink()
  const remotes = createGitRemotes({ sourceDir: link })
  const answer = await remotes.trackPath(join(link, 'committed.md'))
  assert.equal(answer.inRepo, true, `${JSON.stringify(answer)}`)
  assert.equal(answer.tracked, true, 'already tracked, reported as such')
  assert.equal(git(real, 'diff', '--cached', '--name-only'), '',
    'and nothing was staged, because there was nothing to stage')
})

test('CONTROL: an ordinary non-symlinked path is unaffected', async () => {
  // The behaviour that already worked must keep working — canonicalising is
  // meant to widen this by one shape, not to change the ordinary answer.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tlda-plain-project-')))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@tlda')
  git(root, 'config', 'user.name', 'test')
  writeFileSync(join(root, 'plain.md'), '# plain\n')

  const answer = await createGitRemotes({ sourceDir: root }).trackPath(join(root, 'plain.md'))
  assert.equal(answer.inRepo, true, `${JSON.stringify(answer)}`)
  assert.equal(answer.tracked, true, 'staged as before')
})

test('CONTROL: a path genuinely outside the repository is still refused', async () => {
  // THE LINE THAT MUST NOT MOVE. `trackPath` refuses rather than staging blind,
  // and a repair that answered `inRepo: true` for everything would satisfy the
  // cases above while quietly removing that refusal.
  const { root, link } = repoBehindASymlink()
  const outside = join(root, 'not-the-project')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'stranger.md'), 'not ours\n')

  const answer = await createGitRemotes({ sourceDir: link }).trackPath(join(outside, 'stranger.md'))
  assert.equal(answer.inRepo, false,
    `a file outside the repository is still outside it: ${JSON.stringify(answer)}`)
  assert.equal(answer.tracked, false, 'and nothing was staged for it')
})
