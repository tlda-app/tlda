import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditClusterDebouncer } from './edit-cluster.mjs'

function manualClock() {
  let callback = null
  return {
    clearTimeout() { callback = null },
    setTimeout(next) {
      callback = next
      return { unref() {} }
    },
    async fire() {
      const next = callback
      callback = null
      if (next) await next()
    },
  }
}

test('a mirror does not carry its own settle event into the next head observation', async () => {
  const clock = manualClock()
  let settlements = 0
  let cluster
  cluster = createEditClusterDebouncer({
    sourceDir: '/course',
    clock,
    onSettled: async () => {
      settlements += 1
      cluster.note('/course/index.qmd')
    },
  })

  cluster.note('/course/index.qmd')
  await cluster.serializeMirror(async () => {
    await clock.fire()
  }, async () => false)
  await cluster.serializeMirror(async () => {}, async () => false)

  assert.equal(settlements, 1)
  assert.deepEqual(cluster.state(), { open: false, mirrorDepth: 0, queued: 0 })
})

test('a real edit during the pre-mirror settle remains queued', async () => {
  const clock = manualClock()
  let settlements = 0
  let cluster
  cluster = createEditClusterDebouncer({
    sourceDir: '/course',
    clock,
    onSettled: async () => {
      settlements += 1
      if (settlements === 1) cluster.note('/course/lecture.qmd')
    },
  })

  cluster.note('/course/index.qmd')
  await cluster.serializeMirror(async () => {}, async paths => paths.includes('/course/lecture.qmd'))
  assert.deepEqual(cluster.state(), { open: true, mirrorDepth: 0, queued: 0 })

  await clock.fire()
  assert.equal(settlements, 2)
  assert.deepEqual(cluster.state(), { open: false, mirrorDepth: 0, queued: 0 })
})
