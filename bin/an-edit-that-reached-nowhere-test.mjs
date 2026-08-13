#!/usr/bin/env node
// How long an edit is exposed before anything can lose it.
//
// Skip's criterion for this domain, tonight:
//
//   "I shouldn't be risking a paper... unless you're gonna run a delete
//    operation on fucking GitHub or Overleaf, nothing is gonna go away. But the
//    goal is to not lose fucking data."
//
// Git is the floor. Anything that reached the remote or the shadow history is
// recoverable, so the only genuinely losable edit is one that never reached
// them. Every other story in this suite asserts that an edit which got
// somewhere survives. This one measures the window before it gets anywhere.
//
// ---------------------------------------------------------------------------
// The window
//
// A person types into the room. The text is in the server's memory — one Y.Doc
// per project and file — and nowhere else. It reaches the source authority when
// the room checkpoints, `pushDelayMs` after the last edit, 250ms by default. If
// the server dies inside that window the text is gone: no file on disk, no
// revision, nothing for git to be a floor under.
//
// That is not a defect and this file does not assert it is one. A checkpoint on
// every keystroke would be a push per character. **What matters is that the
// window is bounded and that we know its length**, because an unbounded one is
// the difference between "your last quarter second" and "your afternoon".
//
// So: the exposure is stated as a measured fact, and the story asserts the
// thing that must be true — that it ends.
import assert from 'assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  closeProjectStore, createProject, initProjectStore, outputDir, projectDir,
  readClientSourceManifest, readProject, readSourceFile, sourceLifecycleStore, updateProject,
} from '../server/lib/project-store.mjs'
import { createSourceRoomDaemon } from '../server/lib/source-room-daemon.mjs'
import { initSyncRooms } from '../server/lib/sync-rooms.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'
import { clearSourceSyncRefusal, recordSourceSyncRefusal, sourceSyncIsStale, sourceSyncLedger } from '../server/lib/source-sync-conflicts.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-reached-nowhere-'))
await initProjectStore(root)
initSyncRooms(root)

const daemons = []

function makeRoomDaemon(pushDelayMs) {
  const daemon = createSourceRoomDaemon({
    projectDir, readProject, sourceLifecycleStore, readClientSourceManifest,
    processProjectPush, pushDelayMs, log: { error() {} },
  })
  daemons.push(daemon)
  return daemon
}

async function paper(name, content) {
  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success' })
  mkdirSync(outputDir(name), { recursive: true })
  writeFileSync(join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))
  const start = await processProjectPush(name, {
    expectedRevision: null, sourceManifest: ['main.tex'], files: [{ path: 'main.tex', content }],
  })
  assert.equal(start.status, 200, `the paper had to exist first: ${start.error}`)
  return start
}

/**
 * The server dies. Every room it was holding dies with it — the Y.Docs are
 * process memory. What survives is only what reached the source authority,
 * which is what a restarted server reads.
 */
function theServerDies(daemon) {
  daemon.closeAll()
}

try {
  // ## An edit that has not checkpointed has reached nowhere
  //
  // A person types into the room and the server dies before the checkpoint
  // fires. This is the whole exposure: the text was in one process's memory and
  // nowhere else.
  {
    const name = 'the-server-died-before-the-checkpoint'
    await paper(name, 'opening\nclosing\n')
    // Frozen so the checkpoint cannot fire — the window held open on purpose,
    // which is the same thing as dying at the worst possible moment inside it.
    const roomDaemon = makeRoomDaemon(1_000_000)
    const room = await roomDaemon.getRoom(name, 'main.tex')

    // ### The person types
    room.ytext.insert('opening\n'.length, 'a paragraph that only exists in memory\n')
    assert.ok(
      room.ytext.toString().includes('a paragraph that only exists in memory'),
      'the room — holds what the person typed; otherwise they were never typing into it and nothing below is about their work',
    )

    // ### The server dies before the checkpoint
    theServerDies(roomDaemon)

    // ### What reached the paper is what a restarted server would find
    // Stated, not lamented: this is the cost of checkpointing on an interval
    // rather than on every keystroke, and it is why the interval's length is
    // the number that matters.
    const onDisk = readSourceFile(name, 'main.tex')
    assert.ok(
      !onDisk.includes('a paragraph that only exists in memory'),
      'the paper — does not have the uncheckpointed paragraph; otherwise the room checkpoints on '
      + 'every edit and this story is measuring the wrong mechanism',
    )
  }

  // ## The window ends on its own
  //
  // The exposure above must be bounded by the checkpoint interval and nothing
  // else. If a room can hold an edit indefinitely — because the timer is reset
  // by each keystroke, or starved, or never armed — then the window is not a
  // quarter second, it is however long somebody keeps typing.
  {
    const name = 'the-window-closes-by-itself'
    await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon(250) // the shipped default
    const room = await roomDaemon.getRoom(name, 'main.tex')

    // ### The person types and stops
    room.ytext.insert('opening\n'.length, 'a paragraph that should become durable\n')

    // ### The room checkpoints without being asked
    // No flush call anywhere. Waiting on the room's own `status` frame would be
    // better, but there is no socket here — so this polls the authority, which
    // is the durable thing rather than a proxy for it.
    const deadline = Date.now() + 15_000
    let landed = false
    while (Date.now() < deadline) {
      if (readSourceFile(name, 'main.tex').includes('a paragraph that should become durable')) { landed = true; break }
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    // ### The paper has it, and the server may now die freely
    assert.ok(
      landed,
      'the paper — has the paragraph after the room checkpointed on its own; otherwise an edit can '
      + 'sit in a room indefinitely and the exposure is not a quarter second, it is however long '
      + 'somebody keeps typing',
    )
    theServerDies(roomDaemon)
    assert.ok(
      readSourceFile(name, 'main.tex').includes('a paragraph that should become durable'),
      'the paper — still has it after the server dies; otherwise the checkpoint did not make it durable',
    )
  }

  // ## When the checkpoint fails, the window does not end
  //
  // The story above holds only while the push succeeds. A non-conflict failure
  // — the server busy, the store closed, anything that is not somebody else's
  // edit — sets the room's `queued` flag and schedules nothing: the flush timer
  // is armed by a local edit and by the tail of a successful push, and this is
  // neither. So the text sits in the room until somebody happens to type again.
  //
  // The people with the file open see an error. Nobody else learns anything,
  // and by the criterion at the top of this file that is the losable kind.
  // What follows asserts the record, not a retry: this domain is detection
  // rather than prevention, so the requirement is that the paper knows.
  {
    const name = 'the-checkpoint-that-failed'
    await paper(name, 'opening\n')
    let refuse = true
    const roomDaemon = createSourceRoomDaemon({
      projectDir, readProject, sourceLifecycleStore, readClientSourceManifest,
      pushDelayMs: 25,
      log: { error() {} },
      recordHeldEdit: recordSourceSyncRefusal,
      clearHeldEdit: clearSourceSyncRefusal,
      processProjectPush: async (project, body) => (refuse
        ? { status: 500, ok: false, error: 'the paper is being rebuilt' }
        : processProjectPush(project, body)),
    })
    daemons.push(roomDaemon)
    const room = await roomDaemon.getRoom(name, 'main.tex')

    // ### The person types, and the checkpoint fails for a reason nobody chose
    room.ytext.insert('opening\n'.length, 'a paragraph nobody else is touching\n')
    await new Promise(resolve => setTimeout(resolve, 400))

    // ### The paper does not have it, and nothing is going to try again
    assert.equal(readSourceFile(name, 'main.tex').includes('a paragraph nobody else is touching'), false,
      'the paper — does not have the paragraph, because the checkpoint failed')
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(readSourceFile(name, 'main.tex').includes('a paragraph nobody else is touching'), false,
      'the paper — still does not have it however long anyone waits; otherwise this story is about a retry '
      + 'that exists, and the whole point is that the flush timer is only armed by a keystroke')

    // ### The paper knows the live editor is holding an edit
    const held = sourceSyncLedger(await readProject(name), Date.now())
    assert.equal(held.entries.length, 1,
      'the ledger — holds it; otherwise a paragraph sits in server memory with the error shown only to the '
      + 'people who already have the file open, and every instrument outside that room says the paper is fine')
    assert.equal(held.entries[0].file, 'main.tex',
      'the entry — names the file, because for a room that is what one stuck thing is')
    assert.equal(held.entries[0].owner.participant, 'the live editor',
      'the entry — says the live editor is holding it, so it points at where the text actually is')

    // ### An hour later it is a problem rather than a moment
    const anHourOn = sourceSyncLedger(await readProject(name), Date.now() + 60 * 60_000)
    assert.equal(sourceSyncIsStale(anHourOn, 30 * 60_000), true,
      'the paper — raises, because an edit held for an hour is not a checkpoint in progress')

    // ### The next keystroke that succeeds carries it in, and the ledger lets go
    refuse = false
    room.ytext.insert(room.ytext.length, 'and one more line\n')
    const deadline = Date.now() + 15_000
    let landed = false
    while (Date.now() < deadline) {
      if (readSourceFile(name, 'main.tex').includes('a paragraph nobody else is touching')) { landed = true; break }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(landed,
      'the paper — gets the held paragraph when a later checkpoint succeeds, because the room pushes its '
      + 'whole text rather than the one edit that failed')
    // The clear runs after the push returns, so the text reaching disk is not
    // the moment the record is gone. Polling the thing being asserted rather
    // than sleeping past it.
    const clearedBy = Date.now() + 15_000
    let settled = sourceSyncLedger(await readProject(name), Date.now() + 60 * 60_000)
    while (settled.entries.length > 0 && Date.now() < clearedBy) {
      await new Promise(resolve => setTimeout(resolve, 50))
      settled = sourceSyncLedger(await readProject(name), Date.now() + 60 * 60_000)
    }
    assert.deepEqual(settled.entries, [],
      'the ledger — is empty once the text reached the paper; otherwise it reports a room as stuck forever '
      + 'and an alarm that never clears is one nobody reads')
  }

  console.log('an edit that reached nowhere: the window exists, it ends, and a failed checkpoint is recorded')
} finally {
  for (const daemon of daemons) daemon.closeAll()
  await closeProjectStore()
}
