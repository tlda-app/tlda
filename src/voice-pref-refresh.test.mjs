// voice-pref-refresh.test.mjs — startup preference race regression.
// Run with: node --import tsx src/voice-pref-refresh.test.mjs

import assert from 'node:assert/strict'

const timers = []
let tid = 0
let clock = 0
global.setTimeout = (fn, ms = 0) => {
  const id = ++tid
  timers.push({ id, fn, fireAt: clock + ms })
  return id
}
global.clearTimeout = id => {
  const i = timers.findIndex(t => t.id === id)
  if (i !== -1) timers.splice(i, 1)
}
function tick(ms) {
  clock += ms
  const ready = timers.filter(t => t.fireAt <= clock).sort((a, b) => a.fireAt - b.fireAt)
  for (const t of ready) {
    const i = timers.findIndex(x => x.id === t.id)
    if (i !== -1) {
      timers.splice(i, 1)
      t.fn()
    }
  }
}

global.setInterval = () => 0
global.clearInterval = () => {}
global.requestAnimationFrame = fn => { fn(); return 0 }

global.Event = class Event {
  constructor(type, opts = {}) {
    this.type = type
    this.bubbles = !!opts.bubbles
    this.cancelable = !!opts.cancelable
    this.defaultPrevented = false
  }
  preventDefault() { this.defaultPrevented = true }
  stopImmediatePropagation() {}
}

class MockSpeechRecognition {
  start() {}
  stop() {}
  abort() {}
}

const mockDiv = { textContent: '', style: {}, id: '', appendChild: () => {}, remove: () => {} }
global.document = {
  createElement: () => mockDiv,
  body: { appendChild: () => {} },
  addEventListener: () => {},
  querySelectorAll: () => [],
}
global.MutationObserver = class MutationObserver {
  observe() {}
  disconnect() {}
}
global.BroadcastChannel = class BroadcastChannel { postMessage() {} }
global.WebSocket = class WebSocket {
  static OPEN = 1
  constructor() {
    this.readyState = WebSocket.OPEN
    setTimeout(() => this.onopen?.(), 0)
  }
  send() {}
  close() { this.readyState = 3; this.onclose?.() }
}

const fetchCalls = []
global.fetch = async (url) => {
  fetchCalls.push(String(url))
  if (String(url).startsWith('/api/fleet/prefs?')) {
    return { ok: true, json: async () => ({ 'voice-backend': 'chrome' }) }
  }
  if (String(url) === '/api/fleet/prefs/voice-backend') {
    return { ok: true, json: async () => ({ ok: true }) }
  }
  if (String(url) === '/api/voice/whisper/start') {
    return { ok: true, json: async () => ({ ok: true }) }
  }
  throw new Error(`unexpected fetch: ${url}`)
}
global.AbortSignal = { timeout: () => ({}) }

global.window = {
  SpeechRecognition: MockSpeechRecognition,
  location: { search: '', protocol: 'http:', hostname: 'localhost', host: 'localhost:5173', origin: 'http://localhost:5173' },
  addEventListener: () => {},
  __TLDA_CONFIG__: {
    name: 'test',
    database: { http: 'http://127.0.0.1:3000', ws: 'ws://127.0.0.1:3000' },
    store: { http: 'http://127.0.0.1:3000', ws: 'ws://127.0.0.1:3000' },
    licenseKey: '',
  },
}
global.location = global.window.location
Object.defineProperty(global, 'navigator', {
  value: { userAgent: 'Chrome test', maxTouchPoints: 0 },
  configurable: true,
})
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const { initVoice, getBackend } = await import('./voice.mjs')
const { loadPrefs, setPref } = await import('./preferences.ts')

const init = initVoice()
await Promise.resolve()
tick(2000)
assert.equal(await init, false, 'voice should stay off when prefs have not loaded')
assert.equal(getBackend(), 'none')
assert.ok(!fetchCalls.some(u => u.includes('/api/voice/deepgram-sdk/start')), 'default startup must not start Deepgram')

await loadPrefs('fleet:voice-test')
assert.equal(getBackend(), 'chrome', 'late-loaded saved Chrome pref should apply without a settings toggle')
assert.ok(!fetchCalls.some(u => u.includes('/api/voice/deepgram-sdk/start')), 'loading saved Chrome pref must not start Deepgram')

setPref('voice-backend', 'whisper')
await Promise.resolve()
assert.equal(getBackend(), 'whisper-stream', 'late non-Deepgram pref changes should start Whisper without a settings toggle')
assert.ok(fetchCalls.some(u => u === '/api/voice/whisper/start'), 'Whisper should lazy-start when selected after init')
assert.ok(!fetchCalls.some(u => u.includes('/api/voice/deepgram-sdk/start')), 'selecting Whisper must not start Deepgram')

console.log('✓ voice startup applies late saved backend preference without Deepgram default')
