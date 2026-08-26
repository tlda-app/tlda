/**
 * **A source room writing the first file of a project that has no revision yet.**
 *
 * Preserved failure, `~/worktrees/app-tester-overlay-proof`, preview :5191:
 *
 *     room working tree: main.md UNTRACKED, zero commits,
 *                        HEAD -> refs/heads/tlda/<project> (unborn), no refs
 *     server.log:        proposal not accepted: not-on-work-branch
 *                        proposal not accepted: empty-checkout
 *     project record:    sourceRevision NONE, acceptSeq null,
 *                        project source repo has no commits
 *
 * **The project never had a head**, so this is not a missing fetch. It is the
 * gap between two decisions that are each right on their own:
 *
 *   `d60d18573`  settle stages TRACKED changes only, never `add -A`. Correct for
 *                a repository the app does not own; its stated cost is that a
 *                new file is not submitted until the author git-adds it.
 *   `de356e277`  the room stands on the project branch before writing. Correct
 *                whenever the project has a head to stand on.
 *
 * Neither covers a room that is the project's FIRST writer. `standOnWorkBranch`
 * resolves no project head, so the branch is unborn; the room writes its file,
 * which is untracked; `settledCommit()` stages tracked paths only, gets an empty
 * tree with no HEAD, and settle refuses `empty-checkout`. Nothing ever stages
 * the file, so every later settle refuses identically.
 *
 * **A person's checkout does not hit this**: they run `git add`. A source room
 * has no author at a keyboard — it is a projection of a Yjs document, and it is
 * the only writer in the system with no one to stage for it.
 *
 * **The repair, and where each test sits.** The room stages what it owns through
 * `track-path` — the verb the adopt-a-root path already uses — before queueing
 * it, so the settle sees a tracked file. The first test below pins the MECHANISM
 * (an untracked file in a zero-commit tree is correctly refused, and must stay
 * refused); the last drives the real source-room API and carries the
 * requirement; the middle one is the line the repair must not cross. The deleted
 * app-owned `add -A` exception is not restored and nothing is materialised.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createGitProjectSync } from './git-project-sync.mjs'
import { createGitSyncManager } from './git-sync-manager.mjs'
import { createSourceRoomDaemon } from '../server/lib/source-room-daemon.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })

/** A room tree exactly as the daemon creates one: `git init`, nothing else. */
async function roomForAProjectWithNoRevision(root) {
  const remote = join(root, 'server.git')
  const working = join(root, 'projects', 'paper', '.source-room', 'working')
  await git(root, ['init', '--bare', remote])
  mkdirSync(working, { recursive: true })
  await git(working, ['init', '-b', 'main'])
  await git(working, ['config', 'user.name', 'source-room'])
  await git(working, ['config', 'user.email', 'room@tlda'])
  return { remote, working }
}

const syncFor = (working, remote) => createGitProjectSync({
  sourceDir: working,
  project: 'paper',
  daemonId: 'source-room:paper',
  bindingId: 'paper',
  remote,
  documentRoots: ['main.md'],
  log: { info() {}, warn() {}, error() {} },
})

test('the MECHANISM: an untracked file in a zero-commit tree is refused as empty-checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-room-first-writer-'))
  const { remote, working } = await roomForAProjectWithNoRevision(root)
  const sync = syncFor(working, remote)

  // The intended order: stand on the project branch, then the editor writes.
  const stood = await sync.standOnWorkBranch()
  assert.notEqual(stood?.ok, false, `the room stands on its work branch: ${JSON.stringify(stood)}`)

  // Confirm the fixture is the reported shape before concluding anything from
  // it: an UNBORN branch, which is what "no project head to start from" leaves.
  const refs = (await git(working, ['for-each-ref', '--format=%(refname)'])).stdout.trim()
  assert.equal(refs, '', 'the branch is unborn — there was no project head to start it from')

  // The editor writes its document. A room's file arrives untracked; nothing in
  // the system git-adds for it.
  writeFileSync(join(working, 'main.md'), '# paper\n\nfirst words\n')

  const result = await sync.editClusterSettled()

  // This layer is RIGHT to refuse. `settledCommit` stages tracked changes only,
  // so an untracked file in a zero-commit tree is an empty tree with no HEAD.
  // Asking the sync layer to publish it would be `add -A` in a repository the
  // app does not own, which `d60d18573` removed on purpose.
  //
  // So this test pins the mechanism rather than the requirement: it is WHY the
  // room stalled, and it must keep behaving this way. The requirement — that a
  // room's first document actually reaches the remote — is the API test below,
  // where the room stages what it owns before queueing it.
  assert.equal(result?.status, 'empty-checkout',
    `nothing tracked means nothing to commit, and that is correct here: ${JSON.stringify(result)}`)

  const proposals = (await git(remote, ['for-each-ref', '--format=%(objectname)', 'refs/tlda/proposals/'])).stdout
    .split('\n').filter(Boolean)
  assert.equal(proposals.length, 0, 'and nothing was published')
})

test('a PERSON\'s checkout with an unstaged new file is still left alone', async () => {
  // THE LINE THE REPAIR MUST NOT CROSS. `d60d18573` removed `add -A` because the
  // app does not stage files in a repository it does not own, and the accepted
  // cost is that a new file waits for `git add`. Whatever fixes the room must
  // not reintroduce that for a person — this test is what tells the two apart,
  // and without it "just stage everything" passes the test above.
  const root = mkdtempSync(join(tmpdir(), 'tlda-person-unstaged-'))
  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.md'), '# paper\n\ncommitted\n')
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', 'base'])
  await git(checkout, ['checkout', '-q', '-b', 'tlda/paper'])

  // An untracked file the author has NOT staged.
  writeFileSync(join(checkout, 'draft-notes.md'), 'not staged yet\n')
  await syncFor(checkout, remote).editClusterSettled()

  const proposals = (await git(remote, ['for-each-ref', '--format=%(objectname)', 'refs/tlda/proposals/'])).stdout
    .split('\n').filter(Boolean)
  const paths = proposals.length
    ? (await git(remote, ['ls-tree', '-r', '--name-only', proposals[0]])).stdout.split('\n').filter(Boolean)
    : []
  assert.ok(!paths.includes('draft-notes.md'),
    `an unstaged file in a person's checkout stays theirs until they add it (saw ${JSON.stringify(paths)})`)
  assert.equal((await git(checkout, ['diff', '--cached', '--name-only'])).stdout.trim(), '',
    'and nothing was staged in their index')
})

test('through the real source-room API, a first document becomes a proposal', async () => {
  // THE SAME FAILURE, DRIVEN THROUGH THE PRODUCT rather than through
  // `createGitProjectSync` directly. The first test in this file proves the
  // mechanism; this one proves the path a room actually takes — the real
  // `createSourceRoomDaemon` over the real `createGitSyncManager`, with only
  // the watcher and the remote replaced, which is the pattern
  // `git-sync-manager.test.mjs` already uses.
  //
  // Without it the fix could be right at the sync layer and never wired into
  // the writer, which is the shape this repository keeps producing: both ends
  // correct and nothing crossing between them.
  // realpath: on macOS mkdtemp gives /var/folders/... and git reports
  // /private/var/folders/..., and `trackPath` compares the strings. Without this
  // the fixture measures the path prefix rather than the behaviour.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tlda-room-api-')))
  const remote = join(root, 'server.git')
  const projectsDir = join(root, 'projects')
  const working = join(projectsDir, 'paper', '.source-room', 'working')
  await git(root, ['init', '--bare', remote])
  mkdirSync(working, { recursive: true })
  await git(working, ['init', '-b', 'main'])
  await git(working, ['config', 'user.name', 'source-room'])
  await git(working, ['config', 'user.email', 'room@tlda'])

  const notes = []
  const watcher = new EventEmitter()
  watcher.add = () => {}
  watcher.unwatch = async () => {}
  watcher.close = async () => {}
  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'),
    daemonId: 'source-room:paper',
    server: 'http://unused.test',
    remoteUrlFor: () => remote,
    quietMs: 10,
    watch: () => watcher,
    log: { info(v) { notes.push(`info ${v}`) }, warn(v) { notes.push(`warn ${v}`) }, error(v) { notes.push(`error ${v}`) } },
  })

  const daemon = createSourceRoomDaemon({
    projectDir: project => join(projectsDir, project),
    readProject: async name => ({ name, mainFile: 'main.md' }),
    sourceLifecycleStore: async () => ({
      gitRepository: async () => ({ head: async () => null }),
      readCurrentFile: async () => null,
      readRevisionFile: async () => Buffer.from(''),
    }),
    readClientSourceManifest: async () => ['main.md'],
    gitSyncManagerForProject: () => manager,
    pushDelayMs: 5,
    log: { info(v) { notes.push(`room-info ${v}`) }, warn(v) { notes.push(`room-warn ${v}`) }, error(v) { notes.push(`room-error ${v}`) } },
  })

  // The project has NO revision — this room is its first writer.
  const answer = await daemon.submitFiles('paper', {
    files: [{ path: 'main.md', content: '# paper\n\nfirst words\n' }],
  })
  assert.equal(answer.status, 202, `the write was accepted: ${JSON.stringify(answer)}`)
  notes.push(`ls-files: ${JSON.stringify((await git(working, ['ls-files'])).stdout.trim())}`)
  notes.push(`status: ${JSON.stringify((await git(working, ['status', '--porcelain'])).stdout.trim())}`)
  notes.push(`branch: ${(await git(working, ['symbolic-ref', '-q', 'HEAD'])).stdout.trim()}`)

  const deadline = Date.now() + 30_000
  let proposals = []
  while (Date.now() < deadline) {
    proposals = (await git(remote, ['for-each-ref', '--format=%(objectname)', 'refs/tlda/proposals/'])).stdout
      .split('\n').filter(Boolean)
    if (proposals.length) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(proposals.length,
    'the first document the editor wrote reached the remote as a proposal — without staging it, ' +
    `nothing tracks the file and every settle refuses \`empty-checkout\` forever.\nlog:\n${notes.join('\n')}`)

  const paths = (await git(remote, ['ls-tree', '-r', '--name-only', proposals[0]])).stdout.split('\n').filter(Boolean)
  assert.deepEqual(paths, ['main.md'], `carrying the document (saw ${JSON.stringify(paths)})`)

  await manager.closeAll()
  daemon.closeAll()
})

test('NEGATIVE: a file that cannot be staged is not reported as queued', async () => {
  // THE FAILURE PATH, and it is the one that hides everything else.
  //
  // `trackPath` answers `{ inRepo: false, tracked: false }` WITHOUT throwing
  // whenever the path does not textually match git's `--show-toplevel` — a
  // realpath difference is enough. An earlier version of this fix warned and
  // carried on, so `submitFiles` answered `202 queued` for a file that could
  // never become a revision: the document simply never appeared, and the only
  // trace was a log line.
  //
  // The bytes are persisted before this point, in the room's tree and its Yjs
  // document, so refusing costs nothing and `flushRoom`'s catch schedules a
  // retry.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tlda-room-unstageable-')))
  const projectsDir = join(root, 'projects')
  const working = join(projectsDir, 'paper', '.source-room', 'working')
  mkdirSync(working, { recursive: true })
  await git(working, ['init', '-b', 'main'])
  await git(working, ['config', 'user.name', 'source-room'])
  await git(working, ['config', 'user.email', 'room@tlda'])

  const queued = []
  const daemon = createSourceRoomDaemon({
    projectDir: project => join(projectsDir, project),
    readProject: async name => ({ name, mainFile: 'main.md' }),
    sourceLifecycleStore: async () => ({
      gitRepository: async () => ({ head: async () => null }),
      readCurrentFile: async () => null,
      readRevisionFile: async () => Buffer.from(''),
    }),
    readClientSourceManifest: async () => ['main.md'],
    gitSyncManagerForProject: () => ({
      bindSource: () => {},
      sync: async () => {},
      standOnWorkBranch: async () => ({ ok: true, status: 'stood' }),
      headChanged: async () => ({ ok: true }),
      // The exact shape `trackPath` returns for a path it will not stage.
      remoteOperation: async () => ({ inRepo: false, tracked: false, path: null }),
      queuePaths: (project, paths) => { queued.push(...paths) },
    }),
    pushDelayMs: 5,
    log: { info() {}, warn() {}, error() {} },
  })

  const answer = await daemon.submitFiles('paper', {
    files: [{ path: 'main.md', content: '# paper\n\nfirst words\n' }],
  })

  assert.notEqual(answer.status, 202,
    `an unstageable file must not be answered as queued: ${JSON.stringify(answer)}`)
  assert.equal(answer.body?.ok, false, 'and the answer says so')
  assert.match(String(answer.body?.error || ''), /was not staged/,
    `naming what went wrong: ${JSON.stringify(answer.body)}`)
  assert.deepEqual(queued, [],
    `and nothing was queued for a settle that could only refuse it (saw ${JSON.stringify(queued)})`)

  daemon.closeAll()
})
