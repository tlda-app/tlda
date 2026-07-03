import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createFileWatcher } from '../bin/lib/file-watch.mjs'

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'tlda-watch-'))
}

function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out waiting for watcher event'))
        return
      }
      setTimeout(tick, 25)
    }
    tick()
  })
}

const quietLog = { info() {}, warn() {} }

test('file watcher reports changes for a watched file', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'session.jsonl')
  writeFileSync(file, '')
  const events = []
  let ready
  const readyPromise = new Promise(resolve => { ready = resolve })
  const watcher = createFileWatcher({
    label: 'jsonl',
    paths: file,
    usePolling: true,
    interval: 50,
    onEvent: (event) => events.push(event),
    onReady: ready,
    log: quietLog,
  })

  try {
    await readyPromise
    writeFileSync(file, '{"type":"message"}\n')
    await waitFor(() => events.some(e => e.event === 'change' && e.absPath === file))
    assert.equal(watcher.isWatching(), true)
  } finally {
    await watcher.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file watcher supports dynamic relative add and unwatch', async () => {
  const dir = tempDir()
  const watched = path.join(dir, 'main.tex')
  const ignored = path.join(dir, 'other.tex')
  writeFileSync(watched, 'a')
  writeFileSync(ignored, 'x')
  const events = []
  let ready
  const readyPromise = new Promise(resolve => { ready = resolve })
  const watcher = createFileWatcher({
    label: 'source files',
    paths: [],
    cwd: dir,
    usePolling: true,
    interval: 50,
    onEvent: (event) => events.push(event),
    onReady: ready,
    log: quietLog,
  })

  try {
    await readyPromise
    watcher.add('main.tex')
    await new Promise(resolve => setTimeout(resolve, 100))
    writeFileSync(ignored, 'y')
    writeFileSync(watched, 'b')
    await waitFor(() => events.some(e => e.relPath === 'main.tex'))
    assert.equal(events.some(e => e.relPath === 'other.tex'), false)

    events.length = 0
    watcher.unwatch('main.tex')
    writeFileSync(watched, 'c')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(events.length, 0)
  } finally {
    await watcher.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
