import assert from 'node:assert/strict'
import test from 'node:test'

import { formatServerStatus, resolveServerStatus } from '../cli/tlda.mjs'

function okHealth(body) {
  return async () => ({
    ok: true,
    json: async () => body,
  })
}

async function failingFetch() {
  throw new Error('timeout')
}

test('remote healthy status names remote URL and labels returned pid as remote/container', async () => {
  const serverUrl = 'https://tlda.example.test'
  let lsofCalled = false
  const status = await resolveServerStatus({
    serverUrl,
    fetchImpl: okHealth({ uptime: 12.9, pid: 4242 }),
    execSyncImpl: () => {
      lsofCalled = true
      return ''
    },
  })

  assert.equal(lsofCalled, false)
  assert.deepEqual(status, {
    status: 'running',
    serverUrl,
    local: false,
    uptime: 12,
    pid: 4242,
  })
  assert.match(formatServerStatus(status), /Server running at https:\/\/tlda\.example\.test/)
  assert.match(formatServerStatus(status), /remote\/container pid 4242/)
  assert.doesNotMatch(formatServerStatus(status), /\(uptime: 12s, pid 4242\)/)
})

test('remote timeout reports the resolved URL not responding and does not inspect local ports', async () => {
  const serverUrl = 'https://tlda.example.test'
  const status = await resolveServerStatus({
    serverUrl,
    fetchImpl: failingFetch,
    execSyncImpl: () => {
      throw new Error('lsof must not run for remote status')
    },
  })

  assert.deepEqual(status, { status: 'not-responding', serverUrl, local: false })
  assert.equal(formatServerStatus(status), 'Server not responding at https://tlda.example.test.')
})

test('local healthy status names local URL and keeps local pid wording', async () => {
  const serverUrl = 'http://127.0.0.1:5176'
  const status = await resolveServerStatus({
    serverUrl,
    fetchImpl: okHealth({ uptime: 45.1, pid: 5151 }),
  })

  assert.deepEqual(status, {
    status: 'running',
    serverUrl,
    local: true,
    uptime: 45,
    pid: 5151,
  })
  assert.equal(formatServerStatus(status), 'Server running at http://127.0.0.1:5176 (uptime: 45s, pid 5151)')
})

test('local timeout with no listener reports not running at resolved URL', async () => {
  const serverUrl = 'http://localhost:5176'
  const status = await resolveServerStatus({
    serverUrl,
    port: '5176',
    fetchImpl: failingFetch,
    execSyncImpl: () => {
      throw new Error('no listener')
    },
  })

  assert.deepEqual(status, { status: 'not-running', serverUrl, local: true })
  assert.equal(formatServerStatus(status), 'Server not running at http://localhost:5176.')
})

test('local timeout with listener reports busy local process using first pid', async () => {
  const serverUrl = 'http://localhost:5176'
  const status = await resolveServerStatus({
    serverUrl,
    port: '5176',
    fetchImpl: failingFetch,
    execSyncImpl: () => '5151\n5152',
  })

  assert.deepEqual(status, {
    status: 'local-listener-not-responding',
    serverUrl,
    local: true,
    pid: '5151',
  })
  assert.equal(
    formatServerStatus(status),
    'Server running at http://localhost:5176 but not responding (event loop busy, pid 5151)',
  )
})
