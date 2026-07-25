import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PcmBacklog, composeVoiceText, deliverVoiceComposition, partitionAtCursor, pcmInputLevel, voiceIndicatorState } from '../src/voice-indicator.mjs'

assert.equal(voiceIndicatorState(false, 'speech detected'), 'off')
// The two steady states are rendered as visible text in a centered, fixed-width row,
// so their equal width (8 chars each) is load-bearing — unequal lengths make the panel
// shift on every transition. Asserted here so a future rename has to notice.
assert.equal(voiceIndicatorState(true, 'mic live'), 'mic live')
assert.equal(voiceIndicatorState(true, 'speech detected'), 'speaking')
assert.equal(
  voiceIndicatorState(true, 'mic live').length,
  voiceIndicatorState(true, 'speech detected').length,
  'steady-state labels must be equal width or the voice panel strobes while dictating',
)
assert.equal(voiceIndicatorState(true, 'connection lost; reconnecting'), 'reconnecting')
assert.equal(voiceIndicatorState(true, 'speech lost; recognizer recovering'), 'reconnecting')
assert.equal(voiceIndicatorState(true, 'waiting for recognizer'), 'reconnecting')
assert.equal(pcmInputLevel(new Int16Array(128).buffer), 0)
assert.ok(pcmInputLevel(new Int16Array(128).fill(8192).buffer) > 0.9)
assert.equal(pcmInputLevel(new ArrayBuffer(0)), 0)
const detachedTextarea = { value: 'kept', isConnected: false }
const detachedReceipt = deliverVoiceComposition(detachedTextarea, { left: '', interim: 'lost', right: '' }, () => { throw new Error('detached target must not be written') })
assert.deepEqual(detachedReceipt, {
  connectedBefore: false, connectedAfter: false, beforeLength: 4, afterLength: 4, written: false,
})
assert.equal(detachedTextarea.value, 'kept')
const connectedTextarea = { value: 'before', isConnected: true, selectionStart: 6, selectionEnd: 6 }
const connectedReceipt = deliverVoiceComposition(connectedTextarea, { left: 'a ', interim: 'live ', right: 'cursor' }, (textarea, text) => { textarea.value = text })
assert.deepEqual(connectedReceipt, {
  connectedBefore: true, connectedAfter: true, beforeLength: 6, afterLength: 13, written: true,
})
assert.equal(connectedTextarea.value, 'a live cursor')
assert.deepEqual(partitionAtCursor('abcXYZdef', 3), { left: 'abc', interim: '', right: 'XYZdef', cursor: 3 })
assert.deepEqual(partitionAtCursor('abcXYZdef', 3, 6), { left: 'abc', interim: '', right: 'def', cursor: 3 })
assert.equal(composeVoiceText('hello ', 'new ', 'world'), 'hello new world')
const chatComposerSource = readFileSync(new URL('../src/shapes/ChatComposer.tsx', import.meta.url), 'utf8')
assert.match(chatComposerSource, /const textarea = inputRef\.current\s+return \(\) => \{ if \(textarea\) clearVoiceTarget\(textarea\) \}/)
assert.match(chatComposerSource, /completeMessageSend\(text\)/)
const voiceSource = readFileSync(new URL('../src/voice.mjs', import.meta.url), 'utf8')
assert.doesNotMatch(voiceSource, /retainVoiceTextareaValue|retention-check|retained/)
assert.doesNotMatch(voiceSource, /hardResetVoice\(\{ keepDeepgramMic: true \}\)/)
assert.match(voiceSource, /if \(msg\.type === 'utterance_end'\) \{[\s\S]*?_dgLastFinalAt = 0\s+return\s+\}/)
assert.doesNotMatch(voiceSource, /if \(msg\.is_final && !_dgHasSeenInterim && _state === 'edit'\) return/)
assert.match(voiceSource, /const partition = partitionAtCursor\(ta\?\.value, ta\?\.selectionStart, ta\?\.selectionEnd\)/)
assert.match(voiceSource, /function afterSend\(submittedTextOverride\) \{\s+const submittedText = submittedTextOverride \?\? currentSubmittedVoiceText\(\)/)
assert.match(voiceSource, /if \(\(msg\.type === 'transcript' \|\| msg\.type === 'speech_started' \|\| msg\.type === 'utterance_end'\) && msg\.epoch !== _speechEpoch\) return/)
assert.doesNotMatch(voiceSource, /onaudioprocess[\s\S]*?fillTextarea|process =[\s\S]*?fillTextarea/)
const backlog = new PcmBacklog()
backlog.push(7, new Uint8Array([1]).buffer)
backlog.push(7, new Uint8Array([2]).buffer)
const delivered = []
assert.equal(backlog.drain(7, chunk => { delivered.push(new Uint8Array(chunk)[0]); return true }), true)
assert.deepEqual(delivered, [1, 2])
assert.equal(backlog.length, 0)
backlog.push(7, new Uint8Array([3]).buffer)
backlog.push(7, new Uint8Array([4]).buffer)
assert.equal(backlog.drain(7, chunk => new Uint8Array(chunk)[0] !== 3), false)
assert.equal(backlog.length, 2)

// afterSend()/hard reset advance the speech epoch. Old PCM must not cross that
// boundary even if a caller missed the eager clear; current-epoch PCM still
// drains in capture order.
backlog.clear()
backlog.push(8, new Uint8Array([8]).buffer)
backlog.push(9, new Uint8Array([9]).buffer)
const nextEpochDelivered = []
assert.equal(backlog.drain(9, chunk => { nextEpochDelivered.push(new Uint8Array(chunk)[0]); return true }), true)
assert.deepEqual(nextEpochDelivered, [9])
assert.equal(backlog.length, 0)

// hardResetVoice() eagerly clears the epoch-owned queue before reconnecting.
backlog.push(10, new Uint8Array([10]).buffer)
backlog.clear()
const afterResetDelivered = []
assert.equal(backlog.drain(10, chunk => { afterResetDelivered.push(new Uint8Array(chunk)[0]); return true }), true)
assert.deepEqual(afterResetDelivered, [])

const boundedBacklog = new PcmBacklog({ maxBytes: 2, maxAgeMs: 1000 })
boundedBacklog.push(11, new Uint8Array([1]).buffer)
boundedBacklog.push(11, new Uint8Array([2]).buffer)
boundedBacklog.push(11, new Uint8Array([3]).buffer)
const boundedSnapshot = boundedBacklog.snapshot()
assert.equal(boundedSnapshot.frames, 2)
assert.equal(boundedSnapshot.bytes, 2)
assert.equal(boundedSnapshot.droppedFrames, 1)
assert.equal(boundedSnapshot.flushedFrames, 0)
assert.equal(boundedSnapshot.maxBytes, 2)
assert.equal(boundedSnapshot.maxAgeMs, 1000)
assert.ok(Number.isFinite(boundedSnapshot.oldestAgeMs))
assert.deepEqual({
  ...boundedSnapshot,
  oldestAgeMs: 0,
}, {
  frames: 2,
  bytes: 2,
  oldestAgeMs: 0,
  droppedFrames: 1,
  flushedFrames: 0,
  maxBytes: 2,
  maxAgeMs: 1000,
})
const boundedDelivered = []
assert.equal(boundedBacklog.drain(11, chunk => { boundedDelivered.push(new Uint8Array(chunk)[0]); return true }), true)
assert.deepEqual(boundedDelivered, [2, 3])
assert.equal(boundedBacklog.snapshot().flushedFrames, 2)
console.log('voice indicator tests passed')
