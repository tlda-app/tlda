import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PcmBacklog, deliverVoiceTextareaValue, pcmInputLevel, retainVoiceTextareaValue, voiceIndicatorState } from '../src/voice-indicator.mjs'

assert.equal(voiceIndicatorState(false, 'speech detected'), 'off')
assert.equal(voiceIndicatorState(true, 'mic live'), 'listening')
assert.equal(voiceIndicatorState(true, 'speech detected'), 'receiving audio')
assert.equal(voiceIndicatorState(true, 'connection lost; reconnecting'), 'reconnecting')
assert.equal(voiceIndicatorState(true, 'speech lost; recognizer recovering'), 'reconnecting')
assert.equal(voiceIndicatorState(true, 'waiting for recognizer'), 'reconnecting')
assert.equal(pcmInputLevel(new Int16Array(128).buffer), 0)
assert.ok(pcmInputLevel(new Int16Array(128).fill(8192).buffer) > 0.9)
assert.equal(pcmInputLevel(new ArrayBuffer(0)), 0)
const detachedTextarea = { value: 'kept', isConnected: false }
const detachedReceipt = deliverVoiceTextareaValue(detachedTextarea, 'lost', () => { throw new Error('detached target must not be written') })
assert.deepEqual(detachedReceipt, {
  connectedBefore: false, connectedAfter: false, beforeLength: 4, afterLength: 4, retained: false,
})
assert.equal(detachedTextarea.value, 'kept')
const connectedTextarea = { value: 'before', isConnected: true }
const connectedReceipt = deliverVoiceTextareaValue(connectedTextarea, 'after', (textarea, text) => { textarea.value = text })
assert.deepEqual(connectedReceipt, {
  connectedBefore: true, connectedAfter: true, beforeLength: 6, afterLength: 5, retained: true,
})
assert.equal(connectedTextarea.value, 'after')
assert.equal(retainVoiceTextareaValue(connectedTextarea, 'after', connectedReceipt).retained, true)
connectedTextarea.value = 'overwritten'
assert.deepEqual(retainVoiceTextareaValue(connectedTextarea, 'after', connectedReceipt), {
  connectedBefore: true, connectedAfter: true, beforeLength: 6, afterLength: 11, retained: false,
})
const chatComposerSource = readFileSync(new URL('../src/shapes/ChatComposer.tsx', import.meta.url), 'utf8')
assert.match(chatComposerSource, /const textarea = inputRef\.current\s+return \(\) => \{ if \(textarea\) clearVoiceTarget\(textarea\) \}/)
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
console.log('voice indicator tests passed')
