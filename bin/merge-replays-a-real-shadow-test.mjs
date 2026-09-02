#!/usr/bin/env node
/**
 * `tlda project merge` against a shadow repository the SERVER actually built.
 *
 * WHY THIS EXISTS BESIDE THE OTHER TWO. `bin/work-gets-out-of-the-app-test.mjs`
 * proves the wire, and it builds the app's copy by hand — two `git commit`s
 * with the right property, which is enough to prove the CLI reaches the route
 * and the replay lands. What it cannot see is anything the REAL shadow builder
 * puts in a shadow that a hand-built one does not have.
 *
 * So this one uses the real thing end to end: `initProjectStore`,
 * `createProject`, real accepted revisions through the source-lifecycle git,
 * and the real `commitSnapshot` — which calls the real `ensureShadowRepo` —
 * once per accepted revision, the way a build does. Then the real
 * `tlda project merge` binary, as a subprocess, against the real router.
 *
 * The project is created with no source repo on the server, which is the
 * no-origin branch of `ensureShadowRepo`. That is not an edge case: it is the
 * shape every locally-linked project has, and `commitSnapshot` says so where it
 * refuses to skip creation — "a locally-linked project has no source git repo
 * ON THE SERVER, so its shadow can only ever come from this call".
 *
 * Run: node bin/merge-replays-a-real-shadow-test.mjs
 */

import express from 'express'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(HERE, '../cli/tlda.mjs')

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tlda-real-shadow-')))
const projectsDir = join(root, 'projects')
const authorRepo = join(root, 'author')
const projectName = 'a-throwaway-project'
mkdirSync(projectsDir, { recursive: true })

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const OPENING = 'The opening line.\n'
const SECOND = 'The opening line.\nA line written in the app.\n'

// The author's repository. It has a CLAUDE.md of its own, because the shadow
// builder writes a CLAUDE.md too and the question is what a replay does with
// it.
mkdirSync(authorRepo, { recursive: true })
git(authorRepo, 'init', '-q', '-b', 'main')
git(authorRepo, 'config', 'user.email', 'test@local')
git(authorRepo, 'config', 'user.name', 'Test')
writeFileSync(join(authorRepo, 'main.tex'), OPENING)
writeFileSync(join(authorRepo, 'CLAUDE.md'), '# My own notes to my agents\n')
writeFileSync(join(authorRepo, '.gitignore'), 'my-own-ignores/\n')
git(authorRepo, 'add', '.')
git(authorRepo, 'commit', '-qm', 'Start the paper')
const authorClaudeMd = readFileSync(join(authorRepo, 'CLAUDE.md'), 'utf8')
const authorGitignore = readFileSync(join(authorRepo, '.gitignore'), 'utf8')

const store = await import('../server/lib/project-store.mjs')
const { commitSnapshot, shadowRepoDir } = await import('../server/lib/shadow-repo.mjs')
await store.initProjectStore(projectsDir)
store.createProject({ name: projectName, mainFile: 'main.tex', format: 'svg' })

// Two accepted revisions, then a snapshot of each — one build per save, which
// is what the shadow accrues in life.
const lifecycle = await store.sourceLifecycleStore(projectName, { context: { referencedRoots: ['main.tex'] } })
const revisionGit = await lifecycle.gitRepository()
mkdirSync(store.sourceDir(projectName), { recursive: true })

async function acceptAndBuild(content, message) {
  const revision = await revisionGit.acceptRevision({
    project: projectName,
    files: [{ path: 'main.tex', content }],
    message,
  })
  // `source/` is the materialized tree the build renders from, and
  // `commitSnapshot` snapshots THAT rather than the revision — so it is written
  // here for the same reason a build writes it.
  writeFileSync(join(store.sourceDir(projectName), 'main.tex'), content)
  return commitSnapshot(projectName, revision)
}

const firstSnapshot = await acceptAndBuild(OPENING, 'Start the paper')
const secondSnapshot = await acceptAndBuild(SECOND, 'Write in the app')

const projectRoutes = (await import('../server/routes/projects.mjs')).default
const app = express()
app.use('/api/projects', projectRoutes)
const server = await new Promise(res => {
  const s = app.listen(0, '127.0.0.1', () => res(s))
})
const serverUrl = `http://127.0.0.1:${server.address().port}`

function runCli(argv, cwd = authorRepo) {
  return new Promise(res => {
    const child = spawn(process.execPath, [CLI, ...argv, '--server', serverUrl], {
      cwd, env: { ...process.env, TLDA_TOKEN: 'test-token' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', status => res({ status, stdout, stderr }))
  })
}

let failures = 0
function ok(name, cond, detail = '') {
  if (cond) { console.log(`  ok  ${name}`); return }
  failures++
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
}

try {
  console.log('\nthe shadow the server built is the one it was asked to build')
  ok('the first build committed a version', firstSnapshot.status === 'committed', JSON.stringify(firstSnapshot))
  ok('the second build committed a version', secondSnapshot.status === 'committed', JSON.stringify(secondSnapshot))
  const shadowLog = git(shadowRepoDir(projectName), 'log', '--format=%s', '--reverse')
  console.log(`       shadow history: ${shadowLog.split('\n').join(' / ')}`)
  const shadowFiles = git(shadowRepoDir(projectName), 'ls-tree', '-r', '--name-only', 'HEAD')
  console.log(`       shadow tree: ${shadowFiles.split('\n').join(' ')}`)

  console.log('\nmerging it into the author\'s repository')
  const before = git(authorRepo, 'rev-parse', 'main')
  const merged = await runCli(['project', 'merge', projectName, '--ff-only'])
  console.log(merged.stdout.trim().split('\n').map(l => `       ${l}`).join('\n'))
  if (merged.stderr.trim()) console.log(merged.stderr.trim().split('\n').map(l => `       ! ${l}`).join('\n'))

  ok('the CLI succeeds', merged.status === 0, `exit ${merged.status}`)
  ok('the branch moved', git(authorRepo, 'rev-parse', 'main') !== before)
  ok('the work the person did in the app is in their tree',
    readFileSync(join(authorRepo, 'main.tex'), 'utf8') === SECOND,
    JSON.stringify(readFileSync(join(authorRepo, 'main.tex'), 'utf8')))

  // THE POINT OF THIS FILE. The shadow builder writes its own `.gitignore` and
  // a `CLAUDE.md` that says "DO NOT WRITE HERE", and commits them as the `init`
  // commit of a no-origin shadow. They are the server's bookkeeping, not the
  // paper: `readShadowSourceScope` skips both by name when it works out what
  // the paper's files are. A replay that carries them lands two files the
  // author never wrote in the author's own repository, on top of whichever of
  // them they already had.
  console.log('\nthe server\'s own bookkeeping does not land in the author\'s repository')
  ok('their CLAUDE.md is byte-identical to what they wrote',
    readFileSync(join(authorRepo, 'CLAUDE.md'), 'utf8') === authorClaudeMd,
    JSON.stringify(readFileSync(join(authorRepo, 'CLAUDE.md'), 'utf8').slice(0, 120)))
  ok('their .gitignore is byte-identical to what they wrote',
    readFileSync(join(authorRepo, '.gitignore'), 'utf8') === authorGitignore,
    JSON.stringify(readFileSync(join(authorRepo, '.gitignore'), 'utf8').slice(0, 120)))
  ok('no commit of the server\'s bookkeeping is on their branch',
    !/DO NOT WRITE HERE/.test(git(authorRepo, 'log', '-p', 'main')),
    git(authorRepo, 'log', '--format=%s', 'main').split('\n').join(' / '))

  // THE COMMIT THAT CARRIES BOTH. The story above never proves the patch-level
  // filter: the shadow's first `Build at …` commit deletes `CLAUDE.md` AND adds
  // `main.tex`, but against the repository above its paper half matches the
  // author's own opening commit by patch-id, so it is never selected and its
  // deletion never gets a chance to land. Dropping the filter from
  // `format-patch` leaves that story green.
  //
  // A repository that does NOT already have that content selects it, and then
  // the patch is the only thing standing between the author's `CLAUDE.md` and a
  // deletion they did not ask for.
  console.log('\na commit that carries both a paper change and a bookkeeping deletion')
  const secondAuthor = join(root, 'second-author')
  mkdirSync(secondAuthor, { recursive: true })
  git(secondAuthor, 'init', '-q', '-b', 'main')
  git(secondAuthor, 'config', 'user.email', 'test@local')
  git(secondAuthor, 'config', 'user.name', 'Test')
  writeFileSync(join(secondAuthor, 'CLAUDE.md'), '# My own notes to my agents\n')
  writeFileSync(join(secondAuthor, 'README.md'), 'A repository that does not have the paper yet.\n')
  git(secondAuthor, 'add', '.')
  git(secondAuthor, 'commit', '-qm', 'Set up the repository')

  const fresh = await runCli(['project', 'merge', projectName, '--ff-only'], secondAuthor)
  console.log(fresh.stdout.trim().split('\n').map(l => `       ${l}`).join('\n'))
  if (fresh.stderr.trim()) console.log(fresh.stderr.trim().split('\n').map(l => `       ! ${l}`).join('\n'))
  ok('the CLI succeeds', fresh.status === 0, `exit ${fresh.status}\n${fresh.stderr}`)
  ok('it selected the commit that also deletes CLAUDE.md',
    /2 commit\(s\) to replay/.test(fresh.stdout), fresh.stdout)
  ok('the paper landed', readFileSync(join(secondAuthor, 'main.tex'), 'utf8') === SECOND,
    JSON.stringify(readFileSync(join(secondAuthor, 'main.tex'), 'utf8')))
  ok('their CLAUDE.md was NOT deleted', existsSync(join(secondAuthor, 'CLAUDE.md')),
    git(secondAuthor, 'log', '--format=%s', '--name-status', 'main').split('\n').join(' / '))
  ok('and is byte-identical to what they wrote',
    existsSync(join(secondAuthor, 'CLAUDE.md')) &&
      readFileSync(join(secondAuthor, 'CLAUDE.md'), 'utf8') === authorClaudeMd)
  ok('no .gitignore of the server\'s was added',
    !existsSync(join(secondAuthor, '.gitignore')),
    existsSync(join(secondAuthor, '.gitignore')) ? readFileSync(join(secondAuthor, '.gitignore'), 'utf8') : '')

  console.log('\nrunning it again lands nothing')
  const tip = git(authorRepo, 'rev-parse', 'main')
  const again = await runCli(['project', 'merge', projectName, '--ff-only'])
  ok('the second run succeeds', again.status === 0, `${again.stdout}\n${again.stderr}`)
  ok('the branch did not move', git(authorRepo, 'rev-parse', 'main') === tip)
  ok('no scratch worktree survives',
    !git(authorRepo, 'worktree', 'list').includes('tlda-merge-scratch'),
    git(authorRepo, 'worktree', 'list'))
  ok('no merge state is left behind', !existsSync(join(authorRepo, '.git', 'tlda-merge.json')))
} finally {
  await new Promise(res => server.close(res))
  await store.closeProjectStore().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nPASS merge replays a real shadow')
process.exit(failures ? 1 : 0)
