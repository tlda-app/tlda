#!/usr/bin/env node
// Two people typing, and a collaborator on Overleaf who is in none of it.
//
// Skip asked for this configuration directly: "is that do we have, like, the
// git story? Worked out too? Like, the sort of Overleaf type situation?"
//
// Every other room story uses a plain project. This is a project with a linked
// git remote, which changes both directions:
//
//   OUT  the room's checkpoint calls processProjectPush without `overleafSync`
//        in the body (source-room-daemon.mjs:228), so the guard in the push
//        route is true and prepareSourcePushToOverleaf runs. The room's
//        checkpoint publishes to the remote by the same door a daemon does.
//
//   IN   nothing. A remote advance is applied by processProjectPushSerialized,
//        the inner function inside the lock, while the notification handler
//        lives on the wrapper — so nobody is told. That is the shipped defect
//        bin/a-remote-pull-tells-nobody-test.mjs demonstrates without a room in
//        it at all, and the room inherits it.
//
// Told as the story: you and a colleague are typing in the browser. A third
// author who has never opened tlda pushes a chapter to Overleaf. Does your
// work reach them, and does theirs reach you?
//
// The second half is expected red. `pull-tells-nobody` is fixing that root
// cause; if it goes green under this file, that is the system working and the
// story stops being a finding and starts being a regression guard.
import assert from 'assert/strict'
import { createServer } from 'http'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket, { WebSocketServer } from 'ws'
import * as Y from 'yjs'

import {
  closeProjectStore, createProject, initProjectStore, outputDir, projectDir,
  readClientSourceManifest, readProject, readSourceFile, sourceDir,
  sourceLifecycleStore, updateClientSourceManifest, updateProject,
} from '../server/lib/project-store.mjs'
import { createSourceRoomDaemon } from '../server/lib/source-room-daemon.mjs'
import { initSyncRooms } from '../server/lib/sync-rooms.mjs'
import { syncOverleaf } from '../server/lib/overleaf-sync.mjs'
import { processProjectPush, setAcceptedSourceMutationHandler } from '../server/routes/projects.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-room-and-remote-'))
await initProjectStore(root)
initSyncRooms(root)

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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

async function paperWithARemote(name) {
  const remote = join(root, `${name}.git`)
  const seed = join(root, `${name}-seed`)
  mkdirSync(seed, { recursive: true })
  git(['init'], seed)
  git(['config', 'user.email', 'test@example.invalid'], seed)
  git(['config', 'user.name', 'test'], seed)
  writeFileSync(join(seed, 'main.tex'), 'opening\nclosing\n')
  git(['add', 'main.tex'], seed)
  git(['commit', '-m', 'seed'], seed)
  git(['init', '--bare', remote], root)
  git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/master'], root)
  git(['remote', 'add', 'origin', remote], seed)
  git(['push', '-u', 'origin', 'HEAD:master'], seed)

  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success', overleafRemote: remote, autoSync: true })
  mkdirSync(outputDir(name), { recursive: true })
  writeFileSync(join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))
  writeFileSync(join(sourceDir(name), 'main.tex'), 'opening\nclosing\n')
  await updateClientSourceManifest(name, ['main.tex'])
  const bootstrap = (await sourceLifecycleStore(name)).bootstrap({
    expectedRevision: null, sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: readSourceFile(name, 'main.tex') }],
  })
  assert.equal(bootstrap.ok, true, 'the fixture needs a source authority to start from')

  const clone = join(projectDir(name), 'overleaf-clone')
  git(['clone', remote, clone], root)
  git(['config', 'user.email', 'test@example.invalid'], clone)
  git(['config', 'user.name', 'test'], clone)
  return { remote, startRevision: bootstrap.authority.currentRevision }
}

/** What the remote actually holds, read from a fresh clone rather than inferred. */
function fileOnTheRemote(remote, path = 'main.tex') {
  const peek = join(root, `peek-${Math.random().toString(16).slice(2)}`)
  git(['clone', remote, peek], root)
  try { return readFileSync(join(peek, path), 'utf8') } catch {
    // The file genuinely is not on the remote yet; the caller asserts on that.
    return null
  }
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

/** A third author, who has never opened tlda, pushing to the shared remote. */
function theThirdAuthorPushes(remote, content) {
  const checkout = join(root, `third-author-${Math.random().toString(16).slice(2)}`)
  git(['clone', remote, checkout], root)
  git(['config', 'user.email', 'third@example.invalid'], checkout)
  git(['config', 'user.name', 'third author'], checkout)
  writeFileSync(join(checkout, 'main.tex'), content)
  git(['add', 'main.tex'], checkout)
  git(['commit', '-m', 'the third author writes'], checkout)
  git(['push', 'origin', 'HEAD:master'], checkout)
}

try {
  // ---------------------------------------------------------------------
  // Out: two people type in the room, the room checkpoints, and the work has
  // to reach the collaborator who only ever looks at Overleaf.
  // ---------------------------------------------------------------------
  {
    const name = 'the-room-publishes-to-the-remote'
    const { remote } = await paperWithARemote(name)
    const roomDaemon = makeRoomDaemon()
    const room = await roomDaemon.getRoom(name, 'main.tex')

    room.ytext.insert('opening\n'.length, "carol's paragraph\n")
    await roomDaemon.flushRoom(room)

    assert.ok(
      readSourceFile(name, 'main.tex').includes("carol's paragraph"),
      "the room's checkpoint did not even reach the project source",
    )
    const onRemote = fileOnTheRemote(remote)
    assert.ok(
      onRemote && onRemote.includes("carol's paragraph"),
      'the room checkpointed and the collaborator on Overleaf never got it — '
      + `the remote still holds ${JSON.stringify(onRemote)}`,
    )
  }

  // ---------------------------------------------------------------------
  // In: the third author pushes to the remote, tlda pulls it, and the people
  // with the file open have to be told. Expected red — the pull path bypasses
  // the notification handler, which bin/a-remote-pull-tells-nobody-test.mjs
  // shows with no room in it.
  // ---------------------------------------------------------------------
  {
    const name = 'the-remote-reaches-the-room'
    const { remote, startRevision } = await paperWithARemote(name)
    const roomDaemon = makeRoomDaemon()
    const room = await roomDaemon.getRoom(name, 'main.tex')
    assert.equal(room.ytext.toString(), 'opening\nclosing\n', 'the room did not open on the file')

    // The room is told about accepted changes through this handler, the way
    // unified-server wires it. Standing it in so the room can actually hear.
    setAcceptedSourceMutationHandler(async payload => {
      await roomDaemon.applyAcceptedSourceMutation(payload)
    })

    theThirdAuthorPushes(remote, 'the third author rewrote the opening\nclosing\n')
    await syncOverleaf(name)

    // Preconditions: the pull landed and the authority moved. Without these,
    // "the room was not told" is indistinguishable from "nothing happened".
    assert.ok(
      readSourceFile(name, 'main.tex').includes('the third author rewrote the opening'),
      'the pull never reached the project source, so this proves nothing',
    )
    assert.notEqual(
      (await sourceLifecycleStore(name)).readAuthority().currentRevision, startRevision,
      'the authority did not move, so there was nothing to announce',
    )

    const inTheRoom = room.ytext.toString()
    if (!inTheRoom.includes('the third author rewrote the opening')) {
      findings.push(
        'THE REMOTE DOES NOT REACH THE ROOM.\n'
        + `    Everyone with main.tex open still sees ${JSON.stringify(inTheRoom)} while the project\n`
        + '    has moved on. Their next checkpoint writes this back over the third author\'s work.\n'
        + '    Root cause is not the room: an Overleaf pull applies through\n'
        + '    processProjectPushSerialized and the notification handler lives on the wrapper.\n'
        + '    See bin/a-remote-pull-tells-nobody-test.mjs, which shows it with no room in it.',
      )
    }
    setAcceptedSourceMutationHandler(null)
  }

  // ---------------------------------------------------------------------
  // The half nobody has looked at: the room checkpoints and the publish to the
  // remote fails. Publishing is the path with the compensation logic —
  // restoreRemote, overleafConflictFiles, the crash-after-publish story.
  //
  // The question is what the room believes afterwards. If it holds a revision
  // the paper accepted while the remote does not have it, then everyone in the
  // room is typing on top of a state the collaborator will never see, and
  // nothing says so.
  //
  // Reported rather than asserted: I do not know the intended behaviour here,
  // and inventing one and asserting it is how a test ends up encoding my guess.
  // ---------------------------------------------------------------------
  {
    const name = 'the-remote-refuses-the-checkpoint'
    let threwInside = null
    const { remote, startRevision } = await paperWithARemote(name)
    const roomDaemon = makeRoomDaemon()
    const room = await roomDaemon.getRoom(name, 'main.tex')

    room.ytext.insert('opening\n'.length, "carol's paragraph\n")
    // The remote goes away underneath — a dead host, a revoked token, a
    // deleted project. Whatever the cause, the push cannot land.
    rmSync(remote, { recursive: true, force: true })

    // Sit a client on the room so we can see what the person is actually told,
    // rather than inferring it from what flushRoom returns.
    const frames = []
    await withSockets(roomDaemon, async port => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/source-sync/${name}/main.tex`)
      await nextMessage(ws, 'sync')
      ws.on('message', raw => {
        const message = JSON.parse(String(raw))
        if (message.type === 'status') frames.push(message)
      })

      try { await roomDaemon.flushRoom(room) } catch (e) { threwInside = e.message }
      await new Promise(r => setTimeout(r, 500))
      ws.close()
    })
    const threw = threwInside

    const authority = (await sourceLifecycleStore(name)).readAuthority()
    const onDisk = readSourceFile(name, 'main.tex')
    console.log(
      '\nWHEN THE REMOTE REFUSES THE ROOM\'S CHECKPOINT:\n'
      + `    flushRoom ${threw ? `threw: ${threw.slice(0, 120)}` : 'did not throw'}\n`
      + `    room still holds: ${JSON.stringify(room.ytext.toString())}\n`
      + `    room.heldRevision moved: ${room.heldRevision !== startRevision}\n`
      + `    source on disk: ${JSON.stringify(onDisk)}\n`
      + `    authority moved: ${authority.currentRevision !== startRevision}\n`
      + `    what the person is told: ${frames.length === 0 ? 'nothing — no status frame at all' : JSON.stringify(frames.map(f => f.status))}`,
    )
  }

  if (findings.length > 0) {
    console.error(`\n${findings.length} story fails — this is the current product:\n`)
    for (const finding of findings) console.error(`  ${finding}\n`)
    process.exit(1)
  }
  console.log('the room and a git remote: both directions carry')
} finally {
  setAcceptedSourceMutationHandler(null)
  for (const daemon of daemons) daemon.closeAll()
  await closeProjectStore()
}
