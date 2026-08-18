#!/usr/bin/env node
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceSync } from '../daemon/source-sync.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-source-reconcile-'))
const main = join(root, 'main.tex')
writeFileSync(main, 'first')
writeFileSync(join(root, 'legacy-preserved.tex'), 'surviving server bytes')

// A daemon watches what this machine has linked, not what the server says a
// project's directory is — fbf78c647 removed the `|| p.sourceDir` fallback when
// it made linking explicit. So the binding is the setup, not a detail.
const bindingsFile = join(root, 'source-bindings.json')
writeFileSync(bindingsFile, JSON.stringify({ paper: root }))

const sent = []
const warnings = []
const silentWatch = () => {
  const watcher = new EventEmitter()
  watcher.close = () => Promise.resolve()
  return watcher
}
const sourceSync = createSourceSync({
  sourceChangeSettleDeadlineMs: 300_000,
  sourceBindingsFile: bindingsFile,
  log: { info() {}, error() {}, warn(message) { warnings.push(message) } },
  sendMsg(message) { sent.push(message); return true },
  isConnected: () => true,
  resolveEditor: () => null,
  reconcileIntervalMs: 20,
  watch: silentWatch,
})

try {
  sourceSync.sync([{ name: 'paper', sourceDir: root, mainFile: 'main.tex', format: 'svg', sourceManifest: ['legacy-preserved.tex'] }])
  assert.equal(sent.length, 0, 'connecting sends nobody the whole project again')

  writeFileSync(main, 'second')
  await new Promise(resolve => setTimeout(resolve, 350))

  assert.equal(sent.length, 1, 'reconciliation recovers a source change missed by the watcher')
  assert.equal(sent[0].files[0].content, 'second')
  assert.deepEqual(sent[0].sourceManifest, ['legacy-preserved.tex', 'main.tex'], 'reconciliation does not imply deletion of inherited authored files')
  assert.match(warnings.join('\n'), /missed watcher edge.*paper: main\.tex/)
  console.log('source watch reconciliation: ok')
} finally {
  sourceSync.closeAll()
  rmSync(root, { recursive: true, force: true })
}
