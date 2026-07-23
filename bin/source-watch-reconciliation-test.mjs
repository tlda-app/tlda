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

const sent = []
const warnings = []
const silentWatch = () => {
  const watcher = new EventEmitter()
  watcher.close = () => Promise.resolve()
  return watcher
}
const sourceSync = createSourceSync({
  sourceBindingsFile: join(root, 'missing-bindings.json'),
  log: { info() {}, error() {}, warn(message) { warnings.push(message) } },
  sendMsg(message) { sent.push(message); return true },
  isConnected: () => true,
  resolveEditor: () => null,
  reconcileIntervalMs: 20,
  watch: silentWatch,
})

try {
  sourceSync.sync([{ name: 'paper', sourceDir: root, mainFile: 'main.tex', format: 'svg', sourceManifest: ['legacy-preserved.tex'] }])
  assert.equal(sent.length, 1, 'connect push establishes the initial source version')
  assert.deepEqual(sent[0].sourceManifest, ['legacy-preserved.tex', 'main.tex'], 'connect push preserves inherited authored ownership')

  writeFileSync(main, 'second')
  await new Promise(resolve => setTimeout(resolve, 350))

  assert.equal(sent.length, 2, 'reconciliation recovers a source change missed by the watcher')
  assert.equal(sent[1].files[0].content, 'second')
  assert.deepEqual(sent[1].sourceManifest, ['legacy-preserved.tex', 'main.tex'], 'reconciliation does not imply deletion of inherited authored files')
  assert.match(warnings.join('\n'), /missed watcher edge.*paper: main\.tex/)
  console.log('source watch reconciliation: ok')
} finally {
  sourceSync.closeAll()
  rmSync(root, { recursive: true, force: true })
}
