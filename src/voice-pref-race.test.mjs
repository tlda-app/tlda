// Regression: voice init may run before server-backed prefs finish loading.
// Saved Chrome must still apply without requiring a settings off/on toggle.

import assert from 'node:assert/strict'

global.Event = class Event {
  constructor(type, opts = {}) {
    this.type = type
    this.bubbles = !!opts.bubbles
  }
}
global.requestAnimationFrame = fn => { fn(); return 0 }

class MockSpeechRecognition {
  start() {}
  stop() { this.onend?.() }
  abort() {}
}

global.document = {
  createElement: () => ({ style: {}, appendChild: () => {}, remove: () => {} }),
  body: { appendChild: () => {} },
  addEventListener: () => {},
  querySelectorAll: () => [],
}
global.MutationObserver = class MutationObserver {
  observe() {}
  disconnect() {}
}
global.BroadcastChannel = class BroadcastChannel {
  postMessage() {}
}
global.WebSocket = class WebSocket {
  static OPEN = 1
  constructor() {
    this.readyState = WebSocket.OPEN
    setTimeout(() => this.onopen?.(), 0)
  }
  send() {}
  close() {}
}

global.window = {
  SpeechRecognition: MockSpeechRecognition,
  location: {
    search: '',
    protocol: 'http:',
    hostname: 'localhost',
    host: 'localhost:5173',
    origin: 'http://localhost:5173',
  },
  addEventListener: () => {},
  __TLDA_CONFIG__: {
    name: 'test',
    database: { http: 'http://127.0.0.1:3000', ws: 'ws://127.0.0.1:3000' },
    store: { http: 'http://127.0.0.1:3000', ws: 'ws://127.0.0.1:3000' },
    licenseKey: '',
  },
}
global.location = global.window.location
global.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}
Object.defineProperty(global, 'navigator', {
  value: {
    userAgent: 'Chrome test',
    maxTouchPoints: 0,
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [{ stop: () => {} }],
        getAudioTracks: () => [{ stop: () => {}, onended: null }],
      }),
    },
  },
  configurable: true,
})
global.AudioContext = class AudioContext {
  constructor() {
    this.state = 'running'
    this.audioWorklet = { addModule: async () => {} }
  }
  resume() { return Promise.resolve() }
  close() { return Promise.resolve() }
  createMediaStreamSource() { return { connect: () => {} } }
}
global.AudioWorkletNode = class AudioWorkletNode {
  constructor() { this.port = { onmessage: null } }
  disconnect() {}
}

global.fetch = async url => {
  if (String(url).startsWith('/api/fleet/prefs?')) {
    return {
      ok: true,
      json: async () => ({ 'voice-backend': 'chrome' }),
    }
  }
  return { ok: true, json: async () => ({ ok: true }) }
}

const { initVoice, getBackend } = await import('./voice.mjs')
const { loadPrefs } = await import('./preferences.ts')

const init = initVoice()
await new Promise(r => setTimeout(r, 2100))
await init

assert.equal(getBackend(), 'deepgram')

await loadPrefs('fleet:skip')
await Promise.resolve()

assert.equal(getBackend(), 'chrome')

console.log('✓ late-loaded voice-backend pref switches Chrome on without a settings toggle')
