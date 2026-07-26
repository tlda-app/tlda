import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { Room, RoomEvent, Track } from 'livekit-client'
import { getLiveSession, subscribeLiveSession, setLiveRuntime, leaveLiveSession } from './liveSession'
import { setCallMicState } from '../voice.mjs'
import type {
  LocalTrackPublication,
  Participant,
  RemoteAudioTrack,
  RemoteVideoTrack,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  TrackPublication,
} from 'livekit-client'
import { log } from '../logger'
import { getDeviceId, getHumanId, getHumanName } from '../fleet/fleet-data.mjs'
import { isMyFleetShape, placeFleetShapeAtScreenPoint } from '../shapes/fleet-utils'
import { getLiveVideoTiles, removeLiveVideoTile, setLiveVideoTile } from './liveVideoRegistry'
import './LiveRoomAudio.css'

type Status = 'idle' | 'connecting' | 'connected' | 'error'
type SpatialStatus = 'off' | 'enabled' | 'unsupported' | 'error'

interface LiveRoomAudioProps {
  docName: string
  editor: Editor
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

interface SpatialTrackState {
  key: string
  identity: string
  sid?: string
  source?: string
  mode: 'panner' | 'stereo'
  position: SpatialPosition
  cleanup: () => void
}

interface LiveKitMediaStreamTrackHolder {
  mediaStreamTrack?: MediaStreamTrack
}

interface FleetVideoShapeRecord {
  id: string
  type: 'fleet-video'
  props: { title?: string; tileKeys?: string }
  isLocked?: boolean
}

function isFleetVideoShapeRecord(shape: unknown): shape is FleetVideoShapeRecord {
  return (
    !!shape &&
    typeof shape === 'object' &&
    (shape as { type?: unknown }).type === 'fleet-video' &&
    typeof (shape as { id?: unknown }).id === 'string'
  )
}

function asShapeId(id: string): TLShapeId {
  return id as TLShapeId
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

export function LiveRoomAudio({ docName, editor }: LiveRoomAudioProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [micOn, setMicOn] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [participantCount, setParticipantCount] = useState(0)
  const [videoKeys, setVideoKeys] = useState<string[]>([])
  const [spatialEnabled, setSpatialEnabled] = useState(false)
  const [spatialStatus, setSpatialStatus] = useState<SpatialStatus>('off')
  const [error, setError] = useState<string | null>(null)
  const roomRef = useRef<Room | null>(null)
  const audioElsRef = useRef(new Map<string, HTMLMediaElement>())
  const audioTracksRef = useRef(new Map<string, RemoteAudioTrackInfo>())
  const spatialAudioContextRef = useRef<AudioContext | null>(null)
  const spatialNodesRef = useRef(new Map<string, SpatialTrackState>())
  const disconnectSeqRef = useRef(0)
  const videoShapeIdRef = useRef<string | null>(null)
  const autoVideoShapeRef = useRef(false)
  const localVideoKeyRef = useRef<string | null>(null)

  const session = useSyncExternalStore(subscribeLiveSession, getLiveSession)

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
      return true
    } catch (e) {
      info.element.muted = false
      setSpatialStatus('error')
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
      removeLiveVideoTile(key)
      setVideoKeys(prev => prev.filter(tileKey => tileKey !== key))
    }
  }, [cleanupSpatialTrack])

  const removeVideoKey = useCallback((key: string) => {
    removeLiveVideoTile(key)
    setVideoKeys(prev => prev.filter(tileKey => tileKey !== key))
  }, [])

  const videoKeyForPublication = useCallback((publication: TrackPublication, participant: Participant) => {
    return `${participant.identity}:${publication.trackSid || publication.track?.sid || publication.source || Track.Kind.Video}`
  }, [])

  const removePublicationVideo = useCallback((publication: TrackPublication, participant: Participant) => {
    if (publication.kind !== Track.Kind.Video) return
    removeVideoKey(videoKeyForPublication(publication, participant))
  }, [removeVideoKey, videoKeyForPublication])

  const setLocalVideoTile = useCallback((publication?: LocalTrackPublication) => {
    const room = roomRef.current
    if (!room) return false
    const pub = publication ?? Array.from(room.localParticipant.videoTrackPublications.values())
      .find(candidate => candidate.source === Track.Source.Camera)
    const track = pub?.videoTrack
    const mediaStreamTrack = (track as unknown as LiveKitMediaStreamTrackHolder | undefined)?.mediaStreamTrack
    if (!pub || !track || !mediaStreamTrack || pub.isMuted) return false

    const nextKey = videoKeyForPublication(pub, room.localParticipant)
    const prevKey = localVideoKeyRef.current
    if (prevKey && prevKey !== nextKey) removeVideoKey(prevKey)
    localVideoKeyRef.current = nextKey

    setLiveVideoTile({
      key: nextKey,
      identity: room.localParticipant.identity,
      name: 'You',
      trackSid: pub.trackSid || track.sid,
      local: true,
      stream: new MediaStream([mediaStreamTrack]),
    })
    setVideoKeys(prev => [nextKey, ...prev.filter(tileKey => tileKey !== nextKey)])
    return true
  }, [removeVideoKey, videoKeyForPublication])

  const removeLocalVideoTile = useCallback(() => {
    const key = localVideoKeyRef.current
    if (!key) return
    localVideoKeyRef.current = null
    removeVideoKey(key)
  }, [removeVideoKey])

  const attachTrack = useCallback((track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    const key = `${participant.identity}:${publication.trackSid || track.sid || track.kind}`
    detachTrack(track, key)

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
        subscribedAtMs: Date.now(),
        participantMetadata: (participant as any).metadata,
        publicationMetadata: (publication as any).metadata,
        track,
        element: el,
      }
      audioTracksRef.current.set(key, trackInfo)
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
    } else {
      return
    }
  }, [applySpatialTrack, detachTrack])

  const disconnect = useCallback(async (nextStatus: Status = 'idle') => {
    const seq = ++disconnectSeqRef.current
    const room = roomRef.current
    roomRef.current = null
    cleanupAllSpatialTracks(false)
    audioTracksRef.current.clear()
    for (const el of audioElsRef.current.values()) el.remove()
    audioElsRef.current.clear()
    void spatialAudioContextRef.current?.close().catch(() => {})
    spatialAudioContextRef.current = null
    for (const tile of getLiveVideoTiles()) removeLiveVideoTile(tile.key)
    localVideoKeyRef.current = null
    setVideoKeys([])
    if (autoVideoShapeRef.current && videoShapeIdRef.current && editor.getShape(asShapeId(videoShapeIdRef.current))) {
      const id = videoShapeIdRef.current
      editor.run(() => {
        const shape = editor.getShape(asShapeId(id))
        if (shape?.isLocked) editor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
        if (editor.getShape(asShapeId(id))) editor.deleteShape(asShapeId(id))
      }, { history: 'ignore' })
    }
    videoShapeIdRef.current = null
    autoVideoShapeRef.current = false
    setSpatialEnabled(false)
    setSpatialStatus('off')
    setMicOn(false)
    setCameraOn(false)
    setParticipantCount(0)
    if (room) await room.disconnect()
    // Clear join intent so a server-initiated drop doesn't immediately
    // re-trigger connect() via the intent effect.
    leaveLiveSession()
    if (seq === disconnectSeqRef.current) setStatus(nextStatus)
  }, [cleanupAllSpatialTracks, editor])

  const deleteVideoShape = useCallback((id: string) => {
    const shape = editor.getShape(asShapeId(id))
    if (!shape) return
    editor.run(() => {
      const current = editor.getShape(asShapeId(id))
      if (current?.isLocked) editor.updateShape({ id: current.id, type: current.type, isLocked: false })
      if (editor.getShape(asShapeId(id))) editor.deleteShape(asShapeId(id))
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

      room
        .on(RoomEvent.Connected, () => {
          setStatus('connected')
          refreshParticipants()
          log.info('livekit', 'connected', { docName, room: info.room })
        })
        .on(RoomEvent.Disconnected, () => {
          if (roomRef.current === room) void disconnect()
        })
        .on(RoomEvent.ParticipantConnected, () => {
          refreshParticipants()
        })
        .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
          for (const key of Array.from(audioTracksRef.current.keys())) {
            if (!key.startsWith(`${participant.identity}:`)) continue
            cleanupSpatialTrack(key)
            audioTracksRef.current.delete(key)
            audioElsRef.current.get(key)?.remove()
            audioElsRef.current.delete(key)
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
          detachTrack(track, key)
        })
        .on(RoomEvent.TrackMuted, (publication: TrackPublication, participant: Participant) => {
          removePublicationVideo(publication, participant)
          if (participant === room.localParticipant && publication.source === Track.Source.Camera) {
            removeLocalVideoTile()
            setCameraOn(false)
          }
        })
        .on(RoomEvent.TrackUnmuted, (publication: TrackPublication, participant: Participant) => {
          if (publication.kind !== Track.Kind.Video) return
          if (participant === room.localParticipant) {
            if (publication.source === Track.Source.Camera) setCameraOn(setLocalVideoTile(publication as LocalTrackPublication))
            return
          }
          const track = publication.videoTrack
          if (track && isRemoteVideo(track as RemoteTrack)) {
            attachTrack(track as RemoteTrack, publication as RemoteTrackPublication, participant as RemoteParticipant)
          }
        })
        .on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication) => {
          if (publication.kind !== Track.Kind.Video || publication.source !== Track.Source.Camera) return
          setCameraOn(setLocalVideoTile(publication))
        })
        .on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
          if (publication.kind !== Track.Kind.Video || publication.source !== Track.Source.Camera) return
          removeLocalVideoTile()
          setCameraOn(false)
        })
        .on(RoomEvent.ActiveSpeakersChanged, () => {
          refreshParticipants()
        })

      await room.connect(info.url, info.token, { autoSubscribe: true })
      try {
        await room.startAudio()
      } catch (e) {
        // Browser autoplay unlock is best-effort; attached remote media can still play after user gesture.
        log.debug('livekit', 'startAudio best-effort failed', { error: String(e) })
      }
    } catch (e) {
      // Recover into visible TOC error state and tear down any partially connected room.
      log.warn('livekit', 'connect failed', { error: String(e) })
      setError(e instanceof Error ? e.message : String(e))
      await disconnect('error')
    }
  }, [
    attachTrack,
    cleanupSpatialTrack,
    detachTrack,
    disconnect,
    docName,
    refreshParticipants,
    removeLocalVideoTile,
    removePublicationVideo,
    setLocalVideoTile,
    status,
  ])

  // --- Entry point: react to the "Join voice/video" intent from the store ---
  // The document is the room; joining is driven by the TOC option (next to
  // "Link cameras"), never by always-on corner chrome.
  useEffect(() => {
    if (session.intent && status === 'idle' && !roomRef.current) {
      void connect()
    } else if (!session.intent && roomRef.current) {
      void disconnect()
    }
  }, [session.intent, status, connect, disconnect])

  // Mic mute intent → room mic state. Joining unmutes by default, so this also
  // enables the mic once the room reaches 'connected'.
  useEffect(() => {
    if (status !== 'connected') return
    const room = roomRef.current
    if (!room) return
    const wantMic = !session.muteIntent
    if (wantMic === micOn) return
    let cancelled = false
    room.localParticipant.setMicrophoneEnabled(wantMic)
      .then(() => { if (!cancelled) setMicOn(wantMic) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [session.muteIntent, status, micOn])

  // Camera intent mirrors the mic control: the TOC owns the intent, this
  // controller owns the LiveKit local publication and self-view tile.
  useEffect(() => {
    if (status !== 'connected') return
    const room = roomRef.current
    if (!room) return
    const wantCamera = session.cameraIntent
    if (wantCamera === cameraOn) return
    let cancelled = false
    room.localParticipant.setCameraEnabled(wantCamera)
      .then((publication) => {
        if (cancelled) return
        if (wantCamera) {
          setCameraOn(setLocalVideoTile(publication))
        } else {
          removeLocalVideoTile()
          setCameraOn(false)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [session.cameraIntent, status, cameraOn, removeLocalVideoTile, setLocalVideoTile])

  // Spatial audio intent → engaged state. The existing spatialEnabled effect
  // (below) applies/cleans the per-track panner graph.
  useEffect(() => {
    setSpatialEnabled(session.spatialIntent)
    if (!session.spatialIntent) setSpatialStatus('off')
  }, [session.spatialIntent])

  // Publish runtime back to the store (drives the TOC label) and fold mic
  // status into the dictation speech HUD — never a standalone floating chip.
  useEffect(() => {
    setLiveRuntime({ status, micOn, cameraOn, participantCount, spatialEnabled, error })
    if (status === 'connected') {
      setCallMicState({ inCall: true, micOn, participantCount })
    } else {
      setCallMicState(null)
    }
  }, [status, micOn, cameraOn, participantCount, spatialEnabled, error])

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
      room: () => roomRef.current,
      videos: () => getLiveVideoTiles().map(({ stream: _stream, ...tile }) => tile),
      camera: () => ({
        intent: session.cameraIntent,
        on: cameraOn,
        localKey: localVideoKeyRef.current,
      }),
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
        })),
      }),
    }
  }, [cameraOn, session.cameraIntent, spatialEnabled, spatialStatus])

  useEffect(() => {
    const existingId = videoShapeIdRef.current
    if (videoKeys.length === 0) {
      if (autoVideoShapeRef.current && existingId && editor.getShape(asShapeId(existingId))) {
        deleteVideoShape(existingId)
      }
      videoShapeIdRef.current = null
      autoVideoShapeRef.current = false
      return
    }

    const tileKeys = JSON.stringify(videoKeys)
    if (existingId && editor.getShape(asShapeId(existingId))) {
      editor.run(() => {
        editor.updateShape({
          id: asShapeId(existingId),
          type: 'fleet-video' as any,
          props: { tileKeys },
        })
      }, { history: 'ignore' })
      return
    }

    const fleetVideoShapes = (editor.getCurrentPageShapes() as readonly unknown[])
      .filter(isFleetVideoShapeRecord)
    const ownedVideoShapes = fleetVideoShapes
      .filter(shape => isMyFleetShape(shape))
    const reusable = ownedVideoShapes[0]
    if (reusable && editor.getShape(asShapeId(reusable.id))) {
      editor.run(() => {
        const shape = editor.getShape(asShapeId(reusable.id))
        if (shape?.isLocked) editor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
        editor.updateShape({
          id: asShapeId(reusable.id),
          type: 'fleet-video' as any,
          props: { tileKeys },
        })
        for (const duplicate of ownedVideoShapes.slice(1)) {
          const current = editor.getShape(duplicate.id as Parameters<Editor['getShape']>[0])
          if (!current) continue
          if (current.isLocked) editor.updateShape({ id: current.id, type: current.type, isLocked: false })
          editor.deleteShape(current)
        }
      }, { history: 'ignore' })
      videoShapeIdRef.current = reusable.id
      autoVideoShapeRef.current = false
      return
    }

    let cancelled = false
    const w = 260
    const h = 172
    void placeFleetShapeAtScreenPoint(editor, 'fleet-video', 24 + w / 2, 72 + h / 2, w, h, {
      tileKeys,
    }, { select: false }).then((id) => {
      if (!id || cancelled) return
      videoShapeIdRef.current = id
      autoVideoShapeRef.current = true
    })
    return () => { cancelled = true }
  }, [deleteVideoShape, editor, videoKeys])

  // Headless controller: the entry point is the "Join voice/video" TOC option,
  // mic status lives in the speech HUD, and optional video tiles are TLDraw
  // shapes. A plain doc open shows no extra chrome.
  return null
}
