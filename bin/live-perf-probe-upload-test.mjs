import assert from 'node:assert/strict'
import test from 'node:test'

function installBrowserGlobals() {
  const listeners = new Map()
  const location = { protocol: 'http:', search: '', href: 'http://example.test/?project=test' }
  globalThis.location = location
  globalThis.window = {
    __TLDA_CONFIG__: {
      name: 'test',
      database: { http: 'http://example.test', ws: 'ws://example.test' },
      store: { http: 'http://example.test', ws: 'ws://example.test' },
      licenseKey: '',
    },
    location,
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type) { listeners.delete(type) },
  }
  globalThis.localStorage = { getItem() { return null } }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      onLine: true,
      sendBeacon: () => false,
      userAgent: 'live-perf-probe-upload-test',
    },
  })
}

installBrowserGlobals()
const { postLivePerf } = await import('../src/livePerfUpload.ts')

function waitForRejectedFetchTurn() {
  return new Promise(resolve => {
    setImmediate(() => setImmediate(resolve))
  })
}

test('postLivePerf contains rejected fallback fetches', async () => {
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    navigator.sendBeacon = () => false
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'))

    postLivePerf({ sample: 'rejecting-fallback' })
    await waitForRejectedFetchTurn()

    assert.equal(unhandled.length, 0, 'fallback fetch rejection escaped as an unhandled rejection')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('postLivePerf preserves successful fallback POST shape', async () => {
  const calls = []
  navigator.sendBeacon = () => false
  globalThis.fetch = async (...args) => {
    calls.push(args)
    return new Response('{"ok":true}', { status: 200 })
  }

  postLivePerf({ sample: 'successful-fallback' })
  await waitForRejectedFetchTurn()

  assert.equal(calls.length, 1)
  const [url, init] = calls[0]
  assert.equal(url, '/api/log')
  assert.equal(init.method, 'POST')
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json' })
  assert.equal(init.keepalive, true)

  const body = JSON.parse(init.body)
  assert.equal(body.level, 'info')
  assert.equal(body.ns, 'live-perf')
  assert.equal(body.msg, 'live perf sample')
  assert.deepEqual(body.data, { sample: 'successful-fallback' })
  assert.match(body.ts, /^\d{4}-\d{2}-\d{2}T/)
})
