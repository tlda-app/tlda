#!/usr/bin/env node
import assert from 'assert/strict'
import { createServer } from 'http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
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

async function acceptedPush(name, body) {
  const result = await processProjectPush(name, body)
  assert.equal(result.status, 200, result.error)
  assert.equal(result.ok, true, result.error)
  return result
}

function makeRoomDaemon(pushDelayMs = 1000000) {
  const daemon = createSourceRoomDaemon({
    projectDir,
    readProject,
    sourceLifecycleStore,
    readClientSourceManifest,
    processProjectPush,
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

  const peer = await acceptedPush(name, {
    expectedRevision: base.sourceRevision,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'intro\noutro\npeer accepted\n' }],
  })
  await roomDaemon.applyAcceptedSourceMutation({
    project: name,
    ...peer.acceptedSourceMutation,
    sourceRevision: peer.sourceRevision,
  })

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
  const conflictPeer = await acceptedPush(conflict, {
    expectedRevision: conflictBase.sourceRevision,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'peer same line\n' }],
  })
  await conflictRoomDaemon.applyAcceptedSourceMutation({
    project: conflict,
    ...conflictPeer.acceptedSourceMutation,
    sourceRevision: conflictPeer.sourceRevision,
  })
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
    processProjectPush: async (...args) => {
      duplicatePushes += 1
      return processProjectPush(...args)
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
