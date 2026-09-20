import test from 'node:test'
import assert from 'node:assert/strict'
import { replyKind, replyTarget, type PlayingLayer } from '../src/classroom/replyLayer'
import { WarpRecorder, warpAt } from '../shared/annotation-thread.mjs'

const ANSWER = { submissionRoomId: 'doc-sub-ada', problemId: 'ans-ex3' }

test('with nothing playing, plus starts the answer\'s first layer', () => {
  const target = replyTarget(ANSWER, null)
  assert.deepEqual(target, { answer: ANSWER })
  assert.equal(target.parentLayerId, undefined, 'a root layer answers nothing')
  assert.equal(replyKind(null), 'first')
})

test('while a layer is playing, plus answers that layer', () => {
  const playing: PlayingLayer = { layerId: 'layer-1', currentMs: () => 2000 }
  const target = replyTarget(ANSWER, playing)
  assert.equal(target.parentLayerId, 'layer-1')
  assert.equal(replyKind(playing), 'reply')
})

test('the parent playhead is read when sampled, not captured when plus is pressed', () => {
  // The distinction the warp lives on. A snapshot taken at press time would
  // make every sample report the same parent position, which reads back as the
  // reader having stared at one instant for the whole reply.
  let playhead = 0
  const target = replyTarget(ANSWER, { layerId: 'layer-1', currentMs: () => playhead })

  let layerTime = 0
  const warp = new WarpRecorder({
    layerTime: () => layerTime,
    parentTime: target.parentTime!,
  })
  for (const [t, pt] of [[0, 0], [100, 100], [200, 200]]) {
    layerTime = t
    playhead = pt
    warp.tick()
  }
  assert.equal(warpAt(warp.warp, 100), 100, 'the parent moved while the reply recorded')
  assert.equal(warpAt(warp.warp, 200), 200)
})

test('replying to any layer is reaching it, not choosing it from a list', () => {
  // "Reply to anything" is realised by playing the thing and pressing plus, so
  // the target is whatever is open — including an early layer, not only the
  // most recent one.
  const early = replyTarget(ANSWER, { layerId: 'layer-1', currentMs: () => 0 })
  const late = replyTarget(ANSWER, { layerId: 'layer-9', currentMs: () => 0 })
  assert.equal(early.parentLayerId, 'layer-1')
  assert.equal(late.parentLayerId, 'layer-9')
})
