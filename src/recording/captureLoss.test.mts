/**
 * When capture fails under us, the recorder must stop claiming to record.
 *
 * Lecture capture starts by itself, so there is no button that visibly failed.
 * If the microphone goes away mid-lab — unplugged, permission revoked, the
 * device grabbed by something else — the track ends and MediaRecorder goes
 * quiet, but status stayed 'recording' for the rest of the lecture. The
 * lecturer had no reason to doubt it and found out on playback the next day.
 *
 * Both cases assert the same three things: what was captured is SAVED, the
 * recorder returns to idle, and the reason is left on `RecorderState.error`
 * where RecorderErrorPill renders it.
 *
 * MODE=ended    the audio track fires 'ended'
 * MODE=error    MediaRecorder fires onerror
 */
const MODE = (globalThis as any).process?.env?.MODE ?? 'ended'

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

/** An audio track that can end the way a real one does. */
const trackListeners = new Map<string, Set<() => void>>()
let trackStopped = false
const micTrack = {
  kind: 'audio',
  stop() { trackStopped = true },
  addEventListener(type: string, cb: () => void) {
    const s = trackListeners.get(type) ?? new Set(); s.add(cb); trackListeners.set(type, s)
  },
  removeEventListener(type: string, cb: () => void) { trackListeners.get(type)?.delete(cb) },
}
nav.mediaDevices = {
  getUserMedia: async () => ({ getTracks: () => [micTrack], getAudioTracks: () => [micTrack] }),
}

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
    requestData() { this.ondataavailable?.({ data: { size: 9, type: 'audio/webm' } }) }
    stop() { this.state = 'inactive'; this.onstop?.() }
    pause() {} ; resume() {}
  },
})
Object.defineProperty(globalThis, 'Blob', {
  configurable: true,
  value: class { size = 1; type: string; constructor(_p: any[], o: any = {}) { this.type = o.type ?? '' } },
})
const posted: string[] = []
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async (url: string) => { posted.push(String(url)); return { ok: true, status: 200 } },
})

function ok(cond: boolean, what: string) { if (!cond) throw new Error(`FAILED: ${what}`) }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const settle = () => wait(25)

const td = await import('tldraw')
const DrawUtil: any = td.defaultShapeUtils.find((u: any) => u.type === 'draw')
const store = td.createTLStore({ shapeUtils: td.defaultShapeUtils })
;(store as unknown as { ensureStoreIsUsable(): void }).ensureStoreIsUsable()
const pageId = store.query.records('page').get()[0].id
const editor = {
  store,
  getCamera: () => ({ x: 0, y: 0, z: 1 }),
  getCurrentPageId: () => pageId,
} as any

const recorder = await import('./recorder')

recorder.openAppRecordingSession('qtm285-course')
await settle()
recorder.attachAppRecordingEditor(editor)
await settle()
ok(recorder.getRecorderState().status === 'recording', 'recorder reached "recording"')

// Something worth keeping was captured before the microphone went away.
store.put([{
  id: td.createShapeId('before-loss'), typeName: 'shape', type: 'draw', parentId: pageId,
  index: 'a1', x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: DrawUtil.prototype.getDefaultProps.call(null),
} as any])
await settle()

// Control that the instrument is measuring the right thing: still recording,
// and no error, immediately before the loss.
ok(recorder.getRecorderState().status === 'recording', 'control: still recording before the loss')
ok(!recorder.getRecorderState().error, 'control: no error before the loss')

if (MODE === 'ended') {
  ok((trackListeners.get('ended')?.size ?? 0) > 0, 'the recorder is listening for the track ending')
  for (const cb of trackListeners.get('ended') ?? []) cb()
} else {
  ok(typeof recorderInstance?.onerror === 'function', 'the recorder installed an onerror handler')
  recorderInstance.onerror({ error: { message: 'the encoder fell over' } })
}
await settle(); await settle()

const state = recorder.getRecorderState()

// 1. It stops claiming to record.
ok(state.status === 'idle', `recorder left "recording" after capture was lost (status=${state.status})`)

// 2. The reason reaches the surface that shows it.
ok(!!state.error, 'a reason is on RecorderState.error for RecorderErrorPill to render')
ok(/microphone|encoder|recorder/i.test(state.error ?? ''), `the reason names what happened: "${state.error}"`)

// 3. What was captured is saved rather than discarded.
ok(posted.some(url => /\/recording$/.test(url)), 'the partial recording was POSTed, not thrown away')
ok(posted.some(url => /\/audio$/.test(url)), 'its audio was POSTed too')

// 4. The microphone is released.
ok(trackStopped, 'the microphone track was released')

console.log(`capture loss (${MODE}): PASS`)
console.log(`  status -> ${state.status}, error -> "${state.error}"`)
;(globalThis as any).process.exit(0)
