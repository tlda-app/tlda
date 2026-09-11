/**
 * Turning to another homework must reach the recording.
 *
 * A multipage HTML document is ONE editor holding a TLDraw page per chapter, so
 * navigating changes `currentPageId` and nothing else. That field is on the
 * `instance` record — session scope — and the listener that captures strokes is
 * document scope, so without a page watch the student hears the whole lab while
 * looking at whichever page capture began on. Silently, and only discoverable on
 * playback the next day.
 *
 * These drive the real recorder against a real three-page tldraw store, and
 * check the recording through `playbackSegmentAt` — what the player actually
 * resolves — rather than through the event list alone.
 */

const nav = { userAgent: 'node', platform: 'node', maxTouchPoints: 0 } as any
const raf = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0) as unknown as number
const storage = { getItem() { return null }, setItem() {}, removeItem() {} }
const windowListeners = new Map<string, Set<() => void>>()
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: raf })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (h: any) => clearTimeout(h) })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: nav })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    navigator: nav, localStorage: storage, sessionStorage: storage, devicePixelRatio: 2,
    location: { origin: 'https://classroom.test', search: '' },
    requestAnimationFrame: raf,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener(t: string, cb: () => void) { const s = windowListeners.get(t) ?? new Set(); s.add(cb); windowListeners.set(t, s) },
    removeEventListener(t: string, cb: () => void) { windowListeners.get(t)?.delete(cb) },
    __TLDA_CONFIG__: {
      name: 'test',
      database: { http: 'https://classroom.test', ws: 'wss://classroom.test' },
      store: { http: 'https://classroom.test', ws: 'wss://classroom.test' },
      licenseKey: '',
    },
  },
})
nav.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }
Object.defineProperty(globalThis, 'MediaRecorder', {
  configurable: true,
  value: class {
    static isTypeSupported() { return true }
    mimeType = 'audio/webm'; state = 'inactive'
    ondataavailable: ((e: { data: any }) => void) | null = null
    onstop: (() => void) | null = null
    start() { this.state = 'recording' }
    requestData() {}
    stop() { this.state = 'inactive'; this.onstop?.() }
    pause() {} ; resume() {}
  },
})
Object.defineProperty(globalThis, 'Blob', {
  configurable: true,
  value: class { size = 1; type: string; constructor(_p: any[], o: any = {}) { this.type = o.type ?? '' } },
})
let postedMeta: any = null
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async (_u: string, init: any) => {
    if (typeof init?.body === 'string') postedMeta = JSON.parse(init.body)
    return { ok: true, status: 200 }
  },
})

function ok(cond: boolean, what: string) { if (!cond) throw new Error(`FAILED: ${what}`) }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Past one frame: store.listen delivers through throttleToNextFrame. */
const settle = () => wait(25)

const td = await import('tldraw')
const { TLINSTANCE_ID } = await import('@tldraw/tlschema')
const DrawUtil: any = td.defaultShapeUtils.find((u: any) => u.type === 'draw')

/** One document, three chapters — a TLDraw page each, as createShapes.ts builds them. */
function makeMultipageDocument(name: string) {
  const store = td.createTLStore({ shapeUtils: td.defaultShapeUtils })
  ;(store as unknown as { ensureStoreIsUsable(): void }).ensureStoreIsUsable()
  const first = store.query.records('page').get()[0].id
  const pageIds = [first]
  for (const n of ['Homework 5', 'Homework 6']) {
    const id = `page:${n.replace(/\s+/g, '-')}` as typeof first
    store.put([{ id, typeName: 'page', name: n, index: `a${pageIds.length + 1}`, meta: {} } as any])
    pageIds.push(id)
  }
  const editor = {
    store,
    getCamera: () => ({ x: 0, y: 0, z: 1 }),
    getCurrentPageId: () => (store.get(TLINSTANCE_ID) as any).currentPageId,
  } as any
  return {
    name, store, editor, pageIds,
    /** Turn to a chapter, the way setCurrentPage does: currentPageId on `instance`. */
    turnTo(pageId: string) {
      const instance = store.get(TLINSTANCE_ID) as any
      store.put([{ ...instance, currentPageId: pageId }])
    },
    annotate(tag: string) {
      const id = td.createShapeId(`${name}-${tag}`)
      store.put([{
        id, typeName: 'shape', type: 'draw', parentId: (store.get(TLINSTANCE_ID) as any).currentPageId,
        index: 'a1', x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {},
        props: DrawUtil.prototype.getDefaultProps.call(null),
      } as any])
      return String(id)
    },
  }
}

const recorder = await import('./recorder')
const { playbackSegmentAt } = await import('./playbackEngine')

const course = makeMultipageDocument('qtm285-course')
const [pageA, pageB, pageC] = course.pageIds

recorder.openAppRecordingSession('qtm285-course')
await settle()
recorder.attachAppRecordingEditor(course.editor)
await settle()
ok(recorder.getRecorderState().status === 'recording', 'recorder reached "recording"')

// --- the lab: annotate page A, turn to B, annotate, turn to C, annotate ---
const drawnOnA = course.annotate('a1')
await settle()

course.turnTo(pageB)
await settle()
const drawnOnB = course.annotate('b1')
await settle()

// Turning to the page we are ALREADY on must not add a base.
course.turnTo(pageB)
await settle()

course.turnTo(pageC)
await settle()
const drawnOnC = course.annotate('c1')
await settle()

// A document switch must still emit exactly one base, not one plus a page base.
const other = makeMultipageDocument('other-document')
recorder.attachAppRecordingEditor(null)
await settle()
recorder.attachAppRecordingEditor(other.editor)
await settle()
const drawnElsewhere = other.annotate('x1')
await settle()

for (const cb of windowListeners.get('pagehide') ?? []) cb()
await settle(); await settle()

// ---------------------------------------------------------------- assertions
ok(!!postedMeta, 'the recording was POSTed')
const events = postedMeta.events as any[]
const bases = events.filter(e => e.kind === 'base')
const pageOf = (base: any) => String(base?.snapshot?.session?.currentPageId ?? '')

// 1. One base for the opening page, one per turn, one for the document switch.
ok(bases.length === 4, `four bases: open A, turn B, turn C, switch document (got ${bases.length})`)
ok(pageOf(bases[0]) === pageA, `the opening base is on page A (got ${pageOf(bases[0])})`)
ok(pageOf(bases[1]) === pageB, `turning to B recorded a base on B (got ${pageOf(bases[1])})`)
ok(pageOf(bases[2]) === pageC, `turning to C recorded a base on C (got ${pageOf(bases[2])})`)

// 2. Re-selecting the page already shown adds nothing — asserted by the count
//    above, and directly here so the reason a regression fails is legible.
ok(bases.filter(b => pageOf(b) === pageB).length === 1, 'page B has exactly one base, not one per turnTo call')

// 3. Playback resolves each moment to the page that was showing then.
for (const [tag, shapeId, expectedPage] of [
  ['A', drawnOnA, pageA], ['B', drawnOnB, pageB], ['C', drawnOnC, pageC],
] as [string, string, string][]) {
  const at = events.find(e => e.kind === 'stroke' && e.put.some((r: any) => r.id === shapeId))
  ok(!!at, `the annotation on page ${tag} is in the recording`)
  const segment = playbackSegmentAt(events, at.t)
  ok(pageOf(segment.base) === expectedPage,
    `replaying the moment page ${tag} was annotated shows page ${tag} (got ${pageOf(segment.base)})`)
  ok(segment.events.some(e => e.kind === 'stroke' && e.put.some((r: any) => r.id === shapeId)),
    `the annotation on page ${tag} belongs to page ${tag}'s segment`)
}

// 4. The document switch did not collide with the page watch: one base, and the
//    strokes after it are in its segment.
const switchBase = bases[3]
const elsewhere = events.find(e => e.kind === 'stroke' && e.put.some((r: any) => r.id === drawnElsewhere))
ok(!!elsewhere, 'the annotation on the second document is in the recording')
ok(playbackSegmentAt(events, elsewhere.t).base === switchBase,
  'the second document resolves to the base the document switch emitted')

// 5. Events stay ordered, so "last base at or before t" remains well defined.
ok(events.every((e, i) => i === 0 || e.t >= events[i - 1].t), 'events remain in non-decreasing time order')

console.log('page transitions: PASS')
console.log(`  bases: ${bases.map(pageOf).map(p => p.replace('page:', '')).join(' -> ')}`)
;(globalThis as any).process.exit(0)
