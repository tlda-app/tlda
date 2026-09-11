/**
 * Stroke sampling: the event log must stop growing quadratically in stroke
 * length WITHOUT changing what the finished recording shows.
 *
 * The draw tool rewrites the whole shape per pointer move, so one stroke used to
 * cost the sum of all its prefixes. A 90-minute annotated lab passed the
 * server's 50MB body limit and the recording became unuploadable — and then
 * retried the same oversized body from IndexedDB forever.
 *
 * These run against the real recorder and real tldraw stores. The load-bearing
 * check is not the byte reduction, it is that every shape's FINAL record still
 * matches the store exactly: sampling may thin the frames a stroke is drawn
 * over, never the thing it ends up as.
 */

// --- the browser surface tldraw and the recorder need ---
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
// A real MediaStream has getAudioTracks, and a real track has addEventListener —
// the recorder uses both to notice the microphone going away.
const micTrack = { kind: 'audio', stop() {}, addEventListener() {}, removeEventListener() {} }
nav.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [micTrack], getAudioTracks: () => [micTrack] }) }
Object.defineProperty(globalThis, 'MediaRecorder', {
  configurable: true,
  value: class {
    static isTypeSupported() { return true }
    mimeType = 'audio/webm'; state = 'inactive'
    ondataavailable: ((e: { data: any }) => void) | null = null
    onstop: (() => void) | null = null
    start() { this.state = 'recording' }
    requestData() { this.ondataavailable?.({ data: { size: 9, type: 'audio/webm' } }) }
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
/**
 * Let the store's listeners run. `store.listen` delivers through
 * `throttleToNextFrame`, so a change is not visible to the recorder until the
 * next frame — and two changes inside one frame are squashed into a single diff
 * (a shape created and erased within one would cancel out and never be
 * recorded). A wait comfortably longer than a frame keeps each step of this test
 * a separate flush, so what it asserts is the recorder's behaviour and not a
 * race in the harness.
 */
const settle = () => wait(25)

const td = await import('tldraw')
const { b64Vecs } = await import('@tldraw/tlschema')
const DrawUtil: any = td.defaultShapeUtils.find((u: any) => u.type === 'draw')

function makeDoc(name: string) {
  const store = td.createTLStore({ shapeUtils: td.defaultShapeUtils })
  // The recorder snapshots the store on attach, and `getSnapshot` throws
  // "Session state is not ready yet" until an instance record exists. Outside a
  // mounted editor that is this call's job; it is not on the public TLStore type.
  ;(store as unknown as { ensureStoreIsUsable(): void }).ensureStoreIsUsable()
  const pageId = store.query.records('page').get()[0].id
  return {
    name, store, pageId,
    editor: {
      store,
      getCamera: () => ({ x: 0, y: 0, z: 1 }),
      // The recorder watches this to record a page turn; a real Editor always
      // has it, so a double without it tests a narrower editor than exists.
      getCurrentPageId: () => pageId,
    } as any,
  }
}

/** One pointer move: rewrite the whole shape with the path re-encoded, as the draw tool does. */
function movePointer(doc: ReturnType<typeof makeDoc>, id: any, pts: any[]) {
  doc.store.put([{
    id, typeName: 'shape', type: 'draw', parentId: doc.pageId, index: 'a1',
    x: 100, y: 100, rotation: 0, isLocked: false, opacity: 1, meta: {},
    props: {
      ...DrawUtil.prototype.getDefaultProps.call(null),
      segments: [{ type: 'free', path: b64Vecs.encodePoints(pts, 3), dim: 3 }],
      isComplete: false,
    },
  } as any])
}

const recorder = await import('./recorder')

const hw = makeDoc('homework-1')
const sol = makeDoc('homework-1-solution')

recorder.openAppRecordingSession('qtm285-book')
await settle()
recorder.attachAppRecordingEditor(hw.editor)
await settle()
ok(recorder.getRecorderState().status === 'recording', 'recorder reached "recording"')

// --- a drawn stroke, paced as a real one is ---
// The saving is set by how many pointer moves fall inside one window, so the
// moves have to arrive at pointer rate. Pacing them at the speed of the test
// loop instead would measure the harness, not the change.
const FRAME_MS = 16          // ~60fps, the rate the draw tool emits moves at
const MOVES = 60             // a ~1 second stroke
const strokeId = td.createShapeId('hw-stroke')
const pts: any[] = []
let writtenBytes = 0
for (let i = 0; i < MOVES; i++) {
  pts.push({ x: i * 1.7, y: Math.sin(i / 6) * 20, z: 0.5 })
  movePointer(hw, strokeId, [...pts])
  writtenBytes += JSON.stringify(hw.store.get(strokeId)).length
  await wait(FRAME_MS)
}
await settle()
const finalDrawn = hw.store.get(strokeId)

// --- a second stroke after the window closes: must NOT fold into the first ---
await wait(150)
const laterId = td.createShapeId('hw-stroke-later')
movePointer(hw, laterId, [{ x: 0, y: 0, z: 0.5 }, { x: 5, y: 5, z: 0.5 }])
await settle()

// --- an erase inside the window: a removal must keep its own place in the log ---
movePointer(hw, laterId, [{ x: 0, y: 0, z: 0.5 }, { x: 9, y: 9, z: 0.5 }])
await settle()
hw.store.remove([laterId])
await settle()

// --- switch document, draw there: continuity must survive sampling ---
recorder.attachAppRecordingEditor(null)
await settle()
recorder.attachAppRecordingEditor(sol.editor)
await settle()
const solId = td.createShapeId('sol-stroke')
const solPts: any[] = []
for (let i = 0; i < 20; i++) {
  solPts.push({ x: i * 2, y: i, z: 0.5 })
  movePointer(sol, solId, [...solPts])
  await settle()
}
const finalSol = sol.store.get(solId)

for (const cb of windowListeners.get('pagehide') ?? []) cb()
await settle(); await settle()

// ---------------------------------------------------------------- assertions
ok(!!postedMeta, 'the recording was POSTed')
const events = postedMeta.events as any[]
const strokes = events.filter(e => e.kind === 'stroke')
const bases = events.filter(e => e.kind === 'base')
const loggedBytes = JSON.stringify(strokes).length

/** The last record the log holds for an id — what replay resolves to at the end. */
function lastRecord(id: string) {
  let found: any = null
  for (const e of strokes) for (const r of e.put) if (r.id === id) found = r
  return found
}

// 1. FIDELITY. Every shape's finished form is byte-identical to the store's.
const finalInLog = lastRecord(String(strokeId))
ok(JSON.stringify(finalInLog) === JSON.stringify(finalDrawn),
  'the finished stroke in the log is byte-identical to the finished stroke in the document')
ok(JSON.stringify(lastRecord(String(solId))) === JSON.stringify(finalSol),
  'the finished stroke on the second document is byte-identical too')

// 1b. POSITIVE CONTROL: that comparison must be able to reject a near-miss.
const nearMiss = { ...finalDrawn, props: { ...(finalDrawn as any).props, isComplete: true } }
ok(JSON.stringify(nearMiss) !== JSON.stringify(finalDrawn),
  'control: the fidelity comparison discriminates — a one-prop difference is not equal')

// 2. The quadratic growth is gone: one stroke is no longer one event per move.
ok(strokes.length < MOVES / 2, `sampling folded the stroke (${strokes.length} events for ${MOVES + 5} writes)`)
ok(loggedBytes < writtenBytes / 2, `the log is smaller than the records written (${loggedBytes} < ${writtenBytes})`)

// 3. A removal keeps its own event and is not folded away.
const removed = strokes.filter(e => e.remove.includes(String(laterId)))
ok(removed.length === 1, 'the erase is in the log exactly once, as its own event')

// 4. Document continuity: a base per document, strokes captured in each segment.
ok(bases.length === 2, `one base per document opened (got ${bases.length})`)
const secondBaseAt = events.indexOf(bases[1])
ok(events.slice(secondBaseAt).some(e => e.kind === 'stroke' && e.put.some((r: any) => r.id === String(solId))),
  'capture survived the document switch — the second document has its own strokes')

// 5. Events stay ordered, so playback's "last put at or before t" still holds.
ok(events.every((e, i) => i === 0 || e.t >= events[i - 1].t), 'events remain in non-decreasing time order')

console.log(`stroke sampling: PASS`)
console.log(`  ${MOVES} pointer moves -> ${strokes.length} stroke events`)
console.log(`  records written ${(writtenBytes / 1024).toFixed(0)} KB -> logged ${(loggedBytes / 1024).toFixed(0)} KB ` +
  `(${(writtenBytes / loggedBytes).toFixed(1)}x smaller)`)
;(globalThis as any).process.exit(0)
