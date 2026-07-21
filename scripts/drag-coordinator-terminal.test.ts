import assert from 'node:assert/strict'
import test from 'node:test'

const doc = new EventTarget() as EventTarget & { hidden: boolean }
doc.hidden = false
const win = new EventTarget()
Object.assign(globalThis, { document: doc, window: win })
const { dragCoordinator } = await import('../src/shapes/dragCoordinator')

function claimCounters() {
  const counts = { up: 0, cancel: 0 }
  dragCoordinator.claim(() => {}, () => { counts.up++ }, () => { counts.cancel++ })
  return counts
}

test('pointerup terminates through the success path', () => {
  const counts = claimCounters()
  doc.dispatchEvent(new Event('pointerup'))
  assert.deepEqual(counts, { up: 1, cancel: 0 })
  assert.equal(dragCoordinator.isActive, false)
})

for (const [name, target, event] of [
  ['pointercancel', doc, new Event('pointercancel')],
  ['lostpointercapture', doc, new Event('lostpointercapture')],
  ['blur', win, new Event('blur')],
  ['pagehide', win, new Event('pagehide')],
] as const) {
  test(`${name} terminates through the idempotent cancel path`, () => {
    const counts = claimCounters()
    target.dispatchEvent(event)
    target.dispatchEvent(event)
    assert.deepEqual(counts, { up: 0, cancel: 1 })
    assert.equal(dragCoordinator.isActive, false)
  })
}

test('Escape and hidden visibility terminate through cancel', () => {
  let counts = claimCounters()
  const escape = new Event('keydown') as Event & { key: string }
  escape.key = 'Escape'
  doc.dispatchEvent(escape)
  assert.equal(counts.cancel, 1)

  counts = claimCounters()
  doc.hidden = true
  doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(counts.cancel, 1)
  doc.hidden = false
})

test('custom drag owner cleanup cancels only its own active claim', () => {
  const first = { cancel: 0 }
  const releaseFirst = dragCoordinator.claim(() => {}, () => {}, () => { first.cancel++ })
  const second = { cancel: 0 }
  const releaseSecond = dragCoordinator.claim(() => {}, () => {}, () => { second.cancel++ })
  assert.equal(first.cancel, 1)
  releaseFirst()
  assert.equal(dragCoordinator.isActive, true)
  assert.equal(second.cancel, 0)
  releaseSecond()
  releaseSecond()
  assert.equal(second.cancel, 1)
  assert.equal(dragCoordinator.isActive, false)
})
