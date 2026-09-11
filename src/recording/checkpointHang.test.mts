/**
 * A hung checkpoint write must not take the lecture with it.
 *
 * `checkpointQueue` is a serialized chain and `.catch()` handles a REJECTED
 * write, not a HANGING one. An IndexedDB transaction that never settles — quota
 * pressure, a second tab, a slow disk — used to leave `stopRecording` waiting on
 * that promise forever: nothing uploaded, status stuck at 'saving', no error,
 * and the only artifact ever reaching the server was the frozen draft picked up
 * by a later `retryPendingDrafts`.
 *
 * The four cases chief named:
 *   healthy   — writes complete, stop delivers, no regression
 *   hang      — one write never settles; stop still delivers
 *   timeout   — delivery happens because the wait is bounded, not because the
 *               write finished
 *   resurrect — a checkpoint still queued when delivery began must not write the
 *               draft back: the server stores by id, so a stale shorter
 *               checkpoint re-delivered would overwrite a complete lecture
 *
 * MODE=healthy|hang|resurrect
 */
const MODE = (globalThis as any).process?.env?.MODE ?? 'healthy'

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
const micTrack = { kind: 'audio', stop() {}, addEventListener() {}, removeEventListener() {} }
nav.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [micTrack], getAudioTracks: () => [micTrack] }) }

let recorderInstance: any = null
Object.defineProperty(globalThis, 'MediaRecorder', {
  configurable: true,
  value: class {
    static isTypeSupported() { return true }
    mimeType = 'audio/webm'; state = 'inactive'
    ondataavailable: ((e: { data: any }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: ((e: any) => void) | null = null
    constructor() { recorderInstance = this }
    start() { this.state = 'recording' }
    tick() { this.ondataavailable?.({ data: { size: 4096, type: 'audio/webm' } }) }
    requestData() { this.tick() }
    stop() { this.state = 'inactive'; this.onstop?.() }
    pause() {} ; resume() {}
  },
})
Object.defineProperty(globalThis, 'Blob', {
  configurable: true,
  value: class { size = 1; type: string; constructor(_p: any[], o: any = {}) { this.type = o.type ?? '' } },
})

// A fake IndexedDB whose chosen write HANGS — neither succeeding nor failing.
const HANG_ON_PUT = 3
let puts = 0
let deletes = 0
let releaseHungWrite: (() => void) | null = null
const stored = new Map<string, any>()
Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  value: {
    open() {
      const request: any = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null }
      setTimeout(() => {
        const objectStore = {
          put(value: any) {
            puts += 1
            const r: any = {}
            if (MODE !== 'healthy' && puts === HANG_ON_PUT) {
              // Held open. `resurrect` releases it later, after delivery.
              releaseHungWrite = () => { stored.set(value.key, value); r.onsuccess?.() }
              return r
            }
            stored.set(value.key, value)
            setTimeout(() => r.onsuccess?.(), 0)
            return r
          },
          getAll() { const r: any = { result: [...stored.values()] }; setTimeout(() => r.onsuccess?.(), 0); return r },
          delete(key: string) { deletes += 1; stored.delete(key); const r: any = {}; setTimeout(() => r.onsuccess?.(), 0); return r },
        }
        request.result = {
          transaction() {
            const tx: any = { oncomplete: null, onerror: null, objectStore: () => objectStore }
            setTimeout(() => { if (!releaseHungWrite) tx.oncomplete?.() }, 1)
            return tx
          },
          close() {},
        }
        request.onsuccess?.()
      }, 0)
      return request
    },
  },
})

const posted: Array<{ url: string; duration?: number }> = []
let serverDuration = 0
let serverHasAudio = false
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async (url: string, init: any) => {
    let duration: number | undefined
    if (typeof init?.body === 'string') { try { duration = JSON.parse(init.body).duration_ms } catch { /* audio body */ } }
    posted.push({ url: String(url), duration })
    if (/\/recording$/.test(String(url)) && duration != null) {
      if (duration < serverDuration) return { ok: false, status: 409 }
      serverDuration = duration
    }
    if (/\/audio$/.test(String(url))) {
      if (serverHasAudio) return { ok: true, status: 200, existing: true }
      serverHasAudio = true
    }
    return { ok: true, status: 200 }
  },
})

function ok(cond: boolean, what: string) { if (!cond) throw new Error(`FAILED: ${what}`) }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const td = await import('tldraw')
const tlStore = td.createTLStore({ shapeUtils: td.defaultShapeUtils })
;(tlStore as unknown as { ensureStoreIsUsable(): void }).ensureStoreIsUsable()
const pageId = tlStore.query.records('page').get()[0].id
const editor = { store: tlStore, getCamera: () => ({ x: 0, y: 0, z: 1 }), getCurrentPageId: () => pageId } as any

const recorder = await import('./recorder')
recorder.openAppRecordingSession('qtm285-course')
await wait(25)
recorder.attachAppRecordingEditor(editor)
await wait(25)
ok(recorder.getRecorderState().status === 'recording', 'recorder reached "recording"')

// Ten timeslices of lecture. In the non-healthy modes the third write hangs.
for (let i = 0; i < 10; i++) { recorderInstance.tick(); await wait(20) }

if (MODE !== 'healthy') ok(!!releaseHungWrite, 'control: a write really is hung')
const frozenDraft = [...stored.values()].find(v => v.meta)

// End of the lab.
const startedStopAt = Date.now()
for (const cb of windowListeners.get('pagehide') ?? []) cb()
// Wait for the transition itself rather than a fixed sleep, so the elapsed time
// below is when delivery actually finished and not how long this test slept.
let stopTook = -1
for (let i = 0; i < 300; i++) {
  await wait(200)
  if (recorder.getRecorderState().status === 'idle') { stopTook = Date.now() - startedStopAt; break }
}
if (stopTook < 0) stopTook = Date.now() - startedStopAt

const status = recorder.getRecorderState().status
const metaPosts = posted.filter(p => /\/recording$/.test(p.url))
const audioPosts = posted.filter(p => /\/audio$/.test(p.url))

// 1. The lecture is delivered in EVERY mode — that is the whole point.
ok(status === 'idle', `recorder returned to idle rather than stranding in "saving" (got ${status})`)
ok(metaPosts.length === 1, `the recording was uploaded exactly once (got ${metaPosts.length})`)
ok(audioPosts.length === 1, `its audio was uploaded exactly once (got ${audioPosts.length})`)

// 2. What was delivered is the FULL recording, not the frozen checkpoint.
const deliveredDuration = metaPosts[0].duration ?? 0
ok(deliveredDuration > 0, 'the delivered recording has a duration')
if (MODE !== 'healthy' && frozenDraft?.meta?.duration_ms != null) {
  ok(deliveredDuration >= frozenDraft.meta.duration_ms,
    `delivered duration ${deliveredDuration} is not truncated to the frozen checkpoint ${frozenDraft.meta.duration_ms}`)
}

// 3. The bound is what let it through, not the write completing.
if (MODE !== 'healthy') {
  ok(!!releaseHungWrite, 'the write was still hung when delivery happened — the wait was bounded, not satisfied')
  ok(stopTook >= 2000, `stop waited for the bound before proceeding (${stopTook}ms)`)
}

// 4. A checkpoint may finish its already-running IndexedDB write after delivery,
//    but retry must not replace the complete server copy with that stale draft.
if (MODE === 'resurrect') {
  const deliveredCount = posted.length
  const putsBefore = puts
  for (let i = 0; i < 20 && deletes === 0; i++) await wait(100)
  ok(deletes > 0, 'control: final delivery attempted to clear the outbox before the stale write lands')
  releaseHungWrite!()                  // the write we gave up on finally lands
  await wait(200)

  // Guaranteed: every checkpoint still QUEUED when delivery began is abandoned
  // rather than written back. Those are the ones the recorder can still decide
  // about, and several were queued behind the hung write.
  ok(puts === putsBefore,
    `no queued checkpoint wrote after delivery began (${puts - putsBefore} did)`)
  ok(posted.length === deliveredCount, 'nothing was re-POSTed after delivery')

  const resurrected = [...stored.values()].filter(v => v.meta)
  ok(resurrected.length === 1, 'control: one stale draft really landed after final delivery')
  ok(resurrected[0].meta.duration_ms < deliveredDuration, 'control: the resurrected draft is shorter than the delivered lecture')

  const serverDurationBeforeRetry = serverDuration
  const audioPostsBeforeRetry = posted.filter(p => /\/audio$/.test(p.url)).length
  const { retryPendingDrafts } = await import('./draftOutbox')
  await retryPendingDrafts({
    async put(envelope) { stored.set(envelope.key, envelope) },
    async list() { return [...stored.values()].filter(envelope => envelope?.meta) },
    async delete(key) { stored.delete(key) },
  })
  ok(serverDuration === serverDurationBeforeRetry, 'the stale retry did not replace complete metadata')
  ok(posted.filter(p => /\/audio$/.test(p.url)).length === audioPostsBeforeRetry,
    'the rejected stale retry never attempted to replace complete audio')
  ok([...stored.values()].filter(envelope => envelope?.meta).length === 0,
    'the rejected stale draft was cleared from the outbox')
}

console.log(`checkpoint hang (${MODE}): PASS`)
console.log(`  status=${status}  delivered duration_ms=${deliveredDuration}  frozen checkpoint=${frozenDraft?.meta?.duration_ms ?? '-'}  stop took ${stopTook}ms`)
;(globalThis as any).process.exit(0)
