#!/usr/bin/env node

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceSync } from '../daemon/source-sync.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-source-rejection-'))
const main = join(root, 'main.tex')
writeFileSync(main, 'first\n')

const sent = []
let activeWatcher = null
const silentWatch = () => {
  const watcher = new EventEmitter()
  watcher.close = () => Promise.resolve()
  activeWatcher = watcher
  return watcher
}

const sourceSync = createSourceSync({
  sourceBindingsFile: join(root, 'missing-bindings.json'),
  log: { info() {}, error() {}, warn() {} },
  sendMsg(message) { sent.push(message); return true },
  isConnected: () => true,
  resolveEditor: () => null,
  reconcileIntervalMs: 20,
  watch: silentWatch,
})

try {
  sourceSync.bindSource('paper', root)
  sourceSync.sync([{ name: 'paper', sourceDir: root, mainFile: 'main.tex', format: 'svg' }])
  writeFileSync(main, 'changed\n')
  activeWatcher.emit('change', main)

  const deadline = Date.now() + 5000
  while (!sent.some(message => message.type === 'source-change') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const push = sent.find(message => message.type === 'source-change')
  assert.ok(push, 'local change push goes out')

  sourceSync.handleSourceChangeResult({
    type: 'source-change-result',
    requestId: push.requestId,
    project: 'paper',
    ok: false,
    httpStatus: 400,
    status: 'error',
    error: 'pushed file is not an authored source path: _quarto_book.yml',
  })

  const warning = sent.find(message => message.type === 'daemon-warning' && message.warning === 'source-change-rejected')
  assert.ok(warning, 'non-conflict source rejection is sent as a daemon warning')
  assert.equal(warning.severity, 'critical')
  assert.equal(warning.project, 'paper')
  assert.equal(warning.httpStatus, 400)
  assert.match(warning.message, /pushed file is not an authored source path/)

  console.log('source change rejection delivery: ok')
} finally {
  await sourceSync.closeAll()
  rmSync(root, { recursive: true, force: true })
}
