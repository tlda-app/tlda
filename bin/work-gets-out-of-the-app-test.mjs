#!/usr/bin/env node
/**
 * `tlda project merge` gets a person's work back out of the app, over the real wire.
 *
 * WHY THIS EXISTS SEPARATELY from bin/a-replay-that-lands-on-a-real-branch-test.mjs:
 * that one proves the replay. This one proves the three pieces are CONNECTED —
 * the server route that hands out the project's history, the CLI that asks for
 * it, and the replay that lands it. Calling the route handler and the replay
 * from one process would prove both ends and nothing about whether the CLI can
 * reach the server, which is the only part that can be missing.
 *
 * So: the REAL express router from server/routes/projects.mjs is mounted and
 * listening on a socket, and the REAL `tlda project merge` binary is run as a
 * subprocess against it. Nothing on either side is stubbed. The shadow repo it
 * serves is a real git repository in a real project directory.
 *
 * Run: node bin/work-gets-out-of-the-app-test.mjs
 */

import assert from 'node:assert'
import express from 'express'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(HERE, '../cli/tlda.mjs')

const root = mkdtempSync(join(tmpdir(), 'tlda-merge-wire-'))
const projectsDir = join(root, 'projects')
const projectName = 'a-throwaway-project'
const projectDir = join(projectsDir, projectName)
const shadowDir = join(projectDir, 'shadow-repo')
const authorRepo = join(root, 'author')

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@local')
  git(dir, 'config', 'user.name', 'Test')
}

function commit(dir, file, contents, message) {
  writeFileSync(join(dir, file), contents)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', message)
}

// The author's repository — where the paper actually lives.
initRepo(authorRepo)
commit(authorRepo, 'main.tex', 'The opening line.\n', 'Start the paper')

// The app's copy. The server builds this with git-filter-repo, which rewrites
// every commit; here it is stood up directly with the same property — it holds
// the same opening line under a DIFFERENT sha, so nothing can merge by
// identity and the pairing has to be by content.
initRepo(shadowDir)
commit(shadowDir, 'main.tex', 'The opening line.\n', 'Start the paper')
commit(shadowDir, 'main.tex', 'The opening line.\nA line written in the app.\n', 'Write in the app')
commit(shadowDir, 'main.tex', 'The opening line.\nA line written in the app.\nAnd another.\n', 'Write in the app again')

assert.notEqual(
  git(shadowDir, 'rev-parse', 'main~2'),
  git(authorRepo, 'rev-parse', 'main'),
  'precondition: the app copy must NOT share commit identity with the author repo',
)

// The REAL store initialisation, pointed at the throwaway projects directory —
// not `setProjectPathOverride`, which is the build-instance override and is
// deliberately invisible to `liveProjectDir`. The bundle route resolves its
// repository through `shadowRepoDir`, which is `liveProjectDir`, because the
// shadow is durable per-project state rather than instance-local; an override
// therefore left `projectsDir` null and the route answered
// `shadow bundle failed: The "path" argument must be of type string`.
//
// `no-such-project` needs no setup at all. It is a name under this same
// projects directory with nothing on disk, which is exactly the live state the
// story is about: the directory is configured, the shadow repo is missing.
const { initProjectStore, closeProjectStore } = await import('../server/lib/project-store.mjs')
await initProjectStore(projectsDir)
const projectRoutes = (await import('../server/routes/projects.mjs')).default

const app = express()
app.use('/api/projects', projectRoutes)
const server = await new Promise(res => {
  const s = app.listen(0, '127.0.0.1', () => res(s))
})
const serverUrl = `http://127.0.0.1:${server.address().port}`

// ASYNCHRONOUSLY, and that is load-bearing. The server the CLI is about to call
// lives in THIS process, so `spawnSync` blocks the event loop that has to serve
// the request: every run deadlocks until the CLI's own timeout fires, and the
// output reads as the route hanging. Written with spawnSync first, it reported
// "Request timed out ... GET /shadow/bundle" on every story while the route
// answered a direct fetch in 2.2 seconds.
function runCli(argv, cwd = authorRepo) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...argv, '--server', serverUrl], {
      cwd, env: { ...process.env, TLDA_TOKEN: 'test-token' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

let failures = 0
function ok(name, cond, detail = '') {
  if (cond) { console.log(`  ok  ${name}`); return }
  failures++
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
}

try {
  console.log('\nthe work a person did in the app reaches their own branch')

  const before = git(authorRepo, 'rev-parse', 'main')
  const run = await runCli(['project', 'merge', projectName, '--ff-only'])

  ok('the CLI succeeds', run.status === 0, `exit ${run.status}\n${run.stdout}\n${run.stderr}`)
  ok('it fetched the history over HTTP', /Fetching the version history/.test(run.stdout), run.stdout)
  ok('it reported what it was going to replay', /2 commit\(s\) to replay/.test(run.stdout), run.stdout)
  ok('it says the commit already present was recognised', /1 already present/.test(run.stdout), run.stdout)
  ok('it reports landing', /Landed 2 commit\(s\) on main/.test(run.stdout), run.stdout)

  ok('the branch moved', git(authorRepo, 'rev-parse', 'main') !== before)
  ok('the work is in the author\'s working tree',
    readFileSync(join(authorRepo, 'main.tex'), 'utf8') ===
      'The opening line.\nA line written in the app.\nAnd another.\n',
    JSON.stringify(readFileSync(join(authorRepo, 'main.tex'), 'utf8')))
  ok('one commit per real change, with their messages',
    git(authorRepo, 'log', '--format=%s', 'main').split('\n').reverse().join('|') ===
      'Start the paper|Write in the app|Write in the app again',
    git(authorRepo, 'log', '--format=%s', 'main').replace(/\n/g, ' / '))
  ok('no scratch worktree is left behind',
    !git(authorRepo, 'worktree', 'list').includes('tlda-merge-scratch'),
    git(authorRepo, 'worktree', 'list'))

  console.log('\nrunning it again lands nothing')
  const tip = git(authorRepo, 'rev-parse', 'main')
  const again = await runCli(['project', 'merge', projectName, '--ff-only'])
  ok('the second run succeeds', again.status === 0, `${again.stdout}\n${again.stderr}`)
  ok('it says the branch already has everything', /already has everything/.test(again.stdout), again.stdout)
  ok('the branch did not move', git(authorRepo, 'rev-parse', 'main') === tip)

  console.log('\n--ff-only refuses a conflict rather than landing half of it')
  commit(shadowDir, 'main.tex', 'The opening line.\nA line written in the app.\nAnd another.\nApp four.\n', 'App four')
  commit(shadowDir, 'main.tex', 'The opening line.\nA line written in the app.\nAnd another.\nApp four.\nApp five.\n', 'App five')
  commit(authorRepo, 'main.tex', 'The opening line.\nA line written in the app.\nAnd another.\nLocal four.\n', 'Local four')

  const conflictTip = git(authorRepo, 'rev-parse', 'main')
  const refused = await runCli(['project', 'merge', projectName, '--ff-only'])
  ok('the CLI exits nonzero', refused.status !== 0, `exit ${refused.status}`)
  ok('it says nothing was applied', /Nothing was applied/.test(refused.stderr), refused.stderr)
  ok('it names the patch that stopped it', /App four/.test(refused.stderr), refused.stderr)
  ok('the branch did not move at all', git(authorRepo, 'rev-parse', 'main') === conflictTip)
  ok('it points at the mode that can resolve it',
    /without --ff-only/.test(refused.stderr), refused.stderr)
  const idle = await runCli(['project', 'merge', '--status'])
  ok('nothing was left in progress', /No merge in progress/.test(idle.stdout), idle.stdout)

  console.log('\nthe default mode stops with the conflict where a person can reach it')
  const stopped = await runCli(['project', 'merge', projectName])
  ok('it exits nonzero', stopped.status !== 0, `exit ${stopped.status}`)
  ok('it stopped at the conflict', /Stopped at a conflict/.test(stopped.stderr), stopped.stderr)
  ok('the branch has not moved', git(authorRepo, 'rev-parse', 'main') === conflictTip)
  // The CLI prints `Resolve it in <path>:` — colour codes stripped first, and
  // the trailing colon excluded, because `\S+` swallows it and the path then
  // reads as missing.
  const plain = stopped.stderr.replace(/\[[0-9;]*m/g, '')
  const worktree = (plain.match(/Resolve it in (.+?):?$/m) || [])[1]
  ok('it named a working tree that exists', worktree && existsSync(worktree), worktree)
  ok('the conflict is in that tree and not in the person\'s checkout',
    readFileSync(join(worktree, 'main.tex'), 'utf8').includes('<<<<<<<') &&
    !readFileSync(join(authorRepo, 'main.tex'), 'utf8').includes('<<<<<<<'))

  const status = await runCli(['project', 'merge', '--status'])
  ok('--status reports the stop', /A merge onto main is stopped/.test(status.stdout), status.stdout)

  const aborted = await runCli(['project', 'merge', '--abort'])
  ok('--abort drops it', aborted.status === 0 && /never moved/.test(aborted.stdout),
    `${aborted.stdout}\n${aborted.stderr}`)
  ok('the branch is still where it was', git(authorRepo, 'rev-parse', 'main') === conflictTip)
  ok('the person\'s file is byte-identical to what they wrote',
    readFileSync(join(authorRepo, 'main.tex'), 'utf8') ===
      'The opening line.\nA line written in the app.\nAnd another.\nLocal four.\n')

  console.log('\na project with no history says so rather than failing obscurely')
  const missing = await runCli(['project', 'merge', 'no-such-project', '--ff-only'])
  ok('it exits nonzero', missing.status !== 0)
  ok('it says there is no version history', /no version history/.test(missing.stderr), missing.stderr)
  // It also has to STOP. `finishCliOperation` retries anything 5xx or
  // connection-shaped forever, and wrapping merge in it turned this exact story
  // into an unbounded loop that printed `Fetching the version history…` once a
  // second and never exited. A test that only checks the message passes on that.
  ok('it does not retry a permanent failure',
    (missing.stdout.match(/Fetching the version history/g) || []).length === 1,
    missing.stdout)

  console.log('\nthe top-level spelling is refused and points at the nested one')
  const wrongSpelling = await runCli(['merge', projectName, '--ff-only'])
  ok('`tlda merge` exits nonzero', wrongSpelling.status !== 0, `exit ${wrongSpelling.status}`)
  ok('it names `tlda project merge`', /use: tlda project merge/.test(wrongSpelling.stderr), wrongSpelling.stderr)
  ok('it did not run a merge', !/Fetching the version history/.test(wrongSpelling.stdout), wrongSpelling.stdout)
} finally {
  await new Promise(res => server.close(res))
  await closeProjectStore().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nPASS work gets out of the app')
process.exit(failures ? 1 : 0)
