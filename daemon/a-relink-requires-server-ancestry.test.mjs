/**
 * **A relink must prove ancestry, not mere object presence.**
 *
 * `containsCommits` asks `rev-list --all` — a fetch alone satisfies it. The
 * relink short-circuit built on it then preserved a server head the checkout
 * never descended from, and every later settle died the same way: push
 * rejected as WrongHead, `merge-tree` refusing unrelated histories,
 * `proposal failed`, nothing submitted. Measured on testing 2026-09-24
 * behind a full day of dead auto-settles.
 *
 * `containsCommitsInHistory` scopes the question to the link head's ancestry,
 * and the short-circuit requires it: objects present but unreachable fail the
 * link loudly with the recovery (relink adopting local history) instead of
 * minting a binding that can never sync.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createShadowMirror } from './shadow-mirror.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd })

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-ancestry-'))
  await git(dir, ['init', '-q', '-b', 'main', '.'])
  await git(dir, ['config', 'user.email', 'test@example.test'])
  await git(dir, ['config', 'user.name', 'test'])
  writeFileSync(join(dir, 'a.md'), '# a\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'ancestor'])
  const ancestor = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  writeFileSync(join(dir, 'b.md'), '# b\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'head'])
  const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  // An unrelated root: present as an object, ancestor of nothing on main.
  await git(dir, ['checkout', '-q', '--orphan', 'elsewhere'])
  writeFileSync(join(dir, 'c.md'), '# c\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'unrelated'])
  const unrelated = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(dir, ['checkout', '-q', 'main'])
  return { dir, ancestor, head, unrelated }
}

const mirror = createShadowMirror({ getSourceDir: () => null, log: { info() {}, warn() {}, error() {} } })

test('history contains its own ancestors', async () => {
  const { dir, ancestor, head } = await fixture()

  const result = await mirror.containsCommitsInHistory({ sourceDir: dir, ref: 'main', hashes: [ancestor, head] })

  assert.equal(result.ok, true, `ancestors satisfy the check: ${JSON.stringify(result)}`)
})

test('a present-but-unrelated object fails the ancestry check', async () => {
  const { dir, unrelated } = await fixture()

  const ancestry = await mirror.containsCommitsInHistory({ sourceDir: dir, ref: 'main', hashes: [unrelated] })
  assert.equal(ancestry.ok, false, 'unrelated objects are not in history')
  assert.deepEqual(ancestry.missing, [unrelated])

  // The control: bare containment DOES see it (a fetch put it here), which is
  // exactly the gap the short-circuit used to fall through.
  const containment = await mirror.containsCommits({ sourceDir: dir, hashes: [unrelated] })
  assert.equal(containment.ok, true, 'bare containment still sees the object')
})

test('invalid commit ids are rejected, not passed to git', async () => {
  const { dir } = await fixture()

  await assert.rejects(
    () => mirror.containsCommitsInHistory({ sourceDir: dir, ref: 'main', hashes: ['not-a-hash'] }),
    /invalid commit id/,
  )
})

test('the relink short-circuit requires the ancestry check', () => {
  const daemon = readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')

  assert.match(daemon, /containsCommitsInHistory\(\{ sourceDir, ref: seedRevision, hashes \}\)/,
    'the short-circuit gates on ancestry from the link head')
  assert.match(daemon, /relink without acceptContainedServerHistory to adopt local history/,
    'and the failure names the recovery')
})
