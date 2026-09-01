export interface RecordingViewerFrame {
  x: number
  y: number
  w: number
  h: number
}

export function recordingViewerFrameAt(
  start: RecordingViewerFrame,
  kind: 'move' | 'resize',
  dx: number,
  dy: number,
): RecordingViewerFrame {
  return kind === 'move'
    ? { ...start, x: start.x + dx, y: start.y + dy }
    : { ...start, w: Math.max(280, start.w + dx), h: Math.max(220, start.h + dy) }
}

interface PointerWindow {
  addEventListener(type: string, listener: EventListener, capture?: boolean): void
  removeEventListener(type: string, listener: EventListener, capture?: boolean): void
}

export function trackRecordingViewerFrame(
  target: PointerWindow,
  pointer: { x: number; y: number },
  start: RecordingViewerFrame,
  kind: 'move' | 'resize',
  update: (frame: RecordingViewerFrame) => void,
): () => void {
  const move: EventListener = (event) => {
    const next = event as PointerEvent
    update(recordingViewerFrameAt(start, kind, next.clientX - pointer.x, next.clientY - pointer.y))
  }
  let active = true
  const cleanup = () => {
    if (!active) return
    active = false
    target.removeEventListener('pointermove', move, true)
    target.removeEventListener('pointerup', cleanup as EventListener, true)
    target.removeEventListener('pointercancel', cleanup as EventListener, true)
  }
  target.addEventListener('pointermove', move, true)
  target.addEventListener('pointerup', cleanup as EventListener, true)
  target.addEventListener('pointercancel', cleanup as EventListener, true)
  return cleanup
}
