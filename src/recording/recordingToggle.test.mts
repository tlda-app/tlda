/**
 * Capture follows the toggle and nothing else touches the microphone.
 *
 * Skip, 2026-09-12: *"you can keep the toggle — the question is just does it
 * start on by default"*. So there is one piece of state, one control, and one
 * initial value that depends on where you are: a classroom instructor is
 * recorded by default because he forgets to start it, and everywhere else comes
 * up off.
 *
 * The half that is easy to ship wrong is turning it OFF. Default-on means the
 * first thing anyone ever does with this control is stop it, and a toggle that
 * arms but cannot disarm is worse than no toggle — so the release of the device
 * is asserted here, not assumed from the status field.
 */

function equal(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`)
}

async function run() {
  let mediaRequests = 0
  let liveTracks = 0
  const newTrack = () => {
    liveTracks += 1
    let stopped = false
    return {
      kind: 'audio',
      stop() { if (!stopped) { stopped = true; liveTracks -= 1 } },
      addEventListener() {},
      removeEventListener() {},
    }
  }

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'node',
      platform: 'node',
      permissions: { query: async () => ({ state: 'granted' }) },
      mediaDevices: {
        getUserMedia: async () => {
          mediaRequests += 1
          const tracks = [newTrack()]
          return { getTracks: () => tracks, getAudioTracks: () => tracks }
        },
      },
    },
  })

  class FakeMediaRecorder {
    static isTypeSupported() { return true }
    mimeType = 'audio/webm'
    state = 'inactive'
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    start() { this.state = 'recording' }
    requestData() {}
    stop() { this.state = 'inactive'; this.onstop?.() }
    pause() { this.state = 'paused' }
    resume() { this.state = 'recording' }
  }
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder })
  const storage = { getItem() { return null }, setItem() {} }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })

  const listeners = new Map<string, Set<(e: unknown) => void>>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'https://tlda.test' },
      navigator: globalThis.navigator,
      localStorage: storage,
      addEventListener(type: string, listener: (e: unknown) => void) {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener(type: string, listener: (e: unknown) => void) { listeners.get(type)?.delete(listener) },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      __TLDA_CONFIG__: {
        name: 'test',
        database: { http: 'https://tlda.test', ws: 'wss://tlda.test' },
        store: { http: 'https://tlda.test', ws: 'wss://tlda.test' },
        licenseKey: '',
      },
    },
  })
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => ({ ok: true }) })

  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const tap = async () => {
    const event = { type: 'pointerdown', pointerType: 'touch', target: null, isPrimary: true }
    for (const listener of [...(listeners.get('pointerdown') ?? [])]) listener(event)
    await settle()
  }

  const {
    getRecorderState, isAppRecordingOn, recordsByDefault, setAppRecording,
  } = await import('./recorder')

  // 1. The initial value, which is the only thing context decides.
  equal(recordsByDefault({ classroom: true, permissionKnown: true, canPublish: true }), true,
    'a classroom instructor is recorded by default')
  equal(recordsByDefault({ classroom: false, permissionKnown: true, canPublish: true }), false,
    'the same person on their own document is not')
  equal(recordsByDefault({ classroom: true, permissionKnown: true, canPublish: false }), false,
    'a student in the classroom is not')
  equal(recordsByDefault({ classroom: true, permissionKnown: false, canPublish: true }), false,
    'and nothing starts before the server has answered which token this is')

  // 2. Importing the module, rendering a page, tapping the canvas: none of that
  //    is asking to be recorded, and none of it may reach the microphone. This
  //    is the claim Skip cares about — "i dont like that", on capture starting
  //    outside classroom — so it is asserted against the device, not the status.
  await tap()
  await settle()
  equal(mediaRequests, 0, 'nothing touched the microphone before the toggle was pressed')
  equal(getRecorderState().requested, false, 'and the toggle reads off')
  equal(isAppRecordingOn(), false, 'and so does the session')

  // 3. On.
  setAppRecording(true, 'toggle-fixture', { userInitiated: true })
  await settle()
  equal(mediaRequests, 1, 'pressing it asked for the microphone once')
  equal(getRecorderState().requested, true, 'the toggle reads on')
  equal(getRecorderState().status, 'recording', 'and capture is running')
  equal(liveTracks, 1, 'the device is held')

  // 4. Off — and the device actually comes back. `status` going idle is not the
  //    same fact as the microphone being released, which is why both are here.
  setAppRecording(false, null)
  await settle()
  equal(getRecorderState().requested, false, 'the toggle reads off')
  equal(isAppRecordingOn(), false, 'the session is closed')
  equal(getRecorderState().status, 'idle', 'capture has stopped')
  equal(liveTracks, 0, 'and the microphone is released')

  // 5. Off stays off. A tap after stopping must not re-acquire — that is the
  //    gesture retry from the refusal path, and turning the toggle off has to
  //    disarm it or the app takes the microphone back a moment later.
  const afterStop = mediaRequests
  await tap()
  await settle()
  equal(mediaRequests, afterStop, 'a tap after stopping did not re-acquire the microphone')
  equal(liveTracks, 0, 'and nothing is held')

  console.log('capture follows the toggle, both directions, device released: PASS')
}

await run()
;(globalThis as any).process.exit(0)
