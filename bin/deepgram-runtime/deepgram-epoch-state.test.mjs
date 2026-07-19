import assert from 'node:assert/strict'
import { acceptsSpeechEpoch, attemptOwnsTransition, canEnqueueEpochPcm, createEpochTransition, drainEpochPcm, enqueueEpochPcm, readyEpochTransition } from './deepgram-epoch-state.mjs'

assert.equal(canEnqueueEpochPcm(319999, 1, 320000), true, 'exact bound is accepted')
assert.equal(canEnqueueEpochPcm(319999, 2, 320000), false, 'first byte over is rejected before enqueue')
assert.equal(acceptsSpeechEpoch(null, 4), true, 'first control establishes an epoch')
assert.equal(acceptsSpeechEpoch(4, 4), false, 'same epoch control is rejected')
assert.equal(acceptsSpeechEpoch(4, 3), false, 'decreasing epoch control is rejected')
assert.equal(acceptsSpeechEpoch(4, 5), true, 'increasing epoch control is accepted')

const transition = createEpochTransition(5, 11)
const first = Buffer.from([1, 2])
const second = Buffer.from([3, 4])
assert.equal(enqueueEpochPcm(transition, first, 4), true, 'binary after control is owned while connect is pending')
assert.equal(enqueueEpochPcm(transition, second, 4), true, 'exact-bound binary remains owned')
assert.equal(enqueueEpochPcm(transition, Buffer.from([5]), 4), false, 'overflow frame is rejected without mutation')
assert.equal(transition.pcmBytes, 4)
assert.equal(attemptOwnsTransition(transition, 5, 10), false, 'older same-epoch attempt is stale')
assert.equal(attemptOwnsTransition(transition, 5, 11), true, 'current attempt owns readiness')
const drained = []
drainEpochPcm(transition, frame => { drained.push(...frame); return true })
assert.deepEqual(drained, [1, 2, 3, 4], 'ready drains queued PCM once in FIFO order')
assert.equal(transition.pcmBytes, 0)
drainEpochPcm(transition, frame => { drained.push(...frame); return true })
assert.deepEqual(drained, [1, 2, 3, 4], 'a second readiness cannot redrain PCM')

const partial = createEpochTransition(6, 12)
enqueueEpochPcm(partial, Buffer.from([1, 2]), 8)
enqueueEpochPcm(partial, Buffer.from([3, 4]), 8)
enqueueEpochPcm(partial, Buffer.from([5, 6]), 8)
const partialSent = []
assert.equal(drainEpochPcm(partial, frame => {
  if (frame[0] === 3) return false
  partialSent.push(...frame)
  return true
}), false, 'mid-drain send failure is explicit')
assert.deepEqual(partialSent, [1, 2], 'only successfully delivered frames leave ownership')
assert.deepEqual(partial.pcmQueue.map(frame => [...frame]), [[3, 4], [5, 6]], 'failed and later frames remain owned for loss accounting')
assert.equal(partial.pcmBytes, 4, 'remaining byte count is exact after partial failure')
assert.equal(partial.state, 'connecting', 'failed drain never reports ready')

const overflowed = createEpochTransition(7, 20)
enqueueEpochPcm(overflowed, Buffer.from([1, 2]), 2)
assert.equal(enqueueEpochPcm(overflowed, Buffer.from([3]), 2), false)
overflowed.state = 'recovering'
const staleOpenSent = []
assert.equal(readyEpochTransition(overflowed, 7, 20, frame => { staleOpenSent.push(...frame); return true }), 'stale', 'overflow revokes readiness from the pending attempt')
assert.deepEqual(staleOpenSent, [], 'old attempt opening after overflow cannot drain')
assert.equal(overflowed.pcmBytes, 2, 'old attempt leaves failed epoch ownership intact')
const recovered = createEpochTransition(7, 21)
enqueueEpochPcm(recovered, Buffer.from([4, 5]), 2)
const recoverySent = []
assert.equal(readyEpochTransition(recovered, 7, 20, () => true), 'stale', 'old same-epoch attempt cannot ready the fresh recovery transition')
assert.equal(readyEpochTransition(recovered, 7, 21, frame => { recoverySent.push(...frame); return true }), 'ready', 'fresh same-epoch recovery attempt alone can ready')
assert.deepEqual(recoverySent, [4, 5])
console.log('deepgram epoch queue bound tests passed')
