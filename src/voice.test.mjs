// voice.test.mjs — state machine tests for voice.mjs
// Run with: node src/voice.test.mjs

import assert from 'node:assert/strict'

// ---- Fake timers ----
const timers = []
let tid = 0
let clock = 0
Date.now = () => clock
global.setTimeout = (fn, ms = 0) => {
  const id = ++tid
  timers.push({ id, fn, fireAt: clock + ms })
  return id
}
global.clearTimeout = id => {
  const i = timers.findIndex(t => t.id === id)
  if (i !== -1) timers.splice(i, 1)
}

const intervals = []
let iid = 0
global.setInterval = (fn, ms = 0) => {
  const id = ++iid
  intervals.push({ id, fn, interval: ms, nextAt: clock + ms })
  return id
}
global.clearInterval = id => {
  const i = intervals.findIndex(t => t.id === id)
  if (i !== -1) intervals.splice(i, 1)
}

// Advance clock by ms, firing any timers whose fireAt <= new clock value,
// and any interval ticks that fall within the elapsed range.
function tick(ms) {
  clock += ms
  const fire = timers.filter(t => t.fireAt <= clock).sort((a, b) => a.fireAt - b.fireAt)
  for (const t of fire) {
    const i = timers.findIndex(x => x.id === t.id)
    if (i !== -1) { timers.splice(i, 1); t.fn() }
  }
  for (const iv of [...intervals]) {
    while (iv.nextAt <= clock) {
      iv.fn()
      iv.nextAt += iv.interval
    }
  }
}

global.requestAnimationFrame = fn => { fn(); return 0 }
global.Event = class Event {
  constructor(type, opts = {}) {
    this.type = type
    this.bubbles = !!opts.bubbles
    this.cancelable = !!opts.cancelable
    this.defaultPrevented = false
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true
  }
}
global.KeyboardEvent = class KeyboardEvent extends Event {
  constructor(type, opts = {}) {
    super(type, opts)
    this.key = opts.key || ''
    this.code = opts.code || ''
    this.shiftKey = !!opts.shiftKey
  }
}

// ---- Mock SpeechRecognition ----
let mockRec = null
const mockRecs = []
let startCount = 0
let throwInvalidStateStarts = 0
class MockSpeechRecognition {
  constructor() { mockRec = this; mockRecs.push(this) }
  start() {
    startCount++
    if (throwInvalidStateStarts > 0) {
      throwInvalidStateStarts--
      const err = new Error('invalid state')
      err.name = 'InvalidStateError'
      throw err
    }
  }
  stop() { this.onend?.() }
  abort() {}
}

// ---- Mock document ----
function makeMockElement() {
  return {
    _ownText: '',
    children: [],
    style: {},
    id: '',
    appendChild(child) {
      this.children.push(child)
      return child
    },
    remove() {},
    set textContent(value) {
      this._ownText = String(value ?? '')
      this.children = []
    },
    get textContent() {
      return this._ownText + this.children.map(child => child?.textContent || '').join('')
    },
  }
}
let mockDiv = null
const bodyClasses = new Set()
global.document = {
  createElement: () => {
    const el = makeMockElement()
    if (!mockDiv) mockDiv = el
    return el
  },
  body: {
    appendChild: () => {},
    classList: {
      add: (name) => bodyClasses.add(name),
      remove: (name) => bodyClasses.delete(name),
      contains: (name) => bodyClasses.has(name),
    },
  },
  addEventListener: () => {},
  querySelectorAll: () => [],
}
global.MutationObserver = class MutationObserver {
  observe() {}
  disconnect() {}
}

// ---- Mock BroadcastChannel ----
let micChannel = null
class MockBroadcastChannel {
  constructor() { micChannel = this }
  postMessage() {}
}
global.BroadcastChannel = MockBroadcastChannel
const mockWebSockets = []
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  constructor() {
    this.readyState = MockWebSocket.OPEN
    this.sent = []
    mockWebSockets.push(this)
    setTimeout(() => this.onopen?.(), 0)
  }
  send(data) { this.sent.push(data) }
  close() { this.readyState = 3; this.onclose?.() }
}
global.WebSocket = MockWebSocket

// ---- Mock fetch (whisper detection fails → falls back to Web Speech API) ----
global.fetch = (url = '') => String(url).includes('/api/log')
  ? Promise.resolve({ ok: true, status: 200, text: async () => '' })   // logger POST succeeds (no unhandled rejection)
  : Promise.reject(new Error('no whisper'))                            // whisper/deepgram detection still fails -> fallback
global.AbortSignal = { timeout: () => ({}) }

// ---- Setup window before import ----
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
  resume() { this.state = 'running'; return Promise.resolve() }
  close() { return Promise.resolve() }
  createMediaStreamSource() { return { connect: () => {} } }
}
global.AudioWorkletNode = class AudioWorkletNode {
  constructor() { this.port = { onmessage: null } }
  disconnect() {}
}

// ---- Import module ----
const { initVoice, setVoiceTarget: registerVoiceTarget, setVoiceAccumulator, clearVoiceAccumulator, toggleRecording, isRecording, getSpeechEpoch, enterVoiceSink, setBackend, resetTranscript, sendCurrentText } = await import('./voice.mjs')
const { setPref, loadPrefs } = await import('./preferences.ts')
await loadPrefs('voice-test')
setPref('voice-backend', 'chrome')

function makeTextarea() {
  const listeners = new Map()
  const ta = {
    value: '',
    style: {},
    scrollHeight: 20,
    selectionStart: 0,
    selectionEnd: 0,
    setSelectionRange(start, end) {
      this.selectionStart = start
      this.selectionEnd = end
    },
    dispatchEvent(event) {
      event.target = this
      event.currentTarget = this
      const entries = listeners.get(event.type) || []
      for (const entry of entries.filter(entry => entry.capture)) entry.fn(event)
      for (const entry of entries.filter(entry => !entry.capture)) entry.fn(event)
      return !event.defaultPrevented
    },
    addEventListener(type, fn, capture = false) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push({ fn, capture: capture === true })
    },
    removeEventListener(type, fn, capture = false) {
      const list = listeners.get(type) || []
      const i = list.findIndex(entry => entry.fn === fn && entry.capture === (capture === true))
      if (i !== -1) list.splice(i, 1)
    },
  }
  return ta
}

function attachComposerEnter(ta, sendFn, targets = ['fleet:abc']) {
  ta.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    const text = ta.value.trim()
    if (!text) return
    sendFn(targets, text, { voice: !!e.__tldaVoiceSubmit })
    ta.value = ''
    ta.style.height = 'auto'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function setVoiceTarget(textarea, sendTargets = [], agentNames = {}, sendFn = null, agentColor = null) {
  registerVoiceTarget(textarea, {
    getSendTargets: () => sendTargets,
    getAgentNames: () => agentNames,
    getAgentColor: () => agentColor,
    sendVoice: (targets, text) => sendFn?.(targets, text),
  })
}

function reset() {
  if (isRecording()) toggleRecording()
  timers.length = 0
  intervals.length = 0
  startCount = 0
  mockRecs.length = 0
  throwInvalidStateStarts = 0
  mockWebSockets.length = 0
}

// ---- Liveness helpers: backend-specific indicator decisions ----
{
  const { chromeLiveness, whisperLiveness, shouldAutoStartOnInit } = window.__voiceTest

  assert.equal(chromeLiveness(null, true, false, 1000), 'live', 'Chrome silence is live while recognition is active')
  assert.equal(chromeLiveness(100000, true, false, 1000), 'live', 'Chrome long quiet session is not death')
  assert.equal(chromeLiveness(null, false, false, 1000), 'dead', 'Chrome with no active session and no results is dead')
  assert.equal(chromeLiveness(1500, false, false, 1000), 'dead', 'Chrome inactive past the long window is dead')
  assert.equal(chromeLiveness(500, false, false, 1000), 'live', 'Chrome inactive inside the grace window is not dead')
  assert.equal(chromeLiveness(1500, false, true, 1000), 'live', 'Chrome edit-stop handoff is not death')

  assert.equal(whisperLiveness(100, WebSocket.OPEN, true, 1000), 'live', 'Whisper is live with recent bridge messages')
  assert.equal(whisperLiveness(null, WebSocket.OPEN, true, 1000), 'no-input', 'Whisper open bridge with no messages is no-input')
  assert.equal(whisperLiveness(1500, WebSocket.OPEN, true, 1000), 'no-input', 'Whisper open bridge with stale messages is no-input')
  assert.equal(whisperLiveness(100, 3, false, 1000), 'dead', 'Whisper closed bridge is dead')
  assert.equal(whisperLiveness(100, null, false, 1000), 'dead', 'Whisper missing bridge is dead')

  assert.equal(shouldAutoStartOnInit(true, 'chrome'), false, 'touch Web Speech waits for user gesture instead of auto-starting on init')
  assert.equal(shouldAutoStartOnInit(true, 'deepgram'), false, 'touch Deepgram also waits for an explicit mic action')
  assert.equal(shouldAutoStartOnInit(false, 'chrome'), false, 'desktop Chrome does not auto-start on init')
  assert.equal(shouldAutoStartOnInit(true, 'none'), false, 'off backend never auto-starts')

  console.log('✓ Liveness helpers: Chrome/whisper indicator decisions + init auto-start guard')
}

// ---- Test 1: Happy path ----
{
  const init = initVoice()
  await Promise.resolve()
  tick(2000)
  await init
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()

  toggleRecording()
  assert.ok(isRecording(), 'should be recording')
  tick(300)  // fire doStart (BroadcastChannel delay)
  assert.equal(startCount, 1, 'recognition should have started')

  // Fire onresult with a transcript
  mockRec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hello world' } }] })
  assert.ok(ta.value.includes('hello world'), `textarea should contain transcript, got: "${ta.value}"`)

  reset()
  console.log('✓ Test 1: Happy path')
}

// ---- Test 2: audio-capture auto-retry ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()

  toggleRecording()
  tick(300)
  assert.equal(startCount, 1, 'initial start')

  // 3 retries: each onerror fires a delayed retry
  const delays = [500, 1000, 2000]
  for (let i = 0; i < 3; i++) {
    mockRec.onerror({ error: 'audio-capture' })
    assert.ok(isRecording(), `should still be recording before retry ${i + 1}`)
    tick(delays[i])
    assert.equal(startCount, i + 2, `should have restarted ${i + 1} time(s)`)
    assert.ok(isRecording(), `should still be recording after retry ${i + 1}`)
  }

  // 4th error → retries exhausted → stop
  mockRec.onerror({ error: 'audio-capture' })
  assert.ok(!isRecording(), 'should have stopped after 3 retries exhausted')

  reset()
  console.log('✓ Test 2: audio-capture auto-retry (3 attempts with backoff)')
}

// ---- Test 3: BroadcastChannel handoff delay is 300ms ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()

  toggleRecording()
  assert.ok(isRecording(), 'recording state set immediately')
  assert.equal(startCount, 0, 'recognition not started yet — waiting for delay')

  tick(299)
  assert.equal(startCount, 0, 'still not started at 299ms')

  tick(1)  // total 300ms
  assert.equal(startCount, 1, 'should have started at exactly 300ms')

  // Cross-tab: another tab starts recording → this tab stops
  micChannel.onmessage({ data: 'mic-start' })
  assert.ok(!isRecording(), 'should have stopped on mic-start from other tab')

  reset()
  console.log('✓ Test 3: BroadcastChannel handoff delay is 300ms')
}

// ---- Test 4: Silence does not restart Chrome recognition ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()

  toggleRecording()
  tick(300)  // fire doStart → recognition starts, watchdog set for +8000ms
  assert.equal(startCount, 1, 'initial start')
  assert.ok(isRecording())

  tick(8000)
  assert.equal(startCount, 1, 'silence should not restart recognition')
  assert.ok(isRecording(), 'should still be recording after silence')

  reset()
  console.log('✓ Test 4: silence does not restart Chrome recognition')
}

// ---- Test 5: Long Chrome session stays in the same recognition session ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()

  toggleRecording()
  tick(300)   // fire doStart
  assert.equal(startCount, 1, 'initial start')

  tick(45000)
  assert.equal(startCount, 1, 'long session should not restart recognition')
  assert.ok(isRecording(), 'should still be recording after long session')

  reset()
  console.log('✓ Test 5: long Chrome session stays in one recognition session')
}

// ---- Test 6: stopRecording clears recording state ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()

  toggleRecording()
  tick(300)
  assert.equal(startCount, 1, 'initial start')

  toggleRecording()  // stop
  assert.ok(!isRecording(), 'should have stopped')
  assert.equal(intervals.length, 0, 'no intervals should remain active')

  reset()
  console.log('✓ Test 6: stopRecording clears recording state')
}

// ---- Test 7: Generation counter — stale onresult after send is discarded ----
{
  const ta = makeTextarea()
  let sentText = null
  const sendFn = (targets, text) => { sentText = text }
  attachComposerEnter(ta, sendFn)
  setVoiceTarget(ta, ['fleet:abc'], { 'fleet:abc': 'agent' }, sendFn)
  reset()

  toggleRecording()
  tick(300)
  assert.equal(startCount, 1, 'initial start')

  // Capture the OLD recognition object BEFORE triggering send —
  // the send path bumps generation and onend swaps in a new mockRec, so
  // we must grab the reference first to simulate a late callback from
  // the old session.
  const oldRec = mockRec
  const genBefore = getSpeechEpoch()

  // Speak a phrase then say "send"
  oldRec.onresult({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: 'hello world send' } }]
  })
  assert.equal(sentText, 'hello world', 'send keyword should trigger send')
  const genAfter = getSpeechEpoch()
  assert.ok(genAfter > genBefore, 'generation should have been bumped on send')

  // Now simulate a stale in-flight result arriving from the OLD session.
  // oldRec still has the old myEpoch snapshot in its closure, so its
  // onresult should be discarded even though recording is still active.
  ta.value = ''
  oldRec.onresult({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: 'stale garbage' } }]
  })
  assert.equal(ta.value, '', 'stale onresult should be discarded — textarea stays empty')

  reset()
  console.log('✓ Test 7: Generation counter discards stale onresult after send')
}

// ---- Test 8: Deepgram magic-word hits Enter once, not direct send twice ----
{
  const ta = makeTextarea()
  const sent = []
  const sendFn = (targets, text) => { sent.push(text) }
  attachComposerEnter(ta, sendFn)
  setVoiceTarget(ta, ['fleet:abc'], { 'fleet:abc': 'agent' }, sendFn)
  window.__voiceTest.fakeRecord(ta)
  const firstMagicEpoch = window.__voiceTest.getState().speechEpoch

  // Interim may contain the magic word, but Deepgram must only submit on final.
  window.__voiceTest.injectTranscript('hello world send', false)
  assert.equal(sent.length, 0, 'interim magic word should not send')

  window.__voiceTest.injectTranscript('hello world send', true)
  assert.deepEqual(sent, ['hello world'], 'final magic word should press Enter once with cleaned text')
  assert.equal(window.__voiceTest.getState().speechEpoch, firstMagicEpoch + 1, 'magic Enter crosses the shared boundary exactly once')

  // Racing duplicate results from the same Deepgram utterance are ignored until
  // Deepgram says the utterance ended. Duplicate finals can arrive without a
  // fresh interim on the old utterance too.
  window.__voiceTest.injectTranscript('hello world send', true)
  window.__voiceTest.injectTranscript('hello world send', false)
  window.__voiceTest.injectTranscript('hello world send', true)
  assert.deepEqual(sent, ['hello world'], 'same utterance should not send twice')

  // If Deepgram misses utterance_end entirely, a different new utterance should
  // release the duplicate guard instead of leaving dictation stuck forever.
  window.__voiceTest.injectTranscript('second message send', false)
  assert.deepEqual(sent, ['hello world'], 'new interim magic word still should not send')
  window.__voiceTest.injectTranscript('second message send', true)
  assert.deepEqual(sent, ['hello world', 'second message'], 'new utterance should submit even without prior utterance_end')
  assert.equal(window.__voiceTest.getState().speechEpoch, firstMagicEpoch + 2, 'each magic send advances exactly one epoch')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8: Deepgram magic-word submits once via Enter')
}

// ---- Test 8.0a: Deepgram magic-word is a voice submit through the active composer ----
{
  const ta = makeTextarea()
  const sent = []
  const targets = ['fleet:panel-target', 'fleet:inbox-target']
  const sendFn = (sendTargets, text, meta) => { sent.push({ targets: sendTargets, text, voice: meta?.voice }) }
  attachComposerEnter(ta, sendFn, targets)
  setVoiceTarget(ta, targets, { 'fleet:panel-target': 'panel', 'fleet:inbox-target': 'inbox' }, sendFn)
  window.__voiceTest.fakeRecord(ta)

  window.__voiceTest.injectTranscript('first thought send', false)
  window.__voiceTest.injectTranscript('first thought send', true)
  window.__voiceTest.injectTranscript('second thought send', false)
  window.__voiceTest.injectTranscript('second thought send', true)

  assert.deepEqual(sent, [
    { targets: ['fleet:panel-target', 'fleet:inbox-target'], text: 'first thought', voice: true },
    { targets: ['fleet:panel-target', 'fleet:inbox-target'], text: 'second thought', voice: true },
  ], 'voice magic-word should mark synthetic Enter and submit separate messages through the active composer targets')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8.0a: Deepgram magic-word uses active composer targets and keeps thoughts separate')
}

// ---- Test 8.0b: Direct voice send control uses active composer targets ----
{
  const ta = makeTextarea()
  const sent = []
  const targets = ['fleet:panel-target', 'fleet:inbox-target']
  setVoiceTarget(ta, targets, { 'fleet:panel-target': 'panel', 'fleet:inbox-target': 'inbox' }, (sendTargets, text) => {
    sent.push({ targets: sendTargets, text })
  })
  window.__voiceTest.fakeRecord(ta)
  ta.value = 'manual voice control'
  const directEpoch = window.__voiceTest.getState().speechEpoch

  sendCurrentText()
  assert.equal(window.__voiceTest.getState().speechEpoch, directEpoch + 1, 'direct voice control advances its boundary exactly once')

  assert.deepEqual(sent, [
    { targets: ['fleet:panel-target', 'fleet:inbox-target'], text: 'manual voice control' },
  ], 'direct voice send control should submit through the active composer targets')
  assert.equal(ta.value, '', 'direct voice send should clear the composer')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8.0b: Direct voice send control uses active composer targets')
}

// ---- Test 8.0f: Accumulator magic send uses the same boundary exactly once ----
{
  const sent = []
  setVoiceAccumulator(() => {}, text => sent.push(text), () => {}, 'note')
  window.__voiceTest.fakeRecord()
  const accumulatorEpoch = window.__voiceTest.getState().speechEpoch
  window.__voiceTest.injectTranscript('note thought send', false)
  window.__voiceTest.injectTranscript('note thought send', true)
  assert.deepEqual(sent, ['note thought'])
  assert.equal(window.__voiceTest.getState().speechEpoch, accumulatorEpoch + 1, 'accumulator magic send advances exactly one epoch')
  clearVoiceAccumulator()
  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8.0f: accumulator magic send uses one speech boundary')
}

// ---- Test 8.0c: Plain composer Enter uses its own targets ----
{
  const ta = makeTextarea()
  const sent = []
  const targets = ['fleet:panel-target', 'fleet:inbox-target']
  attachComposerEnter(ta, (sendTargets, text, meta) => {
    sent.push({ targets: sendTargets, text, voice: meta?.voice })
  }, targets)
  ta.value = 'keyboard message'

  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  assert.deepEqual(sent, [
    { targets: ['fleet:panel-target', 'fleet:inbox-target'], text: 'keyboard message', voice: false },
  ], 'plain composer Enter should submit through its own targets')
  assert.equal(ta.value, '', 'plain composer Enter should clear the composer')

  reset()
  console.log('✓ Test 8.0c: Plain composer Enter uses its own targets')
}

// ---- Test 8.0d: Direct voice send uses the currently active composer handle ----
{
  const chatTa = makeTextarea()
  const inboxTa = makeTextarea()
  const sent = []
  setVoiceTarget(chatTa, ['fleet:panel-target'], { 'fleet:panel-target': 'panel' }, (sendTargets, text) => {
    sent.push({ surface: 'panel', targets: sendTargets, text })
  })
  setVoiceTarget(inboxTa, ['fleet:inbox-target'], { 'fleet:inbox-target': 'inbox' }, (sendTargets, text) => {
    sent.push({ surface: 'inbox', targets: sendTargets, text })
  })
  window.__voiceTest.fakeRecord(inboxTa)
  inboxTa.value = 'inbox reply only'

  sendCurrentText()

  assert.deepEqual(sent, [
    { surface: 'inbox', targets: ['fleet:inbox-target'], text: 'inbox reply only' },
  ], 'direct voice send should use the active composer handle, not a prior chat-panel handle')
  assert.equal(inboxTa.value, '', 'direct voice send should clear the active composer')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8.0d: Direct voice send uses the currently active composer handle')
}

// ---- Test 8.0e: Active handle reflects updated composer targets without re-registering ----
{
  const ta = makeTextarea()
  const sent = []
  const targets = ['fleet:initial-target']
  const names = { 'fleet:initial-target': 'initial' }
  setVoiceTarget(ta, targets, names, (sendTargets, text) => {
    sent.push({ targets: sendTargets.slice(), text })
  })
  window.__voiceTest.fakeRecord(ta)
  targets.splice(0, targets.length, 'fleet:updated-target')
  names['fleet:updated-target'] = 'updated'
  ta.value = 'updated target message'

  sendCurrentText()

  assert.deepEqual(sent, [
    { targets: ['fleet:updated-target'], text: 'updated target message' },
  ], 'active voice handle should read the composer target state at send time')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8.0e: Active handle reflects updated composer targets without re-registering')
}

// ---- Test 8a: Enter send clears Deepgram in-flight utterance bleed ----
{
  const ta = makeTextarea()
  const sent = []
  const sendFn = (targets, text) => { sent.push(text) }
  attachComposerEnter(ta, sendFn)
  setVoiceTarget(ta, ['fleet:abc'], { 'fleet:abc': 'agent' }, sendFn)
  window.__voiceTest.fakeRecord(ta)

  window.__voiceTest.injectTranscript('the old message tail', false)
  ta.value = 'the old message tail'

  const enterEpoch = window.__voiceTest.getState().speechEpoch
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  assert.equal(window.__voiceTest.getState().speechEpoch, enterEpoch + 1, 'physical Enter crosses the shared boundary exactly once')
  resetTranscript('the old message tail')

  assert.deepEqual(sent, ['the old message tail'], 'Enter should send and clear the composer')
  assert.equal(ta.value, '', 'composer starts blank after Enter')

  window.__voiceTest.injectTranscript('the old message tail.', false)
  assert.equal(ta.value, '', 'late old interim after Enter must not repopulate the blank composer')
  window.__voiceTest.injectTranscript('the old message tail.', true)
  assert.equal(ta.value, '', 'late old final after Enter must not repopulate the blank composer')

  window.__voiceTest.injectTranscript('fresh thought', false)
  tick(100)
  assert.ok(ta.value.includes('fresh thought'), 'a genuinely new utterance releases the guard')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8a: Enter send clears Deepgram in-flight utterance bleed')
}

// ---- Test 8b: Submit magic words are preference-configurable ----
{
  const ta = makeTextarea()
  const sent = []
  const sendFn = (targets, text) => { sent.push(text) }
  attachComposerEnter(ta, sendFn)
  setVoiceTarget(ta, ['fleet:abc'], { 'fleet:abc': 'agent' }, sendFn)
  setPref('voice-submit-words', 'post')
  window.__voiceTest.fakeRecord(ta)

  window.__voiceTest.injectTranscript('hello world send', false)
  window.__voiceTest.injectTranscript('hello world send', true)
  assert.deepEqual(sent, [], 'unconfigured trailing word should not submit')

  const ta2 = makeTextarea()
  attachComposerEnter(ta2, sendFn)
  setVoiceTarget(ta2, ['fleet:abc'], { 'fleet:abc': 'agent' }, sendFn)
  window.__voiceTest.fakeRecord(ta2)

  window.__voiceTest.injectTranscript('hello world post', false)
  assert.deepEqual(sent, [], 'configured interim magic word should not submit')

  window.__voiceTest.injectTranscript('hello world post', true)
  assert.deepEqual(sent, ['hello world'], 'configured final magic word should submit via Enter')

  setPref('voice-submit-words', 'send, send it, post')
  const ta3 = makeTextarea()
  attachComposerEnter(ta3, sendFn)
  setVoiceTarget(ta3, ['fleet:abc'], { 'fleet:abc': 'agent' }, sendFn)
  window.__voiceTest.fakeRecord(ta3)
  window.__voiceTest.injectTranscript('please send it!', false)
  assert.deepEqual(sent, ['hello world'], 'configured multi-word interim should not submit')
  window.__voiceTest.injectTranscript('please send it!', true)
  assert.deepEqual(sent, ['hello world', 'please'], 'longest configured phrase should win before punctuation')

  const ta4 = makeTextarea()
  attachComposerEnter(ta4, sendFn)
  setVoiceTarget(ta4, ['fleet:abc'], { 'fleet:abc': 'agent' }, sendFn)
  window.__voiceTest.fakeRecord(ta4)
  window.__voiceTest.injectTranscript('launch POST.', false)
  assert.deepEqual(sent, ['hello world', 'please'], 'configured case-insensitive interim should not submit')
  window.__voiceTest.injectTranscript('launch POST.', true)
  assert.deepEqual(sent, ['hello world', 'please', 'launch'], 'configured submit words should be case-insensitive')

  setPref('voice-submit-words', ' ')
  const ta5 = makeTextarea()
  attachComposerEnter(ta5, sendFn)
  setVoiceTarget(ta5, ['fleet:abc'], { 'fleet:abc': 'agent' }, sendFn)
  window.__voiceTest.fakeRecord(ta5)
  window.__voiceTest.injectTranscript('disabled post', false)
  window.__voiceTest.injectTranscript('disabled post', true)
  assert.deepEqual(sent, ['hello world', 'please', 'launch'], 'blank submit-word preference should disable magic submit')

  setPref('voice-submit-words', 'send, send it, sent')
  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8b: submit magic words are configurable')
}

// ---- Test 8c: 2nd sink tap wipes the last real field's interim (the #4 fix) ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  window.__voiceTest.fakeRecord(ta)

  window.__voiceTest.injectTranscript('ambient words', false)
  assert.ok(ta.value.includes('ambient'), 'prior target should receive interim before sink')

  enterVoiceSink()
  assert.equal(window.__voiceTest.getState().dumping, true, 'first sink tap enters sink mode')
  assert.ok(ta.value.includes('ambient'), 'first sink tap leaves prior target-owned content alone')
  assert.equal(window.__voiceTest.getState().interim, '', 'first sink tap starts a fresh sink segment')

  window.__voiceTest.injectTranscript('television noise', false)
  assert.equal(ta.value.includes('television'), false, 'sink interim should not write to prior target')
  assert.ok(window.__voiceTest.getState().interim.includes('television'), 'sink keeps a live interim buffer')

  enterVoiceSink()
  const state = window.__voiceTest.getState()
  assert.equal(state.dumping, true, 'second sink tap stays in sink mode')
  assert.equal(state.state, 'edit', 'second sink tap resets the sink buffer')
  assert.equal(state.interim, '', 'sink buffer is cleared')
  // The #4 fix: the 2nd tap wipes the interim that was in the LAST REAL field
  // ("ambient", an uncommitted interim) — not the sink's nowhere buffer (the old
  // no-op). "ambient" was never finalized, so the field is left empty.
  assert.equal(ta.value.includes('ambient'), false, 'second sink tap wipes the prior field’s in-flight interim')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8c: 2nd sink tap wipes the last real field’s interim')
}

// ---- Test 8d: Accumulator target switches preserve committed note text ----
{
  function makeNoteAccumulator(getText, setText) {
    let base = null
    const onUpdate = text => {
      if (base === null) {
        const cur = getText()
        base = cur ? cur + (/\s$/.test(cur) ? '' : ' ') : ''
      }
      setText(base + text)
    }
    const onStop = () => { base = null }
    return { onUpdate, onStop }
  }

  let noteA = 'alpha'
  let noteB = 'beta'
  const a = makeNoteAccumulator(() => noteA, text => { noteA = text })
  const b = makeNoteAccumulator(() => noteB, text => { noteB = text })

  setVoiceAccumulator(a.onUpdate, null, a.onStop, 'note A')
  window.__voiceTest.fakeRecord()
  window.__voiceTest.injectTranscript('first phrase', false)
  tick(500)
  assert.equal(noteA, 'alpha first phrase', 'note A should append live accumulator text')

  setVoiceAccumulator(b.onUpdate, null, b.onStop, 'note B')
  window.__voiceTest.fakeRecord()
  window.__voiceTest.injectTranscript('second phrase', false)
  tick(500)
  assert.equal(noteA, 'alpha first phrase', 'switching target should preserve note A committed text')
  assert.equal(noteB, 'beta second phrase', 'note B should receive its own live accumulator text')

  enterVoiceSink()
  window.__voiceTest.injectTranscript('television noise', false)
  tick(500)
  assert.equal(noteA, 'alpha first phrase', 'sink should not mutate note A')
  assert.equal(noteB, 'beta second phrase', 'sink should not mutate note B')

  clearVoiceAccumulator(a.onUpdate)
  clearVoiceAccumulator(b.onUpdate)
  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8d: accumulator switches preserve committed note text')
}

// ---- Test 8e: Deepgram duplicate final without fresh interim is stale ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  window.__voiceTest.fakeRecord(ta)

  window.__voiceTest.injectTranscript('shows up again', false)
  window.__voiceTest.injectTranscript('shows up again', true)
  assert.equal(ta.value, 'shows up again', 'first final should commit text')

  window.__voiceTest.injectTranscript('shows up again', true)
  assert.equal(ta.value, 'shows up again', 'duplicate final without fresh interim should be dropped')

  window.__voiceTest.injectTranscript('shows up again', false)
  window.__voiceTest.injectTranscript('shows up again', true)
  assert.equal(ta.value, 'shows up again', 'same words after fresh interim should still be dropped in the same utterance')

  window.__voiceTest.injectTranscript('second phrase', false)
  window.__voiceTest.injectTranscript('second phrase', true)
  assert.equal(ta.value, 'shows up again second phrase', 'different fresh interim should still be accepted without an utterance_end')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8e: Deepgram duplicate stale final/interim is dropped')
}

// ---- Test 8f: Deepgram utterance boundary permits repeated text later ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  window.__voiceTest.fakeRecord(ta)

  window.__voiceTest.injectTranscript('repeatable phrase', false)
  window.__voiceTest.injectTranscript('repeatable phrase', true)
  assert.equal(ta.value, 'repeatable phrase', 'first utterance should commit text')

  window.__voiceTest.injectDeepgramMessage({ type: 'utterance_end' })
  window.__voiceTest.injectDeepgramMessage({ type: 'speech_started' })
  window.__voiceTest.injectTranscript('repeatable phrase', false)
  window.__voiceTest.injectTranscript('repeatable phrase', true)
  assert.equal(ta.value, 'repeatable phrase repeatable phrase', 'same text should be allowed again after an utterance boundary')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8f: Deepgram utterance boundary permits repeated text later')
}

// ---- Test 8g: Deepgram genuine repeated words survive the echo guard ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  window.__voiceTest.fakeRecord(ta)

  window.__voiceTest.injectTranscript('no', false)
  window.__voiceTest.injectTranscript('no', true)
  assert.equal(ta.value, 'no', 'first repeated word should commit text')

  tick(1300)
  window.__voiceTest.injectTranscript('no', false)
  window.__voiceTest.injectTranscript('no', true)
  assert.equal(ta.value, 'no no', 'same word after the echo window should be kept as genuine repeated speech')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8g: Deepgram genuine repeated words survive the echo guard')
}

await setBackend('chrome')

// ---- Test 9: Identical finals append as ordinary final text ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()

  toggleRecording()
  tick(300)
  assert.equal(startCount, 1, 'initial start')

  // Identical finals are treated as ordinary final transcript chunks.
  const poisonFragment = { isFinal: true, 0: { transcript: ' garbage garbage' } }
  for (let i = 0; i < 2; i++) {
    mockRec.onresult({ resultIndex: 0, results: [poisonFragment] })
    assert.ok(isRecording(), `still recording after repeat ${i + 1}`)
    assert.ok(ta.value.length > 0 || i === 0, `textarea has text before threshold`)
  }
  mockRec.onresult({ resultIndex: 0, results: [poisonFragment] })
  assert.equal(ta.value, ' garbage garbage garbage garbage garbage garbage', 'identical finals should remain committed text')
  assert.equal(startCount, 1, 'identical finals should not restart recognition')
  assert.ok(isRecording(), 'should still be recording after repeated finals')

  reset()
  console.log('✓ Test 9: identical finals append as ordinary final text')
}

// ---- Test 10: Generation bump in onend respawns fresh session (chat-switch regression) ----
// Regression: after "left chat" command, _speechEpoch is bumped before onend fires.
// onend must call _setupRecognition() so the new session has an updated myEpoch
// snapshot — otherwise every onresult is discarded and voice appears dead.
{
  const ta = makeTextarea()
  let sentText = null
  const sendFn = (targets, text) => { sentText = text }
  setVoiceTarget(ta, ['fleet:abc'], { 'fleet:abc': 'agent' }, sendFn)
  reset()

  toggleRecording()
  tick(300)
  const startCountBefore = startCount

  // Simulate generation being bumped (as happens during chat-switch or send)
  // by directly triggering a recognition stop while _recording is true.
  // We do this by firing a result that bumps generation (poison path), then
  // verify recognition restarts and accepts new results.
  //
  // Simpler: manually bump generation to mimic send/chat-switch, then call
  // mockRec.onend() to simulate the stop() completing.
  const genBefore = getSpeechEpoch()

  // Fire onend as if stop() completed after a generation bump.
  // The onend handler should detect the stale generation and call _setupRecognition().
  // We simulate the generation bump that happens in setVoiceTarget (target switch).
  const ta2 = makeTextarea()
  setVoiceTarget(ta2, ['fleet:abc'], { 'fleet:abc': 'agent' }, sendFn)
  // setVoiceTarget bumped _speechEpoch; now simulate the old session's onend firing
  const genAfterSwitch = getSpeechEpoch()
  assert.ok(genAfterSwitch > genBefore, 'generation bumped on target switch')

  tick(300)
  assert.equal(startCount, startCountBefore + 1, 'target switch should start a fresh recognition session')

  // New session should accept results (not discard due to stale generation)
  ta2.value = ''
  mockRec.onresult({
    resultIndex: 0,
    results: [{ isFinal: false, 0: { transcript: 'hello after switch' } }]
  })
  assert.ok(ta2.value.includes('hello after switch'), 'new session should accept results after target switch')

  reset()
  console.log('✓ Test 10: onend with stale generation creates fresh session (chat-switch regression)')
}

// ---- Test 11: transient Deepgram reconnect stays in the quiet fixed HUD ----
{
  reset()
  window.__voiceTest.fakeDeepgramConnected()
  window.__voiceTest.showDontSpeak()
  assert.equal(window.__voiceTest.isDontSpeakVisible(), false, 'transient reconnect must not show the old full-width banner')
  assert.equal(window.__voiceTest.getVoiceStatusLabel(), 'reconnecting', 'disconnect maps to compact reconnecting state')
  assert.equal(window.__voiceTest.getHudWidth(), '240px', 'voice HUD keeps a fixed width through reconnect states')

  const sent = window.__voiceTest.simulateDeepgramAudioFrame()
  assert.equal(sent, true, 'connected Deepgram frame should be sent')
  assert.equal(window.__voiceTest.isDontSpeakVisible(), false, 'audio recovery keeps the banner hidden before transcript arrives')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 11: transient Deepgram reconnect uses quiet fixed HUD')
}

// ---- Test 11a: phone voice HUD sits at the top of the viewport ----
{
  reset()
  document.body.classList.add('phone-mode')
  window.__voiceTest.fakeDeepgramConnected()
  window.__voiceTest.showDontSpeak()
  assert.equal(window.__voiceTest.getHudStyle().top, '12px', 'phone voice HUD should be anchored near the top')
  assert.equal(window.__voiceTest.getHudStyle().bottom, '', 'phone voice HUD should not also keep the desktop bottom anchor')
  document.body.classList.remove('phone-mode')
  window.__voiceTest.showDontSpeak()
  assert.equal(window.__voiceTest.getHudStyle().top, '', 'desktop voice HUD clears the phone top anchor')
  assert.equal(window.__voiceTest.getHudStyle().bottom, '20px', 'desktop voice HUD keeps the bottom anchor')
  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 11a: phone voice HUD is top anchored')
}

// ---- Test 11b: relay transport and recognizer usability are separate facts ----
{
  reset()
  const relay = window.__voiceTest.fakeDeepgramRelay()
  assert.deepEqual(window.__voiceTest.getDeepgramFacts(), {
    relayConnected: true,
    recognizerStatus: null,
    recognizerConnected: false,
    commonState: 'starting',
  }, 'relay open alone must not establish recognizer usability')

  window.__voiceTest.injectDeepgramMessage({ type: 'status', status: 'idle' })
  assert.equal(window.__voiceTest.getDeepgramFacts().commonState, 'recovering', 'idle recognizer remains recovery-eligible')
  assert.equal(window.__voiceTest.getVoiceStatusLabel(), 'reconnecting', 'idle recognizer must not claim mic live')
  assert.equal(window.__voiceTest.simulateDeepgramAudioFrame(), true, 'PCM must remain available as bridge recovery input')
  assert.equal(window.__voiceTest.getDeepgramFacts().recognizerConnected, false, 'PCM transport must not fabricate recognizer usability')

  window.__voiceTest.injectDeepgramMessage({ type: 'epoch_ready' })
  window.__voiceTest.injectDeepgramMessage({ type: 'status', status: 'connected' })
  assert.equal(window.__voiceTest.getDeepgramFacts().recognizerConnected, true, 'current structured connected establishes usability')

  window.__voiceTest.injectDeepgramMessage({ type: 'status', status: 'error' })
  assert.equal(window.__voiceTest.getDeepgramFacts().commonState, 'recovering', 'bridge error is recoverable, not terminal failure')
  assert.equal(window.__voiceTest.simulateDeepgramAudioFrame(), true, 'error recovery still receives PCM')

  window.__voiceTest.setBackend('chrome')
  assert.equal(window.__voiceTest.simulateDeepgramAudioFrame(), false, 'stale worklet PCM is rejected after backend switch')
  window.__voiceTest.setBackend('deepgram')
  window.__voiceTest.setDeepgramRelayReadyState(MockWebSocket.CLOSED)
  assert.equal(window.__voiceTest.simulateDeepgramAudioFrame(), false, 'PCM is rejected when the owned relay socket is not open')

  const staleRelay = relay
  window.__voiceTest.fakeDeepgramRelay()
  window.__voiceTest.injectDeepgramMessageFrom(staleRelay, { type: 'status', status: 'connected' })
  assert.equal(window.__voiceTest.getDeepgramFacts().recognizerConnected, false, 'stale relay status cannot authorize current usability')
  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 11b: relay and recognizer facts remain separate through recovery')
}

// ---- Test 11c: stale Deepgram reconnect work cannot resurrect stopped/switched voice ----
{
  reset()
  const currentRelay = window.__voiceTest.startDeepgramRelayTest()
  tick(0)
  assert.equal(currentRelay.sent.length > 0, true, 'current relay open sends start')
  currentRelay.close()
  assert.equal(window.__voiceTest.getDeepgramReconnectFacts().hasTimer, true, 'current close schedules one tracked reconnect')
  currentRelay.onclose?.()
  assert.equal(timers.filter(t => t.fireAt === clock + 1000).length, 1, 'repeated close cannot schedule parallel reconnects')
  tick(1000)
  tick(0)
  assert.equal(mockWebSockets.length, 2, 'current intent-on generation reconnects exactly once')
  assert.equal(mockWebSockets[1].sent.length > 0, true, 'current replacement relay sends start')

  reset()
  const stoppedRelay = window.__voiceTest.startDeepgramRelayTest()
  tick(0)
  stoppedRelay.close()
  const stoppedTimerCallback = timers.find(t => t.fireAt === clock + 1000)?.fn
  assert.ok(stoppedTimerCallback, 'stop race captures the queued reconnect callback')
  window.__voiceTest.stopDeepgramRelayTest()
  stoppedTimerCallback()
  const stoppedFacts = window.__voiceTest.getDeepgramReconnectFacts()
  assert.equal(stoppedFacts.hasTimer, false, 'intent off clears the tracked reconnect timer')
  assert.equal(stoppedFacts.hasRelay, false, 'intent off leaves no relay')
  assert.equal(stoppedFacts.recording, false, 'intent off remains authoritative')
  assert.equal(mockWebSockets.length, 1, 'stale timer cannot create a relay after stop')

  reset()
  const switchedRelay = window.__voiceTest.startDeepgramRelayTest()
  tick(0)
  switchedRelay.close()
  const switchedTimerCallback = timers.find(t => t.fireAt === clock + 1000)?.fn
  await window.__voiceTest.switchBackendTest('chrome')
  switchedTimerCallback()
  assert.equal(mockWebSockets.length, 1, 'stale timer cannot create a relay after backend switch')
  assert.equal(window.__voiceTest.getDeepgramReconnectFacts().backend, 'chrome', 'backend switch remains authoritative')

  reset()
  const lateOpenRelay = window.__voiceTest.startDeepgramRelayTest()
  window.__voiceTest.stopDeepgramRelayTest()
  tick(0)
  assert.equal(lateOpenRelay.sent.length, 0, 'stale onopen after stop closes without sending start')
  assert.equal(lateOpenRelay.readyState, MockWebSocket.CLOSED, 'stale onopen socket is closed')

  reset()
  const switchedLateOpenRelay = window.__voiceTest.startDeepgramRelayTest()
  await window.__voiceTest.switchBackendTest('chrome')
  tick(0)
  assert.equal(switchedLateOpenRelay.sent.length, 0, 'stale onopen after backend switch sends no start')
  assert.equal(switchedLateOpenRelay.readyState, MockWebSocket.CLOSED, 'backend switch closes the stale opening socket')

  reset()
  const oldRelay = window.__voiceTest.startDeepgramRelayTest()
  tick(0)
  oldRelay.close()
  const oldTimer = timers.find(t => t.fireAt === clock + 1000)
  window.__voiceTest.stopDeepgramRelayTest()
  const newerRelay = window.__voiceTest.startDeepgramRelayTest()
  tick(0)
  newerRelay.close()
  assert.equal(window.__voiceTest.getDeepgramReconnectFacts().hasTimer, true, 'new generation owns its reconnect timer')
  oldTimer.fn()
  assert.equal(window.__voiceTest.getDeepgramReconnectFacts().hasTimer, true, 'stale callback cannot clear a newer owned timer')
  tick(1000)
  tick(0)
  assert.equal(mockWebSockets.length, 3, 'newer owned timer still performs exactly one reconnect')
  window.__voiceTest.stopDeepgramRelayTest()
  reset()
  console.log('✓ Test 11c: relay generation prevents stale reconnect resurrection')
}

// ---- Test 12: mic watchdog never tears down a live (running) context ----
// Root-cause regression for the intermittent cut-outs / false "stop talking".
// The old heartbeat restarted the whole mic pipeline whenever audio chunks paused
// for >2s — but that gap is a MAIN-THREAD timing artifact (jank, an iOS audio
// duck, a WS blip), not pipeline death, and the teardown itself manufactured the
// cut-out. The fix: decide purely from the AudioContext state. A running (or
// unknown) context is alive → 'none'; 'suspended' → cheap resume; only a genuinely
// dead 'closed' context → 'rebuild'.
{
  const action = window.__voiceTest.micWatchdogAction
  assert.equal(action('running'), 'none', 'running context must never be torn down (the 6/19 false-stall case)')
  assert.equal(action(undefined), 'none', 'unknown state is treated as alive — never a destructive restart')
  assert.equal(action('suspended'), 'resume', 'suspended context is repaired by resume(), not teardown')
  assert.equal(action('closed'), 'rebuild', 'only a genuinely dead (closed) context warrants a rebuild')
  console.log('✓ Test 12: mic watchdog never restarts a running/suspended context')
}

// Test 13: upstream lifecycle decision — stream to Deepgram ONLY while actively
// dictating in the active tab. Drop recording / routing / foreground and the
// upstream is released; restore all three and it resumes. (Cost-leak gate.)
{
  const act = window.__voiceTest.upstreamAction
  const S = (recording, routed, tabHidden, paused) => act({ recording, routed, tabHidden, paused })
  // Actively dictating, foreground, routed → stream.
  assert.equal(S(true, true, false, false), 'send', 'recording + routed + foreground must stream')
  // Routed-to-nowhere (dumb mode) while streaming → pause (send stop).
  assert.equal(S(true, false, false, false), 'pause', 'routed-to-nowhere must release upstream')
  // Backgrounded tab while streaming → pause.
  assert.equal(S(true, true, true, false), 'pause', 'backgrounded tab must release upstream')
  // Recording off while streaming → pause.
  assert.equal(S(false, true, false, false), 'pause', 'not recording must release upstream')
  // Already paused and still shouldn't stream → hold (no repeat stop).
  assert.equal(S(true, false, false, true), 'hold', 'stay paused when still not dictating')
  // Paused but now actively dictating again → resume (send start).
  assert.equal(S(true, true, false, true), 'resume', 'resume when routed + foreground + recording')
  console.log('✓ Test 13: upstream streams only while actively dictating in the active tab')
}

// Test 14: honest mic status — the HUD reads "no mic input" when raw frames stop
// (a silently-dead/muted mic), "live" while frames arrive, even across a pause.
{
  const p = window.__voiceTest.micPresence
  assert.equal(p(0, 'running', 1500), 'live', 'a just-arrived frame reads live')
  assert.equal(p(200, 'running', 1500), 'live', 'recent frame reads live')
  assert.equal(p(3000, 'running', 1500), 'no-input', 'no frame past the timeout = dead/muted mic, not a fake live')
  assert.equal(p(null, 'running', 1500), 'no-input', 'no frame ever delivered reads no-input')
  assert.equal(p(0, 'closed', 1500), 'no-input', 'a closed context is never live')
  console.log('✓ Test 14: HUD mic status is honest about real audio presence')
}

// Test 15: <nowhere> second click wipes ONLY the in-flight interim from the last
// real field; committed text (left) survives.
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {}, null)
  window.__voiceTest.fakeRecord(ta)
  window.__voiceTest.injectTranscript('hello', false) // interim → state=speech, hasSeenInterim
  window.__voiceTest.injectTranscript('hello', true)  // final → commits "hello" to _left
  window.__voiceTest.injectTranscript('world', false) // new interim (uncommitted) to be wiped
  enterVoiceSink()  // 1st click → nowhere, remembers ta + left/right
  enterVoiceSink()  // 2nd click → wipe interim only
  assert.ok(/hello/i.test(ta.value), `committed text must survive, got "${ta.value}"`)
  assert.ok(!/world/i.test(ta.value), `in-flight interim must be wiped, got "${ta.value}"`)
  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 15: <nowhere> 2nd click wipes interim, keeps committed text')
}

// Test 16: service-not-allowed message is plain + iOS-aware (pure helper).
{
  const msg = window.__voiceTest.serviceUnavailableMessage
  const ios = msg(true)
  const other = msg(false)
  assert.ok(/iphone/i.test(ios),
    `iOS message must name iPhone, got "${ios}"`)
  assert.ok(!/safari/i.test(ios), `iOS message must not pretend Safari is an escape hatch, got "${ios}"`)
  assert.ok(!/deepgram|whisper|preferences/i.test(ios), `iOS message must not tell the user to switch tools, got "${ios}"`)
  assert.ok(!/iphone|deepgram|whisper|preferences/i.test(other),
    `non-iOS message stays generic and plain, got "${other}"`)
  assert.notEqual(ios, other, 'iOS and non-iOS messages differ')
  console.log('✓ Test 16: service-not-allowed message is plain + iOS-aware')
}

// Test 17: Chrome 'service-not-allowed' first tries an explicit mic-permission
// probe and recognition restart. If the speech service still refuses after that,
// it stops cleanly, logs the error, and shows the plain hard-failure message.
{
  const { log } = await import('./logger.ts')
  const warnCalls = []
  const origWarn = log.warn
  log.warn = (...args) => { warnCalls.push(args) }
  try {
    const ta = makeTextarea()
    setVoiceTarget(ta, [], {})
    reset()
    setBackend('chrome')    // a prior test's fakeRecord left _backend='deepgram'

    toggleRecording()
    tick(300)               // fire doStart -> recognition.start()
    assert.equal(startCount, 1, 'recognition started')
    const startsBefore = startCount

    mockRec.onerror({ error: 'service-not-allowed' })

    await Promise.resolve()

    assert.ok(isRecording(), 'first service-not-allowed should keep recording while retrying')
    assert.equal(startCount, startsBefore + 1, 'first service-not-allowed should retry once after mic probe')

    mockRec.onerror({ error: 'service-not-allowed' })

    assert.ok(!isRecording(), 'service-not-allowed must stop recording')
    const voiceWarn = warnCalls.find(a => a[0] === 'voice' && a[2] && a[2].error === 'service-not-allowed')
    assert.ok(voiceWarn, 'must route the error through log.warn("voice", ...) carrying the error code')
    assert.ok(/browser voice .*refused/i.test(mockDiv.textContent), `HUD must show the plain hard-failure message, got "${mockDiv.textContent}"`)
    assert.ok(!/preferences|deepgram|whisper|safari/i.test(mockDiv.textContent), `HUD must not tell the user to switch tools, got "${mockDiv.textContent}"`)
    assert.ok(!/mic error/i.test(mockDiv.textContent), 'must NOT fall through to the generic "mic error" HUD')

    tick(5000)              // give any extra (wrong) retry timer a chance to fire
    assert.equal(startCount, startsBefore + 1, 'must retry exactly once before treating it as a hard platform restriction')
  } finally {
    log.warn = origWarn
  }
  reset()
  console.log('✓ Test 17: Chrome service-not-allowed retries once, then stops/logs/messages')
}

// Test 18: time-to-first-interim is logged once per recording, tagged + timed.
{
  const { log } = await import('./logger.ts')
  const infoCalls = []
  const origInfo = log.info
  log.info = (...args) => { infoCalls.push(args) }
  try {
    const ta = makeTextarea()
    setVoiceTarget(ta, [], {})
    reset()
    setBackend('chrome')

    toggleRecording()
    tick(300)
    assert.equal(startCount, 1, 'recognition started')

    mockRec.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'hello' } }] })
    const fi = infoCalls.filter(a => a[0] === 'voice' && a[1] === 'first-interim')
    assert.equal(fi.length, 1, 'first-interim logged exactly once on first content')
    assert.equal(typeof fi[0][2].ms, 'number', 'first-interim carries numeric ms')
    assert.ok(fi[0][2].ms >= 0, 'elapsed ms is non-negative')
    assert.equal(fi[0][2].backend, 'chrome', 'first-interim tagged with backend')

    mockRec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hello world' } }] })
    const fi2 = infoCalls.filter(a => a[0] === 'voice' && a[1] === 'first-interim')
    assert.equal(fi2.length, 1, 'first-interim logged only ONCE per recording')
  } finally {
    log.info = origInfo
  }
  reset()
  console.log('✓ Test 18: time-to-first-interim logged once with elapsed ms')
}

// Test 19: idle Chrome reconnect blips restart recognition without text markers.
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()
  await setBackend('chrome')

  toggleRecording()
  tick(300)
  assert.equal(startCount, 1, 'recognition started')
  const firstRec = mockRec

  throwInvalidStateStarts = 1
  firstRec.onend()
  assert.equal(startCount, 2, 'Chrome onend attempts immediate recognition restart')
  assert.ok(!ta.value.includes('technical difficulties'), 'idle blip must not insert a missingness marker before restart')
  tick(100)

  assert.equal(startCount, 3, 'Chrome onend auto-restarts recognition after retry')
  assert.notEqual(mockRec, firstRec, 'unexpected onend creates a fresh recognition instance')
  assert.equal(ta.value, '', `idle reconnect should keep composer blank, got "${ta.value}"`)
  assert.equal(window.__voiceTest.getLastChromeMissingnessMarker(), '', 'idle reconnect must not track a missingness marker')
  assert.ok(/reconnecting/i.test(mockDiv.textContent), `HUD should say reconnecting during auto-restart, got "${mockDiv.textContent}"`)
  assert.equal(window.__voiceTest.getHealthLabel(), 'restarting voice', 'health label tracks restart state')

  mockRec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'resumed words' } }] })
  assert.ok(ta.value.includes('resumed words'), `fresh restarted recognizer should accept later results, got "${ta.value}"`)

  tick(700)
  assert.ok(!/reconnecting/i.test(mockDiv.textContent), `restart label should clear after grace window, got "${mockDiv.textContent}"`)
  reset()
  console.log('✓ Test 19: idle Chrome reconnect blips restart without text markers')
}

// Test 19a: Chrome reconnect during active speech inserts/merges one marker.
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()
  await setBackend('chrome')

  toggleRecording()
  tick(300)
  assert.equal(startCount, 1, 'recognition started')
  mockRec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'spoken words' } }] })
  const firstRec = mockRec

  throwInvalidStateStarts = 1
  firstRec.onend()
  tick(100)

  assert.ok(ta.value.includes('spoken words [missed 0.1 seconds due to technical difficulties]'), `active speech restart should insert one marker, got "${ta.value}"`)
  assert.equal(window.__voiceTest.getLastChromeMissingnessMarker(), '[missed 0.1 seconds due to technical difficulties]', 'test hook tracks inserted marker')

  const secondRec = mockRec
  throwInvalidStateStarts = 1
  secondRec.onend()
  tick(100)

  const markerCount = (ta.value.match(/technical difficulties/g) || []).length
  assert.equal(markerCount, 1, `sequential reconnect markers without intervening text should merge, got "${ta.value}"`)
  assert.ok(ta.value.includes('spoken words [missed 0.1 seconds due to technical difficulties]'), `merged marker should preserve prior speech text, got "${ta.value}"`)

  reset()
  console.log('✓ Test 19a: Chrome reconnect during active speech inserts/merges one marker')
}

// Test 19b: user-initiated stop does not auto-restart or insert a marker.
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()
  await setBackend('chrome')

  toggleRecording()
  tick(300)
  assert.equal(startCount, 1, 'recognition started')
  toggleRecording()

  assert.equal(startCount, 1, 'user stop must not restart recognition')
  assert.equal(isRecording(), false, 'user stop turns recording off')
  assert.equal(window.__voiceTest.getLastChromeMissingnessMarker(), '', 'user stop must not insert missingness marker')
  assert.ok(!ta.value.includes('technical difficulties'), `user stop should leave textarea unmarked, got "${ta.value}"`)
  reset()
  console.log('✓ Test 19b: user stop does not auto-restart or mark missingness')
}

// Test 19c: Chrome restart retries are bounded when start() keeps failing.
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()
  await setBackend('chrome')

  toggleRecording()
  tick(300)
  assert.equal(startCount, 1, 'recognition started')
  throwInvalidStateStarts = 20
  mockRec.onend()
  for (let i = 0; i < 10; i++) tick(100)

  assert.equal(isRecording(), false, 'repeated failed restarts eventually stop recording')
  assert.ok(startCount <= 11, `restart attempts should be bounded, got ${startCount}`)
  reset()
  console.log('✓ Test 19c: failed Chrome restart attempts are bounded')
}

// Test 20: stale-audio label is backend-specific, not leaked from Deepgram state.
{
  reset()
  window.__voiceTest.fakeRecord()
  await setBackend('chrome')

  window.__voiceTest.dotAudioStale()
  assert.equal(window.__voiceTest.getHealthLabel(), 'mic live', 'Chrome stale label should stay Chrome-specific')

  await setBackend('deepgram')
  window.__voiceTest.dotAudioStale()
  assert.equal(window.__voiceTest.getHealthLabel(), 'mic unavailable; tap to retry', 'explicit Deepgram mic initialization failure remains honest')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 20: stale voice label follows active backend')
}

// ---- Test 21: server-inserted fly URL is never rewritten by the autocorrect ----
// Regression: before this fix, fillTextarea() applied postProcessTranscript() to
// the entire textarea value including _left (pre-speech text). A drag-dropped URL
// like https://tlda-fly.cormorant-matrix.ts.net/... got "fly"→"phi" rewritten,
// producing a dead link. Fix: correct only dictated interim/finals, never _left/_right.
{
  const FLY_URL = 'https://tlda-fly.cormorant-matrix.ts.net/api/file?path=/tmp/foo.png'

  // Scenario A: server-inserted URL in textarea before dictation starts
  {
    const ta = makeTextarea()
    ta.value = FLY_URL
    ta.selectionStart = FLY_URL.length
    ta.selectionEnd   = FLY_URL.length
    setVoiceTarget(ta, [], {}, null)
    reset()
    setBackend('chrome')

    toggleRecording()
    tick(300)

    // Interim: user says "hello" — triggers speech entry; _left = FLY_URL
    mockRec.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'hello' } }] })
    assert.ok(ta.value.includes(FLY_URL), `URL must survive interim display, got "${ta.value}"`)
    assert.ok(!ta.value.includes('phi.cormorant'), `"fly" in URL must NOT be rewritten to "phi", got "${ta.value}"`)

    // Final: user says "fly" (the word) — should be corrected to "phi" in the dictated span
    mockRec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'fly' } }] })
    assert.ok(ta.value.includes(FLY_URL), `URL must still survive after final, got "${ta.value}"`)
    assert.ok(!ta.value.includes('phi.cormorant'), `URL must not be rewritten after final, got "${ta.value}"`)
    assert.ok(ta.value.includes('phi'), `dictated "fly" must be corrected to "phi", got "${ta.value}"`)

    reset()
  }

  // Scenario B: spoken "fly" in interim IS still corrected (the word, isolated)
  {
    const ta = makeTextarea()
    setVoiceTarget(ta, [], {}, null)
    reset()
    setBackend('chrome')

    toggleRecording()
    tick(300)

    mockRec.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'fly' } }] })
    assert.ok(ta.value.includes('phi'), `spoken "fly" interim must be corrected to "phi", got "${ta.value}"`)
    assert.ok(!ta.value.includes('fly'), `uncorrected "fly" must not appear in interim display, got "${ta.value}"`)

    reset()
  }

  console.log('✓ Test 21: server-inserted fly URL survives dictation; spoken "fly" is still corrected')
}

// ---- Test 22: radio subtitle first slice ----
{
  reset()
  setPref('radio-subtitles-enabled', true)
  setPref('radio-subtitle-dwell-sec', 9)
  window.location.search = '?doc=bregman'
  location.search = '?doc=bregman'
  window.innerWidth = 1000
  const originalQuerySelectorAll = document.querySelectorAll
  document.querySelectorAll = (selector) => selector === '.svg-page-background, iframe'
    ? [{
        tagName: 'DIV',
        getBoundingClientRect: () => ({ left: 100, right: 900, width: 800, height: 1100 }),
      }]
    : []
  const ta = makeTextarea()
  setVoiceTarget(ta, ['frontier'], { 'fleet:frontier': 'frontier' }, null)

  const agents = [{ id: 'fleet:frontier', friendly_name: 'frontier' }]
  const unrelated = window.__voiceTest.maybeShowRadioSubtitleForIncomingChat(
    { type: 'chat', from: 'fleet:someone-else', to: 'fleet:skip', text: 'wrong channel' },
    [{ id: 'fleet:someone-else', friendly_name: 'someone-else' }],
    'fleet:skip',
  )
  assert.equal(unrelated, false, 'unrelated incoming chat should not render in radio HUD')

  const shown = window.__voiceTest.maybeShowRadioSubtitleForIncomingChat(
    {
      type: 'chat',
      from: 'fleet:frontier',
      to: 'fleet:skip',
      text: '<system-reminder>hide this</system-reminder>**Radio** line [one](https://example.com) `now` https://example.com/noise',
    },
    agents,
    'fleet:skip',
  )
  assert.equal(shown, true, 'active-target incoming chat should render in radio HUD')
  assert.ok(window.__voiceTest.getHudText().includes('radio <- frontier'), 'HUD should show radio source')
  assert.ok(window.__voiceTest.getHudText().includes('Radio line one now'), 'HUD should show cleaned subtitle text')
  assert.equal(window.__voiceTest.getHudStyle().width, '600px', 'radio HUD should use about 75% of the rendered doc page width')
  assert.ok(!window.__voiceTest.getHudText().includes('hide this'), 'HUD should strip system reminder text')
  assert.ok(!window.__voiceTest.getHudText().includes('https://example.com'), 'HUD should strip raw URLs')
  const live = window.__voiceTest.getRadioSubtitle()
  assert.equal(live.from, 'fleet:frontier', 'radio subtitle should store source')
  assert.equal(live.label, 'frontier', 'radio subtitle should store display label')
  assert.equal(live.text, 'Radio line one now', 'radio subtitle should store cleaned text')
  assert.equal(live.expanded, true, 'radio subtitle should be expanded immediately after an incoming chat')

  tick(8999)
  assert.equal(window.__voiceTest.getRadioSubtitle().expanded, true, 'radio subtitle should remain expanded until its configured dwell expires')
  tick(1)
  const stored = window.__voiceTest.getRadioSubtitle()
  assert.equal(stored.text, 'Radio line one now', 'last radio subtitle should persist until replaced')
  assert.equal(stored.expanded, false, 'radio subtitle should collapse after the expanded window')

  setPref('radio-subtitles-enabled', false)
  const disabled = window.__voiceTest.maybeShowRadioSubtitleForIncomingChat(
    { type: 'chat', from: 'fleet:frontier', to: 'fleet:skip', text: 'hidden while disabled' },
    agents,
    'fleet:skip',
  )
  assert.equal(disabled, false, 'radio subtitle toggle should suppress active-target incoming chat')
  assert.equal(window.__voiceTest.getRadioSubtitle().text, 'Radio line one now', 'disabled radio should not replace the current subtitle')
  setPref('radio-subtitles-enabled', true)

  const longShown = window.__voiceTest.maybeShowRadioSubtitleForIncomingChat(
    {
      type: 'chat',
      from: 'fleet:frontier',
      to: 'fleet:skip',
      text: `Frontier says [look here](https://example.com): ${'word '.repeat(180)}`,
    },
    agents,
    'fleet:skip',
  )
  assert.equal(longShown, true, 'long active-target chat should render in radio HUD')
  const longStored = window.__voiceTest.getRadioSubtitle()
  assert.ok(longStored.text.startsWith('Frontier says look here: word'), 'radio subtitle should clean markdown without punctuation gaps')
  assert.ok(longStored.text.length <= 700, 'radio subtitle should keep a bounded but readable excerpt')
  assert.ok(longStored.text.endsWith('...'), 'radio subtitle should mark truncated excerpts')
  assert.deepEqual(
    window.__voiceTest.getRadioHistory().map(item => item.text).slice(0, 2),
    [longStored.text, 'Radio line one now'],
    'radio history should keep newest messages first',
  )

  for (const text of ['trace alpha', 'trace beta', 'trace gamma']) {
    window.__voiceTest.maybeShowRadioSubtitleForIncomingChat(
      { type: 'chat', from: 'fleet:frontier', to: 'fleet:skip', text },
      agents,
      'fleet:skip',
    )
  }
  const history = window.__voiceTest.getRadioHistory()
  assert.equal(history.length, 4, 'radio history should stay bounded')
  assert.deepEqual(
    history.map(item => item.text),
    ['trace gamma', 'trace beta', 'trace alpha', longStored.text],
    'radio history should keep a short receding trace',
  )
  assert.ok(window.__voiceTest.getHudText().includes('frontier: trace beta'), 'HUD should include previous radio events while expanded')

  setPref('radio-subtitle-dwell-sec', 1)
  window.__voiceTest.maybeShowRadioSubtitleForIncomingChat(
    { type: 'chat', from: 'fleet:frontier', to: 'fleet:skip', text: 'minimum dwell' },
    agents,
    'fleet:skip',
  )
  tick(2999)
  assert.equal(window.__voiceTest.getRadioSubtitle().expanded, true, 'radio subtitle dwell should enforce the readable minimum')
  tick(1)
  assert.equal(window.__voiceTest.getRadioSubtitle().expanded, false, 'radio subtitle should collapse when the bounded minimum expires')

  setPref('radio-subtitle-dwell-sec', Infinity)
  window.__voiceTest.maybeShowRadioSubtitleForIncomingChat(
    { type: 'chat', from: 'fleet:frontier', to: 'fleet:skip', text: 'invalid dwell' },
    agents,
    'fleet:skip',
  )
  tick(14999)
  assert.equal(window.__voiceTest.getRadioSubtitle().expanded, true, 'non-finite persisted dwell should use the readable default')
  tick(1)
  assert.equal(window.__voiceTest.getRadioSubtitle().expanded, false, 'non-finite persisted dwell should expire at the readable default')

  setPref('radio-subtitle-dwell-sec', 1e20)
  window.__voiceTest.maybeShowRadioSubtitleForIncomingChat(
    { type: 'chat', from: 'fleet:frontier', to: 'fleet:skip', text: 'oversized dwell' },
    agents,
    'fleet:skip',
  )
  tick(119999)
  assert.equal(window.__voiceTest.getRadioSubtitle().expanded, true, 'oversized persisted dwell should remain visible until the sane maximum')
  tick(1)
  assert.equal(window.__voiceTest.getRadioSubtitle().expanded, false, 'oversized persisted dwell should expire at the sane maximum')

  window.location.search = ''
  location.search = ''
  document.querySelectorAll = originalQuerySelectorAll
  setPref('radio-subtitle-dwell-sec', 15)
  reset()
  console.log('✓ Test 22: radio subtitle is active-target, doc gated, toggleable, and collapses')
}

// Speech epoch: the shared send boundary advances once, stale producer output
// cannot enter the next composer, and Deepgram recovery preserves intent while
// pausing PCM until current-epoch readiness.
{
  window.__voiceTest.fakeDeepgramConnected()
  const relay = window.__voiceTest.fakeDeepgramRelay()
  const sent = []
  relay.send = (value) => sent.push(value)
  const before = window.__voiceTest.getState().speechEpoch
  window.__voiceTest.afterSend()
  const current = window.__voiceTest.getState().speechEpoch
  assert.equal(current, before + 1, 'the common send boundary advances exactly one epoch')
  assert.ok(sent.some(value => typeof value === 'string' && JSON.parse(value).type === 'speech_epoch'), 'Deepgram receives the new epoch before later PCM')

  window.__voiceTest.injectDeepgramMessage({ type: 'epoch_loss', epoch: current, queuedBytes: 4, reason: 'connect-failed' })
  assert.equal(window.__voiceTest.getState().recording, true, 'epoch loss preserves durable recording intent')
  assert.equal(window.__voiceTest.getState().pcmPaused, true, 'PCM pauses during same-epoch recovery')
  assert.equal(window.__voiceTest.simulateDeepgramAudioFrame(), false, 'unowned PCM is rejected while recovery is pending')
  window.__voiceTest.injectDeepgramMessage({ type: 'epoch_ready', epoch: current - 1 })
  assert.equal(window.__voiceTest.getState().pcmPaused, true, 'stale readiness cannot resume PCM')
  window.__voiceTest.injectDeepgramMessage({ type: 'epoch_ready', epoch: current })
  assert.equal(window.__voiceTest.getState().pcmPaused, false, 'current readiness resumes PCM')
  window.__voiceTest.injectDeepgramMessage({ type: 'status', status: 'connected', epoch: current })
  window.__voiceTest.injectDeepgramMessage({ type: 'status', status: 'error', epoch: current - 1 })
  assert.equal(window.__voiceTest.getState().recognizerStatus, 'connected', 'stale upstream status cannot mutate the current epoch')
  console.log('✓ Test 23: speech epoch boundary and intent-preserving Deepgram recovery')
}

console.log('\nAll voice tests passed.')
