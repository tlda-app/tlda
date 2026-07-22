import assert from 'node:assert/strict'
import { PcmBacklog, pcmInputLevel, voiceIndicatorState } from '../src/voice-indicator.mjs'

assert.equal(voiceIndicatorState(false, 'speech detected'), 'off')
assert.equal(voiceIndicatorState(true, 'mic live'), 'listening')
assert.equal(voiceIndicatorState(true, 'speech detected'), 'receiving audio')
assert.equal(voiceIndicatorState(true, 'connection lost; reconnecting'), 'reconnecting')
assert.equal(voiceIndicatorState(true, 'speech lost; recognizer recovering'), 'reconnecting')
assert.equal(voiceIndicatorState(true, 'waiting for recognizer'), 'reconnecting')
assert.equal(pcmInputLevel(new Int16Array(128).buffer), 0)
assert.ok(pcmInputLevel(new Int16Array(128).fill(8192).buffer) > 0.9)
assert.equal(pcmInputLevel(new ArrayBuffer(0)), 0)
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
