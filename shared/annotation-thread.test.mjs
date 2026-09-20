import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendWarpSample,
  composeAlongPath,
  emptyWarp,
  layerPath,
  repliesTo,
  threadLayers,
  threadRoots,
  warpAt,
  WarpRecorder,
} from './annotation-thread.mjs'

/** A warp from control points, bypassing the sampler's compression. */
const warpOf = (...pairs) => ({ samples: pairs.map(([t, pt]) => ({ t, pt })) })

test('playing along with the parent is slope one', () => {
  const warp = warpOf([0, 0], [1000, 1000])
  assert.equal(warpAt(warp, 0), 0)
  assert.equal(warpAt(warp, 500), 500)
  assert.equal(warpAt(warp, 1000), 1000)
})

test('talking over the answer holds the parent still while this layer advances', () => {
  // Played to 2s, then stopped there and talked for nine seconds.
  const warp = warpOf([0, 0], [2000, 2000], [11000, 2000])
  assert.equal(warpAt(warp, 2000), 2000)
  assert.equal(warpAt(warp, 6500), 2000, 'the parent does not move while he talks')
  assert.equal(warpAt(warp, 11000), 2000)
})

test('scrubbing back is a pair of samples sharing an instant, and reads as a jump', () => {
  // At 11s on his own clock he jumps the parent from 2s back to 0.5s.
  const warp = warpOf([0, 0], [2000, 2000], [11000, 2000], [11000, 500], [12000, 1500])

  assert.equal(warpAt(warp, 10999), 2000, 'just before the jump, still at 2s')
  assert.equal(warpAt(warp, 11000), 500, 'at the jump, the value after it')
  assert.equal(warpAt(warp, 11500), 1000, 'and it plays on from there')
})

test('the spec\'s own case round-trips: stopped for nine seconds, then jumped back', () => {
  // Built the way the sampler builds it — a reading per tick — and then read
  // back. This is the case the spec says cannot be derived from ink and audio.
  let warp = emptyWarp()
  for (let t = 0; t <= 2000; t += 100) warp = appendWarpSample(warp, t, t)
  for (let t = 2100; t <= 11000; t += 100) warp = appendWarpSample(warp, t, 2000)
  warp = appendWarpSample(warp, 11000, 500)
  for (let t = 11100; t <= 12000; t += 100) warp = appendWarpSample(warp, t, 500 + (t - 11000))

  assert.equal(warpAt(warp, 1000), 1000, 'playing along')
  assert.equal(warpAt(warp, 6500), 2000, 'the nine seconds he stopped for')
  assert.equal(warpAt(warp, 11000), 500, 'the jump back')
  assert.equal(warpAt(warp, 11500), 1000, 'playing on from where he jumped to')
})

test('a still playhead compresses to its endpoints without moving the function', () => {
  let warp = emptyWarp()
  for (let t = 0; t <= 9000; t += 100) warp = appendWarpSample(warp, t, 2000)

  assert.equal(warp.samples.length, 2, 'ninety-one readings of a still playhead are two points')
  assert.equal(warpAt(warp, 4500), 2000)
  assert.equal(warpAt(warp, 9000), 2000)
})

test('compression never flattens a recorded jump away', () => {
  let warp = emptyWarp()
  warp = appendWarpSample(warp, 0, 0)
  warp = appendWarpSample(warp, 1000, 1000)
  warp = appendWarpSample(warp, 1000, 0) // scrub back to the start
  warp = appendWarpSample(warp, 2000, 1000)

  assert.equal(warp.samples.length, 4)
  assert.equal(warpAt(warp, 999.9), 999.9, 'before the jump')
  assert.equal(warpAt(warp, 1000), 0, 'the jump survived')
})

test('two scrubs inside one instant keep the instant\'s endpoints', () => {
  // He drags the scrubber through 400 on his way to 50. The parent was never
  // shown at 400, so dropping it is the same function, not a lost reading.
  let warp = emptyWarp()
  for (const [t, pt] of [[0, 0], [1000, 1000], [1000, 400], [1000, 50], [2000, 1050]]) {
    warp = appendWarpSample(warp, t, pt)
  }
  assert.equal(warpAt(warp, 999.9), 999.9, 'before the scrub')
  assert.equal(warpAt(warp, 1000), 50, 'lands where he let go, not where he passed through')
  assert.equal(warpAt(warp, 1500), 550, 'and plays on from there')
})

test('a warp holds at its ends rather than extrapolating past what was recorded', () => {
  const warp = warpOf([1000, 500], [2000, 1500])
  assert.equal(warpAt(warp, 0), 500, 'before the first reading')
  assert.equal(warpAt(warp, 99999), 1500, 'after the last')
  assert.equal(warpAt(emptyWarp(), 1234), 0, 'a layer marked against no parent')
})

// --- recording a warp off a moving playhead ---

/** A marking session with both clocks under the test's hand. */
function session() {
  const state = { layer: 0, parent: 0 }
  const recorder = new WarpRecorder({
    layerTime: () => state.layer,
    parentTime: () => state.parent,
  })
  return {
    warp: () => recorder.warp,
    /** Let the parent play alongside for `ms`, ticking every 100ms. */
    play(ms) {
      for (let i = 0; i < ms; i += 100) {
        state.layer += 100
        state.parent += 100
        recorder.tick()
      }
    },
    /** Talk over a still answer for `ms`. */
    talk(ms) {
      for (let i = 0; i < ms; i += 100) {
        state.layer += 100
        recorder.tick()
      }
    },
    /** Move the playhead rather than letting it run. */
    scrubTo(pt) {
      state.parent = pt
      recorder.jump()
    },
  }
}

test('a recorded session reproduces the stop and the jump back', () => {
  const s = session()
  s.play(2000)   // watch the answer for two seconds
  s.talk(9000)   // stop on it and talk for nine
  s.scrubTo(500) // jump back to something they did earlier
  s.play(1000)   // and read on from there

  const warp = s.warp()
  assert.equal(warpAt(warp, 1000), 1000, 'playing along')
  assert.equal(warpAt(warp, 6500), 2000, 'held still through the nine seconds')
  assert.equal(warpAt(warp, 11000), 500, 'the jump back, at the instant it happened')
  assert.equal(warpAt(warp, 11500), 1000, 'reading on from where he jumped to')
})

test('the nine seconds he talked cost two samples, not ninety', () => {
  const s = session()
  s.play(2000)
  s.talk(9000)
  assert.ok(s.warp().samples.length <= 4, `steady ticking compressed to ${s.warp().samples.length} samples`)
})

test('a scrub between ticks is a step, never a ramp through the answer', () => {
  const s = session()
  s.play(1000)
  s.scrubTo(8000) // jump forward past a stretch that was never on screen
  s.talk(500)

  const warp = s.warp()
  assert.equal(warpAt(warp, 999.9), 999.9, 'before the jump')
  assert.equal(warpAt(warp, 1000), 8000, 'after it')
  // The stretch between 1000 and 8000 of the answer was skipped, so no moment
  // of this layer may claim to be looking at it.
  for (let t = 0; t <= 1500; t += 25) {
    const pt = warpAt(warp, t)
    assert.ok(pt <= 1000 || pt >= 8000, `layer time ${t} lands mid-skip at parent ${pt}`)
  }
})

test('a warp recorded against a parent nobody moved is flat, not empty', () => {
  const s = session()
  s.talk(3000)
  assert.equal(warpAt(s.warp(), 1500), 0)
  assert.equal(warpAt(s.warp(), 3000), 0)
})

// --- the thread ---

const ANSWER = { submissionRoomId: 'doc-sub-ana', problemId: 'ans-ex3' }
const OTHER = { submissionRoomId: 'doc-sub-ben', problemId: 'ans-ex3' }

const layer = (id, parentId, warp) => ({
  id,
  answer: ANSWER,
  parent: parentId ? { layerId: parentId, warp } : null,
})

test('a thread is the layers on one student\'s answer to one problem', () => {
  const layers = [
    layer('a', null),
    layer('b', 'a', warpOf([0, 0], [1000, 1000])),
    { id: 'x', answer: OTHER, parent: null },
  ]
  assert.deepEqual(threadLayers(layers, ANSWER).map((l) => l.id), ['a', 'b'])
  assert.deepEqual(threadRoots(threadLayers(layers, ANSWER)).map((l) => l.id), ['a'])
})

test('a reply may answer any earlier layer, not only the most recent', () => {
  const layers = [
    layer('a', null),
    layer('b', 'a', emptyWarp()),
    layer('c', 'a', emptyWarp()), // answers the root, not b
  ]
  assert.deepEqual(repliesTo(layers, 'a').map((l) => l.id), ['b', 'c'])
  assert.deepEqual(layerPath(layers, 'c').map((l) => l.id), ['a', 'c'])
})

test('two replies warping the same parent differently are two paths, not a conflict', () => {
  const layers = [
    layer('a', null),
    layer('b', 'a', warpOf([0, 0], [1000, 500])),  // b reads a at half speed
    layer('c', 'a', warpOf([0, 0], [1000, 2000])), // c reads a at double
  ]
  assert.deepEqual(composeAlongPath(layerPath(layers, 'b'), 1000), [500, 1000])
  assert.deepEqual(composeAlongPath(layerPath(layers, 'c'), 1000), [2000, 1000])
})

test('a path composes its warps in order, layer three through layer two to layer one', () => {
  const layers = [
    layer('one', null),
    layer('two', 'one', warpOf([0, 0], [1000, 500])),   // two's 1000 is one's 500
    layer('three', 'two', warpOf([0, 0], [1000, 1000])), // three's 1000 is two's 1000
  ]
  const path = layerPath(layers, 'three')
  assert.deepEqual(path.map((l) => l.id), ['one', 'two', 'three'])

  // three at 1000 → two at 1000 → one at 500. By hand, and then by compose.
  assert.deepEqual(composeAlongPath(path, 1000), [500, 1000, 1000])
  assert.deepEqual(composeAlongPath(path, 500), [250, 500, 500])
})

test('a pause deep in a path holds every ancestor still, not just the parent', () => {
  const layers = [
    layer('one', null),
    layer('two', 'one', warpOf([0, 0], [1000, 1000])),
    layer('three', 'two', warpOf([0, 0], [500, 500], [4000, 500])), // three talks over two
  ]
  const path = layerPath(layers, 'three')
  assert.deepEqual(composeAlongPath(path, 500), [500, 500, 500])
  assert.deepEqual(composeAlongPath(path, 4000), [500, 500, 4000], 'one and two both held')
})

test('a broken thread says what is broken rather than hanging', () => {
  const cycle = [layer('a', 'b', emptyWarp()), layer('b', 'a', emptyWarp())]
  assert.throws(() => layerPath(cycle, 'a'), /its own ancestor/)
  assert.throws(() => layerPath([layer('a', null)], 'nope'), /No layer nope/)
})

test('a thread whose root was never recorded still composes from the first mark', () => {
  // The student's answer is source + rendered work today, with no timeline of
  // its own, so the first marking layer has nothing to warp onto and is the
  // root. A reply to it warps normally. If a submission later carries its own
  // recording it becomes the root instead, and nothing here changes.
  const layers = [
    layer('first-mark', null),
    layer('reply', 'first-mark', warpOf([0, 0], [1000, 400])),
  ]
  const path = layerPath(layers, 'reply')
  assert.deepEqual(composeAlongPath(path, 1000), [400, 1000])
  assert.equal(composeAlongPath(path, 0)[0], 0)
})
