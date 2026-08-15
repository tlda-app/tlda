function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`)
}

function matches(actual: string, expected: RegExp) {
  if (!expected.test(actual)) throw new Error(`Expected ${actual} to match ${expected}`)
}

async function run() {
  let mediaRequests = 0
  const tracks = [{ stop() {} }]
  let releaseMicrophone!: () => void
  const microphoneReady = new Promise<void>(resolve => { releaseMicrophone = resolve })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'node', platform: 'node', mediaDevices: { getUserMedia: async () => { mediaRequests += 1; await microphoneReady; return { getTracks: () => tracks } } } },
  })

  class FakeMediaRecorder {
    static isTypeSupported() { return true }
    mimeType = 'audio/webm'
    state = 'inactive'
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    start() { this.state = 'recording' }
    requestData() { this.ondataavailable?.({ data: new Blob(['checkpoint']) }) }
    stop() {
      this.ondataavailable?.({ data: new Blob(['lecture']) })
      this.state = 'inactive'
      this.onstop?.()
    }
    pause() { this.state = 'paused' }
    resume() { this.state = 'recording' }
  }
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder })
  const storage = { getItem() { return null }, setItem() {} }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })

  const requests: string[] = []
  const listeners = new Map<string, Set<() => void>>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'https://classroom.test' },
      navigator: globalThis.navigator,
      localStorage: storage,
      addEventListener(type: string, listener: () => void) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set) },
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
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string) => { requests.push(String(input)); return { ok: true } },
  })

  const { openAppRecordingSession, getRecorderState } = await import('./recorder')

  openAppRecordingSession('classroom-course')
  await new Promise(resolve => setTimeout(resolve, 0))
  equal(mediaRequests, 1)
  equal(getRecorderState().status, 'starting')

  for (const listener of listeners.get('pagehide') ?? []) listener()
  releaseMicrophone()
  await new Promise(resolve => setTimeout(resolve, 0))
  equal(getRecorderState().status, 'idle')
  equal(requests.length, 2)
  matches(requests[0], /\/recording$/)
  matches(requests[1], /\/audio$/)
  equal(requests.some(url => url.endsWith('/publish')), false)
  console.log('app-owned recording session: PASS')
}

await run()
;(globalThis as any).process.exit(0)
