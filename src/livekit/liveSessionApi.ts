import type { LiveSessionEvent } from './sessionBuffer'

export interface LiveSessionEventsQuery {
  doc: string
  session: string
  cursor?: number
  since?: number
  fromMs?: number
  toMs?: number
  windowMs?: number
  limit?: number
}

export interface LiveSessionEventsResponse {
  doc: string
  session: string
  key?: string
  events: Array<LiveSessionEvent & { seq?: number; serverTs?: number }>
  total: number
  count: number
  firstSeq: number
  lastSeq: number
  nextCursor: number
  cursor: number
  limit: number
  window: {
    fromMs?: number
    toMs?: number
    windowMs?: number
  }
}

interface LiveSessionEventSink {
  push(event: LiveSessionEvent): void
  flush(): Promise<void>
  dispose(): Promise<void>
}

export async function fetchLiveSessionEvents({
  doc,
  session,
  cursor,
  since,
  fromMs,
  toMs,
  windowMs,
  limit = 1000,
}: LiveSessionEventsQuery): Promise<LiveSessionEventsResponse> {
  const params = new URLSearchParams({
    doc,
    session,
    limit: String(limit),
  })
  if (cursor != null) params.set('cursor', String(cursor))
  else if (since != null) params.set('since', String(since))
  if (fromMs != null) params.set('fromMs', String(fromMs))
  if (toMs != null) params.set('toMs', String(toMs))
  if (windowMs != null) params.set('windowMs', String(windowMs))

  const resp = await fetch(`/api/livekit/session/events?${params}`)
  const body = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(body.error || `session events failed (${resp.status})`)
  return body
}

export function createLiveSessionEventSink({
  doc,
  session,
  flushMs = 1000,
  maxBatch = 50,
}: {
  doc: string
  session: string
  flushMs?: number
  maxBatch?: number
}): LiveSessionEventSink {
  let queue: LiveSessionEvent[] = []
  let timer: number | null = null
  let disposed = false

  const clearTimer = () => {
    if (timer) window.clearTimeout(timer)
    timer = null
  }

  const schedule = () => {
    if (disposed || timer) return
    timer = window.setTimeout(() => { void flush() }, flushMs)
  }

  async function flush() {
    clearTimer()
    if (!queue.length) return
    const events = queue
    queue = []
    try {
      const resp = await fetch('/api/livekit/session/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc, session, events }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    } catch (e) {
      queue = events.concat(queue).slice(-maxBatch * 4)
      if (!disposed) schedule()
      throw e
    }
  }

  return {
    push(event) {
      if (disposed) return
      queue.push(event)
      if (queue.length >= maxBatch) {
        void flush().catch(() => {})
      } else {
        schedule()
      }
    },
    flush,
    async dispose() {
      disposed = true
      clearTimer()
      await flush().catch(() => {})
    },
  }
}
