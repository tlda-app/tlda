/**
 * A platform refusal of a microphone request the app made on its own is not a
 * microphone fault, and a real denial still is. Both halves are here because
 * only the pair distinguishes the fix from the failure it looks like: silencing
 * the pill silences the genuine denial too, and a lecture then fails to record
 * with nothing on screen saying so.
 *
 * Safari answers `getUserMedia` outside a user gesture with `NotAllowedError` —
 * the same name a denial carries — and the app-owned capture starts from an
 * effect on load, so this is the ordinary path on an iPad, not an edge case.
 */

function equal(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`)
}

function notAllowed() {
  const err = new Error('The request is not allowed by the user agent or the platform in the current context.')
  err.name = 'NotAllowedError'
  return err
}

async function run() {
  const tracks = [{ kind: 'audio', stop() {}, addEventListener() {}, removeEventListener() {} }]
  let micAnswer: 'refuse' | 'grant' = 'refuse'
  // Safari has no Permissions API answer for the microphone, which is why
  // 'throw' is one of the cases rather than an unlucky one: on the device this
  // bug was reported from, the gesture test is the ONLY thing that separates a
  // speculative refusal from a denial.
  let permissionAnswer: 'prompt' | 'denied' | 'throw' = 'prompt'
  let mediaRequests = 0

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'node',
      platform: 'node',
      // No `userActivation`, which is the iOS-Safari-shaped case: whether the
      // request was user-initiated has to come from the caller.
      permissions: {
        query: async () => {
          if (permissionAnswer === 'throw') throw new Error('Permissions API unavailable')
          return { state: permissionAnswer }
        },
      },
      mediaDevices: {
        getUserMedia: async () => {
          mediaRequests += 1
          if (micAnswer === 'refuse') throw notAllowed()
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

  const listeners = new Map<string, Set<() => void>>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'https://classroom.test' },
      navigator: globalThis.navigator,
      localStorage: storage,
      addEventListener(type: string, listener: () => void) {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener) },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      __TLDA_CONFIG__: {
        name: 'test',
        database: { http: 'https://classroom.test', ws: 'wss://classroom.test' },
        store: { http: 'https://classroom.test', ws: 'wss://classroom.test' },
        licenseKey: '',
      },
    },
  })
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => ({ ok: true }) })

  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  // A touch, not a mouse click: the whole point is that this has to work on his
  // iPad. Other listeners on this window (tldraw's own) read the event, so it
  // carries the fields a pointer event has.
  const tap = async () => {
    const event = { type: 'pointerdown', pointerType: 'touch', target: null, isPrimary: true }
    for (const listener of [...(listeners.get('pointerdown') ?? [])]) (listener as (e: unknown) => void)(event)
    await settle()
  }

  const { setAppRecording, getRecorderState } = await import('./recorder')

  // 1. The toggle is on — a classroom instructor's default — and the platform
  //    refuses the load-time request. Nothing to report: this says only that we
  //    asked at the wrong moment.
  setAppRecording(true, 'gesture-refusal-fixture')
  await settle()
  equal(mediaRequests, 1, 'the mic was requested on load')
  equal(getRecorderState().error, null, 'a non-gesture refusal reports no fault')
  equal(getRecorderState().status, 'idle', 'and leaves the recorder idle')
  equal(getRecorderState().requested, true, 'the toggle stays on — it is the mic that has not arrived')

  // 2. The next gesture is taken, and with permission actually available the
  //    lecture records. The silence above is a deferral, not an abandonment.
  micAnswer = 'grant'
  await tap()
  equal(mediaRequests, 2, 'the next gesture re-asked')
  equal(getRecorderState().status, 'recording', 'capture starts inside the gesture')
  equal(getRecorderState().error, null, 'and still reports no fault')
  equal(getRecorderState().requested, true, 'the toggle is on and now so is the microphone')

  console.log('non-gesture refusal: silent, and retried on the next tap: PASS')

  // 3. The counterfactual, which is the half that matters. A fix that silenced
  //    the pill would pass step 1 identically and fail both of these.
  const warns = (message: string | null, what: string) => {
    if (!message || !/microphone/i.test(message)) {
      throw new Error(`${what}: a genuine denial must warn; got ${JSON.stringify(message)}`)
    }
  }

  // 3a. The Permissions API says denied. That is authoritative whatever gesture
  //     we were or were not in, so it warns at once.
  const known = await import(`./recorder?denial=known-${Date.now()}`)
  micAnswer = 'refuse'
  permissionAnswer = 'denied'
  known.setAppRecording(true, 'known-denial-fixture')
  await settle()
  warns(known.getRecorderState().error, 'permission known denied')
  equal(known.getRecorderState().status, 'idle', 'and the recorder is idle')
  console.log('denial the Permissions API knows about: warns immediately: PASS')

  // 3b. Safari: no Permissions API answer at all. The load-time refusal stays
  //     silent, and the refusal inside the user's own tap is the fault.
  const safari = await import(`./recorder?denial=safari-${Date.now()}`)
  permissionAnswer = 'throw'
  mediaRequests = 0
  safari.setAppRecording(true, 'safari-denial-fixture')
  await settle()
  equal(safari.getRecorderState().error, null, 'the load-time ask is still silent')
  await tap()
  equal(mediaRequests, 2, 'the gesture re-asked')
  warns(safari.getRecorderState().error, 'refused inside a gesture')
  equal(safari.getRecorderState().status, 'idle', 'and the recorder is idle')
  console.log('denial inside a gesture, no Permissions API: still warns: PASS')

  // 4. Turning the toggle off while a retry is armed. This is the leak that
  //    would be invisible: the person stops recording, taps something a moment
  //    later, and the app takes the microphone it was told not to have.
  const off = await import(`./recorder?off=${Date.now()}`)
  micAnswer = 'refuse'
  permissionAnswer = 'prompt'
  mediaRequests = 0
  off.setAppRecording(true, 'toggled-off-fixture')
  await settle()
  equal(mediaRequests, 1, 'the refused request armed a retry')
  off.setAppRecording(false, null)
  micAnswer = 'grant'
  await tap()
  equal(mediaRequests, 1, 'a tap after turning it off did NOT acquire the microphone')
  equal(off.getRecorderState().requested, false, 'and the toggle stays off')
  equal(off.getRecorderState().status, 'idle', 'with nothing capturing')

  console.log('toggled off while a retry was armed: stays off: PASS')
}

await run()
;(globalThis as any).process.exit(0)
