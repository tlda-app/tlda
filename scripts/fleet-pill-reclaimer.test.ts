import assert from 'node:assert/strict'
import test from 'node:test'
import { markFleetPillActive, isFleetPillActive } from '../src/shapes/fleet-pill-policy'

import { installFleetPillReclaimerWithIdentity } from '../src/shapes/fleet-pill-reclaimer'

type Shape = { id: string; type: string; props: Record<string, unknown>; revision?: number }

class FakeTimers {
  now = 0
  nextId = 1
  jobs = new Map<number, { at: number; fn: () => void }>()
  set = (fn: () => void, delay = 0) => {
    const id = this.nextId++
    this.jobs.set(id, { at: this.now + delay, fn })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clear = (id: ReturnType<typeof setTimeout>) => this.jobs.delete(id as unknown as number)
  advance(ms: number) {
    const end = this.now + ms
    while (true) {
      const next = [...this.jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.now = next[1].at
      this.jobs.delete(next[0])
      next[1].fn()
    }
    this.now = end
  }
}

function harness(initial: Shape[]) {
  const shapes = new Map(initial.map(shape => [shape.id, shape]))
  let listener: ((event: any) => void) | undefined
  const editor = {
    getCurrentPageShapes: () => [...shapes.values()],
    getShape: (id: string) => shapes.get(id),
    deleteShapes: (ids: string[]) => ids.forEach(id => shapes.delete(id)),
    run: (fn: () => void) => fn(),
    store: { listen: (fn: (event: any) => void) => { listener = fn; return () => { listener = undefined } } },
  }
  return {
    editor,
    shapes,
    update(shape: Shape) {
      shapes.set(shape.id, shape)
      listener?.({ changes: { updated: { [shape.id]: [null, shape] } } })
    },
  }
}

function install(initial: Shape[], initialIdentity = { userId: 'fleet:me', deviceId: 'phone' }) {
  const timers = new FakeTimers()
  const h = harness(initial)
  const windowTarget = new EventTarget()
  const documentTarget = new EventTarget() as EventTarget & { hidden: boolean }
  documentTarget.hidden = false
  let identity = initialIdentity
  const cleanup = installFleetPillReclaimerWithIdentity(h.editor as any, {
    now: () => timers.now,
    setTimer: timers.set as any,
    clearTimer: timers.clear as any,
    windowTarget: windowTarget as any,
    documentTarget: documentTarget as any,
    getIdentity: () => identity,
  })!
  return {
    ...h,
    timers,
    windowTarget,
    documentTarget,
    cleanup,
    setIdentity(next: { userId: string; deviceId: string }) { identity = next },
  }
}

const legacy = (id = 'shape:legacy'): Shape => ({ id, type: 'fleet-pill', props: {} })
const owned = (id = 'shape:owned'): Shape => ({ id, type: 'fleet-pill', props: { userId: 'fleet:me', deviceId: 'phone', createdAt: 0, ephemeral: true } })

test('legacy grace is unchanged at 3s and an update restarts it', () => {
  const h = install([legacy()])
  h.timers.advance(2_999)
  assert.equal(h.shapes.has('shape:legacy'), true)
  h.update({ ...legacy(), revision: 2 })
  h.timers.advance(2_999)
  assert.equal(h.shapes.has('shape:legacy'), true)
  h.timers.advance(1)
  assert.equal(h.shapes.has('shape:legacy'), false)
  h.cleanup()
})

test('own stamped pill is reclaimed at 10s', () => {
  const h = install([owned()])
  h.timers.advance(9_999)
  assert.equal(h.shapes.has('shape:owned'), true)
  h.timers.advance(1)
  assert.equal(h.shapes.has('shape:owned'), false)
  h.cleanup()
})

test('identity resolved after install is used by the stale timer without remounting', () => {
  const h = install([], { userId: '', deviceId: '' })
  h.setIdentity({ userId: 'fleet:me', deviceId: 'phone' })
  h.update(owned())
  h.timers.advance(10_000)
  assert.equal(h.shapes.has('shape:owned'), false)
  h.cleanup()
})

for (const terminal of ['blur', 'pagehide'] as const) {
  test(`identity resolved after install is used by ${terminal} cleanup without remounting`, () => {
    const h = install([], { userId: '', deviceId: '' })
    h.setIdentity({ userId: 'fleet:me', deviceId: 'phone' })
    h.update(owned())
    markFleetPillActive('shape:owned')
    h.windowTarget.dispatchEvent(new Event(terminal))
    assert.equal(h.shapes.has('shape:owned'), false)
    assert.equal(isFleetPillActive('shape:owned'), false)
    h.cleanup()
  })
}

test('other user/device and non-ephemeral pills are excluded', () => {
  const h = install([
    { ...owned('shape:user'), props: { ...owned().props, userId: 'fleet:other' } },
    { ...owned('shape:device'), props: { ...owned().props, deviceId: 'tablet' } },
    { ...owned('shape:content'), props: { ...owned().props, ephemeral: false } },
  ])
  h.timers.advance(20_000)
  assert.deepEqual([...h.shapes.keys()].sort(), ['shape:content', 'shape:device', 'shape:user'])
  h.cleanup()
})

test('native terminal and editor unmount delete only the active local pill and clear active state', () => {
  const h = install([owned(), { ...owned('shape:other'), props: { ...owned().props, userId: 'fleet:other' } }])
  markFleetPillActive('shape:owned')
  markFleetPillActive('shape:other')
  h.windowTarget.dispatchEvent(new Event('blur'))
  assert.equal(h.shapes.has('shape:owned'), false)
  assert.equal(isFleetPillActive('shape:owned'), false)
  assert.equal(h.shapes.has('shape:other'), true)
  assert.equal(isFleetPillActive('shape:other'), true)
  h.cleanup()
  assert.equal(h.timers.jobs.size, 0)
  // The foreign active marker is not ours to clear.
  assert.equal(isFleetPillActive('shape:other'), true)
})

test('editor unmount clears timers and deletes an in-flight local pill', () => {
  const h = install([owned()])
  markFleetPillActive('shape:owned')
  h.cleanup()
  assert.equal(h.shapes.has('shape:owned'), false)
  assert.equal(isFleetPillActive('shape:owned'), false)
  assert.equal(h.timers.jobs.size, 0)
})

for (const terminal of ['pagehide', 'Escape', 'hidden visibility'] as const) {
  test(`native ${terminal} terminal deletes its active local pill`, () => {
    const id = `shape:${terminal}`
    const h = install([owned(id)])
    markFleetPillActive(id)
    if (terminal === 'pagehide') h.windowTarget.dispatchEvent(new Event('pagehide'))
    if (terminal === 'Escape') {
      const event = new Event('keydown') as Event & { key: string }
      event.key = 'Escape'
      h.documentTarget.dispatchEvent(event)
    }
    if (terminal === 'hidden visibility') {
      h.documentTarget.hidden = true
      h.documentTarget.dispatchEvent(new Event('visibilitychange'))
    }
    assert.equal(h.shapes.has(id), false)
    assert.equal(isFleetPillActive(id), false)
    h.cleanup()
  })
}
