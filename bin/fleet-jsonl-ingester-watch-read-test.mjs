import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { appendFileSync, createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WatchReadTailFile } from './fleet-jsonl-ingester.mjs'

function onceEvent(emitter, event) {
  return new Promise(resolve => emitter.once(event, resolve))
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function settles(promise, ms, label) {
  let timer
  try {
    await Promise.race([
      promise.then(() => 'settled', () => 'settled'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('watch-read JSONL tail stats once at idle and reads only after chokidar events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-watch-read-tail-'))
  const jsonlPath = join(dir, 'rollout-watch-read.jsonl')
  writeFileSync(jsonlPath, '')
  const watcher = new EventEmitter()
  watcher.close = async () => {}
  let statCalls = 0
  let watchOptions = null
  const chunks = []
  const tail = new WatchReadTailFile(jsonlPath, {
    watch(path, options) {
      assert.equal(path, jsonlPath)
      watchOptions = options
      return watcher
    },
    stat: async path => {
      assert.equal(path, jsonlPath)
      statCalls += 1
      return statSync(path)
    },
    readStream: (path, options) => createReadStream(path, options),
  })
  tail.on('data', chunk => chunks.push(chunk.toString('utf8')))
  try {
    const initialFlush = onceEvent(tail, 'flush')
    await tail.start()
    await initialFlush
    assert.equal(statCalls, 1)
    assert.equal(watchOptions.usePolling, false)
    assert.equal(watchOptions.awaitWriteFinish, false)

    await wait(75)
    assert.equal(statCalls, 1)

    appendFileSync(jsonlPath, '{"type":"assistant","message":{"content":"heard"}}\n')
    const changeFlush = onceEvent(tail, 'flush')
    watcher.emit('change', jsonlPath)
    const flushed = await changeFlush
    assert.equal(flushed.lastReadPosition, statSync(jsonlPath).size)
    assert.equal(chunks.join(''), '{"type":"assistant","message":{"content":"heard"}}\n')
    assert.equal(statCalls, 2)

    await wait(75)
    assert.equal(statCalls, 2)
  } finally {
    await tail.quit()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tail quit while stat is in flight writes nothing after end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-watch-read-quit-stat-'))
  const jsonlPath = join(dir, 'rollout-quit-stat.jsonl')
  writeFileSync(jsonlPath, '{"type":"assistant","message":{"content":"before"}}\n')
  const watcher = new EventEmitter()
  watcher.close = async () => {}
  const errors = []
  const tail = new WatchReadTailFile(jsonlPath, {
    startPos: 0,
    watch: () => watcher,
    stat: async path => {
      await wait(150)
      return statSync(path)
    },
    readStream: (path, options) => createReadStream(path, options),
  })
  tail.on('data', () => {})
  tail.on('error', e => errors.push(e))
  try {
    const started = tail.start()
    await wait(20)
    await tail.quit()
    await settles(started, 5000, 'start() after quit during stat')
    await wait(100)
    assert.equal(errors.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tail quit while blocked on backpressure settles without writing after end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-watch-read-quit-drain-'))
  const jsonlPath = join(dir, 'rollout-quit-drain.jsonl')
  writeFileSync(jsonlPath, `{"type":"assistant","message":{"content":"${'p'.repeat(200000)}"}}\n`)
  const watcher = new EventEmitter()
  watcher.close = async () => {}
  const errors = []
  const tail = new WatchReadTailFile(jsonlPath, {
    startPos: 0,
    watch: () => watcher,
    stat: async path => statSync(path),
    readStream: (path, options) => createReadStream(path, options),
  })
  // No data listener and never resumed: the PassThrough buffers until
  // backpressure, so the read loop parks in its drain wait.
  tail.on('error', e => errors.push(e))
  try {
    const started = tail.start()
    await wait(100)
    await tail.quit()
    await settles(started, 5000, 'start() after quit during drain wait')
    await wait(100)
    assert.equal(errors.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
