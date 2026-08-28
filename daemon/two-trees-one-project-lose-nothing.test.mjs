/**
 * **An admitted browser edit must not vanish from the document.**
 *
 * Measured on a disposable project, 2026-08-27, three cycles of the stylized
 * demo:
 *
 *     disk     3/3 arrived  (25.8s, 17.3s, 35.3s)
 *     browser  0/3 arrived  — "still absent 455s after the window closed"
 *
 * The browser edits were **admitted** and their builds **succeeded**; the text
 * was simply not in the published source, while every disk marker was. **No
 * hold was recorded on any cycle** — no `holding` line, `sourceSyncRefusals`
 * and `sourceSyncConflicts` empty — so it is not the conflict-hold working as
 * designed. It is loss.
 *
 * **The structure that produces it.** A project has TWO working trees that both
 * settle and both push:
 *
 *   - the person's checkout, watched by their daemon
 *   - the source room's `.source-room/working`, watched by the server's own
 *     manager
 *
 * They are separate git trees. Each settles its own content and pushes a
 * proposal. Whichever lands second decides the head — and if it lands as a
 * plain descendant, the other tree's text is simply not in it.
 *
 * **Why the WrongHead repair does not already cover this.** That repair fires
 * when a proposal is REJECTED for not descending from the accepted head, and
 * merges the two. A push that is *accepted* never reaches it. So the question
 * this test asks is narrow: when two trees of one project each publish an edit,
 * does the second one carry the first?
 *
 * The second test is what makes the first mean anything: it distinguishes LOSS
 * from DELAY and from a HOLD. An edit that is merely slow, or deliberately
 * held, is not this defect, and a repair that turned loss into either of those
 * would be a different (and possibly correct) outcome that must not be scored
 * as a pass here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createGitProjectSync } from './git-project-sync.mjs'
import { createGitSyncManager } from './git-sync-manager.mjs'
import { createSourceRoomDaemon } from '../server/lib/source-room-daemon.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })

const BASE = '# paper\n\nalpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf\nhotel\n'

/**
 * One project, two trees that both publish: the person's checkout and the
 * source room's working directory. Both start from the same accepted head,
 * which is what they look like in production once the project has a revision.
 */
/**
 * The server's ancestry rule as a real pre-receive hook.
 *
 * WITHOUT THIS the bare remote accepts any proposal, and the test measures a
 * fixture rather than the product: the whole WrongHead-merge repair exists to
 * fire on this rejection, so a remote that never rejects can never reach it.
 * `git-proposals.mjs` refuses unless the project head is an ancestor.
 */
function installAncestryRule(remote) {
  const hook = join(remote, 'hooks', 'pre-receive')
  writeFileSync(hook, `#!/bin/sh
head=$(git rev-parse --verify --quiet refs/tlda/source/paper)
[ -z "$head" ] && exit 0
while read old new ref; do
  case "$ref" in
    refs/tlda/source/*) continue ;;
  esac
  if ! git merge-base --is-ancestor "$head" "$new"; then
    echo "WrongHead $head" >&2
    exit 1
  fi
done
exit 0
`)
  chmodSync(hook, 0o755)
}

async function projectWithTwoPublishingTrees(root) {
  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  const room = join(root, 'projects', 'paper', '.source-room', 'working')
  await git(root, ['init', '--bare', remote])

  for (const [dir, name] of [[checkout, 'the person'], [room, 'the source room']]) {
    mkdirSync(dir, { recursive: true })
    await git(dir, ['init', '-b', 'main'])
    await git(dir, ['config', 'user.name', name])
    await git(dir, ['config', 'user.email', 'fixture@example.test'])
    await git(dir, ['remote', 'add', 'tlda', remote])
    writeFileSync(join(dir, 'paper.md'), BASE)
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-m', 'base'])
  }

  // One accepted head, shared — they are the same project.
  const head = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(checkout, ['push', '-q', 'tlda', `${head}:refs/tlda/source/paper`])
  for (const dir of [checkout, room]) {
    await git(dir, ['fetch', '-q', 'tlda', '+refs/tlda/source/paper:refs/tlda/fetched/paper'])
    await git(dir, ['update-ref', 'refs/tlda/project/paper', head])
    await git(dir, ['checkout', '-q', '-b', 'tlda/paper'])
  }
  installAncestryRule(remote)
  return { remote, checkout, room }
}

const syncFor = (dir, remote, daemonId) => createGitProjectSync({
  sourceDir: dir,
  project: 'paper',
  daemonId,
  bindingId: `paper:${daemonId}`,
  remote,
  documentRoots: ['paper.md'],
  log: { info() {}, warn() {}, error() {} },
})

/** What the newest accepted head actually contains. */
async function publishedText(remote) {
  const head = (await git(remote, ['rev-parse', 'refs/tlda/source/paper'])).stdout.trim()
  return (await git(remote, ['show', `${head}:paper.md`])).stdout
}

/** Accept a proposal the way the server does: move the shared head to it. */
async function acceptNewestProposal(remote, daemonId) {
  const refs = (await git(remote, ['for-each-ref', '--format=%(refname)', `refs/tlda/proposals/${daemonId}`])).stdout
    .split('\n').filter(Boolean)
  if (!refs.length) return null
  const revision = (await git(remote, ['rev-parse', refs[refs.length - 1]])).stdout.trim()
  await git(remote, ['update-ref', 'refs/tlda/source/paper', revision])
  return revision
}

test('when both trees of one project publish, neither edit is lost', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tlda-two-trees-')))
  const { remote, checkout, room } = await projectWithTwoPublishingTrees(root)

  // THE BROWSER SIDE writes in the room's tree and publishes first.
  writeFileSync(join(room, 'paper.md'), BASE.replace('bravo', 'bravo-FROM-BROWSER'))
  const roomPush = await syncFor(room, remote, 'source-room').editClusterSettled()
  assert.notEqual(roomPush?.ok, false, `the room published: ${JSON.stringify(roomPush)}`)
  await acceptNewestProposal(remote, 'source-room')
  assert.match(await publishedText(remote), /bravo-FROM-BROWSER/,
    'the browser edit is in the document at this point')

  // THE PERSON edits a DIFFERENT line in their own checkout and publishes.
  // Nothing here is a conflict: the two edits are eight lines apart.
  writeFileSync(join(checkout, 'paper.md'), BASE.replace('hotel', 'hotel-FROM-DISK'))
  const diskPush = await syncFor(checkout, remote, 'daemon-a').editClusterSettled()
  assert.notEqual(diskPush?.ok, false, `the person published: ${JSON.stringify(diskPush)}`)
  await acceptNewestProposal(remote, 'daemon-a')

  const published = await publishedText(remote)
  assert.match(published, /hotel-FROM-DISK/, 'the disk edit is in the document')
  assert.match(published, /bravo-FROM-BROWSER/,
    'AND THE BROWSER EDIT IS STILL THERE — a second tree publishing must not erase the first. '
    + `The document now reads:\n---\n${published}---`)
})

test('a browser edit that is merely SLOW or HELD is not this defect', async () => {
  // The distinguishing test. Loss, delay and hold all look the same from the
  // published document at one instant — the text is not there — and only one of
  // them is a defect.
  //
  // Here the room publishes and NOTHING accepts it. The edit is absent from the
  // document, and that is correct: it is waiting, not lost. Its revision exists
  // and carries the text, so it can still arrive.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tlda-two-trees-delay-')))
  const { remote, room } = await projectWithTwoPublishingTrees(root)

  writeFileSync(join(room, 'paper.md'), BASE.replace('bravo', 'bravo-FROM-BROWSER'))
  const roomPush = await syncFor(room, remote, 'source-room').editClusterSettled()
  assert.notEqual(roomPush?.ok, false, `the room published: ${JSON.stringify(roomPush)}`)

  assert.doesNotMatch(await publishedText(remote), /bravo-FROM-BROWSER/,
    'not in the document yet, because nothing has accepted it')

  const refs = (await git(remote, ['for-each-ref', '--format=%(refname)', 'refs/tlda/proposals/source-room'])).stdout
    .split('\n').filter(Boolean)
  assert.ok(refs.length, 'but a proposal EXISTS on the remote')
  const revision = (await git(remote, ['rev-parse', refs[refs.length - 1]])).stdout.trim()
  assert.match((await git(remote, ['show', `${revision}:paper.md`])).stdout, /bravo-FROM-BROWSER/,
    'and it carries the text — pending, recoverable, not lost')
})

test('an edit typed into the ROOM reaches the document', async () => {
  // THE ACTUAL BROWSER PATH, which the two-tree test above does not exercise.
  //
  // That test writes the room's working FILE directly. The browser does not: it
  // writes the room's Yjs document over a websocket, and the room is what
  // decides whether that text ever reaches its working file and gets queued. So
  // a repair proved only against the file path could leave the real one broken —
  // which is exactly what the live demo shows, since with the server's ancestry
  // rule in place the two-tree case already survives.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tlda-room-yjs-')))
  const remote = join(root, 'server.git')
  const projectsDir = join(root, 'projects')
  const room = join(projectsDir, 'paper', '.source-room', 'working')
  await git(root, ['init', '--bare', remote])
  mkdirSync(room, { recursive: true })
  await git(room, ['init', '-b', 'main'])
  await git(room, ['config', 'user.name', 'source-room'])
  await git(room, ['config', 'user.email', 'room@tlda'])
  await git(room, ['remote', 'add', 'tlda', remote])
  writeFileSync(join(room, 'paper.md'), BASE)
  await git(room, ['add', '-A'])
  await git(room, ['commit', '-m', 'base'])
  const head = (await git(room, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(room, ['push', '-q', 'tlda', `${head}:refs/tlda/source/paper`])
  await git(room, ['fetch', '-q', 'tlda', '+refs/tlda/source/paper:refs/tlda/fetched/paper'])
  await git(room, ['update-ref', 'refs/tlda/project/paper', head])
  await git(room, ['checkout', '-q', '-b', 'tlda/paper'])
  installAncestryRule(remote)

  const watcher = new EventEmitter()
  watcher.add = () => {}
  watcher.unwatch = async () => {}
  watcher.close = async () => {}
  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'),
    daemonId: 'source-room',
    server: 'http://unused.test',
    remoteUrlFor: () => remote,
    quietMs: 10,
    watch: () => watcher,
    log: { info() {}, warn() {}, error() {} },
  })

  const daemon = createSourceRoomDaemon({
    projectDir: project => join(projectsDir, project),
    readProject: async name => ({ name, mainFile: 'paper.md' }),
    sourceLifecycleStore: async () => ({
      gitRepository: async () => ({ head: async () => null }),
      readCurrentFile: async () => ({ content: Buffer.from(BASE) }),
      readRevisionFile: async () => Buffer.from(BASE),
    }),
    readClientSourceManifest: async () => ['paper.md'],
    gitSyncManagerForProject: () => manager,
    pushDelayMs: 5,
    log: { info() {}, warn() {}, error() {} },
  })

  // TYPE INTO THE ROOM, the way the editor does — into the Yjs text.
  const live = await daemon.getRoom('paper', 'paper.md')
  live.ydoc.transact(() => {
    live.ytext.delete(0, live.ytext.length)
    live.ytext.insert(0, BASE.replace('bravo', 'bravo-FROM-BROWSER'))
  })
  await daemon.flushRoom(live)

  // Give the manager's debounced settle time to run.
  const deadline = Date.now() + 30_000
  let proposals = []
  while (Date.now() < deadline) {
    proposals = (await git(remote, ['for-each-ref', '--format=%(objectname)', 'refs/tlda/proposals/'])).stdout
      .split('\n').filter(Boolean)
    if (proposals.length) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  assert.ok(proposals.length,
    'the room published a proposal for what was typed into it — with none, the edit is admitted nowhere and cannot reach the document')
  const carried = (await git(remote, ['show', `${proposals[0]}:paper.md`])).stdout
  assert.match(carried, /bravo-FROM-BROWSER/,
    `and the proposal CARRIES the typed text (it carried:\n---\n${carried}---)`)

  daemon.closeAll()
  await manager.closeAll()
})

test('a CONTAMINATED room cannot lose a browser edit silently', async () => {
  // THE DEFECT, and it is the damage the merge repair left behind rather than a
  // new fault.
  //
  // `noteLocalChange` re-derives `blocked` from whether the room's text contains
  // conflict markers, and returned before queuing. `hasConflictMarkers` has
  // exactly two occurrences in that file — its definition and that line — and
  // NOTHING anywhere removes markers from a room's text. So a room that once
  // held them never published again, and said nothing: the editor showed every
  // keystroke and the document never changed.
  //
  // Read from the live disposable project on 2026-08-27, markers dated
  // 2026-08-26 06:07 — from before the merge repair shipped:
  //
  //     <<<<<<< live room for <project>:<file>
  //     - [browser] SYNCDEMO-69410 at 2026-08-26T06:07:49.411Z
  //     =======
  //     - [disk] SYNCDEMO-69409 at 2026-08-26T06:07:49.408Z
  //     >>>>>>> accepted server source for <project>:<file>
  //
  // What is asserted here is ONLY that the silence ends: the file is marked and
  // the hold is recorded, so the person can use the resolution control that
  // already exists. Nothing resolves the markers for them — clearing someone's
  // document is not this code's decision.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tlda-contaminated-room-')))
  const projectsDir = join(root, 'projects')
  const working = join(projectsDir, 'paper', '.source-room', 'working')
  mkdirSync(working, { recursive: true })
  await git(working, ['init', '-b', 'main'])
  await git(working, ['config', 'user.name', 'source-room'])
  await git(working, ['config', 'user.email', 'room@tlda'])
  writeFileSync(join(working, 'paper.md'), BASE)
  await git(working, ['add', '-A'])
  await git(working, ['commit', '-m', 'base'])
  await git(working, ['branch', 'tlda/paper'])

  const held = []
  const queued = []
  const daemon = createSourceRoomDaemon({
    projectDir: project => join(projectsDir, project),
    readProject: async name => ({ name, mainFile: 'paper.md' }),
    sourceLifecycleStore: async () => ({
      gitRepository: async () => ({ head: async () => null }),
      readCurrentFile: async () => ({ content: Buffer.from(BASE) }),
      readRevisionFile: async () => Buffer.from(BASE),
    }),
    readClientSourceManifest: async () => ['paper.md'],
    gitSyncManagerForProject: () => ({
      bindSource: () => {},
      sync: async () => {},
      headChanged: async () => ({ ok: true }),
      standOnWorkBranch: async () => ({ ok: true, status: 'stood' }),
      remoteOperation: async () => ({ inRepo: true, tracked: true, path: 'paper.md' }),
      queuePaths: (project, paths) => { queued.push(...paths) },
    }),
    recordHeldEdit: async (project, record) => { held.push({ project, ...record }) },
    pushDelayMs: 5,
    log: { info() {}, warn() {}, error() {} },
  })

  const room = await daemon.getRoom('paper', 'paper.md')
  const frames = []
  room.clients.add({ readyState: 1, send: payload => frames.push(JSON.parse(payload)) })

  // A room already carrying markers, exactly as the live one was found.
  const contaminated = '# paper\n\n<<<<<<< live room for paper:paper.md\nbravo-FROM-BROWSER\n=======\nbravo-FROM-DISK\n>>>>>>> accepted server source for paper:paper.md\n'
  room.ydoc.transact(() => {
    room.ytext.delete(0, room.ytext.length)
    room.ytext.insert(0, contaminated)
  })
  await new Promise(resolve => setTimeout(resolve, 200))

  // The person keeps typing, which is what actually happened.
  room.ydoc.transact(() => { room.ytext.insert(room.ytext.length, '\nstill typing\n') })
  await new Promise(resolve => setTimeout(resolve, 200))

  // The edit is NOT published — that part is correct and is not what this
  // asserts. What must not happen is publishing nothing and saying nothing.
  const marks = frames.filter(frame => frame?.type === 'status' && frame.status === 'conflict')
  assert.ok(marks.length,
    'the editor was told the file is held — otherwise every keystroke vanishes with the document '
    + `unchanged and no signal anywhere (frames: ${JSON.stringify(frames.map(f => `${f.type}:${f.status ?? ''}`))})`)
  assert.equal(marks[0].file, 'paper.md', 'and told WHICH file, so the mark lands on the right one')
  assert.ok(held.length,
    `and the hold was recorded, so it is visible off the socket too (saw ${JSON.stringify(held)})`)

  // NOTHING WAS RESOLVED FOR THEM. The markers are still theirs to clear with
  // the existing control; this change ends the silence, it does not choose.
  assert.match(room.ytext.toString(), /<{7}/, 'the markers are untouched')
  assert.deepEqual(queued, [], 'and nothing was queued while the text is still conflicted')

  daemon.closeAll()
})
