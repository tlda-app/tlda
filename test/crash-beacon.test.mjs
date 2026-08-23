// The handler has to fire, and the beacon has to leave with something worth
// reading. A handler nobody has watched fire is the thing this whole day was
// about, so this dispatches real events at the real listeners and reads what
// `sendBeacon` was handed.
//
// What this DOES cover: that importing the module installs the listeners (the
// import-time install is what ships — see the hoisting note in the module), that
// both event kinds produce a beacon, the payload shape, the subresource
// exclusion, and the length cap.
//
// What it does NOT cover, stated rather than implied: that a real browser fires
// these events for a genuine uncaught throw, and that `sendBeacon` survives the
// document being torn down. Those are browser guarantees, not ours, and they are
// exercised separately.
import test from 'node:test'
import assert from 'node:assert/strict'

// A window with just enough surface for the module, built before the import so
// the module's own import-time `installCrashBeacon()` is the thing under test
// rather than a call this file makes.
const listeners = new Map()
const beacons = []

globalThis.window = {
  addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, [])
    listeners.get(type).push(handler)
  },
}
globalThis.location = { href: 'https://tlda.example/doc/thing?panel=1' }
globalThis.Blob = class Blob {
  constructor(parts) { this.text = parts.join('') }
}
// Node 26 defines `navigator` as a getter-only global, so it is redefined
// rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    sendBeacon(url, blob) {
      beacons.push({ url, payload: JSON.parse(blob.text) })
      return true
    },
  },
})

const { setCrashSessionId } = await import('../src/crashBeacon.ts')

const fire = (type, event) => {
  const handlers = listeners.get(type) || []
  assert.ok(handlers.length, `no ${type} listener was installed`)
  for (const handler of handlers) handler(event)
}

test('importing the module installs both global handlers', () => {
  assert.equal((listeners.get('error') || []).length, 1)
  assert.equal((listeners.get('unhandledrejection') || []).length, 1)
})

test('a thrown error leaves a beacon with message, stack and where', () => {
  beacons.length = 0
  const err = new Error('boom from a timeout')
  fire('error', {
    target: globalThis.window,
    message: 'Uncaught Error: boom from a timeout',
    error: err,
    filename: 'https://tlda.example/assets/index-abc.js',
    lineno: 42,
    colno: 7,
  })

  assert.equal(beacons.length, 1, 'the handler must beacon')
  const { url, payload } = beacons[0]
  assert.equal(url, '/api/log', 'reuses the existing sink; no new endpoint')
  assert.equal(payload.ns, 'client-crash')
  assert.equal(payload.level, 'error')
  assert.equal(payload.msg, 'Uncaught Error: boom from a timeout')
  assert.equal(payload.data.kind, 'error')
  assert.match(payload.data.stack, /boom from a timeout/)
  assert.equal(payload.data.source, 'https://tlda.example/assets/index-abc.js')
  assert.equal(payload.data.line, 42)
  assert.equal(payload.data.column, 7)
  assert.equal(payload.data.url, 'https://tlda.example/doc/thing?panel=1')
  assert.equal(payload.session, undefined, 'no session until logger has pushed one — absent, never invented')
})

// The session id is pushed in by `logger.ts`, not imported out of it, so that
// the beacon depends on nothing. Before the push the field is simply missing:
// that is the honest state for a page that died before the logger loaded, and
// it is preferable to a second id space that joins to nothing.
test('the session id is stamped once logger hands it over, and not before', () => {
  setCrashSessionId('abc12345')
  beacons.length = 0
  fire('error', { target: globalThis.window, message: 'after the push' })
  assert.equal(beacons[0].payload.session, 'abc12345')
})

test('a rejected promise leaves a beacon', () => {
  beacons.length = 0
  fire('unhandledrejection', { reason: new Error('boom from a rejection') })

  assert.equal(beacons.length, 1)
  const { payload } = beacons[0]
  assert.equal(payload.data.kind, 'unhandledrejection')
  assert.equal(payload.msg, 'boom from a rejection')
  assert.match(payload.data.stack, /boom from a rejection/)
})

// A rejection can carry anything. Reporting `[object Object]` for every one of
// them would make the beacon useless exactly when the reason is not an Error.
test('a rejection that is not an Error still says something', () => {
  beacons.length = 0
  fire('unhandledrejection', { reason: 'plain string reason' })
  assert.equal(beacons[0].payload.msg, 'plain string reason')

  beacons.length = 0
  fire('unhandledrejection', { reason: 404 })
  assert.equal(beacons[0].payload.msg, '404')
})

// `error` also fires for failed images and scripts, where the target is the
// element. Folding those in would bury the page-killing exception under 404s.
test('a failed subresource is not a crash', () => {
  beacons.length = 0
  fire('error', { target: { tagName: 'IMG' }, message: 'Failed to load resource' })
  assert.equal(beacons.length, 0, 'a subresource error must not beacon')
})

// The cap is what stops a runaway message carrying a document's worth of
// anything off the page, and keeps the beacon under the browser's own limit.
test('a huge message is clipped, and says it was', () => {
  beacons.length = 0
  fire('error', { target: globalThis.window, message: 'x'.repeat(50_000) })
  const msg = beacons[0].payload.msg
  assert.ok(msg.length < 2200, `expected a clipped message, got ${msg.length} chars`)
  assert.match(msg, /…\[\+48000\]$/, 'and it must say how much it dropped: 50000 - 2000')
})

// Reporting a crash must not raise one — that would turn a recoverable page into
// a dead one, from the code that exists to observe the death.
test('a beacon that throws does not escape the handler', () => {
  const original = globalThis.navigator.sendBeacon
  globalThis.navigator.sendBeacon = () => { throw new Error('beacon exploded') }
  globalThis.fetch = () => { throw new Error('fetch exploded too') }
  try {
    assert.doesNotThrow(() => fire('error', { target: globalThis.window, message: 'boom' }))
    assert.doesNotThrow(() => fire('unhandledrejection', { reason: new Error('boom') }))
  } finally {
    globalThis.navigator.sendBeacon = original
  }
})
