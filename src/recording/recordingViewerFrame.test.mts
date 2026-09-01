import { recordingViewerFrameAt, trackRecordingViewerFrame } from './recordingViewerFrame'

function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)}`)
}

const start = { x: 10, y: 20, w: 460, h: 320 }
equal(recordingViewerFrameAt(start, 'move', 12, -7), { x: 22, y: 13, w: 460, h: 320 }, 'move')
equal(recordingViewerFrameAt(start, 'resize', 30, 40), { x: 10, y: 20, w: 490, h: 360 }, 'resize')
equal(recordingViewerFrameAt(start, 'resize', -999, -999), { x: 10, y: 20, w: 280, h: 220 }, 'minimum size')

const listeners = new Map<string, EventListener>()
const removed: string[] = []
const target = {
  addEventListener(type: string, listener: EventListener) { listeners.set(type, listener) },
  removeEventListener(type: string, listener: EventListener) {
    if (listeners.get(type) === listener) listeners.delete(type)
    removed.push(type)
  },
}
let frame = start
const cleanup = trackRecordingViewerFrame(target, { x: 5, y: 6 }, start, 'move', next => { frame = next })
listeners.get('pointermove')?.({ clientX: 20, clientY: 30 } as unknown as Event)
equal(frame, { x: 25, y: 44, w: 460, h: 320 }, 'tracked move')
cleanup()
equal([...listeners.keys()], [], 'all listeners removed')
equal(removed.sort(), ['pointercancel', 'pointermove', 'pointerup'], 'removed listener names')
cleanup()
equal(removed.length, 3, 'cleanup is idempotent')

console.log('recording viewer frame: PASS')
