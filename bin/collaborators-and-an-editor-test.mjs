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
import { processProjectPush } from '../server/routes/projects.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-collaborators-and-editor-'))
await initProjectStore(root)
initSyncRooms(root)

const daemons = []

function makeRoomDaemon() {
  // A push delay long enough that nothing checkpoints on its own — every flush
  // in here is one this test asked for, so a failure is never a race.
  const daemon = createSourceRoomDaemon({
    projectDir, readProject, sourceLifecycleStore, readClientSourceManifest,
    processProjectPush, pushDelayMs: 1_000_000, log: { error() {} },
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
  const start = await processProjectPush(name, {
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
  const result = await processProjectPush(name, {
    expectedRevision, sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content }], editedBy: who,
  })
  assert.equal(result.status, 200, `${who}'s push was refused: ${result.error}`)
  await roomDaemon.applyAcceptedSourceMutation({
    project: name, ...result.acceptedSourceMutation, sourceRevision: result.sourceRevision,
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
  // ---------------------------------------------------------------------
  // Alice and Bob are each on their own machine. Carol has main.tex open in
  // the browser and is typing into it — nothing of hers has checkpointed yet.
  // Both daemons push while she types.
  //
  // Everyone's work has to be in the file when Carol's draft lands. Carol's
  // checkpoint is the dangerous moment: it writes the whole file, so anything
  // the room never heard about is what it silently reverts.
  // ---------------------------------------------------------------------
  {
    const name = 'two-daemons-and-an-editor'
    const start = await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon()
    const room = await roomDaemon.getRoom(name, 'main.tex')

    // Carol types. This is in the room and on nobody's disk.
    room.ytext.insert('opening\n'.length, "carol's paragraph\n")

    const alice = await pushesFromTheirMachine(
      roomDaemon, name, 'alice', start.sourceRevision,
      'opening\nclosing\nalice from her laptop\n',
    )
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
      assert.ok(inTheRoom.includes(line), `${who}'s line never reached the room: ${JSON.stringify(inTheRoom)}`)
    }

    // Carol's editor checkpoints. It writes the whole file.
    await roomDaemon.flushRoom(room)
    const onDisk = readSourceFile(name, 'main.tex')
    assert.ok(onDisk.includes("carol's paragraph"), "carol's own draft was lost by her own checkpoint")
    assert.ok(onDisk.includes('alice from her laptop'), "carol's checkpoint reverted alice's push")
    assert.ok(onDisk.includes('bob from his desktop'), "carol's checkpoint reverted bob's push")
  }

  // ---------------------------------------------------------------------
  // "Two n." The same story with six people pushing while one person types.
  // Nothing below knows the number six.
  // ---------------------------------------------------------------------
  {
    const name = 'a-reading-group-and-an-editor'
    const people = ['Alice', 'Bob', 'Dan', 'Erin', 'Frank', 'Grace']
    const start = await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon()
    const room = await roomDaemon.getRoom(name, 'main.tex')

    room.ytext.insert('opening\n'.length, "carol's paragraph\n")

    let revision = start.sourceRevision
    let content = 'opening\nclosing\n'
    for (const who of people) {
      content += `${who} pushed this\n`
      const result = await pushesFromTheirMachine(roomDaemon, name, who.toLowerCase(), revision, content)
      revision = result.sourceRevision
    }

    await roomDaemon.flushRoom(room)
    const onDisk = readSourceFile(name, 'main.tex')
    assert.ok(onDisk.includes("carol's paragraph"), "the person typing lost her draft when six people pushed under her")
    for (const who of people) {
      assert.ok(onDisk.includes(`${who} pushed this`), `${who}'s push was reverted by the editor's checkpoint`)
    }
  }

  // ---------------------------------------------------------------------
  // Two people with the same file open at once. This is the thing Skip
  // expected and that did not exist before the room: not conflict markers
  // between two browsers, but both of them simply looking at the same text.
  //
  // Carol types; Dan, who has touched nothing, must see it without asking.
  // ---------------------------------------------------------------------
  {
    const name = 'two-people-with-the-file-open'
    await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon()

    await withSockets(roomDaemon, async port => {
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
      assert.equal(dan.text.toString(), 'opening\nclosing\n', 'Dan did not receive the file when he opened it')

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
        'Dan has the same file open and never saw Carol type. He is reading text that is already '
        + `out of date, and his own next edit will be built on it: ${JSON.stringify(dan.text.toString())}`,
      )

      carol.ws.close()
      dan.ws.close()
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
