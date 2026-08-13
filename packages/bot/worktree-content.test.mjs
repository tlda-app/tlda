import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyIgnoredPath, classifyWorktreeIgnored, IGNORED_STATUS_ARGS } from './worktree-content.mjs'

test('build output is reclaimable and authored content is not', () => {
  assert.equal(classifyIgnoredPath('node_modules/').reclaimable, true)
  assert.equal(classifyIgnoredPath('dist/').reclaimable, true)
  assert.equal(classifyIgnoredPath('packages/bot/node_modules/').reclaimable, true)
  assert.equal(classifyIgnoredPath('.DS_Store').reclaimable, true)
  assert.equal(classifyIgnoredPath('tsconfig.app.tsbuildinfo').reclaimable, true)

  assert.equal(classifyIgnoredPath('scratch/').reclaimable, false)
  assert.equal(classifyIgnoredPath('TODO.md').reclaimable, false)
  assert.equal(classifyIgnoredPath('.claude/').reclaimable, false)
})

// The polarity is the design. A path nobody thought about is somebody's work.
test('an unrecognised ignored path is authored, not cruft', () => {
  const verdict = classifyIgnoredPath('notes-from-tonight.md')
  assert.equal(verdict.reclaimable, false)
  assert.match(verdict.why, /unclassified/)
})

test('a worktree holding only build output is safe to remove', () => {
  const result = classifyWorktreeIgnored('!! node_modules/\n!! dist/\n!! .DS_Store\n')
  assert.equal(result.safeToRemove, true)
  assert.equal(result.authored.length, 0)
  assert.equal(result.reclaimable.length, 3)
})

// The trap named in the brief: every worktree has node_modules, so "any ignored
// file protects it" disables the sweep entirely.
test('node_modules beside a plan does not make the plan removable', () => {
  const result = classifyWorktreeIgnored('!! node_modules/\n!! scratch/\n')
  assert.equal(result.safeToRemove, false)
  assert.deepEqual(result.authored.map(v => v.path), ['scratch/'])
  assert.deepEqual(result.reclaimable.map(v => v.path), ['node_modules/'])
})

test('tracked-file porcelain lines are ignored by the classifier', () => {
  const result = classifyWorktreeIgnored(' M src/App.css\n?? untracked.ts\n!! node_modules/\n')
  assert.equal(result.safeToRemove, true)
  assert.equal(result.reclaimable.length, 1)
})

// Not a fixture: two real git worktrees, classified from real `git status`
// output, one in each direction. The brief asked for both directions
// demonstrated rather than asserted.
test('both directions on real throwaway worktrees', t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-worktree-content-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  git(repo, 'config', 'user.name', 'fixture')
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\nscratch/\n')
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')

  const cruft = join(root, 'cruft-only')
  git(repo, 'worktree', 'add', '-q', '-b', 'cruft', cruft)
  mkdirSync(join(cruft, 'node_modules'))
  writeFileSync(join(cruft, 'node_modules', 'thing.js'), '// installed\n')
  mkdirSync(join(cruft, 'dist'))
  writeFileSync(join(cruft, 'dist', 'bundle.js'), '// built\n')

  const plan = join(root, 'plan-only')
  git(repo, 'worktree', 'add', '-q', '-b', 'plan', plan)
  mkdirSync(join(plan, 'node_modules'))
  writeFileSync(join(plan, 'node_modules', 'thing.js'), '// installed\n')
  mkdirSync(join(plan, 'scratch'))
  writeFileSync(join(plan, 'scratch', 'plan.md'), '# the only copy\n')

  const cruftVerdict = classifyWorktreeIgnored(git(cruft, ...IGNORED_STATUS_ARGS))
  const planVerdict = classifyWorktreeIgnored(git(plan, ...IGNORED_STATUS_ARGS))

  // Both worktrees read clean to the check the sweep uses today, which is why
  // the plan one was deleted.
  assert.equal(git(cruft, 'status', '--porcelain').trim(), '')
  assert.equal(git(plan, 'status', '--porcelain').trim(), '')

  assert.equal(cruftVerdict.safeToRemove, true, 'cruft-only worktree should be reclaimable')
  assert.equal(planVerdict.safeToRemove, false, 'a worktree holding a plan must survive')
  assert.ok(planVerdict.authored.some(v => v.path.startsWith('scratch')))
})
