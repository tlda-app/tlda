import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

function installBrowserGlobals() {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://example.test/?pw=1',
    pretendToBeVisual: true,
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  dom.window.__TLDA_CONFIG__ = {
    name: 'voice-replay-grown-test',
    database: { http: 'https://example.test', ws: 'wss://example.test' },
    store: { http: 'https://example.test', ws: 'wss://example.test' },
    licenseKey: '',
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 Chrome/125 Safari/537.36',
      maxTouchPoints: 0,
      sendBeacon: () => true,
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    },
    configurable: true,
  })
  globalThis.localStorage = dom.window.localStorage
  globalThis.Event = dom.window.Event
  globalThis.Blob = dom.window.Blob
  globalThis.MutationObserver = dom.window.MutationObserver
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (...args) => {
    const timer = realSetInterval(...args)
    timer?.unref?.()
    return timer
  }
  globalThis.BroadcastChannel = class {
    postMessage() {}
    close() {}
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  return dom
}

test('Deepgram grown final replaces the voice-painted interim after speech is interrupted', async () => {
  installBrowserGlobals()
  const voice = await import('../src/voice.mjs')
  const { __test, setVoiceTarget } = voice

  try {
    __test.resetForVoiceTest()
    __test.forceDeepgram()
    __test.setRecording(true)

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    setVoiceTarget(textarea, {
      getSendTargets: () => ['fleet:test'],
      getAgentNames: () => ({ 'fleet:test': 'test' }),
    })

    const epoch = __test.state().speechEpoch
    __test.deepgramMessage({
      type: 'transcript',
      epoch,
      text: 'Cool',
      is_final: false,
    })
    assert.equal(textarea.value, 'Cool')

    __test.enterEdit({ type: 'input', isTrusted: true, inputType: 'insertText', data: ',' })

    __test.deepgramMessage({
      type: 'transcript',
      epoch,
      text: 'Cool stuff',
      is_final: true,
      speech_final: true,
    })

    assert.equal(textarea.value, 'Cool stuff')
  } finally {
    __test.setRecording(false)
  }
})
