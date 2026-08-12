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
    name: 'voice-cross-message-test',
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

test('Deepgram submitted tail cannot enter the next textarea message after send', async () => {
  installBrowserGlobals()
  const voice = await import('../src/voice.mjs')
  const { __test, setVoiceTarget, completeMessageSend } = voice

  __test.resetForVoiceTest()
  __test.forceDeepgram()
  __test.setRecording(true)

  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  const submitted = []
  const targetHandle = {
    getSendTargets: () => ['fleet:test'],
    getAgentNames: () => ({ 'fleet:test': 'test' }),
    submitCurrent(submittedText) {
      const text = textarea.value.trim()
      if (!text) return false
      submitted.push({ text, submittedText })
      textarea.value = ''
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      completeMessageSend(submittedText ?? text)
      return true
    },
  }

  setVoiceTarget(textarea, targetHandle)
  const epoch1 = __test.state().speechEpoch
  __test.deepgramMessage({ type: 'transcript', epoch: epoch1, text: 'alpha beta', is_final: true })
  assert.equal(textarea.value, 'alpha beta')
  assert.equal(targetHandle.submitCurrent(textarea.value), true)

  const afterSend = __test.state()
  assert.equal(afterSend.speechEpoch, epoch1 + 1)
  assert.equal(afterSend.spanOpen, false)
  assert.equal(afterSend.submittedCarryArmed, true)
  assert.deepEqual(submitted, [{ text: 'alpha beta', submittedText: 'alpha beta' }])

  const epoch2 = afterSend.speechEpoch
  __test.deepgramMessage({ type: 'transcript', epoch: epoch2, text: 'gamma', is_final: false })
  assert.equal(textarea.value, 'gamma')
  assert.equal(__test.state().submittedCarryArmed, true)

  __test.deepgramMessage({ type: 'transcript', epoch: epoch2, text: 'alpha beta gamma delta', is_final: true })
  assert.equal(textarea.value, 'gamma delta')
  assert.doesNotMatch(textarea.value, /alpha beta/)

  const telemetry = __test.boundaryTelemetry()
  assert.equal(telemetry.messageSends, 1)
  assert.equal(telemetry.closedSpanOnMessageSend, 1)
  assert.equal(telemetry.contaminationTrimmed, 1)
  assert.equal(telemetry.lastBoundary.kind, 'message-send')
  assert.equal(telemetry.lastBoundary.hadSpan, true)
  assert.equal(telemetry.lastBoundary.spanOpenAfter, false)
})
