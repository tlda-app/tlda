import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('fleet chat returns the transport settlement to the shared composer', () => {
  const source = fs.readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('const composerSend =')
  const end = source.indexOf('\n\n  const composerCommand', start)
  const composerSend = source.slice(start, end)
  assert.ok(start >= 0 && end > start)
  assert.match(composerSend, /return \(async \(\) => \{[\s\S]*return sendWithFailedRetry/)
})

test('failed chat send leaves the exact composer text and durable draft intact', async () => {
  const handlesBeforeMount = new Set(process._getActiveHandles())
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://tlda.test/', pretendToBeVisual: true })
  ;(dom.window as any).__TLDA_CONFIG__ = {
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
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
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
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = realSetInterval(...args)
    ;(timer as any).unref?.()
    return timer
  }) as typeof setInterval
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
  const React = await import('react')
  ;(globalThis as any).React = React
  const { act, createElement } = React
  const { createRoot } = await import('react-dom/client')
  const { ChatComposer } = await import('../src/shapes/ChatComposer')
  let sendCount = 0
  let rejectSend!: (value: boolean) => void
  const sendResult = new Promise<boolean>(resolve => { rejectSend = resolve })
  const root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(createElement(ChatComposer, {
    sendTargets: ['fleet:recipient'],
    agentNames: {},
    draftKey: 'chat:test',
    onSend: () => { sendCount += 1; return sendResult },
  })))
  const textarea = document.querySelector('textarea')!
  textarea.value = 'exact dictated text'
  await act(async () => textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
  textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.equal(sendCount, 1, 'pending send must not be submitted twice')
  assert.equal(textarea.value, 'exact dictated text', 'pending send must not erase the field')
  await act(async () => { rejectSend(false); await sendResult })
  assert.equal(textarea.value, 'exact dictated text', 'failed send must leave the field intact')
  await new Promise(resolve => setTimeout(resolve, 350))
  const drafts = JSON.parse(localStorage.getItem('tlda-chat-drafts') || '{}')
  assert.equal(drafts['chat:test']?.text, 'exact dictated text', 'failed text must survive reload')

  let acceptOldSend!: (value: boolean) => void
  const oldSendResult = new Promise<boolean>(resolve => { acceptOldSend = resolve })
  await act(async () => root.render(createElement(ChatComposer, {
    key: 'old', sendTargets: ['fleet:recipient'], agentNames: {}, draftKey: 'chat:remount', onSend: () => oldSendResult,
  })))
  const oldTextarea = document.querySelector('textarea')!
  oldTextarea.value = 'old pending text'
  await act(async () => oldTextarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
  oldTextarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await act(async () => root.render(createElement(ChatComposer, {
    key: 'replacement', sendTargets: ['fleet:recipient'], agentNames: {}, draftKey: 'chat:remount', onSend: async () => true,
  })))
  const replacementTextarea = document.querySelector('textarea')!
  replacementTextarea.value = 'new replacement draft'
  await act(async () => replacementTextarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
  await act(async () => { acceptOldSend(true); await oldSendResult })
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(replacementTextarea.value, 'new replacement draft', 'old success must not clear the replacement field')
  const remountedDrafts = JSON.parse(localStorage.getItem('tlda-chat-drafts') || '{}')
  assert.equal(remountedDrafts['chat:remount']?.text, 'new replacement draft', 'old success must not clear the replacement durable draft')

  let rejectOldSend!: (value: boolean) => void
  const rejectedOldResult = new Promise<boolean>(resolve => { rejectOldSend = resolve })
  await act(async () => root.render(createElement(ChatComposer, {
    key: 'old-failure', sendTargets: ['fleet:recipient'], agentNames: {}, draftKey: 'chat:remount-failure', onSend: () => rejectedOldResult,
  })))
  const rejectedOldTextarea = document.querySelector('textarea')!
  rejectedOldTextarea.value = 'old rejected text'
  await act(async () => rejectedOldTextarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
  rejectedOldTextarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await act(async () => root.render(createElement(ChatComposer, {
    key: 'replacement-after-failure', sendTargets: ['fleet:recipient'], agentNames: {}, draftKey: 'chat:remount-failure', onSend: async () => true,
  })))
  const replacementAfterFailure = document.querySelector('textarea')!
  replacementAfterFailure.value = 'new draft after rejected send'
  await act(async () => replacementAfterFailure.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
  await act(async () => { rejectOldSend(false); await rejectedOldResult })
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(replacementAfterFailure.value, 'new draft after rejected send', 'old failure must not overwrite the replacement field')
  const rejectedRemountDrafts = JSON.parse(localStorage.getItem('tlda-chat-drafts') || '{}')
  assert.equal(rejectedRemountDrafts['chat:remount-failure']?.text, 'new draft after rejected send', 'old failure must not overwrite the replacement durable draft')

  let acceptWhitespaceSend!: (value: boolean) => void
  const whitespaceSendResult = new Promise<boolean>(resolve => { acceptWhitespaceSend = resolve })
  await act(async () => root.render(createElement(ChatComposer, {
    key: 'whitespace-edit', sendTargets: ['fleet:recipient'], agentNames: {}, draftKey: 'chat:whitespace-edit', onSend: () => whitespaceSendResult,
  })))
  const whitespaceTextarea = document.querySelector('textarea')!
  whitespaceTextarea.value = 'same transport text'
  await act(async () => whitespaceTextarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
  whitespaceTextarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  whitespaceTextarea.value = 'same transport text '
  await act(async () => whitespaceTextarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
  await act(async () => { acceptWhitespaceSend(true); await whitespaceSendResult })
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(whitespaceTextarea.value, 'same transport text ', 'success must not erase a newer whitespace-only edit')
  const whitespaceDrafts = JSON.parse(localStorage.getItem('tlda-chat-drafts') || '{}')
  assert.equal(whitespaceDrafts['chat:whitespace-edit']?.text, 'same transport text ', 'success must preserve newer exact draft bytes')

  await act(async () => root.render(createElement(ChatComposer, {
    sendTargets: ['fleet:recipient'], agentNames: {}, draftKey: 'chat:accepted', onSend: async () => true,
  })))
  const acceptedTextarea = document.querySelector('textarea')!
  acceptedTextarea.value = 'accepted text'
  await act(async () => acceptedTextarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
  acceptedTextarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await act(async () => { await Promise.resolve() })
  assert.equal(acceptedTextarea.value, '')
  assert.equal(JSON.parse(localStorage.getItem('tlda-chat-drafts') || '{}')['chat:accepted'], undefined)

  await act(async () => root.render(createElement(ChatComposer, {
    key: 'sync-void', sendTargets: ['fleet:recipient'], agentNames: {}, draftKey: 'inbox:task', onSend: () => {},
  })))
  const syncTextarea = document.querySelector('textarea')!
  syncTextarea.value = 'task report'
  await act(async () => syncTextarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
  syncTextarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.equal(syncTextarea.value, '', 'existing synchronous void senders retain their immediate-clear behavior')
  await act(async () => root.unmount())
  dom.window.close()
  for (const handle of process._getActiveHandles()) {
    if (!handlesBeforeMount.has(handle) && handle.constructor.name === 'MessagePort') {
      ;(handle as { close(): void }).close()
    }
  }
})
