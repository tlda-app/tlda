#!/usr/bin/env node
//
// **The cutover, at the seam where it actually happens.**
//
// A file changes on disk, the daemon's own watcher path runs, and the change
// must reach the server as a PROPOSED COMMIT over HTTP rather than as file
// contents over the socket.
//
// This is the incident recorded at `daemon/source-sync.mjs`'s `sendSourceChange`
// in one test: the materializer declined to write server-only prose over a file
// its author was editing, the daemon pushed that file under the *server's* head
// anyway, and the server accepted it — three passages of his writing deleted,
// `acceptSeq` up by one, no error anywhere.
//
// The bundle path cannot express that. A commit's parent is a revision this
// checkout HAS, and the server accepts iff it fast-forwards, so a base we do not
// hold is not a claim that can be made. The contents are never sent — the tree
// is — so there is nothing to write over anybody's prose.
//
// Both halves are asserted, because either alone is satisfiable while broken:
//   - the change ARRIVED, as a commit, with the right bytes
//   - and NO `source-change` went over the socket, which is what "instead of"
//     means. A cutover that leaves both paths running is not a cutover.
import assert from 'node:assert/strict'
import express from 'express'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSourceSync } from '../daemon/source-sync.mjs'
import { createSourceProposal } from '../daemon/source-proposal.mjs'
import { createSourcePush } from '../daemon/source-push.mjs'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'

const root = mkdtempSync(join(tmpdir(), 'propose-not-push-'))
const serverGit = join(root, 'server.git')
const checkout = join(root, 'checkout')
spawnSync('git', ['init', '--bare', '--quiet', serverGit])
spawnSync('git', ['init', '-q', '-b', 'main', checkout])
spawnSync('git', ['config', 'user.name', 'the author'], { cwd: checkout })
spawnSync('git', ['config', 'user.email', 'a@example.test'], { cwd: checkout })

const main = join(checkout, 'main.tex')
writeFileSync(main, 'first\n')

const store = createSourceGitStore({ gitDir: serverGit })
const project = 'paper'

const app = express()
app.post('/api/projects/:name/source-bundle', express.raw({ type: () => true, limit: '500mb' }), async (req, res) => {
  const bundlePath = join(root, `in-${Date.now()}.bundle`)
  writeFileSync(bundlePath, req.body)
  const proposed = await store.ingestBundle(project, bundlePath)
  if (!proposed) return res.status(400).json({ ok: false, error: 'empty' })
  const result = await store.fastForward(project, proposed)
  if (!result.ok) return res.status(409).json({ ok: false, status: result.status, currentRevision: result.revision })
  res.json({ ok: true, status: result.status, sourceRevision: result.revision, postAcceptEffects: ['journal'] })
})
const listening = await new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server))
})
const origin = `http://127.0.0.1:${listening.address().port}`

const sent = []
let activeWatcher = null
const silentWatch = () => {
  const watcher = new EventEmitter()
  watcher.close = () => Promise.resolve()
  activeWatcher = watcher
  return watcher
}

const sourceSync = createSourceSync({
  sourceChangeSettleDeadlineMs: 300_000,
  sourceBindingsFile: join(root, 'missing-bindings.json'),
  log: { info() {}, error() {}, warn() {} },
  sendMsg(message) { sent.push(message); return true },
  isConnected: () => true,
  resolveEditor: () => null,
  reconcileIntervalMs: 20,
  watch: silentWatch,
  createSourcePushFor: ({ sourceDir, project: name }) => createSourcePush({
    proposal: createSourceProposal({ sourceDir, project: name }),
    project: name,
    server: origin,
    token: null,
  }),
})

try {
  sourceSync.bindSource(project, checkout)
  sourceSync.sync([{ name: project, sourceDir: checkout, mainFile: 'main.tex', format: 'svg' }])
  writeFileSync(main, 'his revised prose\n')
  activeWatcher.emit('change', main)

  const deadline = Date.now() + 10000
  while (!(await store.head(project)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  const head = await store.head(project)
  assert.ok(head, 'the change reached the server as an accepted commit')
  assert.equal(
    (await store.readRevisionFile(head, 'main.tex')).toString(),
    'his revised prose\n',
    'and it carries the bytes that were on disk',
  )

  // **The other half.** A cutover that leaves the socket path also running is
  // not a cutover, and it would pass every assertion above.
  const overSocket = sent.filter(message => message.type === 'source-change')
  assert.equal(overSocket.length, 0,
    `no source-change went over the socket (saw ${overSocket.length})`)
} finally {
  await sourceSync.stop?.()
  listening.close()
  rmSync(root, { recursive: true, force: true })
}

console.log('a source change that proposes instead of pushing: passed')
process.exit(0)
