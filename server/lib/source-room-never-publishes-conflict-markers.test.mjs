/**
 * **A document must never be published with git conflict markers in it.**
 *
 * Observed on a real project on 2026-08-26: the published source of a file
 * became 239 bytes of conflicted text against 72 bytes on disk, carrying
 * `<<<<<<<`, `=======` and a `>>>>>>> accepted server source for <project>:<file>`
 * line rendered into the document itself. The conflict hunk contained the
 * canary written by that very run, so it was produced then and did not predate
 * it.
 *
 * **The mechanism, and why `room.blocked` does not stop it.** When an accepted
 * revision arrives for a file a room is holding, `applyAcceptedSourceMutation`
 * three-way merges the room's text against the incoming source through
 * `git merge-file`. On conflict `mergeText` returns `conflicted: true` AND the
 * marker-laden stdout, and the caller then runs
 * `replaceYText(room.ytext, merged.text)` unconditionally. So the markers are
 * already in the shared Yjs document — which is what every viewer sees and what
 * the room flushes — before `room.blocked = merged.conflicted` is assigned.
 * `blocked` is set after the fact and gates nothing. `hasConflictMarkers()`
 * exists in the same file and is not consulted on this path.
 *
 * **What this test does and does not decide.** It asserts only that conflicted
 * output does not reach the document. It deliberately does NOT assert which
 * side wins, whether the person's text is kept, or how the conflict is
 * surfaced — those are merge-resolution semantics and are not a test's to
 * choose.
 *
 * Deterministic and offline: no server, no network, no daemon. The two sides
 * change the SAME line, which is the case that conflicts in any three-way
 * merge.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSourceRoomDaemon } from './source-room-daemon.mjs'

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

const BASE = '# doc\n\nalpha\nbravo\ncharlie\n'
const FROM_BROWSER = BASE.replace('bravo', 'bravo-FROM-BROWSER')
const FROM_DISK = BASE.replace('bravo', 'bravo-FROM-DISK')
const CONFLICT_MARKERS = /^(<{7}|={7}|>{7})/m

/** A room working tree standing on the project branch, so binding succeeds. */
function roomTree(root, project) {
  const working = join(root, project, '.source-room', 'working')
  mkdirSync(working, { recursive: true })
  git(working, 'init', '-q', '-b', 'main')
  git(working, 'config', 'user.email', 'test@tlda')
  git(working, 'config', 'user.name', 'test')
  writeFileSync(join(working, 'doc.md'), BASE)
  git(working, 'add', '-A')
  git(working, 'commit', '-qm', 'base')
  git(working, 'branch', `tlda/${project}`)
  return working
}

/**
 * Build a daemon over a fresh room tree. `held` collects every held-edit
 * record, so a test can assert the divergence was REPORTED and not merely
 * left in the room where nobody would learn of it.
 */
function daemonOver(root, revisions, held) {
  roomTree(root, 'paper')
  return createSourceRoomDaemon({
    projectDir: project => join(root, project),
    readProject: async name => ({ name, mainFile: 'doc.md' }),
    sourceLifecycleStore: async () => ({
      gitRepository: async () => ({ head: async () => null }),
      readCurrentFile: async () => ({ content: Buffer.from(BASE) }),
      readRevisionFile: async (revisionId) => Buffer.from(revisions[revisionId] ?? ''),
    }),
    readClientSourceManifest: async () => ['doc.md'],
    gitSyncManagerForProject: () => ({
      bindSource: () => {},
      sync: async () => {},
      queuePaths: () => {},
      headChanged: async () => ({ ok: true }),
      standOnWorkBranch: async () => ({ ok: true, status: 'stood' }),
    }),
    recordHeldEdit: async (project, record) => { held.push({ project, ...record }) },
    pushDelayMs: 5,
    log: { info() {}, warn() {}, error() {} },
  })
}

/** Assert the shared document is readable text, not a merge to be resolved. */
function assertNotConflicted(published, where) {
  assert.doesNotMatch(published, CONFLICT_MARKERS,
    `${where}: the document must never carry conflict markers; a reader sees this text:\n---\n${published}\n---`)
  assert.doesNotMatch(published, /accepted server source for/,
    `${where}: git merge-file's label must never reach the document`)
}

test('an accepted revision that conflicts with the room never publishes conflict markers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-room-conflict-'))
  const held = []
  try {
    const daemon = daemonOver(root, { r1: BASE, r2: FROM_DISK }, held)
    const room = await daemon.getRoom('paper', 'doc.md')
    room.heldRevision = 'r1'

    // THE BROWSER SIDE: a person has typed into the room and not saved.
    room.ydoc.transact(() => {
      room.ytext.delete(0, room.ytext.length)
      room.ytext.insert(0, FROM_BROWSER)
    })

    // THE DISK SIDE: an accepted revision changing the SAME line arrives.
    await daemon.applyAcceptedSourceMutation({
      project: 'paper',
      previousRevision: 'r1',
      sourceRevision: 'r2',
      files: [{ path: 'doc.md', content: Buffer.from(FROM_DISK).toString('base64') }],
    })

    assertNotConflicted(room.ytext.toString(), 'applyAcceptedSourceMutation')

    // NEITHER SIDE IS LOST. The room keeps what the person typed, the accepted
    // revision is still the accepted revision, and the divergence is REPORTED
    // rather than sitting in a room nobody is told about.
    assert.match(room.ytext.toString(), /bravo-FROM-BROWSER/,
      'the text the person typed is still in the room')
    assert.equal(room.blocked, true, 'the room is marked blocked')
    assert.equal(held.length, 1, `the held edit was recorded (saw ${JSON.stringify(held)})`)
    assert.equal(held[0].file, 'doc.md')

    daemon.closeAll()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reconciling a stale room onto a conflicting revision never publishes conflict markers', async () => {
  // THE SECOND PATH, and it is reached differently: a room that was closed and
  // reopened, or was open when a revision landed, is brought up to date through
  // `reconcileRoomToRevision` rather than the accepted-update handler. Same
  // merge, same marker-laden stdout, so the same rule has to hold -- and one
  // test covering one path would have left the other free to publish markers.
  const root = mkdtempSync(join(tmpdir(), 'tlda-room-reconcile-'))
  const held = []
  try {
    const daemon = daemonOver(root, { r1: BASE, r2: FROM_DISK }, held)
    const room = await daemon.getRoom('paper', 'doc.md')
    room.heldRevision = 'r1'
    room.ydoc.transact(() => {
      room.ytext.delete(0, room.ytext.length)
      room.ytext.insert(0, FROM_BROWSER)
    })

    // POSITIONAL, not an options object. Passing `{ project, sourceRevision }`
    // left `revision` undefined, `reconcileRoomToRevision` returned at its
    // first guard, and this test passed against the UNFIXED code -- a gate that
    // could not go red. Its counterfactual is what caught that.
    await daemon.headChanged('paper', 'r2')

    assertNotConflicted(room.ytext.toString(), 'reconcileRoomToRevision')
    assert.match(room.ytext.toString(), /bravo-FROM-BROWSER/,
      'the text the person typed is still in the room')

    daemon.closeAll()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a held edit is announced to the editor so the file can be marked', async () => {
  // SKIP ASKED FOR THIS, 2026-08-26 10:58:16 EDT: when two people change the
  // same lines, mark the affected file in the editor.
  //
  // It needs its own test because the mark used to happen BY ACCIDENT. The
  // conflicted merge text was written into the document, the client saw
  // `<<<<<<<` in its own buffer and marked the file itself. Keeping the markers
  // out of the document -- the fix above -- removed the only signal the person
  // had, so the room has to say it. A silent hold and a successful sync look
  // identical from the editor, which is the failure this closes.
  //
  // Asserted at the SOCKET, not at `room.blocked`. A flag the server sets and
  // never sends is the same as no signal at all.
  const root = mkdtempSync(join(tmpdir(), 'tlda-room-held-mark-'))
  const held = []
  try {
    const daemon = daemonOver(root, { r1: BASE, r2: FROM_DISK }, held)
    const room = await daemon.getRoom('paper', 'doc.md')
    room.heldRevision = 'r1'

    // A connected editor. `sendJson` writes to anything with readyState 1.
    const frames = []
    room.clients.add({ readyState: 1, send: (payload) => frames.push(JSON.parse(payload)) })

    room.ydoc.transact(() => {
      room.ytext.delete(0, room.ytext.length)
      room.ytext.insert(0, FROM_BROWSER)
    })

    await daemon.applyAcceptedSourceMutation({
      project: 'paper',
      previousRevision: 'r1',
      sourceRevision: 'r2',
      files: [{ path: 'doc.md', content: Buffer.from(FROM_DISK).toString('base64') }],
    })

    const conflictFrames = frames.filter(frame => frame?.type === 'status' && frame.status === 'conflict')
    assert.equal(conflictFrames.length, 1,
      `the editor was told the file is held (frames seen: ${JSON.stringify(frames.map(f => f.type + ':' + (f.status ?? '')))})`)
    assert.equal(conflictFrames[0].file, 'doc.md',
      'and told WHICH file, so the mark lands on the right one rather than the whole project')

    // The document itself is still clean -- the mark replaces the markers, it
    // does not accompany them.
    assert.doesNotMatch(room.ytext.toString(), CONFLICT_MARKERS,
      'and the document still carries no conflict markers')

    daemon.closeAll()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
