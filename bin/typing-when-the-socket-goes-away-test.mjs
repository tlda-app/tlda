#!/usr/bin/env node
// You type a character and the socket carrying it goes away.
//
// This is not a network story. `anchor-drift` measured the HUD gate: opening
// the HUD closes the canvas copy's room socket and opens the HUD copy's, and
// closing it does the reverse. Clean cleanup, no leak — and a full teardown and
// rebuild of the room connection **on an ordinary button Skip presses
// constantly**.
//
// The window is an update in flight when the socket closes: typed into a doc
// that is about to be destroyed, not yet acknowledged by the room. If that
// character is gone, it is gone silently, on a gesture rather than a fault.
//
// ---------------------------------------------------------------------------
// What this file can and cannot reach
//
// It covers the half that needs no browser: a `/source-sync/` socket closing
// around an update, with the same server-side room the browser talks to. That
// is worth having on its own — it runs every time, and if the loss happens
// here then the DOM has nothing to do with it.
//
// It cannot reach the unmounting copy's `roomDoc?.destroy()`, which only
// happens in a React tree. If every story here passes, the remaining suspect is
// that destroy, and the browser pass has to cover it.
import assert from 'assert/strict'
import { createServer } from 'http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket, { WebSocketServer } from 'ws'
import * as Y from 'yjs'

import {
  closeProjectStore, createProject, initProjectStore, outputDir, projectDir,
  readClientSourceManifest, readProject, readSourceFile, sourceLifecycleStore, updateProject,
} from '../server/lib/project-store.mjs'
import { createSourceRoomDaemon } from '../server/lib/source-room-daemon.mjs'
import { initSyncRooms } from '../server/lib/sync-rooms.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-socket-goes-away-'))
await initProjectStore(root)
initSyncRooms(root)

const daemons = []
const findings = []

function makeRoomDaemon(pushDelayMs = 1_000_000) {
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

/** One copy of the editor: a socket, a doc, and the text in it. */
async function openTheEditor(port, project) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/source-sync/${project}/main.tex`)
  const sync = await nextMessage(ws, 'sync')
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(sync.update, 'base64')), 'room')
  const text = doc.getText('source')
  doc.on('update', (update, origin) => {
    if (origin === 'room') return
    ws.send(JSON.stringify({ type: 'update', update: Buffer.from(update).toString('base64') }))
  })
  return { ws, doc, text }
}

try {
  // ---------------------------------------------------------------------
  // The control: you type, the character is acknowledged, and then the socket
  // goes away. This has to survive, or nothing else is worth measuring.
  // ---------------------------------------------------------------------
  {
    const name = 'typed-then-the-socket-closed'
    await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon()

    await withSockets(roomDaemon, async port => {
      const canvas = await openTheEditor(port, name)
      canvas.text.insert('opening\n'.length, 'a settled character\n')
      // Give the room time to have it, the way an idle moment would.
      await new Promise(r => setTimeout(r, 500))
      canvas.ws.close()
      await new Promise(r => setTimeout(r, 300))

      const hud = await openTheEditor(port, name)
      assert.ok(
        hud.text.toString().includes('a settled character'),
        'a character the room had already received did not come back when the editor reopened: '
        + JSON.stringify(hud.text.toString()),
      )
      hud.ws.close()
    })
  }

  // ---------------------------------------------------------------------
  // The story. You type and the socket closes in the same breath — no pause,
  // no acknowledgement, which is what a HUD toggle does to the copy that is
  // unmounting. The update is on the wire when the socket goes.
  //
  // Yjs sends each transaction as it happens, so the question is whether the
  // server processes a frame that arrived immediately before the close, or
  // tears the handler down first.
  // ---------------------------------------------------------------------
  {
    const name = 'typed-and-toggled-in-the-same-breath'
    await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon()

    await withSockets(roomDaemon, async port => {
      const canvas = await openTheEditor(port, name)
      canvas.text.insert('opening\n'.length, 'the character in flight\n')
      canvas.ws.close() // no wait: the toggle does not pause for an ack
      await new Promise(r => setTimeout(r, 500))

      const hud = await openTheEditor(port, name)
      const afterToggle = hud.text.toString()
      if (!afterToggle.includes('the character in flight')) {
        findings.push(
          'TYPING ACROSS A TOGGLE LOSES THE CHARACTER.\n'
          + `    Reopened on: ${JSON.stringify(afterToggle)}\n`
          + '    Typed into the copy that was unmounting, sent, and the socket closed in the same\n'
          + '    breath — which is what opening the HUD does. Nothing tells the person, and the\n'
          + '    gesture is one Skip makes constantly.',
        )
      }
      hud.ws.close()
    })
  }

  // ---------------------------------------------------------------------
  // The harder one: typing continuously across the toggle rather than before
  // it. Characters go in on both sides of the close, and every one of them has
  // to be in the file.
  // ---------------------------------------------------------------------
  {
    const name = 'typing-right-through-a-toggle'
    await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon()

    await withSockets(roomDaemon, async port => {
      const canvas = await openTheEditor(port, name)
      for (const word of ['one ', 'two ', 'three ']) canvas.text.insert('opening\n'.length, word)
      canvas.ws.close()

      const hud = await openTheEditor(port, name)
      for (const word of ['four ', 'five ']) hud.text.insert('opening\n'.length, word)
      await new Promise(r => setTimeout(r, 500))
      await roomDaemon.flushRoom(await roomDaemon.getRoom(name, 'main.tex'))

      const onDisk = readSourceFile(name, 'main.tex')
      const missing = ['one', 'two', 'three', 'four', 'five'].filter(word => !onDisk.includes(word))
      if (missing.length > 0) {
        findings.push(
          `TYPING THROUGH A TOGGLE LOST ${missing.length} OF 5 WORDS: ${missing.join(', ')}.\n`
          + `    On disk: ${JSON.stringify(onDisk)}\n`
          + '    Typed on both sides of the socket teardown. The person never stopped typing and\n'
          + '    was never told anything was dropped.',
        )
      }
      hud.ws.close()
    })
  }

  // ---------------------------------------------------------------------
  // The other side of the toggle, and the worse half if it is wrong: typing
  // into the copy that has just mounted and has not synced yet.
  //
  // Its doc starts empty. The room's state arrives a moment later. Two things
  // are supposed to save it — Yjs merges rather than replaces, and the
  // checkpoint is server-side so an unsynced client cannot write its empty
  // doc over the file. Both are reasons. This measures them.
  //
  // Node can reach this after all: hold the sync frame, type into the empty
  // doc first, then apply it. That is the ordering a just-mounted copy sees.
  // ---------------------------------------------------------------------
  {
    const name = 'typed-before-the-room-arrived'
    await paper(name, 'opening\nclosing\n')
    const roomDaemon = makeRoomDaemon()

    await withSockets(roomDaemon, async port => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/source-sync/${name}/main.tex`)
      const sync = await nextMessage(ws, 'sync')

      // The copy has mounted. Its doc is empty and the room's state is in hand
      // but not applied — the instant a person can already be typing.
      const doc = new Y.Doc()
      const text = doc.getText('source')
      // The send handler goes on at doc creation, before a person can type —
      // as the real client does. Registering it after the insert would mean
      // the typed update is never sent at all, and the empty file that
      // followed would be this test's construction rather than the product's
      // behaviour. It was, the first time I wrote this.
      doc.on('update', (update, origin) => {
        if (origin === 'room') return
        ws.send(JSON.stringify({ type: 'update', update: Buffer.from(update).toString('base64') }))
      })
      text.insert(0, 'typed before the room arrived\n')
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(sync.update, 'base64')), 'room')

      const merged = text.toString()
      if (!merged.includes('typed before the room arrived')) {
        findings.push(
          'TYPING BEFORE THE ROOM ARRIVED IS LOST.\n'
          + `    After the room's state landed the buffer reads ${JSON.stringify(merged)}.\n`
          + '    The person typed into a copy that had mounted but not synced, and it was replaced\n'
          + '    rather than merged.',
        )
      }
      if (!merged.includes('opening')) {
        findings.push(
          "THE ROOM'S TEXT WAS LOST BY AN UNSYNCED COPY.\n"
          + `    The buffer reads ${JSON.stringify(merged)} — the paper's own content is gone from it.`,
        )
      }

      // And the worse half: the file must not end up holding only what the
      // unsynced copy had.
      await new Promise(r => setTimeout(r, 500))
      await roomDaemon.flushRoom(await roomDaemon.getRoom(name, 'main.tex'))
      const onDisk = readSourceFile(name, 'main.tex')
      if (!onDisk.includes('opening') || !onDisk.includes('typed before the room arrived')) {
        findings.push(
          'A CHECKPOINT AFTER AN UNSYNCED COPY TYPED WROTE THE WRONG FILE.\n'
          + `    On disk: ${JSON.stringify(onDisk)}\n`
          + '    This writes rather than drops, which is the worse direction.',
        )
      }
      ws.close()
    })
  }

  if (findings.length > 0) {
    console.error(`\n${findings.length} story fails — this is the current product:\n`)
    for (const finding of findings) console.error(`  ${finding}\n`)
    process.exit(1)
  }
  console.log('typing survives the socket going away')
} finally {
  for (const daemon of daemons) daemon.closeAll()
  await closeProjectStore()
}
