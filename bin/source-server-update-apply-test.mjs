#!/usr/bin/env node
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceSync } from '../daemon/source-sync.mjs'

function silentWatch() {
  const watcher = new EventEmitter()
  watcher.close = () => Promise.resolve()
  return watcher
}

function makeSourceSync(root, sent = []) {
  return createSourceSync({
    sourceBindingsFile: join(root, 'missing-bindings.json'),
    log: { info() {}, error() {}, warn() {} },
    sendMsg(message) { sent.push(message); return true },
    isConnected: () => true,
    resolveEditor: () => null,
    reconcileIntervalMs: 20,
    watch: silentWatch,
  })
}

const root = mkdtempSync(join(tmpdir(), 'tlda-source-server-update-'))
const main = join(root, 'main.tex')
const sent = []
const sourceSync = makeSourceSync(root, sent)

try {
  writeFileSync(main, 'base\n')
  sourceSync.bindSource('paper', root)
  sourceSync.sync([{ name: 'paper', sourceDir: root, mainFile: 'main.tex', format: 'svg', sourceRevision: 'rev-base' }], { authoritativeRevisions: true })

  const clean = sourceSync.applyAcceptedSourceUpdate({
    project: 'paper',
    previousRevision: 'rev-base',
    sourceRevision: 'rev-browser',
    files: [{ path: 'main.tex', content: 'from browser\n' }],
    sourceManifest: ['main.tex'],
  })
  assert.equal(clean.ok, true)
  assert.deepEqual(clean.applied, ['main.tex'])
  assert.deepEqual(clean.conflicted, [])
  assert.equal(readFileSync(main, 'utf8'), 'from browser\n', 'accepted browser edit writes into linked local checkout')

  writeFileSync(main, 'local concurrent edit\n')
  const conflicted = sourceSync.applyAcceptedSourceUpdate({
    project: 'paper',
    previousRevision: 'rev-browser',
    sourceRevision: 'rev-peer',
    files: [{ path: 'main.tex', content: 'peer edit\n' }],
    sourceManifest: ['main.tex'],
  })
  assert.equal(conflicted.ok, true)
  assert.deepEqual(conflicted.applied, [])
  assert.deepEqual(conflicted.conflicted, ['main.tex'])
  const text = readFileSync(main, 'utf8')
  assert.match(text, /^<<<<<<< local checkout/)
  assert.match(text, /local concurrent edit/)
  assert.match(text, /peer edit/)
  assert.match(text, />>>>>>> accepted server source for paper:main\.tex/)
  assert.equal(sent.filter(message => message.type === 'daemon-warning').length, 0)

  console.log('source server update apply: ok')
} finally {
  await sourceSync.closeAll()
  rmSync(root, { recursive: true, force: true })
}
