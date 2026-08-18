// A push's base must mean the daemon HAS that revision's content, not just its hash.
//
// The loss this reproduces, from bregman on 2026-08-18: three passages of the
// author's prose were deleted from the server by an accept that looked
// completely healthy — `acceptSeq` up by one, no error on any surface.
//
// The loop, and both halves are behaving as designed:
//
//   1. The server holds text that exists only there.
//   2. Materialization plans to write it down; the author is editing that file,
//      so the guard from 7c13e1052 / cf6e30cf0 CORRECTLY declines. His local
//      prose is protected and the file is left untouched.
//   3. His checkout therefore never contains the server-only text.
//   4. The daemon later pushes that file. A source-change carries WHOLE FILE
//      CONTENTS, not a diff, and its base comes from `serverHeadRevision` — the
//      hash of what the server said exists, not of what this machine actually
//      wrote down. So the base matches, the server accepts as-is, and the
//      server-only text is deleted.
//
// The guard prevents local loss by creating server loss. No test of either half
// can catch it, which is why this one crosses the wire: a real unified-server
// child process, a real daemon-side createSourceSync, and the daemon's own
// composed source-change delivered over the socket. Calling both ends from one
// process would prove the two ends and not the thing that is broken between
// them (AGENTS.md, "Prove the wire, not the two ends").
//
// The fix this is written against: base the push on `materializedRevision`
// instead. After a declined materialization the base is then stale BY
// CONSTRUCTION, the server answers stale-base, and the three-way merge that
// already exists runs — the same one that saved both sides of his paper at
// 04:52Z. Nothing here builds a merge; it makes the existing one reachable.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSourceSync } from '../../daemon/source-sync.mjs'
import { closeProjectStore, createProject, initProjectStore, updateProject } from './project-store.mjs'
import { deliver, openDaemon, startServer, stopServer, unusedPort } from './durable-source-wire-harness.mjs'

const SERVER_ONLY = 'A passage that exists only on the server.\n'
const SHARED = 'A line both sides agree on.\n'
const LOCAL_EDIT = 'A line the author is typing right now.\n'

function entry(path, content) {
  const bytes = Buffer.from(content)
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

// The materialization payload the server sends with an accepted source update.
function materialization(previousContent, nextContent) {
  const target = entry('main.tex', nextContent)
  return {
    baseManifest: [entry('main.tex', previousContent)],
    targetManifest: [target],
    blobs: { [target.sha256]: Buffer.from(nextContent).toString('base64') },
  }
}

test('a declined materialization does not let the next push delete what it declined', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-push-base-'))
  const projectsDir = join(root, 'projects')
  const fleetDb = join(root, 'fleet.db')
  const bindingRegistry = join(root, 'source-bindings.json')
  const project = 'paper-push-base'
  const port = await unusedPort()
  const targetDir = join(root, 'target-checkout')

  let server = null
  let targetWs = null
  let peerWs = null
  let targetSync = null

  try {
    await initProjectStore(projectsDir)
    createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
    await updateProject(project, { pages: 1, buildStatus: 'success' })
    mkdirSync(join(projectsDir, project, 'output'), { recursive: true })
    writeFileSync(join(projectsDir, project, 'output', 'relevant-files.json'), JSON.stringify(['main.tex']))
    await closeProjectStore()

    server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })

    // The author's machine, holding the base revision.
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'main.tex'), SHARED)
    const watcher = new EventEmitter()
    watcher.close = () => Promise.resolve()
    const targetSent = []
    targetSync = createSourceSync({
      sourceBindingsFile: join(root, 'target-bindings.json'),
      log: { info() {}, warn() {}, error() {} },
      sendMsg(message) { targetSent.push(message); return true },
      isConnected: () => true,
      resolveEditor: () => null,
      reconcileIntervalMs: 60_000,
      watch() { return watcher },
    })
    const targetBinding = targetSync.bindSource(project, targetDir)

    // Establish the base both sides share, over the wire.
    peerWs = await openDaemon(port, {
      machineId: 'peer-machine',
      sourceBindings: [{ bindingId: 'peer-binding', project }],
    })
    const baseReplies = await deliver(peerWs, {
      type: 'source-change', project, requestId: 'R-base', expectedRevision: null,
      sourceBindingId: 'peer-binding',
      files: [{ path: 'main.tex', content: SHARED }],
      deletedFiles: [], sourceManifest: ['main.tex'], editedBy: 'peer',
      __daemon_outbox_id: 'D-base',
    })
    const baseAccepted = baseReplies.find(m => m.type === 'source-change-result')
    assert.equal(baseAccepted?.ok, true, JSON.stringify(baseReplies))
    targetSync.sync([{
      name: project, sourceDir: targetDir, mainFile: 'main.tex', format: 'svg',
      sourceRevision: baseAccepted.sourceRevision, sourceManifest: ['main.tex'],
    }], { authoritativeRevisions: true })

    // The checkout materializes that base cleanly, which is what makes it a
    // checkout that HOLDS a revision rather than one that has merely been told a
    // revision exists. His had been syncing for hours before any of this.
    const seeded = targetSync.applyAcceptedSourceUpdate({
      project,
      bindingId: targetBinding.bindingId,
      previousRevision: null,
      sourceRevision: baseAccepted.sourceRevision,
      files: [{ path: 'main.tex', content: SHARED }],
      sourceManifest: ['main.tex'],
      ...materialization(SHARED, SHARED),
    })
    assert.equal(seeded.ok, true, `the base materialized cleanly: ${JSON.stringify(seeded)}`)

    // Someone else — a browser editor, another machine — adds a passage that the
    // author's checkout has never seen.
    const peerReplies = await deliver(peerWs, {
      type: 'source-change', project, requestId: 'R-peer',
      expectedRevision: baseAccepted.sourceRevision,
      sourceBindingId: 'peer-binding',
      files: [{ path: 'main.tex', content: SHARED + SERVER_ONLY }],
      deletedFiles: [], sourceManifest: ['main.tex'], editedBy: 'peer',
      __daemon_outbox_id: 'D-peer',
    })
    const peerAccepted = peerReplies.find(m => m.type === 'source-change-result')
    assert.equal(peerAccepted?.ok, true, JSON.stringify(peerReplies))
    const serverOnlyRevision = peerAccepted.sourceRevision

    // The author is mid-sentence in that same file when the update arrives, so
    // the materializer declines — correctly, and this is the behaviour to keep.
    writeFileSync(join(targetDir, 'main.tex'), SHARED + LOCAL_EDIT)
    watcher.emit('change', join(targetDir, 'main.tex'))

    const applied = targetSync.applyAcceptedSourceUpdate({
      project,
      bindingId: targetBinding.bindingId,
      previousRevision: baseAccepted.sourceRevision,
      sourceRevision: serverOnlyRevision,
      files: [{ path: 'main.tex', content: SHARED + SERVER_ONLY }],
      sourceManifest: ['main.tex'],
      ...materialization(SHARED, SHARED + SERVER_ONLY),
    })
    assert.equal(applied.accepted, true, 'the update reached the materializer')
    assert.deepEqual(applied.conflicted, ['main.tex'], 'and it declined to write over live local prose')
    assert.equal(readFileSync(join(targetDir, 'main.tex'), 'utf8'), SHARED + LOCAL_EDIT,
      'the guard left the author\'s file exactly as he wrote it')

    // Now the author's machine pushes. This is the daemon's OWN composed message,
    // put on the real socket — not a hand-written envelope.
    await new Promise(resolve => setTimeout(resolve, 400))
    const push = targetSent.filter(m => m.type === 'source-change').pop()
    assert.ok(push, `the checkout pushed after the declined materialization: ${JSON.stringify(targetSent)}`)

    targetWs = await openDaemon(port, {
      machineId: 'target-machine',
      sourceBindings: [{ bindingId: targetBinding.bindingId, project }],
    })
    const pushReplies = await deliver(targetWs, { ...push, __daemon_outbox_id: 'D-target' })
    const pushResult = pushReplies.find(m => m.type === 'source-change-result')

    // THE ASSERTION. Whatever the server does with this push, the passage it
    // already had must still be there afterwards. Accepting a whole file whose
    // sender was refused permission to hold that content deletes it.
    const onServer = readFileSync(join(projectsDir, project, 'source', 'main.tex'), 'utf8')
    assert.ok(onServer.includes(SERVER_ONLY),
      `the server-only passage was deleted by a push from a checkout that never had it `
      + `(push base ${push.expectedRevision}, result ${JSON.stringify(pushResult)})`)

    // Refused, not accepted — and refused with a REAL three-way merge attached,
    // which is only possible because the base named a revision this checkout
    // actually held. Both pieces of prose are in it. Nothing is deleted and a
    // person can resolve it; two people edited the same region, so no machine
    // should resolve it for them.
    assert.equal(pushResult?.ok, false, 'the push is refused rather than silently accepted')
    assert.equal(pushResult?.status, 'stale-base', JSON.stringify(pushResult))
    const classification = pushResult?.evidence?.classifications?.find(c => c.path === 'main.tex')
    assert.equal(classification?.status, 'conflict',
      `the refusal carries a computed merge, not classification-unavailable: ${JSON.stringify(classification)}`)
    const merged = Buffer.from(classification.merged, 'base64').toString('utf8')
    assert.ok(merged.includes(SERVER_ONLY), 'the merge holds the server-only passage')
    assert.ok(merged.includes(LOCAL_EDIT), 'the merge holds the author\'s live edit')

  } finally {
    if (targetSync) await targetSync.closeAll()
    for (const ws of [targetWs, peerWs]) {
      if (!ws) continue
      ws.close()
      await new Promise(resolve => ws.once('close', resolve))
    }
    await stopServer(server)
    await closeProjectStore().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})

// The other half of the ruling: does ordinary contention still clear without a
// human? The self-heal in daemon/source-sync.mjs exists so two machines editing
// one project resolve themselves, and three existing tests assert that a
// rejected push re-rides the authority revision the rejection taught it.
//
// If basing on materializedRevision meant that non-overlapping contention now
// stalls, the change would have broken something real. It does not: a
// non-overlapping three-way merge comes back MERGED rather than CONFLICT and the
// server accepts it, so the peer's paragraph and the author's paragraph both
// land in one accept and nobody is asked to do anything.
//
// Only a textual conflict stops, which is the case where stopping is correct.
test('non-overlapping contention still merges and accepts on its own', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-push-base-clean-'))
  const projectsDir = join(root, 'projects')
  const fleetDb = join(root, 'fleet.db')
  const bindingRegistry = join(root, 'source-bindings.json')
  const project = 'paper-push-base-clean'
  const port = await unusedPort()
  const targetDir = join(root, 'target-checkout')

  // A file with two paragraphs far apart, so the two editors do not overlap.
  const TOP = 'Opening paragraph.\n'
  const MIDDLE = '\n\n\n\n\n\n\n\n\n\n'
  const BOTTOM = 'Closing paragraph.\n'
  const BASE = TOP + MIDDLE + BOTTOM
  const PEER_EDIT = BASE.replace(BOTTOM, 'Closing paragraph, revised by the peer.\n')
  const LOCAL = BASE.replace(TOP, 'Opening paragraph, revised by the author.\n')

  let server = null
  let targetWs = null
  let peerWs = null
  let targetSync = null

  try {
    await initProjectStore(projectsDir)
    createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
    await updateProject(project, { pages: 1, buildStatus: 'success' })
    mkdirSync(join(projectsDir, project, 'output'), { recursive: true })
    writeFileSync(join(projectsDir, project, 'output', 'relevant-files.json'), JSON.stringify(['main.tex']))
    await closeProjectStore()

    server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })

    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'main.tex'), BASE)
    const watcher = new EventEmitter()
    watcher.close = () => Promise.resolve()
    const targetSent = []
    targetSync = createSourceSync({
      sourceBindingsFile: join(root, 'target-bindings.json'),
      log: { info() {}, warn() {}, error() {} },
      sendMsg(message) { targetSent.push(message); return true },
      isConnected: () => true,
      resolveEditor: () => null,
      reconcileIntervalMs: 60_000,
      watch() { return watcher },
    })
    const targetBinding = targetSync.bindSource(project, targetDir)

    peerWs = await openDaemon(port, {
      machineId: 'peer-machine-clean',
      sourceBindings: [{ bindingId: 'peer-binding-clean', project }],
    })
    const baseReplies = await deliver(peerWs, {
      type: 'source-change', project, requestId: 'R-base-clean', expectedRevision: null,
      sourceBindingId: 'peer-binding-clean',
      files: [{ path: 'main.tex', content: BASE }],
      deletedFiles: [], sourceManifest: ['main.tex'], editedBy: 'peer',
      __daemon_outbox_id: 'D-base-clean',
    })
    const baseAccepted = baseReplies.find(m => m.type === 'source-change-result')
    assert.equal(baseAccepted?.ok, true, JSON.stringify(baseReplies))
    targetSync.sync([{
      name: project, sourceDir: targetDir, mainFile: 'main.tex', format: 'svg',
      sourceRevision: baseAccepted.sourceRevision, sourceManifest: ['main.tex'],
    }], { authoritativeRevisions: true })
    const seeded = targetSync.applyAcceptedSourceUpdate({
      project, bindingId: targetBinding.bindingId,
      previousRevision: null, sourceRevision: baseAccepted.sourceRevision,
      files: [{ path: 'main.tex', content: BASE }], sourceManifest: ['main.tex'],
      ...materialization(BASE, BASE),
    })
    assert.equal(seeded.ok, true, `the base materialized cleanly: ${JSON.stringify(seeded)}`)

    // The peer revises the closing paragraph.
    const peerReplies = await deliver(peerWs, {
      type: 'source-change', project, requestId: 'R-peer-clean',
      expectedRevision: baseAccepted.sourceRevision,
      sourceBindingId: 'peer-binding-clean',
      files: [{ path: 'main.tex', content: PEER_EDIT }],
      deletedFiles: [], sourceManifest: ['main.tex'], editedBy: 'peer',
      __daemon_outbox_id: 'D-peer-clean',
    })
    assert.equal(peerReplies.find(m => m.type === 'source-change-result')?.ok, true)

    // The author, who has not seen that, revises the opening paragraph.
    writeFileSync(join(targetDir, 'main.tex'), LOCAL)
    watcher.emit('change', join(targetDir, 'main.tex'))
    await new Promise(resolve => setTimeout(resolve, 400))
    const push = targetSent.filter(m => m.type === 'source-change').pop()
    assert.ok(push, `the checkout pushed: ${JSON.stringify(targetSent)}`)

    targetWs = await openDaemon(port, {
      machineId: 'target-machine-clean',
      sourceBindings: [{ bindingId: targetBinding.bindingId, project }],
    })
    const pushReplies = await deliver(targetWs, { ...push, __daemon_outbox_id: 'D-target-clean' })
    const pushResult = pushReplies.find(m => m.type === 'source-change-result')

    const onServer = readFileSync(join(projectsDir, project, 'source', 'main.tex'), 'utf8')
    assert.ok(onServer.includes('revised by the peer'),
      `the peer's paragraph survives (result ${JSON.stringify(pushResult)})`)
    assert.ok(onServer.includes('revised by the author'),
      `the author's paragraph lands in the same accept, with no human asked `
      + `(result ${JSON.stringify(pushResult)})`)
  } finally {
    if (targetSync) await targetSync.closeAll()
    for (const ws of [targetWs, peerWs]) {
      if (!ws) continue
      ws.close()
      await new Promise(resolve => ws.once('close', resolve))
    }
    await stopServer(server)
    await closeProjectStore().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})
