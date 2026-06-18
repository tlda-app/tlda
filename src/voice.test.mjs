// voice.test.mjs — state machine tests for voice.mjs
// Run with: node src/voice.test.mjs

import assert from 'node:assert/strict'

// ---- Fake timers ----
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
let startCount = 0
class MockSpeechRecognition {
  constructor() { mockRec = this }
  start() { startCount++ }
  stop() { this.onend?.() }
  abort() {}
}

// ---- Mock document ----
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

// ---- Mock BroadcastChannel ----
let micChannel = null
class MockBroadcastChannel {
  constructor() { micChannel = this }
  postMessage() {}
}
global.BroadcastChannel = MockBroadcastChannel
class MockWebSocket {
  static OPEN = 1
  constructor() {
    this.readyState = MockWebSocket.OPEN
    setTimeout(() => this.onopen?.(), 0)
  }
  send() {}
  close() { this.readyState = 3; this.onclose?.() }
}
global.WebSocket = MockWebSocket

// ---- Mock fetch (whisper detection fails → falls back to Web Speech API) ----
global.fetch = () => Promise.reject(new Error('no whisper'))
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
const { initVoice, setVoiceTarget, setVoiceAccumulator, clearVoiceAccumulator, toggleRecording, isRecording, getGeneration, enterVoiceSink, setBackend } = await import('./voice.mjs')
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
      for (const fn of listeners.get(event.type) || []) fn(event)
      return !event.defaultPrevented
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || []
      const i = list.indexOf(fn)
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
    sendFn(targets, text)
    ta.value = ''
    ta.style.height = 'auto'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function reset() {
  if (isRecording()) toggleRecording()
  timers.length = 0
  intervals.length = 0
  startCount = 0
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
  const genBefore = getGeneration()

  // Speak a phrase then say "send"
  oldRec.onresult({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: 'hello world send' } }]
  })
  assert.equal(sentText, 'hello world', 'send keyword should trigger send')
  const genAfter = getGeneration()
  assert.ok(genAfter > genBefore, 'generation should have been bumped on send')

  // Now simulate a stale in-flight result arriving from the OLD session.
  // oldRec still has the old myGeneration snapshot in its closure, so its
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

  // Interim may contain the magic word, but Deepgram must only submit on final.
  window.__voiceTest.injectTranscript('hello world send', false)
  assert.equal(sent.length, 0, 'interim magic word should not send')

  window.__voiceTest.injectTranscript('hello world send', true)
  assert.deepEqual(sent, ['hello world'], 'final magic word should press Enter once with cleaned text')

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

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8: Deepgram magic-word submits once via Enter')
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

// ---- Test 8c: Sink escalation clears only live sink interim ----
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
  assert.equal(state.state, 'edit', 'second sink tap clears the current sink segment')
  assert.equal(state.interim, '', 'live sink interim is cleared')
  assert.ok(ta.value.includes('ambient'), 'second sink tap still does not rewrite prior target text')

  window.__voiceTest.fakeStop()
  reset()
  console.log('✓ Test 8c: sink escalation clears only live sink interim')
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
// Regression: after "left chat" command, _generation is bumped before onend fires.
// onend must call _setupRecognition() so the new session has an updated myGeneration
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
  const genBefore = getGeneration()

  // Fire onend as if stop() completed after a generation bump.
  // The onend handler should detect the stale generation and call _setupRecognition().
  // We simulate the generation bump that happens in setVoiceTarget (target switch).
  const ta2 = makeTextarea()
  setVoiceTarget(ta2, ['fleet:abc'], { 'fleet:abc': 'agent' }, sendFn)
  // setVoiceTarget bumped _generation; now simulate the old session's onend firing
  const genAfterSwitch = getGeneration()
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

console.log('\nAll 12 tests passed.')
