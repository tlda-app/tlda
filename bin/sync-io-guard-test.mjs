#!/usr/bin/env node
// Proves the sync-IO guard still catches what it exists to catch.
//
// Same reasoning as bin/await-fleet-store-guard.mjs: a guard that silently
// stops firing looks exactly like a codebase with no violations, and that
// failure removes protection from every site at once. So the guard gets a
// guard, and it asserts both directions — the shape we forbid throws, and the
// shapes we deliberately allow do not. A check that fires on correct code gets
// switched off, and then it catches nothing.
//
// The forbidden shape is the one measured on 2026-08-17: a full synchronous
// read of a growing file, on the main thread, reached from a request handler.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installSyncIoGuard, whileServing, currentlyServing } from '../server/lib/sync-io-guard.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tlda-sync-io-guard-'))
const file = join(dir, 'log.jsonl')
writeFileSync(file, '{"a":1}\n')

let failures = 0
// Awaits, deliberately: two of these cases are async, and a `check` that only
// calls fn() would report them green while their assertions rejected into an
// unhandled promise. That is the shape of a test that cannot fail.
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (e) {
    failures++
    console.error(`  FAIL ${label}: ${e.message}`)
  }
}

// Before install: nothing is guarded, including inside a handler. The guard
// must be opt-in, or importing it would change production behaviour.
await check('inert until installed', () => {
  whileServing('GET /before-install', () => { fs.readFileSync(file, 'utf8') })
})

const restore = installSyncIoGuard()

await check('THROWS on a sync read inside a handler', () => {
  assert.throws(
    () => whileServing('GET /api/projects/x/source-activity', () => fs.readFileSync(file, 'utf8')),
    e => e.code === 'ERR_TLDA_SYNC_IO_WHILE_SERVING' && /source-activity/.test(e.message),
    'a sync read on a request path must throw and name the request',
  )
})

await check('THROWS through intermediate call frames, not just direct calls', () => {
  const deep = () => fs.readFileSync(file, 'utf8')
  const middle = () => deep()
  assert.throws(
    () => whileServing('WS daemon-ws activity', middle),
    e => e.code === 'ERR_TLDA_SYNC_IO_WHILE_SERVING',
    'the real cases are several frames below the handler',
  )
})

await check('THROWS across an await, where the async context still belongs to the request', async () => {
  await whileServing('GET /api/projects/x/files', async () => {
    await Promise.resolve()
    assert.throws(() => fs.readFileSync(file, 'utf8'), e => e.code === 'ERR_TLDA_SYNC_IO_WHILE_SERVING')
  })
})

await check('THROWS on sync writes too, not only reads', () => {
  assert.throws(
    () => whileServing('POST /api/projects/x/push', () => fs.writeFileSync(join(dir, 'out'), 'x')),
    e => e.code === 'ERR_TLDA_SYNC_IO_WHILE_SERVING',
  )
})

// The allowed shapes. Each of these is real: startup reads config, the forked
// build worker is not in a request, and async IO is the whole point.
await check('ALLOWS sync IO outside any handler (startup, CLI, forked worker)', () => {
  assert.equal(currentlyServing(), null)
  fs.readFileSync(file, 'utf8')
})

await check('ALLOWS async IO inside a handler', async () => {
  await whileServing('GET /api/projects/x', async () => {
    await fs.promises.readFile(file, 'utf8')
  })
})

await check('ALLOWS sync IO after the handler has returned', () => {
  whileServing('GET /api/projects/x', () => {})
  fs.readFileSync(file, 'utf8')
})

// existsSync is deliberately not guarded: it reads no file body, it is how you
// avoid reading one, and banning it pushes people toward async-ifying a check
// that costs nothing.
await check('ALLOWS existsSync inside a handler (metadata only, deliberate)', () => {
  whileServing('GET /api/projects/x', () => { fs.existsSync(file) })
})

// The wire, not the two ends. `whileServing` working and the guard working
// proves neither is connected to express -- and the middleware is the only
// reason any of this fires against real traffic. So drive a real request
// through a real express app.
await check('WIRE: a real express request reaches the guard through the middleware', async () => {
  const express = (await import('express')).default
  const { syncIoGuardMiddleware } = await import('../server/lib/sync-io-guard.mjs')
  const app = express()
  app.use(syncIoGuardMiddleware)
  let caught = null
  app.get('/reads-a-file', (req, res) => {
    try {
      fs.readFileSync(file, 'utf8')
      res.json({ threw: false })
    } catch (e) {
      caught = e
      res.status(500).json({ threw: true, code: e.code })
    }
  })
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s))
  })
  try {
    const port = server.address().port
    const body = await (await fetch(`http://127.0.0.1:${port}/reads-a-file`)).json()
    assert.equal(body.threw, true, 'a sync read inside a real express handler must throw')
    assert.equal(caught?.code, 'ERR_TLDA_SYNC_IO_WHILE_SERVING')
    assert.match(caught.message, /GET \/reads-a-file/, 'the error must name the request')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

restore()

await check('restores the originals on teardown', () => {
  whileServing('GET /after-restore', () => { fs.readFileSync(file, 'utf8') })
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? 'PASS sync-io guard' : `FAIL sync-io guard (${failures})`)
process.exit(failures === 0 ? 0 : 1)
