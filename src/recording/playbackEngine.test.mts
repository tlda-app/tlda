/**
 * Deterministic test of the frozen-doc playback engine's phase logic:
 * at rest everything is a faint ghost; strokes solidify once the playhead passes
 * their draw-time; erased strokes vanish; exit tears the overlay down.
 *
 * playbackEngine.ts has only type-only imports, so it runs standalone under tsx.
 * Run: npx tsx src/recording/playbackEngine.test.mts
 */

import { PlaybackEngine, playbackSegmentAt } from './playbackEngine'
import type { RecordingEvent } from './recorder'

const GHOST = 0.22

// Minimal fake editor: a store that records put/remove and current shape opacities.
function makeFakeEditor() {
  const shapes = new Map<string, any>()
  const store = {
    mergeRemoteChanges(fn: () => void) { fn() },
    put(records: any[]) { for (const r of records) shapes.set(r.id, r) },
    remove(ids: string[]) { for (const id of ids) shapes.delete(id) },
    get(id: string) { return shapes.get(id) },
  }
  return {
    store,
    setCamera() {},
    _shapes: shapes,
  } as any
}

function geo(id: string) {
  return { id, typeName: 'shape', type: 'geo', opacity: 1, x: 0, y: 0 } as any
}

const events: RecordingEvent[] = [
  { t: 0, kind: 'camera', x: 0, y: 0, z: 1 },
  { t: 100, kind: 'stroke', put: [geo('shape:a')], remove: [] },
  { t: 200, kind: 'stroke', put: [geo('shape:b')], remove: [] },
  { t: 300, kind: 'stroke', put: [], remove: ['shape:a'] }, // a erased mid-lecture
]

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) { console.log(`  ok  ${label}`) }
  else { console.log(`  FAIL ${label}`); failures++ }
}

const firstSnapshot = { document: { store: { marker: 'first' } } } as any
const secondSnapshot = { document: { store: { marker: 'second' } } } as any
const bookEvents: RecordingEvent[] = [
  { t: 0, kind: 'base', snapshot: firstSnapshot },
  { t: 10, kind: 'stroke', put: [geo('shape:first-member')], remove: [] },
  { t: 100, kind: 'base', snapshot: secondSnapshot },
  { t: 110, kind: 'stroke', put: [geo('shape:second-member')], remove: [] },
]
const firstSegment = playbackSegmentAt(bookEvents, 50)
const secondSegment = playbackSegmentAt(bookEvents, 150)
console.log('book member base selection')
check('first member uses its recording-time base', firstSegment.base?.snapshot === firstSnapshot)
check('first member excludes later member events', firstSegment.events.length === 1 && firstSegment.events[0].kind === 'stroke')
check('second member uses its recording-time base', secondSegment.base?.snapshot === secondSnapshot)
check('second member excludes prior member events', secondSegment.events.length === 1 && secondSegment.events[0].kind === 'stroke')

const editor = makeFakeEditor()
const shapes: Map<string, any> = editor._shapes
const eng = new PlaybackEngine(editor, events)
const op = (id: string) => (shapes.has(id) ? shapes.get(id).opacity : 'absent')

eng.enter() // seeks to 0
console.log('at rest (t=0): whole lecture ghosted')
check('a is ghost', op('shape:a') === GHOST)
check('b is ghost', op('shape:b') === GHOST)

eng.seek(150)
console.log('t=150: a drawn, b not yet')
check('a is solid', op('shape:a') === 1)
check('b still ghost', op('shape:b') === GHOST)

eng.seek(250)
console.log('t=250: both drawn')
check('a is solid', op('shape:a') === 1)
check('b is solid', op('shape:b') === 1)

eng.seek(350)
console.log('t=350: a erased')
check('a is absent', op('shape:a') === 'absent')
check('b is solid', op('shape:b') === 1)

// Scrub back to rest — must return to all-ghost (idempotent, reversible).
eng.seek(0)
console.log('scrub back to t=0')
check('a ghost again', op('shape:a') === GHOST)
check('b ghost again', op('shape:b') === GHOST)

// Additions-in-time: a later mark folded into the timeline behaves exactly like
// a lecture stroke — ghost before its anchor, solid from it.
eng.addEvents([{ t: 250, kind: 'stroke', put: [geo('shape:add1')], remove: [] }])
eng.seek(0)
console.log('addition folded in, t=0: addition ghosted with the rest')
check('add1 is ghost', op('shape:add1') === GHOST)
eng.seek(260)
console.log('t=260: addition past its anchor')
check('add1 is solid', op('shape:add1') === 1)
check('b is solid', op('shape:b') === 1)
eng.seek(200)
console.log('scrub back to t=200: addition ghosts again')
check('add1 ghost again', op('shape:add1') === GHOST)

eng.exit()
console.log('exit: overlay torn down')
check('a removed', !shapes.has('shape:a'))
check('b removed', !shapes.has('shape:b'))
check('add1 removed', !shapes.has('shape:add1'))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
if (failures > 0) throw new Error(`${failures} failure(s)`)
