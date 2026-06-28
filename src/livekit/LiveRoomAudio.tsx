import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import { Room, RoomEvent, Track } from 'livekit-client'
import type { RemoteAudioTrack, RemoteVideoTrack, RemoteTrack, RemoteTrackPublication, RemoteParticipant } from 'livekit-client'
import { log } from '../logger'
import { getDeviceId, getHumanId, getHumanName } from '../fleet/fleet-data.mjs'
import { createFleetShape } from '../shapes/fleet-utils'
import { attachCanvasBuffer, LiveSessionBuffer } from './sessionBuffer'
import type { LiveSessionCapabilities } from './sessionBuffer'
import { createLiveSessionEventSink, fetchLiveSessionEvents } from './liveSessionApi'
import { LiveSessionReplay } from './LiveSessionReplay'
import { getLiveAudioReplaySummary, registerLiveAudioTrack, stopLiveAudioReplay } from './audioReplayBuffer'
import { getLiveVideoTiles, removeLiveVideoTile, setLiveVideoTile } from './liveVideoRegistry'
import { listLiveRecordings, startLiveRecording, stopLiveRecording } from './recordingApi'
import './LiveRoomAudio.css'

type Status = 'idle' | 'connecting' | 'connected' | 'error'
type SpatialStatus = 'off' | 'enabled' | 'unsupported' | 'error'

interface LiveRoomAudioProps {
  docName: string
  editor: Editor
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
}

interface TokenResponse {
  url: string
  room: string
  token: string
}

interface SpatialPosition {
  x: number
  y: number
  z: number
  pan: number
  angle: number
}

interface RemoteAudioTrackInfo {
  key: string
  identity: string
  name?: string
  sid?: string
  source?: string
  subscribedAtMs: number
  participantMetadata?: string
  publicationMetadata?: string
  track: RemoteAudioTrack
  element: HTMLMediaElement
}

interface LiveTrackTiming {
  key: string
  identity: string
  name?: string
  sid?: string
  source?: string
  trackKind?: string
  subscribedAtMs: number
}

interface SpatialTrackState {
  key: string
  identity: string
  sid?: string
  source?: string
  mode: 'panner' | 'stereo'
  position: SpatialPosition
  cleanup: () => void
}

function sessionId(docName: string) {
  return `doc-${docName}-live`
}

function participantIdentity() {
  return [getHumanId() || 'anon', getDeviceId() || 'device']
    .join('--')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .slice(0, 120)
}

function participantName() {
  return getHumanName() || getHumanId() || 'viewer'
}

const LIVE_SESSION_CAPABILITIES: LiveSessionCapabilities = {
  roomAudio: true,
  multitrackMetadata: true,
  canvasReplay: true,
  recording: true,
  video: true,
  spatialAudio: true,
}

async function requestToken(docName: string): Promise<TokenResponse> {
  const resp = await fetch('/api/livekit/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      doc: docName,
      session: sessionId(docName),
      identity: participantIdentity(),
      name: participantName(),
    }),
  })
  const body = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(body.error || `LiveKit token failed (${resp.status})`)
  return body
}

function isRemoteAudio(track: RemoteTrack): track is RemoteAudioTrack {
  return track.kind === Track.Kind.Audio
}

function isRemoteVideo(track: RemoteTrack): track is RemoteVideoTrack {
  return track.kind === Track.Kind.Video
}

function hashString(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function numericMetadata(value: string | undefined, keys: string[]): number | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    for (const key of keys) {
      const raw = parsed[key]
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      if (typeof raw === 'string') {
        const num = Number(raw)
        if (Number.isFinite(num)) return num
      }
    }
  } catch {
    return undefined
  }
}

function spatialPositionForTrack(info: RemoteAudioTrackInfo, slot: number): SpatialPosition {
  const angleFromMetadata =
    numericMetadata(info.publicationMetadata, ['angle', 'spatialAngle', 'direction']) ??
    numericMetadata(info.participantMetadata, ['angle', 'spatialAngle', 'direction'])
  const xFromMetadata =
    numericMetadata(info.publicationMetadata, ['x', 'spatialX']) ??
    numericMetadata(info.participantMetadata, ['x', 'spatialX'])
  const zFromMetadata =
    numericMetadata(info.publicationMetadata, ['z', 'spatialZ']) ??
    numericMetadata(info.participantMetadata, ['z', 'spatialZ'])

  if (xFromMetadata != null || zFromMetadata != null) {
    const x = xFromMetadata ?? 0
    const z = zFromMetadata ?? -1
    const angle = Math.atan2(z, x)
    return {
      x,
      y: 0,
      z,
      pan: Math.max(-1, Math.min(1, x / Math.max(1, Math.hypot(x, z)))),
      angle,
    }
  }

  const seed = `${info.identity}:${info.sid || info.source || info.key}`
  const base = angleFromMetadata != null ? angleFromMetadata * Math.PI / 180 : ((hashString(seed) + slot * 7919) % 360) * Math.PI / 180
  return {
    x: Number(Math.cos(base).toFixed(3)),
    y: 0,
    z: Number(Math.sin(base).toFixed(3)),
    pan: Number(Math.max(-1, Math.min(1, Math.cos(base))).toFixed(3)),
    angle: Number(base.toFixed(3)),
  }
}

export function LiveRoomAudio({ docName, editor, shapeUtils, tools, licenseKey }: LiveRoomAudioProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [micOn, setMicOn] = useState(false)
  const [participantCount, setParticipantCount] = useState(0)
  const [videoKeys, setVideoKeys] = useState<string[]>([])
  const [spatialEnabled, setSpatialEnabled] = useState(false)
  const [spatialStatus, setSpatialStatus] = useState<SpatialStatus>('off')
  const [error, setError] = useState<string | null>(null)
  const roomRef = useRef<Room | null>(null)
  const audioElsRef = useRef(new Map<string, HTMLMediaElement>())
  const audioRecorderCleanupsRef = useRef(new Map<string, () => void>())
  const audioTracksRef = useRef(new Map<string, RemoteAudioTrackInfo>())
  const spatialAudioContextRef = useRef<AudioContext | null>(null)
  const spatialNodesRef = useRef(new Map<string, SpatialTrackState>())
  const cleanupBufferRef = useRef<(() => void) | null>(null)
  const bufferRef = useRef<LiveSessionBuffer | null>(null)
  const sinkRef = useRef<ReturnType<typeof createLiveSessionEventSink> | null>(null)
  const disconnectSeqRef = useRef(0)
  const videoShapeIdRef = useRef<string | null>(null)
  const recordingArtifactIdRef = useRef<string | null>(null)
  const trackTimingsRef = useRef(new Map<string, LiveTrackTiming>())

  const title = useMemo(() => {
    if (error) return error
    if (status === 'connected') return micOn ? 'Leave live room audio' : 'Turn on microphone'
    if (status === 'connecting') return 'Connecting live room audio'
    return 'Join live room audio'
  }, [error, micOn, status])

  const refreshParticipants = useCallback(() => {
    const room = roomRef.current
    setParticipantCount(room ? room.remoteParticipants.size + 1 : 0)
  }, [])

  const cleanupSpatialTrack = useCallback((key: string, restoreElement = true) => {
    const spatial = spatialNodesRef.current.get(key)
    if (spatial) {
      spatial.cleanup()
      spatialNodesRef.current.delete(key)
    }
    if (restoreElement) {
      const info = audioTracksRef.current.get(key)
      if (info) info.element.muted = false
    }
  }, [])

  const cleanupAllSpatialTracks = useCallback((restoreElements = true) => {
    for (const key of Array.from(spatialNodesRef.current.keys())) {
      cleanupSpatialTrack(key, restoreElements)
    }
    if (restoreElements) {
      for (const info of audioTracksRef.current.values()) info.element.muted = false
    }
  }, [cleanupSpatialTrack])

  const applySpatialTrack = useCallback(async (info: RemoteAudioTrackInfo) => {
    cleanupSpatialTrack(info.key, false)
    info.element.muted = false

    if (!spatialEnabled) return false

    const AudioContextCtor = (window as any).AudioContext || (window as any).webkitAudioContext
    const mediaStreamTrack = (info.track as any).mediaStreamTrack as MediaStreamTrack | undefined
    if (!AudioContextCtor || !mediaStreamTrack) {
      setSpatialStatus('unsupported')
      bufferRef.current?.push({
        kind: 'spatial',
        action: 'updated',
        enabled: false,
        mode: 'unsupported',
        identity: info.identity,
        sid: info.sid,
        source: info.source,
        reason: !AudioContextCtor ? 'AudioContext unavailable' : 'remote MediaStreamTrack unavailable',
      })
      return false
    }

    try {
      const context = spatialAudioContextRef.current ?? new AudioContextCtor()
      spatialAudioContextRef.current = context
      if (context.state === 'suspended') await context.resume()

      const slot = Array.from(audioTracksRef.current.keys()).indexOf(info.key)
      const position = spatialPositionForTrack(info, Math.max(0, slot))
      const stream = new MediaStream([mediaStreamTrack])
      const source = context.createMediaStreamSource(stream)
      let mode: SpatialTrackState['mode'] = 'stereo'
      let cleanup: () => void

      if (typeof context.createPanner === 'function') {
        const panner = context.createPanner()
        panner.panningModel = 'HRTF'
        panner.distanceModel = 'inverse'
        panner.refDistance = 1
        panner.maxDistance = 10000
        panner.rolloffFactor = 1
        if ('positionX' in panner) {
          panner.positionX.value = position.x
          panner.positionY.value = position.y
          panner.positionZ.value = position.z
        } else {
          panner.setPosition(position.x, position.y, position.z)
        }
        source.connect(panner)
        panner.connect(context.destination)
        mode = 'panner'
        cleanup = () => {
          source.disconnect()
          panner.disconnect()
        }
      } else if (typeof context.createStereoPanner === 'function') {
        const panner = context.createStereoPanner()
        panner.pan.value = position.pan
        source.connect(panner)
        panner.connect(context.destination)
        cleanup = () => {
          source.disconnect()
          panner.disconnect()
        }
      } else {
        setSpatialStatus('unsupported')
        bufferRef.current?.push({
          kind: 'spatial',
          action: 'updated',
          enabled: false,
          mode: 'unsupported',
          identity: info.identity,
          sid: info.sid,
          source: info.source,
          reason: 'PannerNode unavailable',
        })
        return false
      }

      info.element.muted = true
      spatialNodesRef.current.set(info.key, {
        key: info.key,
        identity: info.identity,
        sid: info.sid,
        source: info.source,
        mode,
        position,
        cleanup,
      })
      setSpatialStatus('enabled')
      bufferRef.current?.push({
        kind: 'spatial',
        action: 'updated',
        enabled: true,
        mode,
        identity: info.identity,
        sid: info.sid,
        source: info.source,
        x: position.x,
        y: position.y,
        z: position.z,
        pan: position.pan,
      })
      return true
    } catch (e) {
      info.element.muted = false
      setSpatialStatus('error')
      bufferRef.current?.push({
        kind: 'spatial',
        action: 'updated',
        enabled: false,
        mode: 'error',
        identity: info.identity,
        sid: info.sid,
        source: info.source,
        reason: e instanceof Error ? e.message : String(e),
      })
      return false
    }
  }, [cleanupSpatialTrack, spatialEnabled])

  const applySpatialToAllTracks = useCallback(async () => {
    let applied = false
    for (const info of audioTracksRef.current.values()) {
      applied = await applySpatialTrack(info) || applied
    }
    if (spatialEnabled && audioTracksRef.current.size === 0) setSpatialStatus('enabled')
    return applied
  }, [applySpatialTrack, spatialEnabled])

  const pushTrackUnsubscribed = useCallback((key: string, fallback?: Partial<LiveTrackTiming>) => {
    const existing = trackTimingsRef.current.get(key)
    const timing = existing ?? (fallback?.identity ? {
      key,
      identity: fallback.identity,
      name: fallback.name,
      sid: fallback.sid,
      source: fallback.source,
      trackKind: fallback.trackKind,
      subscribedAtMs: fallback.subscribedAtMs ?? (bufferRef.current?.now() ?? 0),
    } : null)
    if (!timing) return
    const unsubscribedAtMs = bufferRef.current?.now() ?? timing.subscribedAtMs
    bufferRef.current?.push({
      kind: 'track',
      action: 'unsubscribed',
      identity: timing.identity,
      name: timing.name,
      trackKey: key,
      sid: timing.sid,
      source: timing.source,
      trackKind: timing.trackKind,
      subscribedAtMs: timing.subscribedAtMs,
      unsubscribedAtMs,
      durationMs: Math.max(0, unsubscribedAtMs - timing.subscribedAtMs),
    })
    trackTimingsRef.current.delete(key)
  }, [])

  const detachTrack = useCallback((track: RemoteTrack, key?: string) => {
    if (isRemoteAudio(track)) {
      const els = track.detach()
      for (const el of els) el.remove()
    }
    if (isRemoteVideo(track)) {
      const els = track.detach()
      for (const el of els) el.remove()
    }
    if (key) {
      cleanupSpatialTrack(key)
      audioTracksRef.current.delete(key)
      audioElsRef.current.delete(key)
      trackTimingsRef.current.delete(key)
      removeLiveVideoTile(key)
      setVideoKeys(prev => prev.filter(tileKey => tileKey !== key))
    }
  }, [cleanupSpatialTrack])

  const attachTrack = useCallback((track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    const key = `${participant.identity}:${publication.trackSid || track.sid || track.kind}`
    detachTrack(track, key)
    const subscribedAtMs = bufferRef.current?.now() ?? 0
    const timing: LiveTrackTiming = {
      key,
      identity: participant.identity,
      name: participant.name,
      sid: publication.trackSid || track.sid,
      source: String(publication.source || ''),
      trackKind: track.kind,
      subscribedAtMs,
    }
    trackTimingsRef.current.set(key, timing)

    if (isRemoteAudio(track)) {
      const el = track.attach()
      el.autoplay = true
      el.dataset.livekitParticipant = participant.identity
      el.dataset.livekitTrack = publication.trackSid || track.sid || ''
      el.style.display = 'none'
      document.body.appendChild(el)
      audioElsRef.current.set(key, el)
      const trackInfo: RemoteAudioTrackInfo = {
        key,
        identity: participant.identity,
        name: participant.name,
        sid: publication.trackSid || track.sid,
        source: String(publication.source || ''),
        subscribedAtMs,
        participantMetadata: (participant as any).metadata,
        publicationMetadata: (publication as any).metadata,
        track,
        element: el,
      }
      audioTracksRef.current.set(key, trackInfo)
      audioRecorderCleanupsRef.current.set(key, registerLiveAudioTrack({
        session: sessionId(docName),
        participant: participant.identity,
        trackSid: publication.trackSid || track.sid || 'audio',
        source: publication.source,
        track,
        liveElement: el,
        now: () => bufferRef.current?.now() ?? 0,
      }))
      void applySpatialTrack(trackInfo)
    } else if (isRemoteVideo(track)) {
      const mediaStreamTrack = (track as any).mediaStreamTrack as MediaStreamTrack | undefined
      if (!mediaStreamTrack) return
      setLiveVideoTile({
        key,
        identity: participant.identity,
        name: participant.name,
        trackSid: publication.trackSid || track.sid,
        stream: new MediaStream([mediaStreamTrack]),
      })
      setVideoKeys(prev => [...prev.filter(tileKey => tileKey !== key), key])
      bufferRef.current?.push({
        kind: 'video',
        action: 'available',
        identity: participant.identity,
        sid: publication.trackSid || track.sid,
        source: publication.source,
      })
    } else {
      return
    }

    bufferRef.current?.push({
      kind: 'track',
      action: 'subscribed',
      identity: participant.identity,
      name: participant.name,
      trackKey: key,
      sid: publication.trackSid || track.sid,
      source: publication.source,
      trackKind: track.kind,
      subscribedAtMs,
    })
  }, [applySpatialTrack, detachTrack, docName])

  const disconnect = useCallback(async (nextStatus: Status = 'idle') => {
    const seq = ++disconnectSeqRef.current
    const room = roomRef.current
    for (const [key, timing] of Array.from(trackTimingsRef.current.entries())) {
      pushTrackUnsubscribed(key, timing)
    }
    bufferRef.current?.push({
      kind: 'session',
      action: 'ended',
      room: bufferRef.current.room,
      capabilities: LIVE_SESSION_CAPABILITIES,
    })
    roomRef.current = null
    cleanupBufferRef.current?.()
    cleanupBufferRef.current = null
    await sinkRef.current?.dispose()
    sinkRef.current = null
    bufferRef.current = null
    stopLiveAudioReplay(sessionId(docName))
    cleanupAllSpatialTracks(false)
    audioTracksRef.current.clear()
    trackTimingsRef.current.clear()
    for (const cleanup of audioRecorderCleanupsRef.current.values()) cleanup()
    audioRecorderCleanupsRef.current.clear()
    for (const el of audioElsRef.current.values()) el.remove()
    audioElsRef.current.clear()
    void spatialAudioContextRef.current?.close().catch(() => {})
    spatialAudioContextRef.current = null
    for (const tile of getLiveVideoTiles()) removeLiveVideoTile(tile.key)
    setVideoKeys([])
    if (videoShapeIdRef.current && editor.getShape(videoShapeIdRef.current as any)) {
      const id = videoShapeIdRef.current
      editor.run(() => {
        const shape = editor.getShape(id as any)
        if (shape?.isLocked) editor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
        if (editor.getShape(id as any)) editor.deleteShape(id as any)
      }, { history: 'ignore' })
    }
    videoShapeIdRef.current = null
    setSpatialEnabled(false)
    setSpatialStatus('off')
    setMicOn(false)
    setParticipantCount(0)
    if (room) await room.disconnect()
    if (seq === disconnectSeqRef.current) setStatus(nextStatus)
  }, [cleanupAllSpatialTracks, docName, pushTrackUnsubscribed])

  const deleteVideoShape = useCallback((id: string) => {
    const shape = editor.getShape(id as any)
    if (!shape) return
    editor.run(() => {
      const current = editor.getShape(id as any)
      if (current?.isLocked) editor.updateShape({ id: current.id, type: current.type, isLocked: false })
      if (editor.getShape(id as any)) editor.deleteShape(id as any)
    }, { history: 'ignore' })
  }, [editor])

  const connect = useCallback(async () => {
    if (roomRef.current || status === 'connecting') return
    setStatus('connecting')
    setError(null)

    try {
      const info = await requestToken(docName)
      const room = new Room({
        adaptiveStream: false,
        dynacast: true,
      })
      roomRef.current = room
      const sink = createLiveSessionEventSink({ doc: docName, session: sessionId(docName) })
      sinkRef.current = sink
      const buffer = new LiveSessionBuffer({ doc: docName, room: info.room, onPush: (event) => sink.push(event) })
      bufferRef.current = buffer
      buffer.push({
        kind: 'session',
        action: 'started',
        room: info.room,
        capabilities: LIVE_SESSION_CAPABILITIES,
      })
      buffer.push({
        kind: 'session',
        action: 'capabilities',
        room: info.room,
        capabilities: LIVE_SESSION_CAPABILITIES,
      })
      cleanupBufferRef.current = attachCanvasBuffer(editor, buffer)

      room
        .on(RoomEvent.Connected, () => {
          setStatus('connected')
          refreshParticipants()
          log.info('livekit', 'connected', { docName, room: info.room })
        })
        .on(RoomEvent.Disconnected, () => {
          if (roomRef.current === room) void disconnect()
        })
        .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
          buffer.push({ kind: 'participant', action: 'joined', identity: participant.identity, name: participant.name })
          refreshParticipants()
        })
        .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
          buffer.push({ kind: 'participant', action: 'left', identity: participant.identity, name: participant.name })
          for (const [key, timing] of Array.from(trackTimingsRef.current.entries())) {
            if (timing.identity === participant.identity) pushTrackUnsubscribed(key, timing)
          }
          for (const key of Array.from(audioTracksRef.current.keys())) {
            if (!key.startsWith(`${participant.identity}:`)) continue
            cleanupSpatialTrack(key)
            audioTracksRef.current.delete(key)
            audioElsRef.current.get(key)?.remove()
            audioElsRef.current.delete(key)
            audioRecorderCleanupsRef.current.get(key)?.()
            audioRecorderCleanupsRef.current.delete(key)
          }
          setVideoKeys(prev => {
            const next = prev.filter(key => {
              if (!key.startsWith(`${participant.identity}:`)) return true
              removeLiveVideoTile(key)
              return false
            })
            return next
          })
          refreshParticipants()
        })
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          attachTrack(track, publication, participant)
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          const key = `${participant.identity}:${publication.trackSid || track.sid || track.kind}`
          pushTrackUnsubscribed(key, {
            identity: participant.identity,
            name: participant.name,
            sid: publication.trackSid || track.sid,
            source: String(publication.source || ''),
            trackKind: track.kind,
          })
          audioRecorderCleanupsRef.current.get(`${participant.identity}:${publication.trackSid || track.sid || 'audio'}`)?.()
          audioRecorderCleanupsRef.current.delete(`${participant.identity}:${publication.trackSid || track.sid || 'audio'}`)
          if (isRemoteVideo(track)) {
            buffer.push({
              kind: 'video',
              action: 'unpublished',
              identity: participant.identity,
              sid: publication.trackSid || track.sid,
              source: publication.source,
            })
          }
          detachTrack(track, key)
        })
        .on(RoomEvent.ActiveSpeakersChanged, () => {
          refreshParticipants()
        })

      await room.connect(info.url, info.token, { autoSubscribe: true })
      await room.startAudio().catch((error) => {
        // Best effort playback unlock; the user can still toggle audio later.
        log.warn('livekit', 'startAudio failed after connect', { error: String(error) })
      })
    } catch (e) {
      log.warn('livekit', 'connect failed', { error: String(e) })
      setError(e instanceof Error ? e.message : String(e))
      await disconnect('error')
    }
  }, [attachTrack, cleanupSpatialTrack, detachTrack, disconnect, docName, editor, pushTrackUnsubscribed, refreshParticipants, status])

  const toggle = useCallback(async () => {
    if (status === 'connected') {
      if (!micOn) {
        try {
          setError(null)
          await roomRef.current?.localParticipant.setMicrophoneEnabled(true)
          setMicOn(true)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
          setStatus(roomRef.current ? 'connected' : 'error')
        }
        return
      }
      await disconnect()
      return
    }
    await connect()
  }, [connect, disconnect, micOn, status])

  const toggleSpatial = useCallback(async () => {
    if (status !== 'connected') return
    const nextEnabled = !spatialEnabled
    setSpatialEnabled(nextEnabled)
    bufferRef.current?.push({
      kind: 'spatial',
      action: 'configured',
      enabled: nextEnabled,
      mode: nextEnabled ? 'auto' : 'off',
      reason: nextEnabled ? undefined : 'disabled by user',
    })

    if (!nextEnabled) {
      cleanupAllSpatialTracks(true)
      setSpatialStatus('off')
      return
    }

    setSpatialStatus('enabled')
  }, [cleanupAllSpatialTracks, spatialEnabled, status])

  const collectRecordingMetadata = useCallback(() => {
    const room = roomRef.current
    const participants: Array<{ identity: string; name?: string; metadata?: string }> = []
    const tracks: Array<{
      identity: string
      sid?: string
      source?: string
      kind?: string
      name?: string
      participantMetadata?: string
      publicationMetadata?: string
    }> = []

    const addParticipant = (participant: any) => {
      if (!participant?.identity) return
      participants.push({
        identity: participant.identity,
        name: participant.name,
        metadata: participant.metadata,
      })
      const publications = participant.trackPublications?.values
        ? Array.from(participant.trackPublications.values())
        : Object.values(participant.trackPublications || {})
      for (const publication of publications as any[]) {
        tracks.push({
          identity: participant.identity,
          sid: publication.trackSid || publication.sid || publication.track?.sid,
          source: publication.source,
          kind: publication.kind || publication.track?.kind,
          name: publication.trackName || publication.name,
          participantMetadata: participant.metadata,
          publicationMetadata: publication.metadata,
        })
      }
    }

    if (room?.localParticipant) addParticipant(room.localParticipant)
    if (room?.remoteParticipants?.values) {
      for (const participant of Array.from(room.remoteParticipants.values())) addParticipant(participant)
    }

    return { participants, tracks }
  }, [])

  const startRecordingManifest = useCallback(async () => {
    if (status !== 'connected' || !roomRef.current) throw new Error('LiveKit room is not connected')
    const metadata = collectRecordingMetadata()
    const artifact = await startLiveRecording({
      doc: docName,
      session: sessionId(docName),
      room: roomRef.current.name,
      participants: metadata.participants,
      tracks: metadata.tracks,
    })
    recordingArtifactIdRef.current = artifact.id
    return artifact
  }, [collectRecordingMetadata, docName, status])

  const stopRecordingManifest = useCallback(async () => {
    const artifactId = recordingArtifactIdRef.current
    if (!artifactId) throw new Error('No active LiveKit recording manifest')
    const metadata = collectRecordingMetadata()
    const artifact = await stopLiveRecording({
      artifactId,
      participants: metadata.participants,
      tracks: metadata.tracks,
    })
    recordingArtifactIdRef.current = null
    return artifact
  }, [collectRecordingMetadata])

  useEffect(() => {
    return () => { void disconnect() }
  }, [disconnect])

  useEffect(() => {
    if (spatialEnabled) {
      void applySpatialToAllTracks()
    } else {
      cleanupAllSpatialTracks(true)
    }
  }, [applySpatialToAllTracks, cleanupAllSpatialTracks, spatialEnabled])

  useEffect(() => {
    ;(window as any).__tldaLiveSession = {
      snapshot: () => bufferRef.current?.snapshot() ?? null,
      room: () => roomRef.current,
      audioReplay: () => getLiveAudioReplaySummary(sessionId(docName)),
      videos: () => getLiveVideoTiles().map(({ stream: _stream, ...tile }) => tile),
      spatial: () => ({
        enabled: spatialEnabled,
        status: spatialStatus,
        trackCount: audioTracksRef.current.size,
        appliedCount: spatialNodesRef.current.size,
        tracks: Array.from(audioTracksRef.current.values()).map(info => ({
          key: info.key,
          identity: info.identity,
          name: info.name,
          sid: info.sid,
          source: info.source,
          muted: info.element.muted,
          applied: spatialNodesRef.current.has(info.key),
          spatial: spatialNodesRef.current.get(info.key)
            ? {
                mode: spatialNodesRef.current.get(info.key)?.mode,
                position: spatialNodesRef.current.get(info.key)?.position,
              }
            : null,
        })),
      }),
      multitrack: () => ({
        activeAudioCount: audioTracksRef.current.size,
        activeElementCount: audioElsRef.current.size,
        activeTimingCount: trackTimingsRef.current.size,
        tracks: Array.from(audioTracksRef.current.values()).map(info => ({
          key: info.key,
          identity: info.identity,
          name: info.name,
          sid: info.sid,
          source: info.source,
          subscribedAtMs: info.subscribedAtMs,
          element: {
            participant: info.element.dataset.livekitParticipant,
            track: info.element.dataset.livekitTrack,
            connected: info.element.isConnected,
            readyState: info.element.readyState,
            paused: info.element.paused,
          },
          timing: trackTimingsRef.current.get(info.key) ?? null,
        })),
      }),
      recording: () => ({
        activeArtifactId: recordingArtifactIdRef.current,
        metadata: collectRecordingMetadata(),
      }),
      recordingStart: startRecordingManifest,
      recordingStop: stopRecordingManifest,
      recordings: () => listLiveRecordings({ doc: docName, session: sessionId(docName) }),
      events: async (query = {}) => fetchLiveSessionEvents({ doc: docName, session: sessionId(docName), limit: 5000, ...query }),
    }
  }, [collectRecordingMetadata, docName, spatialEnabled, spatialStatus, startRecordingManifest, stopRecordingManifest])

  useEffect(() => {
    const existingId = videoShapeIdRef.current
    if (videoKeys.length === 0) {
      if (existingId && editor.getShape(existingId as any)) {
        deleteVideoShape(existingId)
      }
      videoShapeIdRef.current = null
      return
    }

    const tileKeys = JSON.stringify(videoKeys)
    if (existingId && editor.getShape(existingId as any)) {
      editor.run(() => {
        editor.updateShape({
          id: existingId as any,
          type: 'fleet-video' as any,
          props: { tileKeys },
        })
      }, { history: 'ignore' })
      return
    }

    const id = createFleetShape(editor, 'fleet-video', 24, 72, {
      w: 260,
      h: 172,
      title: 'live video',
      tileKeys,
    })
    if (id) {
      videoShapeIdRef.current = id
      editor.run(() => {
        editor.updateShape({ id: id as any, type: 'fleet-video' as any, isLocked: true })
      }, { history: 'ignore' })
    }
  }, [deleteVideoShape, editor, videoKeys])

  const className = [
    'live-room-audio',
    status === 'connected' ? 'live-room-audio--connected' : '',
    status === 'error' ? 'live-room-audio--error' : '',
  ].filter(Boolean).join(' ')
  const spatialClassName = [
    'live-room-spatial',
    spatialEnabled ? 'live-room-spatial--enabled' : '',
    spatialStatus === 'unsupported' || spatialStatus === 'error' ? 'live-room-spatial--warn' : '',
  ].filter(Boolean).join(' ')
  const spatialTitle = spatialStatus === 'unsupported'
    ? 'Spatial audio unavailable; normal remote audio is still playing'
    : spatialStatus === 'error'
      ? 'Spatial audio failed; normal remote audio is still playing'
      : spatialEnabled
        ? `Spatial audio on for ${spatialNodesRef.current.size}/${audioTracksRef.current.size} remote audio tracks`
        : 'Enable spatial audio for remote LiveKit tracks'

  return (
    <span className="live-room-cluster">
      <span className={className} title={title}>
        <span className="live-room-audio__dot" />
        <button type="button" onClick={toggle} disabled={status === 'connecting'}>
          {status === 'connecting'
            ? 'audio...'
            : status === 'connected'
              ? micOn ? `live ${participantCount}` : `muted ${participantCount}`
              : 'audio'}
        </button>
      </span>
      <span className={spatialClassName} title={spatialTitle}>
        <button type="button" onClick={toggleSpatial} disabled={status !== 'connected'}>
          {spatialEnabled ? `spatial ${spatialNodesRef.current.size}` : 'spatial'}
        </button>
      </span>
      <LiveSessionReplay
        docName={docName}
        editor={editor}
        session={sessionId(docName)}
        active={status === 'connected'}
        shapeUtils={shapeUtils}
        tools={tools}
        licenseKey={licenseKey}
      />
    </span>
  )
}
