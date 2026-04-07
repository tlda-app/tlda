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
global.Event = class Event { constructor(type) { this.type = type } }

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

// ---- Mock fetch (whisper detection fails → falls back to Web Speech API) ----
global.fetch = () => Promise.reject(new Error('no whisper'))
global.AbortSignal = { timeout: () => ({}) }

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
  intervals.length = 0
  startCount = 0
}

// ---- Test 1: Happy path ----
{
  await initVoice()
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

  // 8s silence → watchdog fires (aborts old, schedules 250ms restart)
  tick(8000)
  assert.equal(startCount, 1, 'recognition not yet restarted — waiting 250ms')
  tick(250)   // 250ms abort-delay fires → new recognition started
  assert.equal(startCount, 2, 'watchdog should have restarted recognition')
  assert.ok(isRecording(), 'should still be recording after watchdog restart')

  reset()
  console.log('✓ Test 4: Watchdog restarts recognition after 8s silence')
}

// ---- Test 5: Session timer restarts recognition after 45s ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()

  toggleRecording()
  tick(300)   // fire doStart
  assert.equal(startCount, 1, 'initial start')

  tick(45000) // session timer fires → aborts old, schedules 250ms restart
  assert.equal(startCount, 1, 'recognition not yet restarted — waiting 250ms')
  tick(250)   // restart fires
  assert.equal(startCount, 2, 'session timer should have restarted recognition')
  assert.ok(isRecording(), 'should still be recording after session restart')

  reset()
  console.log('✓ Test 5: Session timer restarts recognition after 45s')
}

// ---- Test 6: stopRecording clears session timer and sleep interval ----
{
  const ta = makeTextarea()
  setVoiceTarget(ta, [], {})
  reset()

  toggleRecording()
  tick(300)
  assert.equal(startCount, 1, 'initial start')
  assert.ok(intervals.length > 0, 'sleep detection interval should be active')

  toggleRecording()  // stop
  assert.ok(!isRecording(), 'should have stopped')
  assert.equal(intervals.length, 0, 'sleep detection interval should be cleared')
  assert.ok(!timers.find(t => t.fireAt >= clock + 44000), 'session timer should be cleared')

  reset()
  console.log('✓ Test 6: stopRecording clears session timer and sleep interval')
}

console.log('\nAll 6 tests passed.')
