#!/usr/bin/env node
/**
 * `tlda project merge` replays the app's history onto a real branch.
 *
 * WHAT THIS CROSSES. The whole operation is `git`: format-patch on one repo, am
 * on another, patch-id to pair them. So the boundary this feature crosses in
 * production is the git binary on real repositories, and that is what this
 * exercises — real repos on disk, real commits, real conflicts. Nothing is
 * stubbed, because a stubbed git would prove the argument strings and not the
 * operation.
 *
 * IT REBUILDS THE ACTUAL SHADOW SHAPE rather than a linear fixture: the source
 * repo here is produced from the target repo by `git-filter-repo --path`, which
 * is how server/lib/shadow-repo.mjs builds one. That is the property the whole
 * design rests on — the two repos share NO commit identity — and a fixture that
 * clones instead would share it and prove nothing. Where `git-filter-repo` is
 * not installed the run says so and skips that one story rather than passing.
 *
 * Run: node bin/a-replay-that-lands-on-a-real-branch-test.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mergeReplay, mergeContinue, mergeAbort, mergeStatus, selectCommits } from '../server/lib/merge-replay.mjs'

let failures = 0
let ran = 0
const roots = []

function ok(name, cond, detail = '') {
  ran++
  if (cond) { console.log(`  ok  ${name}`); return }
  failures++
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function newRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `tlda-merge-${label}-`))
  roots.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@local')
  git(dir, 'config', 'user.name', 'Test')
  return dir
}

function commit(dir, file, contents, message, { author = 'Alice <alice@example.com>' } = {}) {
  const path = join(dir, file)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
  git(dir, 'add', file)
  git(dir, '-c', `user.name=${author.split(' <')[0]}`, '-c', `user.email=${author.match(/<(.+)>/)[1]}`,
    'commit', '-q', '--author', author, '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

function subjects(dir, ref = 'HEAD') {
  return git(dir, 'log', '--format=%s', ref).split('\n').filter(Boolean).reverse()
}

// A file long enough that a change at one line does not collide with a change
// twelve lines away. THIS IS NOT DECORATION: written against a four-line file,
// the "stops at the SECOND patch" stories stopped at the first, because `am`'s
// three lines of context reached across the whole file and every patch
// collided with every other. The story being told is marching forward through
// patches that apply and halting at the one that does not, and a fixture where
// nothing applies cannot tell it.
function lines(changes = {}) {
  return Array.from({ length: 20 }, (_, i) => changes[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
}

function haveFilterRepo() {
  try { execFileSync('git-filter-repo', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}

// ---------------------------------------------------------------------------
// Story 1: a shadow built the way the server builds one lands on the author's
// branch, one commit per real change, with author and message intact.
// ---------------------------------------------------------------------------
async function storyFilteredShadowLands() {
  console.log('\na shadow with no shared commit identity lands on the author\'s branch')
  if (!haveFilterRepo()) {
    console.log('  SKIP  git-filter-repo is not installed — this story is not established')
    return
  }

  const author = newRepo('author')
  commit(author, 'paper/main.tex', 'one\n', 'Start the paper')
  commit(author, 'notes/todo.md', 'not in scope\n', 'A note outside the paper')
  const shared = git(author, 'rev-parse', 'HEAD')

  // The shadow: a filtered clone, exactly as ensureShadowRepo builds it.
  const shadow = mkdtempSync(join(tmpdir(), 'tlda-merge-shadow-'))
  roots.push(shadow)
  rmSync(shadow, { recursive: true, force: true })
  execFileSync('git', ['clone', '--no-local', '-q', author, shadow])
  execFileSync('git-filter-repo', ['--path', 'paper', '--force'], { cwd: shadow, stdio: 'ignore' })
  git(shadow, 'config', 'user.email', 'tlda@local')
  git(shadow, 'config', 'user.name', 'tlda')

  ok('the shadow shares no commit identity with the author repo',
    git(shadow, 'rev-parse', 'HEAD') !== shared,
    `both are ${shared}`)

  // Work done in the app, recorded in the shadow.
  commit(shadow, 'paper/main.tex', 'one\ntwo\n', 'Add the second line', { author: 'Bob <bob@example.com>' })
  commit(shadow, 'paper/main.tex', 'one\ntwo\nthree\n', 'Add the third line', { author: 'Bob <bob@example.com>' })

  const before = git(author, 'rev-parse', 'main')
  const result = await mergeReplay({ sourceRepo: shadow, targetRepo: author, ffOnly: true })

  ok('it reports merged', result.status === 'merged', JSON.stringify(result).slice(0, 300))
  ok('it lands one commit per real change', result.commits === 2, `landed ${result.commits}`)
  ok('the author branch moved', git(author, 'rev-parse', 'main') !== before)
  ok('the file on the author side has the replayed content',
    readFileSync(join(author, 'paper/main.tex'), 'utf8') === 'one\ntwo\nthree\n',
    JSON.stringify(readFileSync(join(author, 'paper/main.tex'), 'utf8')))
  ok('the out-of-scope file the shadow never saw is untouched',
    existsSync(join(author, 'notes/todo.md')))
  ok('the messages survive',
    subjects(author).slice(-2).join('|') === 'Add the second line|Add the third line',
    subjects(author).join(' / '))
  ok('the authors survive',
    git(author, 'log', '-1', '--format=%ae', 'main') === 'bob@example.com',
    git(author, 'log', '-1', '--format=%ae', 'main'))
  ok('no scratch worktree is left behind',
    !git(author, 'worktree', 'list').includes('tlda-merge-scratch'),
    git(author, 'worktree', 'list'))
}

// ---------------------------------------------------------------------------
// Story 2: running it twice lands nothing the second time. Patch-id pairing is
// what makes the second merge of the same project a no-op with no base
// remembered anywhere.
// ---------------------------------------------------------------------------
async function storySecondMergeIsANoop() {
  console.log('\na second merge of the same project owes nothing')
  const target = newRepo('target2')
  commit(target, 'a.txt', 'base\n', 'Base')
  const source = newRepo('source2')
  commit(source, 'a.txt', 'base\n', 'Base')
  commit(source, 'a.txt', 'base\nmore\n', 'More')

  const first = await mergeReplay({ sourceRepo: source, targetRepo: target, ffOnly: true })
  ok('the first merge lands the one owed commit', first.status === 'merged' && first.commits === 1,
    JSON.stringify(first).slice(0, 200))
  ok('the identical Base commit was recognised as already present',
    first.alreadyPresent === 1, `alreadyPresent=${first.alreadyPresent}`)

  const tip = git(target, 'rev-parse', 'main')
  const second = await mergeReplay({ sourceRepo: source, targetRepo: target, ffOnly: true })
  ok('the second merge is up to date', second.status === 'up-to-date', JSON.stringify(second).slice(0, 200))
  ok('the second merge did not move the branch', git(target, 'rev-parse', 'main') === tip)
}

// ---------------------------------------------------------------------------
// Story 3: --ff-only cannot leave a half-applied branch.
//
// This is the one the server depends on. `am` is not atomic, so the test makes
// patch 2 of 3 conflict and asserts the branch did not move AT ALL — not that
// it moved less far.
// ---------------------------------------------------------------------------
async function storyFfOnlyIsAtomic() {
  console.log('\n--ff-only refuses whole rather than landing half')
  const target = newRepo('target3')
  commit(target, 'a.txt', lines(), 'Base')
  const source = newRepo('source3')
  commit(source, 'a.txt', lines(), 'Base')
  commit(source, 'a.txt', lines({ 2: 'line 2, from the app' }), 'First app change')
  commit(source, 'a.txt', lines({ 2: 'line 2, from the app', 10: 'line 10, from the app' }), 'Second app change')
  commit(source, 'a.txt', lines({ 2: 'line 2, from the app', 10: 'line 10, from the app', 18: 'line 18, from the app' }), 'Third app change')

  // The target moved underneath, on the line app change TWO touches. So the
  // first patch applies and the second is the one that needs a person.
  commit(target, 'a.txt', lines({ 10: 'line 10, edited locally' }), 'Local divergence')

  const before = git(target, 'rev-parse', 'main')
  const result = await mergeReplay({ sourceRepo: source, targetRepo: target, ffOnly: true })

  ok('it refuses', result.status === 'refused', JSON.stringify(result).slice(0, 300))
  ok('the branch did not move at all', git(target, 'rev-parse', 'main') === before,
    `${before} -> ${git(target, 'rev-parse', 'main')}`)
  ok('the refusal names the patch that stopped it',
    result.failedAt?.subject === 'Second app change',
    JSON.stringify(result.failedAt))
  ok('the refusal carries that patch\'s author, not a blob',
    /alice@example\.com/.test(result.failedAt?.author || ''), result.failedAt?.author)
  ok('no scratch worktree survives a refusal',
    !git(target, 'worktree', 'list').includes('tlda-merge-scratch'),
    git(target, 'worktree', 'list'))
  ok('nothing is left in progress for someone to clean up',
    (await mergeStatus({ targetRepo: target })).status === 'idle')
  ok('the earlier patch that DID apply is not on the branch either',
    !readFileSync(join(target, 'a.txt'), 'utf8').includes('line 2, from the app'),
    'a half-applied branch is the one state --ff-only must never reach')
  ok('the working tree still holds the local text',
    readFileSync(join(target, 'a.txt'), 'utf8').includes('line 10, edited locally'))
}

// ---------------------------------------------------------------------------
// Story 4: the default mode marches forward and stops for a person, and
// `--continue` finishes it. The branch moves only once the sequence is done.
// ---------------------------------------------------------------------------
async function storyDefaultModeStopsAndResumes() {
  console.log('\nthe default mode stops at the conflict and --continue finishes it')
  const target = newRepo('target4')
  commit(target, 'a.txt', lines(), 'Base')
  const source = newRepo('source4')
  commit(source, 'a.txt', lines(), 'Base')
  commit(source, 'a.txt', lines({ 2: 'line 2, from the app' }), 'First app change')
  commit(source, 'a.txt', lines({ 2: 'line 2, from the app', 10: 'line 10, from the app' }), 'Second app change')
  commit(source, 'b.txt', 'unrelated\n', 'Third app change, another file')
  commit(target, 'a.txt', lines({ 10: 'line 10, edited locally' }), 'Local divergence')

  const before = git(target, 'rev-parse', 'main')
  const stopped = await mergeReplay({ sourceRepo: source, targetRepo: target, ffOnly: false })

  ok('it stops with a conflict', stopped.status === 'conflict', JSON.stringify(stopped).slice(0, 300))
  ok('it stops on the patch that conflicted, carrying its message',
    stopped.failedAt?.subject === 'Second app change', JSON.stringify(stopped.failedAt))
  ok('the branch has not moved while it is stopped', git(target, 'rev-parse', 'main') === before)
  ok('there is a working tree with the conflict in it', existsSync(stopped.worktree))
  ok('the conflict markers are in that working tree, not in the person\'s checkout',
    readFileSync(join(stopped.worktree, 'a.txt'), 'utf8').includes('<<<<<<<') &&
    !readFileSync(join(target, 'a.txt'), 'utf8').includes('<<<<<<<'))
  ok('the remaining patches are still owed', stopped.remaining === 1, `remaining=${stopped.remaining}`)

  const status = await mergeStatus({ targetRepo: target })
  ok('the stop is reportable afterwards', status.status === 'stopped' && status.amOpen === true,
    JSON.stringify(status))

  let refused = null
  try { await mergeContinue({ targetRepo: target }) } catch (e) { refused = e.message }
  ok('--continue refuses while the conflicted patch is still open',
    /still open/.test(refused || ''), refused)

  // The person resolves it: they keep both sides of line 10.
  const resolved = lines({ 2: 'line 2, from the app', 10: 'line 10, edited locally and from the app' })
  writeFileSync(join(stopped.worktree, 'a.txt'), resolved)
  git(stopped.worktree, 'add', 'a.txt')
  execFileSync('git', ['-c', 'user.email=t@l', '-c', 'user.name=t', 'am', '--continue'],
    { cwd: stopped.worktree, stdio: 'ignore', env: { ...process.env, GIT_EDITOR: 'true' } })

  const done = await mergeContinue({ targetRepo: target })
  ok('--continue lands it', done.status === 'merged', JSON.stringify(done).slice(0, 300))
  ok('the branch moved once, at the end', git(target, 'rev-parse', 'main') !== before)
  ok('the resolution is on the branch',
    readFileSync(join(target, 'a.txt'), 'utf8') === resolved,
    JSON.stringify(readFileSync(join(target, 'a.txt'), 'utf8')))
  ok('the patch that came after the conflict landed too',
    existsSync(join(target, 'b.txt')))
  ok('nothing is left in progress', (await mergeStatus({ targetRepo: target })).status === 'idle')
  ok('the scratch worktree is gone', !existsSync(stopped.worktree))
}

// ---------------------------------------------------------------------------
// Story 5: --abort leaves nothing behind and never moved the branch.
// ---------------------------------------------------------------------------
async function storyAbortLeavesNothing() {
  console.log('\n--abort drops a stopped merge and the branch was never moved')
  const target = newRepo('target5')
  commit(target, 'a.txt', 'base\n', 'Base')
  const source = newRepo('source5')
  commit(source, 'a.txt', 'base\n', 'Base')
  commit(source, 'a.txt', 'base\napp\n', 'App change')
  commit(target, 'a.txt', 'base\nlocal\n', 'Local change')

  const before = git(target, 'rev-parse', 'main')
  const stopped = await mergeReplay({ sourceRepo: source, targetRepo: target, ffOnly: false })
  ok('it stopped', stopped.status === 'conflict', JSON.stringify(stopped).slice(0, 200))

  const aborted = await mergeAbort({ targetRepo: target })
  ok('abort reports aborted', aborted.status === 'aborted')
  ok('the branch is where it started', git(target, 'rev-parse', 'main') === before)
  ok('the scratch worktree is gone', !existsSync(stopped.worktree))
  ok('nothing is in progress', (await mergeStatus({ targetRepo: target })).status === 'idle')
  ok('the person\'s file is byte-identical to what they wrote',
    readFileSync(join(target, 'a.txt'), 'utf8') === 'base\nlocal\n')
}

// ---------------------------------------------------------------------------
// Story 6: a second merge cannot start on top of a stopped one.
// ---------------------------------------------------------------------------
async function storyOneMergeAtATime() {
  console.log('\na stopped merge blocks a second one rather than being overwritten')
  const target = newRepo('target6')
  commit(target, 'a.txt', 'base\n', 'Base')
  const source = newRepo('source6')
  commit(source, 'a.txt', 'base\n', 'Base')
  commit(source, 'a.txt', 'base\napp\n', 'App change')
  commit(target, 'a.txt', 'base\nlocal\n', 'Local change')

  await mergeReplay({ sourceRepo: source, targetRepo: target, ffOnly: false })
  let message = null
  try { await mergeReplay({ sourceRepo: source, targetRepo: target, ffOnly: false }) }
  catch (e) { message = e.message }
  ok('the second call refuses and names both ways out',
    /already in progress/.test(message || '') && /--continue/.test(message || '') && /--abort/.test(message || ''),
    message)
  await mergeAbort({ targetRepo: target })
}

// ---------------------------------------------------------------------------
// Story 7: a root commit is replayable. `format-patch -1` on a commit with no
// parent fails without --root, and the first commit of a shadow is exactly
// that — so an empty target is the ordinary first-merge case, not an edge one.
// ---------------------------------------------------------------------------
async function storyRootCommitReplays() {
  console.log('\nthe first commit of a history replays onto an empty target')
  const target = newRepo('target7')
  commit(target, 'seed.txt', 'seed\n', 'Seed')
  const source = newRepo('source7')
  commit(source, 'paper.tex', 'hello\n', 'The very first commit')
  commit(source, 'paper.tex', 'hello\nworld\n', 'The second')

  const result = await mergeReplay({ sourceRepo: source, targetRepo: target, ffOnly: true })
  ok('both commits land, including the root one', result.status === 'merged' && result.commits === 2,
    JSON.stringify(result).slice(0, 300))
  ok('the root commit\'s message is on the branch',
    subjects(target).includes('The very first commit'), subjects(target).join(' / '))
}

// ---------------------------------------------------------------------------
// Story 8: it lands on a branch that is not checked out, by compare-and-swap,
// without touching the working tree of whatever IS checked out.
// ---------------------------------------------------------------------------
async function storyLandsOnAnUncheckedOutBranch() {
  console.log('\nit lands on a branch nobody is standing in')
  const target = newRepo('target8')
  commit(target, 'a.txt', 'base\n', 'Base')
  git(target, 'branch', 'publish')
  git(target, 'checkout', '-q', '-b', 'work')
  commit(target, 'a.txt', 'base\nwork in progress\n', 'Work')
  writeFileSync(join(target, 'a.txt'), 'base\nwork in progress\nuncommitted\n')

  const source = newRepo('source8')
  commit(source, 'a.txt', 'base\n', 'Base')
  commit(source, 'a.txt', 'base\nfrom the app\n', 'App change')

  const result = await mergeReplay({ sourceRepo: source, targetRepo: target, targetBranch: 'publish', ffOnly: true })
  ok('it lands', result.status === 'merged', JSON.stringify(result).slice(0, 300))
  ok('it moved publish', git(target, 'rev-parse', 'publish') !== git(target, 'rev-parse', 'main'))
  ok('it says how it landed', result.how === 'compare-and-swap on the ref', result.how)
  ok('the checked-out branch did not move', subjects(target, 'work').at(-1) === 'Work')
  ok('the uncommitted edit in the working tree is byte-identical',
    readFileSync(join(target, 'a.txt'), 'utf8') === 'base\nwork in progress\nuncommitted\n',
    JSON.stringify(readFileSync(join(target, 'a.txt'), 'utf8')))
}

// ---------------------------------------------------------------------------
// Story 9: a commit whose diff is empty cannot be patch-id'd, so it cannot be
// replayed. It is reported rather than dropped in silence.
// ---------------------------------------------------------------------------
async function storyEmptyCommitsAreReported() {
  console.log('\na commit with no diff is reported, not silently dropped')
  const target = newRepo('target9')
  commit(target, 'a.txt', 'base\n', 'Base')
  const source = newRepo('source9')
  commit(source, 'a.txt', 'base\n', 'Base')
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'An empty commit'], { cwd: source })
  commit(source, 'a.txt', 'base\nreal\n', 'A real change')

  const selection = await selectCommits({
    sourceRepo: source, sourceRef: 'HEAD', targetRepo: target, targetBranch: 'main',
  })
  ok('the empty commit is counted', selection.emptyCommits.length === 1,
    JSON.stringify(selection.emptyCommits))
  ok('the real change is still selected', selection.selected.length === 1,
    JSON.stringify(selection.selected.map(c => c.subject)))
}

// ---------------------------------------------------------------------------
// Story 10: it will not overwrite a file somebody is editing, and refusing does
// not wedge the next run.
//
// The second half is the part that would have shipped broken: a refusal that
// leaves the state file behind makes the NEXT run say "a merge is already in
// progress" about a merge that never happened, and the way out of that is not
// discoverable.
// ---------------------------------------------------------------------------
async function storyRefusesOverAnEditedFile() {
  console.log('\nit refuses rather than overwriting an uncommitted edit, and stays re-runnable')
  const target = newRepo('target10')
  commit(target, 'a.txt', lines(), 'Base')
  const source = newRepo('source10')
  commit(source, 'a.txt', lines(), 'Base')
  commit(source, 'a.txt', lines({ 5: 'line 5, from the app' }), 'App change')

  // Somebody is editing the same file, uncommitted, on the checked-out branch.
  writeFileSync(join(target, 'a.txt'), lines({ 5: 'line 5, being typed right now' }))
  const before = git(target, 'rev-parse', 'main')

  let message = null
  try { await mergeReplay({ sourceRepo: source, targetRepo: target, ffOnly: true }) }
  catch (e) { message = e.message }

  ok('it refuses', /uncommitted changes/.test(message || ''), message)
  ok('the branch did not move', git(target, 'rev-parse', 'main') === before)
  ok('the file is byte-identical to what they were typing',
    readFileSync(join(target, 'a.txt'), 'utf8') === lines({ 5: 'line 5, being typed right now' }))
  ok('nothing is left in progress', (await mergeStatus({ targetRepo: target })).status === 'idle')
  ok('no scratch worktree survives',
    !git(target, 'worktree', 'list').includes('tlda-merge-scratch'), git(target, 'worktree', 'list'))

  // And once they commit, the same command works — no recovery step in between.
  git(target, 'add', 'a.txt')
  git(target, 'commit', '-q', '-m', 'Their own edit')
  const retry = await mergeReplay({ sourceRepo: source, targetRepo: target, ffOnly: false })
  ok('re-running afterwards reaches the replay rather than the in-progress refusal',
    retry.status === 'conflict' || retry.status === 'merged',
    JSON.stringify(retry).slice(0, 200))
  if (retry.status === 'conflict') await mergeAbort({ targetRepo: target })
}

const stories = [
  storyFilteredShadowLands,
  storySecondMergeIsANoop,
  storyFfOnlyIsAtomic,
  storyDefaultModeStopsAndResumes,
  storyAbortLeavesNothing,
  storyOneMergeAtATime,
  storyRootCommitReplays,
  storyLandsOnAnUncheckedOutBranch,
  storyEmptyCommitsAreReported,
  storyRefusesOverAnEditedFile,
]

try {
  for (const story of stories) await story()
} finally {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${ran - failures}/${ran} checks passed`)
process.exit(failures ? 1 : 0)
