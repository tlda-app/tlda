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

  console.log('an edit that reached nowhere: the window exists, and it ends')
} finally {
  for (const daemon of daemons) daemon.closeAll()
  await closeProjectStore()
}
