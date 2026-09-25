import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

// Ghost text: consumed or refused composer text must never come back.
//
// Two proven leaks, both reproduced on the real surface 2026-09-25:
//  - `/terminal` consumed the field without clearing its draft, so the next
//    remount or reload resurrected the command text in the composer.
//  - a send with no live holder in the (alive-only) client roster is certainly
//    server-rejected ("No recipients matched": dead agents are excluded from
//    resolution), and the failed-send restore then resurrected the rejected
//    text ~6s after send. Refusing it up front keeps the field honestly unsent
//    instead of fake-sending and ghosting.
//
// The host handlers live inside FleetChatInner and are not importable, so (1)
// and (2) pin their shape the way the failed-send test pins composerSend's
// settlement return. (3) pins the refusal semantics at the composer level.

const SHAPE_URL = new URL('../src/shapes/FleetChatShape.tsx', import.meta.url)

function sliceHandler(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, `${startMarker} must exist`)
  return source.slice(start, end)
}

test('consumed /terminal text clears its draft instead of leaking it', () => {
  const source = fs.readFileSync(SHAPE_URL, 'utf8')
  const command = sliceHandler(source, 'const composerCommand =', '\n\n  const composerKeyActivity')
  assert.match(command, /clearComposerDraft\(composerDraftKey\)/)
})

test('a send with no live holder is refused before the optimistic send', () => {
  const source = fs.readFileSync(SHAPE_URL, 'utf8')
  const send = sliceHandler(source, 'const composerSend =', '\n\n  const composerCommand')
  const refusedAt = send.indexOf('return false')
  const injectedAt = send.indexOf('injectOptimisticEvent')
  assert.ok(refusedAt >= 0 && injectedAt >= 0 && refusedAt < injectedAt,
    'composerSend must refuse (return false) before the optimistic inject')
  assert.match(send, /resolveTargetAgents\(label, agents\)/)
  assert.match(send, /!\s*a\?\.dead/)
})

test('a refused send keeps the exact field text and durable draft', async () => {
  const handlesBeforeMount = new Set(process._getActiveHandles())
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://tlda.test/', pretendToBeVisual: true })
  ;dom.window.__TLDA_CONFIG__ = {
    name: 'testing',
    database: { http: 'https://tlda.test', ws: 'wss://tlda.test' },
    store: { http: 'https://tlda.test', ws: 'wss://tlda.test' },
    licenseKey: '',
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    Event: dom.window.Event,
    Blob: dom.window.Blob,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Mozilla/5.0 Chrome/125 Safari/537.36',
      maxTouchPoints: 0,
      sendBeacon: () => true,
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    },
  })
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    value: class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} },
  })
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = ((...args) => {
    const timer = realSetInterval(...args)
    ;timer.unref?.()
    return timer
  })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
  const React = await import('react')
  ;globalThis.React = React
  const { act, createElement } = React
  const { createRoot } = await import('react-dom/client')
  const { ChatComposer } = await import('../src/shapes/ChatComposer')
  const root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(ChatComposer, {
    sendTargets: ['fleet:recipient'],
    agentNames: {},
    draftKey: 'chat:refused',
    onSend: () => false,
  })))
  const textarea = document.querySelector('textarea')
  textarea.value = 'refused text stays'
  await act(async () => textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
  textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.equal(textarea.value, 'refused text stays', 'a refused send must leave the field intact')
  await new Promise(resolve => setTimeout(resolve, 350))
  const drafts = JSON.parse(localStorage.getItem('tlda-chat-drafts') || '{}')
  assert.equal(drafts['chat:refused']?.text, 'refused text stays', 'refused text must survive reload')
  await act(async () => root.unmount())
  dom.window.close()
  for (const handle of process._getActiveHandles()) {
    if (!handlesBeforeMount.has(handle) && handle.constructor.name === 'MessagePort') {
      ;handle.close()
    }
  }
})
