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

test('an accepted revision that conflicts with the room never publishes conflict markers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-room-conflict-'))
  try {
    roomTree(root, 'paper')

    // `heldRevision` -> text. The room holds r1; r2 is what disk accepted.
    const revisions = { r1: BASE, r2: FROM_DISK }

    const daemon = createSourceRoomDaemon({
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
      pushDelayMs: 5,
      log: { info() {}, warn() {}, error() {} },
    })

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

    const published = room.ytext.toString()

    assert.doesNotMatch(
      published,
      CONFLICT_MARKERS,
      `the document must never carry conflict markers; a reader sees this text:\n---\n${published}\n---`,
    )
    // And the marker text must not be what a viewer would read, by any route.
    assert.doesNotMatch(published, /accepted server source for/,
      'git merge-file\'s label must never reach the document')

    daemon.closeAll()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
