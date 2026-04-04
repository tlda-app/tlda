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
// Advance clock by ms, firing any timers whose fireAt <= new clock value.
function tick(ms) {
  clock += ms
  const fire = timers.filter(t => t.fireAt <= clock).sort((a, b) => a.fireAt - b.fireAt)
  for (const t of fire) {
    const i = timers.findIndex(x => x.id === t.id)
    if (i !== -1) { timers.splice(i, 1); t.fn() }
  }
}

global.requestAnimationFrame = fn => { fn(); return 0 }
global.Event = class Event { constructor(type) { this.type = type } }

// ---- Mock SpeechRecognition ----
let mockRec = null
let startCount = 0
class MockSpeechRecognition {
  constructor() { mockRec = this }
  start() { startCount++ }
  stop() { this.onend?.() }
}

// ---- Mock document ----
const mockDiv = { textContent: '', style: {}, id: '' }
global.document = {
  createElement: () => mockDiv,
  body: { appendChild: () => {} },
  addEventListener: () => {},
}

// ---- Mock BroadcastChannel ----
let micChannel = null
class MockBroadcastChannel {
  constructor() { micChannel = this }
  postMessage() {}
}
global.BroadcastChannel = MockBroadcastChannel

// ---- Setup window before import ----
global.window = { SpeechRecognition: MockSpeechRecognition }

// ---- Import module ----
const { initVoice, setVoiceTarget, toggleRecording, isRecording } = await import('./voice.mjs')

function makeTextarea() {
  return { value: '', style: {}, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} }
}

function reset() {
  if (isRecording()) toggleRecording()
  timers.length = 0
  startCount = 0
}

// ---- Test 1: Happy path ----
{
  initVoice()
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

// ---- Test 4: Watchdog restarts recognition after 8s silence ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()

  toggleRecording()
  tick(300)  // fire doStart → recognition starts, watchdog set for +8000ms
  assert.equal(startCount, 1, 'initial start')
  assert.ok(isRecording())

  // 8 seconds with no onresult → watchdog fires → restart
  tick(8000)
  assert.equal(startCount, 2, 'watchdog should have restarted recognition')
  assert.ok(isRecording(), 'should still be recording after watchdog restart')

  reset()
  console.log('✓ Test 4: Watchdog restarts recognition after 8s silence')
}

console.log('\nAll 4 tests passed.')
