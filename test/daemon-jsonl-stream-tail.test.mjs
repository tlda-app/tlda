import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import TailFile from '@logdna/tail-file'
import { parser as jsonlParser } from 'stream-json/jsonl/parser.js'

function waitFor(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for predicate'))
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

test('tail-file streams appended JSONL records through stream-json parser from a saved offset', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tlda-jsonl-tail-'))
  const file = path.join(dir, 'session.jsonl')
  const first = JSON.stringify({ type: 'user', message: { content: 'old' } }) + '\n'
  await fs.writeFile(file, first)

  const seen = []
  let lastFlush = 0
  const tail = new TailFile(file, { startPos: Buffer.byteLength(first), pollFileIntervalMs: 20 })
  const parser = jsonlParser.asStream({ ignoreErrors: true })
  parser.on('data', item => seen.push(item.value))
  tail.on('flush', ({ lastReadPosition }) => { lastFlush = lastReadPosition })
  tail.pipe(parser)

  try {
    await tail.start()
    await fs.appendFile(file, JSON.stringify({ type: 'assistant', message: { content: 'new' } }) + '\n')
    await waitFor(() => seen.length === 1 && lastFlush > Buffer.byteLength(first))
    assert.deepEqual(seen, [{ type: 'assistant', message: { content: 'new' } }])
  } finally {
    tail.unpipe(parser)
    parser.destroy()
    await tail.quit().catch(() => {})
    await fs.rm(dir, { recursive: true, force: true })
  }
})
