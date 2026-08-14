import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { createClientLogHandler } from '../server/lib/client-log-sink.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await wait(25)
  }
  assert.fail('condition was not reached before timeout')
}

test('offline client batch crosses /api/log once after reconnect and a lost acknowledgement', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tlda-client-log-'))
  const clientLogFile = path.join(dir, 'client.log')
  const app = express()
  app.use(express.json())
  app.post('/api/log', createClientLogHandler({ clientLogFile }))
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const nativeFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const originalNavigator = globalThis.navigator
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let online = false
  let attempts = 0
  const bodies = []

  const testWindow = new EventTarget()
  testWindow.location = { search: '' }
  testWindow.localStorage = { getItem: () => null }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: testWindow })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: testWindow.localStorage })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { get onLine() { return online } },
  })
  globalThis.fetch = async (url, init) => {
    attempts += 1
    bodies.push(JSON.parse(init.body))
    const response = await nativeFetch(base + url, init)
    if (attempts === 1) throw new TypeError('connection dropped after server append')
    return response
  }

  t.after(async () => {
    globalThis.fetch = nativeFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator })
    if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
    else delete globalThis.localStorage
    await new Promise(resolve => server.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  })

  const { log } = await import(`../src/logger.ts?reconnect=${Date.now()}`)
  log.metric('network-proof', 'recorded while offline', { interval: 'offline' })
  await wait(350)
  assert.equal(attempts, 0, 'offline flush must retain the batch without attempting transport')

  online = true
  window.dispatchEvent(new Event('online'))
  await waitFor(() => attempts >= 2)

  assert.equal(bodies[0].deliveryId, bodies[1].deliveryId, 'a retry must retain the batch identity')
  assert.deepEqual(bodies[0].entries, bodies[1].entries, 'a retry must retain the batch contents')
  const lines = (await fs.readFile(clientLogFile, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(lines.length, 1, 'a lost acknowledgement must not duplicate the logical record')
  assert.equal(lines[0].msg, 'recorded while offline')
})
