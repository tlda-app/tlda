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
backlog.push(new Uint8Array([1]).buffer)
backlog.push(new Uint8Array([2]).buffer)
const delivered = []
assert.equal(backlog.drain(chunk => { delivered.push(new Uint8Array(chunk)[0]); return true }), true)
assert.deepEqual(delivered, [1, 2])
assert.equal(backlog.length, 0)
backlog.push(new Uint8Array([3]).buffer)
backlog.push(new Uint8Array([4]).buffer)
assert.equal(backlog.drain(chunk => new Uint8Array(chunk)[0] !== 3), false)
assert.equal(backlog.length, 2)
console.log('voice indicator tests passed')
