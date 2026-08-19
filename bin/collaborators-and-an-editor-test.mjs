#!/usr/bin/env node
// Two daemons and an editor. Skip's threshold for real collaboration.
//
//   "one daemon plus the editor is a baseline. Two daemons, baseline. Two
//    daemons plus the editor is starting to be a real collaboration. And then
//    we can go from there... like, two n. That's the pattern."
//
// bin/collaborators-on-one-project-test.mjs is the daemon rows: n people
// pushing at the source authority, no room. bin/source-room-daemon-test.mjs is
// one daemon and one editor. This is the row above both — people pushing from
// their machines while somebody has the file open and is typing into it — and
// the count of daemons is a loop bound, so `2 + n` needs no new code.
//
// The seam is the interesting part. A daemon's edit arrives at the source
// authority over HTTP; an editor's arrives in a Yjs room that checkpoints to
// that same authority later. Those are two different paths to one file, and
// the failure they can produce is the silent one: a flush that reverts work
// the room never heard about.
//
// No browser. This is the gate that can run every time; the browser pass in
// bin/live-editor-acceptance.mjs proves a real CodeMirror view does the real
// thing, and is run by a person.
import assert from 'assert/strict'
import { createServer } from 'http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket, { WebSocketServer } from 'ws'
import * as Y from 'yjs'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  outputDir,
  projectDir,
  readClientSourceManifest,
  readProject,
  readSourceFile,
  sourceLifecycleStore,
  updateProject,
} from '../server/lib/project-store.mjs'
import { createSourceRoomDaemon } from '../server/lib/source-room-daemon.mjs'
import { initSyncRooms } from '../server/lib/sync-rooms.mjs'
import { acceptSourceSnapshot } from '../server/routes/projects.mjs'
import { pushSourceSnapshot } from './lib/source-collaborators.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-collaborators-and-editor-'))
await initProjectStore(root)
initSyncRooms(root)

const daemons = []

// pushDelayMs 1_000_000 freezes the checkpoint so every flush is one the test
// asked for and a failure is never a race. That makes the stories readable and
// it also removes the timer they were written for, so the last story below
// uses the room's real delay instead.
function makeRoomDaemon(pushDelayMs = 1_000_000) {
  const daemon = createSourceRoomDaemon({
    projectDir, readProject, sourceLifecycleStore, readClientSourceManifest,
    acceptSourceSnapshot, pushDelayMs, log: { error() {} },
  })
  daemons.push(daemon)
  return daemon
}

function suppressBuilds(name) {
  mkdirSync(outputDir(name), { recursive: true })
  writeFileSync(join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))
}

async function paper(name, content) {
  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success' })
  suppressBuilds(name)
  const start = await pushSourceSnapshot(name, {
    expectedRevision: null, sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content }],
  })
  assert.equal(start.status, 200, `the paper had to exist first: ${start.error}`)
  return start
}

/**
 * Somebody on their own machine, pushing at the source authority, and the room
 * being told about it the way the server tells it — this is what
 * acceptedSourceMutationHandler does in unified-server.
 */
async function pushesFromTheirMachine(roomDaemon, name, who, expectedRevision, content) {
  const result = await pushSourceSnapshot(name, {
    expectedRevision, sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content }], editedBy: who, machineId: who,
  })
  assert.equal(result.status, 200, `${who}'s push was refused: ${result.lifecycleStatus ?? result.error}`)
  // The accept no longer hands its caller an `acceptedSourceMutation` to pass
  // along. It calls `acceptedSourceMutationHandler` itself -- but only inside
  // `if (targets.length)`, so with no source bindings registered it never fires
  // and this story has none. Registering the handler and awaiting it deadlocks;
  // that was measured here, not reasoned about.
  //
  // So the payload is built the way `projects.mjs:1300` builds it. That is a
  // second copy of a shape, which is the thing that bit this file's own helper
  // tonight: if that call site grows a field, this does not, and nothing fails
  // to say so. It is written out rather than spread so the mirroring is at
  // least visible to whoever reads it next.
  await roomDaemon.applyAcceptedSourceMutation({
    project: name,
    sourceRevision: result.sourceRevision,
    previousRevision: expectedRevision,
    // Content, not just the path. The room reads `file.content` directly and a
    // path-only entry merges an empty string over somebody's paragraph — which
    // is what this reconstruction sent until `297baba9a` fixed the real
    // fan-out. Base64 because that is what the fan-out sends and what
    // `bufferFromBase64` on the other side expects.
    files: [{ path: 'main.tex', content: Buffer.from(content).toString('base64'), encoding: 'base64' }],
    deletedFiles: [],
    sourceManifest: ['main.tex'],
    sourceDaemonKey: null,
    sourceBindingId: null,
    requestId: null,
  })
  return result
}

async function withSockets(daemon, fn) {
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const rest = url.pathname.slice('/source-sync/'.length)
    const slash = rest.indexOf('/')
    wss.handleUpgrade(req, socket, head, ws => {
      void daemon.handleSocket(decodeURIComponent(rest.slice(0, slash)), decodeURIComponent(rest.slice(slash + 1)), ws)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    return await fn(server.address().port)
  } finally {
    for (const client of wss.clients) client.close()
    await new Promise(resolve => wss.close(resolve))
    await new Promise(resolve => server.close(resolve))
  }
}

function nextMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.type !== type) return
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
    ws.once('error', reject)
  })
}

try {
  // ## Two daemons push while Carol edits
  //
  // Alice and Bob are each on their own machine. Carol has main.tex open in
  // the browser and is typing into it — nothing of hers has checkpointed yet.
  // Both daemons push while she types.
  //
  // Everyone's work has to be in the file when Carol's draft lands. Carol's
  // checkpoint is the dangerous moment: it writes the whole file, so anything
  // the room never heard about is what it silently reverts.
  {
    const name = 'two-daemons-and-an-editor'
    const start = await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon()
    const room = await roomDaemon.getRoom(name, 'main.tex')

    // ### Carol types
    // Carol types. This is in the room and on nobody's disk.
    room.ytext.insert('opening\n'.length, "carol's paragraph\n")
    assert.ok(
      room.ytext.toString().includes("carol's paragraph"),
      "Carol's editor — her paragraph is in the room, not checkpointed yet; otherwise Carol's draft never reached the live room",
    )

    // ### Alice saves
    const alice = await pushesFromTheirMachine(
      roomDaemon, name, 'alice', start.sourceRevision,
      'opening\nclosing\nalice from her laptop\n',
    )
    assert.ok(
      room.ytext.toString().includes('alice from her laptop'),
      "Carol's editor — Alice's laptop line is in the room; otherwise Carol's checkpoint will revert Alice's push",
    )

    // ### Bob saves
    await pushesFromTheirMachine(
      roomDaemon, name, 'bob', alice.sourceRevision,
      'opening\nclosing\nalice from her laptop\nbob from his desktop\n',
    )

    // Before anything is written: the room has to be holding all three.
    const inTheRoom = room.ytext.toString()
    for (const [who, line] of [
      ['Carol', "carol's paragraph"],
      ['Alice', 'alice from her laptop'],
      ['Bob', 'bob from his desktop'],
    ]) {
      assert.ok(inTheRoom.includes(line), "each person's work — in the room before checkpoint")
    }

    // ### Carol checkpoints
    // Carol's editor checkpoints. It writes the whole file.
    await roomDaemon.flushRoom(room)
    const onDisk = readSourceFile(name, 'main.tex')
    assert.ok(onDisk.includes("carol's paragraph"), "the paper — has Carol's paragraph after her checkpoint; otherwise Carol's own draft was lost by her own checkpoint")
    assert.ok(onDisk.includes('alice from her laptop'), "the paper — has Alice's laptop line after Carol checkpoints; otherwise Carol's checkpoint reverted Alice's push")
    assert.ok(onDisk.includes('bob from his desktop'), "the paper — has Bob's desktop line after Carol checkpoints; otherwise Carol's checkpoint reverted Bob's push")
  }

  // ## A reading group pushes while Carol edits
  //
  // "Two n." The same story with six people pushing while one person types.
  // Nothing below knows the number six.
  {
    const name = 'a-reading-group-and-an-editor'
    const people = ['Alice', 'Bob', 'Dan', 'Erin', 'Frank', 'Grace']
    const start = await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon()
    const room = await roomDaemon.getRoom(name, 'main.tex')

    // ### Carol types
    room.ytext.insert('opening\n'.length, "carol's paragraph\n")
    assert.ok(
      room.ytext.toString().includes("carol's paragraph"),
      "Carol's editor — her paragraph is in the room before the group pushes; otherwise the typist's draft never entered the shared file",
    )

    // ### The reading group saves
    let revision = start.sourceRevision
    let content = 'opening\nclosing\n'
    for (const who of people) {
      content += `${who} pushed this\n`
      const result = await pushesFromTheirMachine(roomDaemon, name, who.toLowerCase(), revision, content)
      revision = result.sourceRevision
      assert.ok(
        room.ytext.toString().includes(`${who} pushed this`),
        "each reader's laptop — their push is in the room",
      )
    }

    // ### Carol checkpoints
    await roomDaemon.flushRoom(room)
    const onDisk = readSourceFile(name, 'main.tex')
    assert.ok(onDisk.includes("carol's paragraph"), "the paper — has Carol's paragraph after the group pushes; otherwise the person typing lost her draft when six people pushed under her")
    for (const who of people) {
      assert.ok(onDisk.includes(`${who} pushed this`), "the paper — has each reader's push after Carol checkpoints")
    }
  }

  // ## Two people have the same file open
  //
  // Two people with the same file open at once. This is the thing Skip
  // expected and that did not exist before the room: not conflict markers
  // between two browsers, but both of them simply looking at the same text.
  //
  // Carol types; Dan, who has touched nothing, must see it without asking.
  {
    const name = 'two-people-with-the-file-open'
    await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon()

    await withSockets(roomDaemon, async port => {
      // ### Carol and Dan open the file
      const join = async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/source-sync/${name}/main.tex`)
        const sync = await nextMessage(ws, 'sync')
        const doc = new Y.Doc()
        Y.applyUpdate(doc, new Uint8Array(Buffer.from(sync.update, 'base64')))
        // Everything the room sends after the first frame lands in this doc,
        // which is what "having the file open" means.
        ws.on('message', raw => {
          const message = JSON.parse(String(raw))
          if (message.type === 'update') Y.applyUpdate(doc, new Uint8Array(Buffer.from(message.update, 'base64')))
        })
        return { ws, doc, text: doc.getText('source') }
      }

      const carol = await join()
      const dan = await join()
      assert.equal(dan.text.toString(), 'opening\nclosing\n', "Dan's editor — has the current file when he opens it; otherwise Dan did not receive the file")

      // ### Carol types
      // Carol types, and sends it the way a client does.
      const before = Y.encodeStateVector(carol.doc)
      carol.text.insert('opening\n'.length, "carol's paragraph\n")
      carol.ws.send(JSON.stringify({
        type: 'update',
        update: Buffer.from(Y.encodeStateAsUpdate(carol.doc, before)).toString('base64'),
      }))

      const arrived = await Promise.race([
        (async () => { while (!dan.text.toString().includes("carol's paragraph")) await new Promise(r => setTimeout(r, 25)); return true })(),
        new Promise(resolve => setTimeout(() => resolve(false), 5_000)),
      ])
      assert.ok(
        arrived,
        "Dan's editor — has Carol's paragraph without asking; otherwise Dan has the same file open and never saw Carol type. He is reading text that is already ",
      )

      carol.ws.close()
      dan.ws.close()
    })
  }

  // ## The room checkpoints on its own clock
  //
  // The same room, on its own clock.
  //
  // Every story above forces the checkpoint, which makes them readable and
  // removes the thing they are about. Every silent-loss failure in this
  // domain lives at a boundary that fires on a timer — the browser's idle
  // write, a daemon's debounce, and now the room's checkpoint — so at least
  // one story has to let the timer fire.
  //
  // No sleep anywhere in here. The room announces its own checkpoint with a
  // `status` frame, so the test waits for the edge the product publishes
  // rather than guessing at a duration. If that frame ever stops being
  // emitted, this hangs and says so, which is the correct failure: a timer
  // nobody can observe is a timer nobody can debug when it eats a paragraph.
  {
    const name = 'the-room-on-its-own-clock'
    const start = await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon(250) // the shipped default

    await withSockets(roomDaemon, async port => {
      // ### Carol opens the file
      const ws = new WebSocket(`ws://127.0.0.1:${port}/source-sync/${name}/main.tex`)
      const sync = await nextMessage(ws, 'sync')
      const doc = new Y.Doc()
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(sync.update, 'base64')), 'room')
      const text = doc.getText('source')
      assert.equal(text.toString(), 'opening\nclosing\n', "Carol's editor — has the file before the timer story starts; otherwise the room timer test is not measuring a real edit")
      doc.on('update', (update, origin) => {
        if (origin === 'room') return
        ws.send(JSON.stringify({ type: 'update', update: Buffer.from(update).toString('base64') }))
      })

      // ### Carol types
      // Carol types. Nobody flushes anything.
      const checkpointed = nextMessage(ws, 'status')
      text.insert('opening\n'.length, "carol's paragraph\n")
      assert.ok(
        text.toString().includes("carol's paragraph"),
        "Carol's editor — has her paragraph before the room's timer fires; otherwise there is nothing for the checkpoint to save",
      )

      // ### Alice saves inside the checkpoint window
      // Alice pushes from her machine inside the same window.
      await pushesFromTheirMachine(
        roomDaemon, name, 'alice', start.sourceRevision,
        'opening\nclosing\nalice from her laptop\n',
      )
      const room = await roomDaemon.getRoom(name, 'main.tex')
      assert.ok(
        room.ytext.toString().includes('alice from her laptop'),
        "the room — has Alice's laptop line before its own checkpoint fires; otherwise the timer checkpoint will revert Alice's push",
      )

      // ### The room checkpoint fires
      const status = await checkpointed
      assert.equal(status.status, 'synced', "the room's own checkpoint — reported synced without a manual flush")

      const onDisk = readSourceFile(name, 'main.tex')
      assert.ok(
        onDisk.includes("carol's paragraph"),
        "the paper — has Carol's paragraph after the room's own checkpoint",
      )
      assert.ok(
        onDisk.includes('alice from her laptop'),
        "the paper — has Alice's laptop line after the room's own checkpoint",
      )
      ws.close()
    })
  }

  console.log('two daemons and an editor: all stories passed')
} finally {
  // closeAll(), not a guessed stop(): an optional-call to a method that does
  // not exist is a silent no-op, the rooms stay open, and the process hangs
  // with no output at all.
  for (const daemon of daemons) daemon.closeAll()
  await closeProjectStore()
}
