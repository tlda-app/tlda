import type { Editor, TLRecord } from 'tldraw'

const RECORDABLE_SHAPES = new Set([
  'draw',
  'highlight',
  'arrow',
  'geo',
  'line',
  'text',
  'note',
  'math-note',
])

export type LiveSessionEvent =
  | {
      t: number
      kind: 'session'
      action: 'started' | 'ended' | 'capabilities'
      room?: string
      capabilities?: LiveSessionCapabilities
    }
  | { t: number; kind: 'canvas'; put: TLRecord[]; remove: string[] }
  | { t: number; kind: 'camera'; x: number; y: number; z: number }
  | { t: number; kind: 'participant'; action: 'joined' | 'left'; identity: string; name?: string }
  | { t: number; kind: 'replay-control'; action: 'pause-live' | 'seek' | 'play' | 'pause' | 'return-live'; cursor?: number; windowMs?: number }
  | {
      t: number
      kind: 'track'
      action: 'subscribed' | 'unsubscribed'
      identity: string
      name?: string
      trackKey?: string
      sid?: string
      source?: string
      trackKind?: string
      subscribedAtMs?: number
      unsubscribedAtMs?: number
      durationMs?: number
    }
  | {
      t: number
      kind: 'recording'
      action: 'available' | 'started' | 'stopped' | 'failed'
      egressId?: string
      artifactId?: string
      url?: string
      status?: string
      room?: string
      startedAt?: string
      stoppedAt?: string
      trackCount?: number
      participantCount?: number
      error?: string
    }
  | { t: number; kind: 'video'; action: 'available' | 'published' | 'unpublished'; identity?: string; sid?: string; source?: string }
  | {
      t: number
      kind: 'spatial'
      action: 'configured' | 'updated'
      enabled: boolean
      mode?: string
      identity?: string
      sid?: string
      source?: string
      x?: number
      y?: number
      z?: number
      pan?: number
      reason?: string
    }

export interface LiveSessionCapabilities {
  roomAudio: boolean
  multitrackMetadata: boolean
  canvasReplay: boolean
  recording: boolean
  video: boolean
  spatialAudio: boolean
}

type LiveSessionEventInput = LiveSessionEvent extends infer E
  ? E extends { t: number }
    ? Omit<E, 't'> & { t?: number }
    : never
  : never

export interface LiveSessionSnapshot {
  id: string
  doc: string
  room: string
  startedAt: string
  durationMs: number
  events: LiveSessionEvent[]
}

export class LiveSessionBuffer {
  readonly id: string
  readonly doc: string
  readonly room: string
  readonly startedAtIso: string
  private startedAt = performance.now()
  private events: LiveSessionEvent[] = []
  private maxEvents: number
  private onPush?: (event: LiveSessionEvent) => void

  constructor({ doc, room, maxEvents = 5000, onPush }: { doc: string; room: string; maxEvents?: number; onPush?: (event: LiveSessionEvent) => void }) {
    this.id = `live-${Date.now().toString(36)}`
    this.doc = doc
    this.room = room
    this.maxEvents = maxEvents
    this.onPush = onPush
    this.startedAtIso = new Date().toISOString()
  }

  now() {
    return Math.max(0, performance.now() - this.startedAt)
  }

  push(event: LiveSessionEventInput) {
    const next = { ...event, t: event.t ?? this.now() } as LiveSessionEvent
    this.events.push(next)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    this.onPush?.(next)
  }

  snapshot(): LiveSessionSnapshot {
    return {
      id: this.id,
      doc: this.doc,
      room: this.room,
      startedAt: this.startedAtIso,
      durationMs: Math.round(this.now()),
      events: this.events.slice(),
    }
  }
}

function isRecordable(rec: TLRecord | undefined): boolean {
  return !!rec && rec.typeName === 'shape' && RECORDABLE_SHAPES.has((rec as any).type)
}

export function attachCanvasBuffer(editor: Editor, buffer: LiveSessionBuffer): () => void {
  let lastCamera: { x: number; y: number; z: number } | null = null

  const unlistenStore = editor.store.listen((entry) => {
    const { added, updated, removed } = entry.changes
    const put: TLRecord[] = []
    const remove: string[] = []

    for (const rec of Object.values(added)) {
      if (isRecordable(rec)) put.push(rec)
    }
    for (const pair of Object.values(updated)) {
      const next = (pair as [TLRecord, TLRecord])[1]
      if (isRecordable(next)) put.push(next)
    }
    for (const rec of Object.values(removed)) {
      if (isRecordable(rec)) remove.push(String((rec as TLRecord).id))
    }

    if (put.length || remove.length) buffer.push({ kind: 'canvas', put, remove })
  }, { source: 'user', scope: 'document' })

  const pushCamera = () => {
    const c = editor.getCamera()
    if (!lastCamera || c.x !== lastCamera.x || c.y !== lastCamera.y || c.z !== lastCamera.z) {
      buffer.push({ kind: 'camera', x: c.x, y: c.y, z: c.z })
      lastCamera = { x: c.x, y: c.y, z: c.z }
    }
  }

  pushCamera()
  const cameraInterval = window.setInterval(pushCamera, 250)

  return () => {
    unlistenStore()
    window.clearInterval(cameraInterval)
  }
}
