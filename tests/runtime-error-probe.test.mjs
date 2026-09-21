import assert from 'node:assert/strict'
import test from 'node:test'

const priorWindow = globalThis.window
globalThis.window = {
  location: { origin: 'https://app.test', search: '' },
  localStorage: { getItem: () => null },
  __TLDA_CONFIG__: {
    name: 'test', database: { http: 'https://app.test', ws: 'wss://app.test' },
    store: { http: 'https://app.test', ws: 'wss://app.test' }, licenseKey: '', pages: 'store',
  },
}
const { hasRuntimeProbeBasePath, loadRuntimeProbePage, runtimeProbeUrls, subscribeRuntimeProbe } = await import('../src/runtimeErrorProbeCore.ts')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function fakeDocument() {
  const frames = []
  return {
    frames,
    body: { appendChild: frame => frames.push(frame) },
    createElement: () => {
      const listeners = new Map()
      return {
        style: {},
        setAttribute() {},
        addEventListener(type, handler) { listeners.set(type, handler) },
        fire(type) { listeners.get(type)?.() },
        remove() { this.removed = true },
      }
    },
  }
}

test.after(() => { globalThis.window = priorWindow })

test('reload signal selects rebuilt HTML pages and carries the existing URL auth', () => {
  const urls = runtimeProbeUrls('/docs/my book/', {
    view: { kind: 'html-pages' },
    pages: [{ file: 'chapters/one page.html' }, { file: 'two.html' }],
  }, { type: 'partial', pages: [1], timestamp: 44 })
  assert.deepEqual(urls, ['/docs/my%20book/two.html?_tldaReload=44'])
  assert.doesNotMatch(urls[0], /_tldaShape=/, 'the hidden load must never alias an on-canvas shape')
})

test('non-page and malformed reload signals load every applicable page rather than inventing page indexes', () => {
  const manifest = { view: { kind: 'slides' }, pages: [{ file: 'deck.html' }, { file: 'notes.html' }] }
  assert.equal(runtimeProbeUrls('/docs/book/', manifest, { pages: 2, timestamp: 44 }).length, 2)
  assert.deepEqual(runtimeProbeUrls('/docs/book/', { ...manifest, view: { kind: 'svg-pages' } }, { timestamp: 44 }), [])
})

test('hidden runtime probe holds through the capability settle window then removes its frame', async () => {
  const doc = fakeDocument()
  const probe = loadRuntimeProbePage('/docs/book/ch1.html', doc, 0, 100)
  assert.equal(doc.frames.length, 1)
  assert.match(doc.frames[0].style.cssText, /left:-1px/, 'the frame is offscreen, not a canvas shape')
  doc.frames[0].fire('load')
  assert.equal(await probe.loaded, true)
  assert.equal(doc.frames[0].removed, true)
})

test('cancelling a hidden runtime probe removes it and never reads as a completed load', async () => {
  const doc = fakeDocument()
  const probe = loadRuntimeProbePage('/docs/book/ch1.html', doc, 10, 100)
  probe.dispose()
  assert.equal(await probe.loaded, false)
  assert.equal(doc.frames[0].removed, true)
})

test('a slow load still receives its complete post-load settle interval', async () => {
  const doc = fakeDocument()
  const probe = loadRuntimeProbePage('/docs/book/ch1.html', doc, 50, 100)
  await wait(80)
  doc.frames[0].fire('load')
  await wait(35)
  assert.equal(doc.frames[0].removed, undefined, 'the pre-load timeout must not remove a loaded frame before its settle window')
  assert.equal(await probe.loaded, true)
  assert.equal(doc.frames[0].removed, true)
})

test('without a connected client, a reload signal performs no eager fetch or page load', () => {
  let listener
  let fetches = 0
  let loads = 0
  const stop = subscribeRuntimeProbe({ basePath: '/docs/book/' }, {
    onReload: callback => { listener = callback; return () => {} },
    isConnected: () => false,
    fetchManifest: async () => { fetches++; return { view: { kind: 'html-pages' }, pages: [] } },
    loadPages: async () => { loads++ },
  })
  listener({ type: 'full', timestamp: 44 })
  stop()
  assert.equal(fetches, 0)
  assert.equal(loads, 0)
})

test('documents without a usable base path do not mount a runtime probe', () => {
  assert.equal(hasRuntimeProbeBasePath({}), false)
  assert.equal(hasRuntimeProbeBasePath({ basePath: '' }), false)
  assert.equal(hasRuntimeProbeBasePath({ basePath: '/docs/book/' }), true)
})
