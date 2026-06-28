import type { RemoteAudioTrack } from 'livekit-client'

interface RegisterAudioTrackOptions {
  session: string
  participant: string
  trackSid: string
  source?: string
  track: RemoteAudioTrack
  liveElement: HTMLMediaElement
  now: () => number
}

interface LiveAudioSegment {
  id: string
  participant: string
  trackSid: string
  source?: string
  startedAt: number
  endedAt: number
  url: string
}

interface TrackRecorder {
  recorder: MediaRecorder | null
  stream: MediaStream
  liveElement: HTMLMediaElement
  segments: LiveAudioSegment[]
  stopped: boolean
  stop: () => void
}

interface AudioReplaySession {
  tracks: Map<string, TrackRecorder>
  activePlayback: Array<HTMLAudioElement | number>
}

const MAX_SEGMENTS_PER_TRACK = 90
const SEGMENT_MS = 1000
const sessions = new Map<string, AudioReplaySession>()

function sessionFor(session: string): AudioReplaySession {
  let existing = sessions.get(session)
  if (!existing) {
    existing = { tracks: new Map(), activePlayback: [] }
    sessions.set(session, existing)
  }
  return existing
}

function supportedMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ]
  return candidates.find(type => MediaRecorder.isTypeSupported(type))
}

export function registerLiveAudioTrack({
  session,
  participant,
  trackSid,
  source,
  track,
  liveElement,
  now,
}: RegisterAudioTrackOptions): () => void {
  if (typeof MediaRecorder === 'undefined') return () => {}
  const mediaStreamTrack = track.mediaStreamTrack
  if (!mediaStreamTrack || mediaStreamTrack.readyState !== 'live') return () => {}

  const key = `${participant}:${trackSid}`
  unregisterLiveAudioTrack(session, key)

  const stream = new MediaStream([mediaStreamTrack])
  const mimeType = supportedMimeType()
  const record: TrackRecorder = {
    recorder: null,
    stream,
    liveElement,
    segments: [],
    stopped: false,
    stop: () => {},
  }

  const owner = sessionFor(session)
  owner.tracks.set(key, record)

  const appendSegment = (blob: Blob, startedAt: number, endedAt: number) => {
    if (!blob.size) return
    const url = URL.createObjectURL(blob)
    record.segments.push({
      id: `${key}:${Math.round(startedAt)}:${Math.round(endedAt)}`,
      participant,
      trackSid,
      source,
      startedAt,
      endedAt,
      url,
    })
    while (record.segments.length > MAX_SEGMENTS_PER_TRACK) {
      const old = record.segments.shift()
      if (old) URL.revokeObjectURL(old.url)
    }
  }

  const startSegment = () => {
    if (record.stopped || mediaStreamTrack.readyState !== 'live') return
    const chunks: Blob[] = []
    const startedAt = now()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    record.recorder = recorder
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size) chunks.push(event.data)
    })
    recorder.addEventListener('stop', () => {
      const endedAt = now()
      record.recorder = null
      if (chunks.length) appendSegment(new Blob(chunks, { type: recorder.mimeType }), startedAt, endedAt)
      if (!record.stopped) window.setTimeout(startSegment, 0)
    }, { once: true })
    try {
      recorder.start()
      window.setTimeout(() => {
        if (record.recorder === recorder && recorder.state !== 'inactive') recorder.stop()
      }, SEGMENT_MS)
    } catch {
      record.stopped = true
      owner.tracks.delete(key)
    }
  }

  record.stop = () => {
    record.stopped = true
    if (record.recorder && record.recorder.state !== 'inactive') record.recorder.stop()
    for (const segment of record.segments) URL.revokeObjectURL(segment.url)
    record.segments = []
  }

  startSegment()

  return () => unregisterLiveAudioTrack(session, key)
}

export function unregisterLiveAudioTrack(session: string, key: string) {
  const owner = sessions.get(session)
  const record = owner?.tracks.get(key)
  if (!owner || !record) return
  record.stop()
  owner.tracks.delete(key)
  if (!owner.tracks.size && !owner.activePlayback.length) sessions.delete(session)
}

export function stopLiveAudioReplay(session: string) {
  const owner = sessions.get(session)
  if (!owner) return
  for (const item of owner.activePlayback) {
    if (typeof item === 'number') {
      window.clearTimeout(item)
    } else {
      item.pause()
      item.remove()
    }
  }
  owner.activePlayback = []
  for (const track of owner.tracks.values()) {
    track.liveElement.muted = false
  }
}

export function playLiveAudioReplay(session: string, fromMs: number, toMs: number) {
  const owner = sessions.get(session)
  if (!owner) return { played: 0, stop: () => {} }
  stopLiveAudioReplay(session)

  let start = Math.max(0, fromMs)
  let end = Math.max(start, toMs)
  const allSegments = [...owner.tracks.values()]
    .flatMap(track => track.segments)
    .sort((a, b) => a.startedAt - b.startedAt)
  let segments = allSegments.filter(segment => segment.endedAt >= start && segment.startedAt <= end)

  if (!segments.length && allSegments.length) {
    const latestEnd = Math.max(...allSegments.map(segment => segment.endedAt))
    const duration = Math.max(1000, Math.min(8000, end - start || 8000))
    start = Math.max(0, latestEnd - duration)
    end = latestEnd
    segments = allSegments.filter(segment => segment.endedAt >= start && segment.startedAt <= end)
  }

  if (segments.length) {
    start = Math.min(...segments.map(segment => segment.startedAt))
    end = Math.max(end, ...segments.map(segment => segment.endedAt))
  }

  for (const track of owner.tracks.values()) {
    track.liveElement.muted = true
  }

  for (const segment of segments) {
    const delay = Math.max(0, segment.startedAt - start)
    const timeout = window.setTimeout(() => {
      const el = new Audio(segment.url)
      el.autoplay = true
      el.dataset.livekitReplayParticipant = segment.participant
      el.dataset.livekitReplayTrack = segment.trackSid
      el.style.display = 'none'
      if (segment.startedAt < start) el.currentTime = Math.max(0, (start - segment.startedAt) / 1000)
      document.body.appendChild(el)
      owner.activePlayback.push(el)
      void el.play().catch(() => {})
      el.addEventListener('ended', () => {
        el.remove()
        owner.activePlayback = owner.activePlayback.filter(item => item !== el)
      }, { once: true })
    }, delay)
    owner.activePlayback.push(timeout)
  }

  const unmute = window.setTimeout(() => stopLiveAudioReplay(session), Math.max(1000, end - start + 1000))
  owner.activePlayback.push(unmute)

  return { played: segments.length, stop: () => stopLiveAudioReplay(session) }
}

export function getLiveAudioReplaySummary(session: string) {
  const owner = sessions.get(session)
  if (!owner) return { tracks: 0, segments: 0, active: 0 }
  return {
    tracks: owner.tracks.size,
    segments: [...owner.tracks.values()].reduce((sum, track) => sum + track.segments.length, 0),
    active: owner.activePlayback.length,
  }
}
