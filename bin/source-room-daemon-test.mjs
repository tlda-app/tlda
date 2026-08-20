#!/usr/bin/env node
import assert from 'assert/strict'
import { createServer } from 'http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
import { acceptSourceSnapshot, setAcceptedSourceMutationHandler, setSourceBindingTargetProvider } from '../server/routes/projects.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-source-room-'))
await initProjectStore(root)
initSyncRooms(root)
const roomDaemons = []

function onceSocket(ws, type) {
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

async function withSourceRoomSocketServer(daemon, fn) {
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

function uint8ToBase64(update) {
  return Buffer.from(update).toString('base64')
}

function base64ToUint8(value) {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function suppressBuilds(name) {
  mkdirSync(outputDir(name), { recursive: true })
  writeFileSync(join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))
}

// The accept returns `{status, body}` where the old push returned one flat
// object, so `ok` and the error live under `body`. The room daemon normalizes
// the same way at source-room-daemon.mjs:368 -- stubs below must return that
// shape or they are testing a contract the daemon does not have.
// Returns `result.body` ITSELF, not a copy. Callers below read
// `.acceptedSourceMutation`, which projects.mjs:972 attaches with
// `Object.defineProperty` and therefore NON-ENUMERABLY -- so `{...result.body}`
// silently drops it, `applyAcceptedSourceMutation` receives a mutation carrying
// nothing, and the room never sees the peer's edit. The assertion that fails is
// about the room's text, three lines away from the spread that caused it.
//
// The accept returns `{status, body}` where the old push returned one flat
// object. Nothing here reads the HTTP status off the return -- it is asserted
// below -- so the body is the whole useful value.
async function acceptedPush(name, body) {
  const result = await acceptSourceSnapshot(name, body, { daemonId: 'daemon:test' })
  assert.equal(result.status, 200, JSON.stringify(result))
  assert.equal(result.body.ok, true, JSON.stringify(result))
  return result.body
}

function makeRoomDaemon(pushDelayMs = 1000000) {
  const daemon = createSourceRoomDaemon({
    projectDir,
    readProject,
    sourceLifecycleStore,
    readClientSourceManifest,
    acceptSourceSnapshot,
    pushDelayMs,
    log: { error() {} },
  })
  roomDaemons.push(daemon)
  return daemon
}

try {
  const name = 'source-room-race'
  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success' })
  suppressBuilds(name)

  const base = await acceptedPush(name, {
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'intro\noutro\n' }],
  })
  const roomDaemon = makeRoomDaemon()
  const room = await roomDaemon.getRoom(name, 'main.tex')
  room.ytext.insert(6, 'browser draft\n')

  // **The accept no longer hands the mutation back to its caller.** The old
  // path tagged its result with `acceptedSourceMutation` and the caller passed
  // that on; projects.mjs:1270 says why this path cannot -- the serialized
  // operation returns BEFORE the effects run, so a result-tagged hook would
  // fire with nothing recorded to send. The accept dispatches to a registered
  // handler instead, from inside `applyAcceptedSourceEffects`.
  //
  // So the test registers the room daemon the way the server does, rather than
  // rebuilding the mutation from named keys and calling
  // `applyAcceptedSourceMutation` by hand. Reconstructing it here would prove
  // the room applies a payload the test wrote, not the one the accept sends.
  // The dispatch lives inside `if (targets.length)` (projects.mjs:1232), so
  // with no linked machine there is nothing to send to and the handler never
  // fires. One target is what makes the real producer run -- without it this
  // test would hang waiting for a dispatch that cannot happen.
  setSourceBindingTargetProvider(() => [{ bindingId: 'a-peer-machine' }])
  const dispatched = new Promise(resolve => {
    setAcceptedSourceMutationHandler(async mutation => {
      await roomDaemon.applyAcceptedSourceMutation(mutation)
      resolve()
    })
  })
  await acceptedPush(name, {
    expectedRevision: base.sourceRevision,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'intro\noutro\npeer accepted\n' }],
  })
  // The dispatch is deliberately fire-and-forget (a sleeping machine must not
  // fail an author's push), so the test waits for it rather than assuming it
  // has already run.
  await dispatched
  setAcceptedSourceMutationHandler(null)
  setSourceBindingTargetProvider(null)

  assert.equal(room.ytext.toString(), 'intro\nbrowser draft\noutro\npeer accepted\n')
  await roomDaemon.flushRoom(room)
  assert.equal(readSourceFile(name, 'main.tex'), 'intro\nbrowser draft\noutro\npeer accepted\n')

  const conflict = 'source-room-conflict'
  createProject({ name: conflict, title: conflict, mainFile: 'main.tex', format: 'svg' })
  await updateProject(conflict, { pages: 1, buildStatus: 'success' })
  suppressBuilds(conflict)
  const conflictBase = await acceptedPush(conflict, {
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'same\n' }],
  })
  const conflictRoomDaemon = makeRoomDaemon()
  const conflictRoom = await conflictRoomDaemon.getRoom(conflict, 'main.tex')
  conflictRoom.ytext.delete(0, conflictRoom.ytext.length)
  conflictRoom.ytext.insert(0, 'browser same line\n')
  // Through the real producer, for the same reason the clean case above is:
  // `withAcceptedSourceMutation` has NO CALLERS on this branch, so
  // `result.acceptedSourceMutation` is `undefined` and
  // `...conflictPeer.acceptedSourceMutation` spreads NOTHING. The message then
  // carries no `files`, `changed` is empty, no room matches, and the room keeps
  // its own text -- so the assertion below failed while reporting a room that
  // was never sent anything. A conflict test that dispatches nothing is not
  // testing the merge; it is testing that an empty message is a no-op.
  setSourceBindingTargetProvider(() => [{ bindingId: 'a-peer-machine' }])
  const conflictDispatched = new Promise(resolve => {
    setAcceptedSourceMutationHandler(async mutation => {
      await conflictRoomDaemon.applyAcceptedSourceMutation(mutation)
      resolve()
    })
  })
  await acceptedPush(conflict, {
    expectedRevision: conflictBase.sourceRevision,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'peer same line\n' }],
  })
  await conflictDispatched
  setAcceptedSourceMutationHandler(null)
  setSourceBindingTargetProvider(null)
  assert.match(conflictRoom.ytext.toString(), /^<<<<<<< live room for source-room-conflict:main\.tex/)
  assert.match(conflictRoom.ytext.toString(), /browser same line/)
  assert.match(conflictRoom.ytext.toString(), /peer same line/)

  const durable = 'source-room-durable'
  createProject({ name: durable, title: durable, mainFile: 'main.tex', format: 'svg' })
  await updateProject(durable, { pages: 1, buildStatus: 'success' })
  suppressBuilds(durable)
  await acceptedPush(durable, {
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'stored\n' }],
  })
  const first = makeRoomDaemon()
  const firstRoom = await first.getRoom(durable, 'main.tex')
  firstRoom.ytext.insert(firstRoom.ytext.length, 'unsent\n')
  const second = makeRoomDaemon()
  const secondRoom = await second.getRoom(durable, 'main.tex')
  assert.equal(secondRoom.ytext.toString(), 'stored\nunsent\n')
  assert.equal(readFileSync(join(projectDir(durable), '.source-room', 'working', 'main.tex'), 'utf8'), 'stored\nunsent\n')

  const retryProject = 'source-room-durable-retry'
  createProject({ name: retryProject, title: retryProject, mainFile: 'main.tex', format: 'svg' })
  await updateProject(retryProject, { pages: 1, buildStatus: 'success' })
  suppressBuilds(retryProject)
  await acceptedPush(retryProject, {
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'retry base\n' }],
  })
  const retryRequests = []
  const failingRetryDaemon = createSourceRoomDaemon({
    projectDir,
    readProject,
    sourceLifecycleStore,
    readClientSourceManifest,
    acceptSourceSnapshot: async (_project, body) => {
      retryRequests.push(body)
      return { status: 503, body: { ok: false, error: 'temporarily unavailable' } }
    },
    pushDelayMs: 100,
    log: { error() {} },
  })
  roomDaemons.push(failingRetryDaemon)
  const retryRoom = await failingRetryDaemon.getRoom(retryProject, 'main.tex')
  retryRoom.ytext.insert(retryRoom.ytext.length, 'survives restart\n')
  await failingRetryDaemon.flushRoom(retryRoom)
  assert.equal(retryRequests.length, 1)
  const firstRetryRequest = retryRequests[0]
  failingRetryDaemon.closeAll()

  let recoveredRequest = null
  const recoveredRetryDaemon = createSourceRoomDaemon({
    projectDir,
    readProject,
    sourceLifecycleStore,
    readClientSourceManifest,
    acceptSourceSnapshot: async (project, body, options) => {
      recoveredRequest = body
      return acceptSourceSnapshot(project, body, options)
    },
    pushDelayMs: 10,
    log: { error() {} },
  })
  roomDaemons.push(recoveredRetryDaemon)
  await recoveredRetryDaemon.getRoom(retryProject, 'main.tex')
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000
    const poll = () => {
      if (readSourceFile(retryProject, 'main.tex') === 'retry base\nsurvives restart\n') return resolve()
      if (Date.now() >= deadline) return reject(new Error('durable source-room retry did not recover'))
      setTimeout(poll, 10)
    }
    poll()
  })
  assert.equal(recoveredRequest.requestId, firstRetryRequest.requestId)
  assert.deepEqual(recoveredRequest.files, firstRetryRequest.files)
  assert.equal(readSourceFile(retryProject, 'main.tex'), 'retry base\nsurvives restart\n')

  for (const lifecycleStatus of ['recovery-required', 'invalid-request-id-reuse']) {
    const blockedProject = `source-room-blocked-${lifecycleStatus}`
    createProject({ name: blockedProject, title: blockedProject, mainFile: 'main.tex', format: 'svg' })
    await updateProject(blockedProject, { pages: 1, buildStatus: 'success' })
    suppressBuilds(blockedProject)
    const blockedBase = await acceptedPush(blockedProject, {
      expectedRevision: null,
      sourceManifest: ['main.tex'],
      files: [{ path: 'main.tex', content: 'blocked base\n' }],
    })
    const blockedRequests = []
    const heldEdits = []
    const blockedDaemon = createSourceRoomDaemon({
      projectDir,
      readProject,
      sourceLifecycleStore,
      readClientSourceManifest,
      acceptSourceSnapshot: async (_project, body) => {
        blockedRequests.push(body)
        // `lifecycleStatus` and `authority` are DERIVED by the daemon from
        // `body.status` and `body.currentRevision` (source-room-daemon.mjs:370).
        // Returning them at the top level, as the old flat shape did, would
        // leave the daemon reading undefined and the test asserting nothing.
        return {
          status: 409,
          body: {
            ok: false,
            status: lifecycleStatus,
            error: `terminal ${lifecycleStatus}`,
            currentRevision: blockedBase.sourceRevision,
          },
        }
      },
      recordHeldEdit: async (project, entry) => heldEdits.push({ project, entry }),
      pushDelayMs: 10,
      log: { error() {} },
    })
    roomDaemons.push(blockedDaemon)
    const blockedRoom = await blockedDaemon.getRoom(blockedProject, 'main.tex')
    blockedRoom.ytext.insert(blockedRoom.ytext.length, 'held edit\n')
    await blockedDaemon.flushRoom(blockedRoom)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(blockedRequests.length, 1, `${lifecycleStatus} must not retry`)
    assert.equal(blockedRoom.blocked, true)
    assert.equal(blockedRoom.submission.state, 'blocked')
    assert.equal(heldEdits.length, 1)
    assert.equal(heldEdits[0].project, blockedProject)
    assert.equal(heldEdits[0].entry.reason, `terminal ${lifecycleStatus}`)
  }

  const corrupt = 'source-room-corrupt-revision'
  createProject({ name: corrupt, title: corrupt, mainFile: 'main.tex', format: 'svg' })
  await updateProject(corrupt, { pages: 1, buildStatus: 'success' })
  suppressBuilds(corrupt)
  const corruptStart = await acceptedPush(corrupt, {
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'not blank\n' }],
  })
  // **The promise here is `getRoom`'s, not the store's:** a revision it cannot
  // read is raised, not swallowed into an empty room. That promise is live --
  // the throw is at `source-lifecycle.mjs:385-387`.
  //
  // What changed is how you INDUCE it. This block used to edit
  // `revisions/<id>/snapshot.json` and strip an entry's `content` and `sha256`.
  // Revisions are commits now, and `source-lifecycle.mjs:308` says so in as many
  // words -- *"Nothing writes that shape any more."* There is no snapshot.json
  // to open, so the block died at `readFileSync` with ENOENT before reaching its
  // own assertion: a test that cannot fail, only error.
  //
  // A git manifest entry always carries a `sha256`, so the "neither content nor
  // sha256" arm is now unreachable by construction. The reachable corruption is
  // the other one -- a tree naming a blob the object store does not have.
  const corruptLifecycle = await sourceLifecycleStore(corrupt)
  const corruptRevision = await corruptLifecycle.readRevision(corruptStart.sourceRevision)
  const corruptEntry = corruptRevision.files.find(file => file.path === 'main.tex')
  assert.ok(corruptEntry?.sha256, 'the revision names a blob for main.tex; without one there is nothing to delete and the rejection below would prove nothing')
  const corruptBlobPath = join(
    projectDir(corrupt),
    '.source-lifecycle',
    'git',
    'objects',
    corruptEntry.sha256.slice(0, 2),
    corruptEntry.sha256.slice(2),
  )
  // The control on the deletion. A single accepted push writes loose objects;
  // if that ever changes to a pack this assertion says so, rather than the
  // `rmSync` below quietly removing nothing and the rejection coming from some
  // unrelated cause.
  assert.ok(existsSync(corruptBlobPath), `main.tex's blob is a loose object at ${corruptBlobPath}; if the store started packing single pushes, this induction needs unpacking first`)
  rmSync(corruptBlobPath)
  const corruptDaemon = makeRoomDaemon()
  await assert.rejects(
    () => corruptDaemon.getRoom(corrupt, 'main.tex'),
    /Corrupt revision file entry: main\.tex blob [0-9a-f]+ is missing/,
  )

  const socketProject = 'source-room-socket'
  createProject({ name: socketProject, title: socketProject, mainFile: 'main.tex', format: 'svg' })
  await updateProject(socketProject, { pages: 1, buildStatus: 'success' })
  suppressBuilds(socketProject)
  await acceptedPush(socketProject, {
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'socket base\n' }],
  })
  const socketDaemon = makeRoomDaemon(10)
  await withSourceRoomSocketServer(socketDaemon, async port => {
    const clientDoc = new Y.Doc()
    const clientText = clientDoc.getText('source')
    const ws = new WebSocket(`ws://127.0.0.1:${port}/source-sync/${socketProject}/main.tex`)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const initial = await onceSocket(ws, 'sync')
    Y.applyUpdate(clientDoc, base64ToUint8(initial.update), 'source-room')
    assert.equal(clientText.toString(), 'socket base\n')
    clientDoc.on('update', (update, origin) => {
      if (origin === 'source-room') return
      ws.send(JSON.stringify({ type: 'update', update: uint8ToBase64(update) }))
    })
    clientText.insert(clientText.length, 'node participant\n')
    ws.send(JSON.stringify({ type: 'flush' }))
    const status = await onceSocket(ws, 'status')
    assert.equal(status.status, 'synced')
    assert.equal(readSourceFile(socketProject, 'main.tex'), 'socket base\nnode participant\n')
    ws.close()
  })

  const failedProject = 'source-room-checkpoint-error'
  createProject({ name: failedProject, title: failedProject, mainFile: 'main.tex', format: 'svg' })
  await updateProject(failedProject, { pages: 1, buildStatus: 'success' })
  suppressBuilds(failedProject)
  await acceptedPush(failedProject, {
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'safe base\n' }],
  })
  const failedDaemon = createSourceRoomDaemon({
    projectDir,
    readProject,
    sourceLifecycleStore,
    readClientSourceManifest,
    acceptSourceSnapshot: async () => ({
      status: 409,
      body: { ok: false, error: 'Source transaction failed: remote unavailable' },
    }),
    pushDelayMs: 10,
    log: { error() {} },
  })
  roomDaemons.push(failedDaemon)
  await withSourceRoomSocketServer(failedDaemon, async port => {
    const doc = new Y.Doc()
    const text = doc.getText('source')
    const ws = new WebSocket(`ws://127.0.0.1:${port}/source-sync/${failedProject}/main.tex`)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const initial = await onceSocket(ws, 'sync')
    Y.applyUpdate(doc, base64ToUint8(initial.update), 'source-room')
    doc.on('update', (update, origin) => {
      if (origin === 'source-room') return
      ws.send(JSON.stringify({ type: 'update', update: uint8ToBase64(update) }))
    })
    text.insert(text.length, 'held locally\n')
    ws.send(JSON.stringify({ type: 'flush' }))
    const status = await onceSocket(ws, 'status')
    assert.equal(status.status, 'error')
    assert.equal(status.error, 'Source transaction failed: remote unavailable')
    const room = await failedDaemon.getRoom(failedProject, 'main.tex')
    assert.equal(room.ytext.toString(), 'safe base\nheld locally\n')
    assert.equal(readSourceFile(failedProject, 'main.tex'), 'safe base\n')
    ws.close()
  })

  const duplicateProject = 'source-room-duplicate-render'
  createProject({ name: duplicateProject, title: duplicateProject, mainFile: 'main.tex', format: 'svg' })
  await updateProject(duplicateProject, { pages: 1, buildStatus: 'success' })
  suppressBuilds(duplicateProject)
  await acceptedPush(duplicateProject, {
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'duplicate base\n' }],
  })
  let duplicatePushes = 0
  const duplicateDaemon = createSourceRoomDaemon({
    projectDir,
    readProject,
    sourceLifecycleStore,
    readClientSourceManifest,
    acceptSourceSnapshot: async (...args) => {
      duplicatePushes += 1
      return acceptSourceSnapshot(...args)
    },
    pushDelayMs: 25,
    log: { error() {} },
  })
  roomDaemons.push(duplicateDaemon)
  await withSourceRoomSocketServer(duplicateDaemon, async port => {
    const join = async () => {
      const doc = new Y.Doc()
      const text = doc.getText('source')
      const ws = new WebSocket(`ws://127.0.0.1:${port}/source-sync/${duplicateProject}/main.tex`)
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const initial = await onceSocket(ws, 'sync')
      Y.applyUpdate(doc, base64ToUint8(initial.update), 'source-room')
      doc.on('update', (update, origin) => {
        if (origin === 'source-room') return
        ws.send(JSON.stringify({ type: 'update', update: uint8ToBase64(update) }))
      })
      ws.on('message', raw => {
        const message = JSON.parse(String(raw))
        if (message.type === 'update') Y.applyUpdate(doc, base64ToUint8(message.update), 'source-room')
      })
      return { text, ws }
    }

    const canvas = await join()
    const hud = await join()
    const synced = Promise.all([onceSocket(canvas.ws, 'status'), onceSocket(hud.ws, 'status')])
    canvas.text.insert(canvas.text.length, 'typed once\n')
    const statuses = await Promise.race([
      synced,
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('duplicate-render checkpoint timed out')), 5000)),
    ])
    assert.deepEqual(statuses.map(status => status.status), ['synced', 'synced'])
    assert.equal(duplicatePushes, 1, 'two mounted clients produced more than one checkpoint push')
    assert.equal(readSourceFile(duplicateProject, 'main.tex'), 'duplicate base\ntyped once\n')
    assert.equal(hud.text.toString(), 'duplicate base\ntyped once\n')
    canvas.ws.close()
    hud.ws.close()
  })

  console.log('source room daemon tests passed')
} finally {
  for (const daemon of roomDaemons) daemon.closeAll()
  await closeProjectStore()
}
