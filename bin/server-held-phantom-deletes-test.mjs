#!/usr/bin/env node
// A file the SERVER still holds and the disk no longer has must be deleted on
// the server. Until this landed it could not be, and the consequence was total:
// every push for that project was refused, forever, with
// `sourceManifest contains nonexistent authored file`.
//
// Why nothing else in the daemon reached it. `onFileChange` maintains
// `authorityManifest`, but it only ever runs for a path the watcher reports, and
// the watcher reports paths in the watch set. A file deleted before the daemon
// started, or a dotfile that was never watched, is never reported at all — so
// the entry is never removed and `collectSourceManifest` re-declares it on every
// push. It re-declares it *deliberately*: an authority entry is exempt from the
// existence check, because undeclaring a file the server still holds is the same
// wedge pointing the other way (`missing surviving authored file`).
//
// So the exemption is right and the wedge is real, which is why the fix is a
// deletion rather than a filter: say the file is gone, in the same push that
// stops declaring it.
//
// `.bak-before-deletion.tex` did this to bregman from 2026-08-07. Skip's source
// pushes were still being refused eleven days later.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceSync } from '../daemon/source-sync.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-phantom-'))
writeFileSync(join(root, 'main.tex'), 'real')

const sourceBindingsFile = join(root, 'bindings.json')
writeFileSync(sourceBindingsFile, JSON.stringify({
  paper: { bindingId: 'binding-paper', project: 'paper', sourceDir: root },
}))

const sent = []
const sourceSync = createSourceSync({
  sourceChangeSettleDeadlineMs: 300_000,
  sourceBindingsFile,
  log: { info() {}, error() {}, warn() {} },
  sendMsg(message) { sent.push(message); return true },
  isConnected: () => true,
  resolveEditor: () => null,
  reconcileIntervalMs: 100000,
  watch: () => { const w = new EventEmitter(); w.close = () => Promise.resolve(); return w },
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
const sourceChanges = () => sent.filter(m => m.type === 'source-change')

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`) }
  catch (e) { failures++; console.error(`  FAIL ${label}: ${e.message}`) }
}

try {
  // The server declares 2 files. Only one is on disk. `.bak-before-deletion.tex`
  // is the phantom, and it is a dotfile precisely as bregman's was, so it is not
  // in any watch set and no file event will ever mention it.
  sourceSync.sync([{
    name: 'paper',
    sourceDir: root,
    mainFile: 'main.tex',
    format: 'svg',
    sourceManifest: ['main.tex', '.bak-before-deletion.tex'],
  }])

  await sleep(400)

  check('the daemon pushes at all — with no push there is nothing to assert', () => {
    assert.ok(sourceChanges().length > 0, 'expected a source-change; the daemon never spoke')
  })

  const push = sourceChanges()[sourceChanges().length - 1]

  check('the vanished file is DELETED on the server, not merely forgotten locally', () => {
    assert.ok(push.deletedFiles?.includes('.bak-before-deletion.tex'),
      `deletedFiles was ${JSON.stringify(push.deletedFiles)}`)
  })

  check('and the same push stops declaring it — the pair is what the server accepts', () => {
    assert.ok(!push.sourceManifest.includes('.bak-before-deletion.tex'),
      'a path in deletedFiles AND sourceManifest is refused whole; that is the wedge')
  })

  check('the file that DOES exist is still declared — undeclaring it is the mirror wedge', () => {
    assert.ok(push.sourceManifest.includes('main.tex'),
      `sourceManifest was ${JSON.stringify(push.sourceManifest)}`)
  })

  check('and it is not deleted', () => {
    assert.ok(!(push.deletedFiles || []).includes('main.tex'))
  })

  // The counterfactual for the whole fix: with nothing missing, this must be
  // silent. A daemon that pushes a deletion every time it binds would be a much
  // worse bug than the one being fixed.
  const before = sourceChanges().length
  sourceSync.sync([{
    name: 'paper', sourceDir: root, mainFile: 'main.tex', format: 'svg',
    sourceManifest: ['main.tex'],
  }])
  await sleep(400)

  check('a manifest that matches disk produces NO deletion push', () => {
    const after = sourceChanges().slice(before)
    const deletions = after.filter(m => (m.deletedFiles || []).length > 0)
    assert.equal(deletions.length, 0,
      `expected silence, got ${JSON.stringify(deletions.map(d => d.deletedFiles))}`)
  })
} finally {
  sourceSync.stop?.()
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'PASS server-held phantom deletes' : `FAIL server-held phantom deletes (${failures})`)
process.exit(failures === 0 ? 0 : 1)
