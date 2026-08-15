/**
 * recorder.ts — M1 of the voice-classroom feature.
 *
 * Captures a lecture as two synchronized layers:
 *   1. audio   — the lecturer's mic via MediaRecorder (webm/opus)
 *   2. events  — a timestamped stream of annotation-stroke diffs + camera moves,
 *                relative to the moment recording started.
 *
 * On stop, the bundle is POSTed to the server and stored per-project under
 * server/projects/{doc}/recordings/. Playback (M2) replays events against the
 * audio on one shared clock.
 *
 * Design notes:
 *  - Only annotation strokes are recorded (RECORDABLE set). Page shapes, fleet
 *    shapes, sentinels, etc. are excluded — they're not part of the lecture.
 *  - Updated shapes are stored as their full new record (not a delta), so replay
 *    is a pure function of currentMs: for each touched id, the last event <= t
 *    wins. This keeps M2's scrubber idempotent on scrub-back.
 *  - Camera is sampled (throttled) rather than on every frame; lecture playback
 *    doesn't need 60fps camera fidelity.
 */

import { getSnapshot } from 'tldraw'
import type { Editor, TLRecord } from 'tldraw'
import { log } from '../logger'
import { FLEET_SHAPE_TYPES } from '../shapes/fleet-utils'
import { persistAndDeliverDraft, persistDraftCheckpoint, retryPendingDrafts } from './draftOutbox'

export function isRecordable(rec: TLRecord | undefined): boolean {
  return !!rec && rec.typeName === 'shape' && !FLEET_SHAPE_TYPES.has(rec.type)
}

export interface StrokeEvent {
  t: number
  kind: 'stroke'
  /** Full records for added/updated shapes (replay puts these). */
  put: TLRecord[]
  /** Shape ids removed at this instant. */
  remove: string[]
}

export interface CameraEvent {
  t: number
  kind: 'camera'
  x: number
  y: number
  z: number
}

export interface BaseEvent {
  t: number
  kind: 'base'
  snapshot: ReturnType<typeof getSnapshot>
}

export type RecordingEvent = StrokeEvent | CameraEvent | BaseEvent

export interface RecordingMeta {
  id: string
  title: string
  doc: string
  created: string
  duration_ms: number
  audioMime: string
  events: RecordingEvent[]
  baseSnapshot: ReturnType<typeof getSnapshot> | null
}

type StateListener = (state: RecorderState) => void

export interface RecorderState {
  status: 'idle' | 'starting' | 'recording' | 'saving'
  startedAt: number | null
  /** True while on the record but currently paused ("off the record"). */
  paused: boolean
  doc: string | null
  error: string | null
}

let state: RecorderState = { status: 'idle', startedAt: null, paused: false, doc: null, error: null }
const listeners = new Set<StateListener>()

function setState(patch: Partial<RecorderState>) {
  state = { ...state, ...patch }
  for (const cb of listeners) cb(state)
}

export function getRecorderState(): RecorderState {
  return state
}

export function subscribeRecorder(cb: StateListener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// --- Active session internals ---

let mediaRecorder: MediaRecorder | null = null
let mediaStream: MediaStream | null = null
let audioChunks: Blob[] = []
let events: RecordingEvent[] = []
/** Ids of shapes BORN during this recording — lifted off the live doc on stop. */
let t0 = 0
let unlistenStore: (() => void) | null = null
let cameraInterval: ReturnType<typeof setInterval> | null = null
let activeEditor: Editor | null = null
let activeDoc: string | null = null
let activeToken: string | null = null
let activeRecordingId: string | null = null
let checkpointQueue: Promise<void> = Promise.resolve()
let lastCamera: { x: number; y: number; z: number } | null = null
// Off-the-record bookkeeping: paused stretches are subtracted from the clock so
// the recorded timeline (and the paused audio) contain only on-record time.
let paused = false
let pauseStart = 0
let pausedAccum = 0

let appSessionGeneration = 0
let appSessionDoc: string | null = null
let appSessionEditor: Editor | null = null
let appSessionToken: string | null = null

const CAMERA_SAMPLE_MS = 120

/** Elapsed on-record ms — excludes any time spent off the record. */
function now(): number {
  return performance.now() - t0 - pausedAccum
}

/**
 * Begin recording. Requests mic permission (throws if denied), starts the
 * MediaRecorder, and attaches the store + camera listeners.
 */
export async function startRecording(editor: Editor | null, doc: string): Promise<string | null> {
  if (state.status !== 'idle') return null
  const token = crypto.randomUUID()
  activeToken = token
  activeRecordingId = `rec-${Date.now().toString(36)}`
  checkpointQueue = Promise.resolve()
  activeDoc = doc
  activeEditor = editor
  setState({ status: 'starting', startedAt: null, paused: false, doc, error: null })

  // 1. Mic — a dedicated capture for the file recorder. We deliberately do NOT
  // clone the Deepgram transcription track: a clone of a track that's already
  // wired into Deepgram's AudioContext graph goes silent after the first take
  // (MediaRecorder ends up with a header-only, frameless webm). Opening our own
  // getUserMedia is the same physical device with permission already granted —
  // no new prompt — but a clean, independent tap that records reliably and has
  // its own stop lifecycle (stopping the lecture never touches the live voice mic).
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
  } catch (err: any) {
    const msg = `Microphone unavailable — ${err?.message ?? 'grant mic access'}`
    if (activeToken === token) {
      activeToken = null
      activeRecordingId = null
      activeDoc = null
      activeEditor = null
      setState({ status: 'idle', doc: null, error: msg })
    }
    throw new Error(msg)
  }

  if (activeToken !== token) {
    activeRecordingId = null
    stream.getTracks().forEach((track) => track.stop())
    return null
  }

  mediaStream = stream
  audioChunks = []
  events = []
  paused = false
  pausedAccum = 0
  lastCamera = null

  const mime = pickAudioMime()
  mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || e.data.size <= 0) return
    audioChunks.push(e.data)
    const doc = activeDoc
    const id = activeRecordingId
    if (!doc || !id) return
    const checkpointMeta = recordingMeta(doc, id, mediaRecorder?.mimeType || 'audio/webm', Math.max(1, now()))
    const checkpointAudio = new Blob([...audioChunks], { type: checkpointMeta.audioMime })
    checkpointQueue = checkpointQueue.then(() => persistDraftCheckpoint(doc, id, checkpointMeta, checkpointAudio))
      .catch((error) => log.error('recording', 'checkpoint-failed', { error: String(error) }))
  }

  // Clock zero is set the instant audio capture begins, so events and audio
  // share an origin.
  t0 = performance.now()
  mediaRecorder.start(1000) // gather a chunk per second so a crash loses <=1s

  // 2. Frozen document base + store events. Book member switches append another
  // base event on this same clock; playback therefore changes member without
  // consulting whichever live document happens to be open later.
  if (editor) {
    const baseSnapshot = getSnapshot(editor.store)
    events.push({ t: 0, kind: 'base', snapshot: baseSnapshot })
    attachEditor(editor)
  }

  setState({ status: 'recording', startedAt: Date.now(), paused: false, doc, error: null })
  log.info('recording', 'started', { doc })
  return token
}

function recordingMeta(doc: string, id: string, audioMime: string, duration: number): RecordingMeta {
  return {
    id,
    title: new Date().toLocaleString(),
    doc,
    created: new Date().toISOString(),
    duration_ms: Math.round(duration),
    audioMime,
    events: [...events],
    baseSnapshot: events.find((event): event is BaseEvent => event.kind === 'base')?.snapshot ?? null,
  }
}

async function startConfiguredAppSession(generation: number) {
  if (!appSessionDoc || appSessionToken || state.status !== 'idle') return
  const token = await startRecording(appSessionEditor, appSessionDoc)
  if (!token) return
  if (generation !== appSessionGeneration || !appSessionDoc) {
    await stopRecording(token)
    return
  }
  appSessionToken = token
  if (activeEditor !== appSessionEditor) switchRecordingEditor(token, appSessionEditor)
}

function requestConfiguredAppSession(generation: number) {
  void startConfiguredAppSession(generation).catch((error) => {
    log.error('recording', 'automatic-start-failed', { doc: appSessionDoc, error: String(error) })
  })
}

/** Own one raw capture envelope for the authenticated classroom app lifecycle. */
export function openAppRecordingSession(doc: string): () => void {
  const generation = ++appSessionGeneration
  appSessionDoc = doc
  void retryPendingDrafts().catch((error) => log.error('recording', 'draft-retry-failed', { error: String(error) }))
  requestConfiguredAppSession(generation)
  let finalized = false
  const finalize = () => {
    if (finalized) return
    finalized = true
    if (generation !== appSessionGeneration) return
    appSessionGeneration += 1
    appSessionDoc = null
    appSessionEditor = null
    if (mediaRecorder?.state === 'recording') mediaRecorder.requestData()
    const token = appSessionToken
    appSessionToken = null
    if (token) void stopRecording(token)
  }
  window.addEventListener('pagehide', finalize, { once: true })
  return () => {
    window.removeEventListener('pagehide', finalize)
    finalize()
  }
}

/** Supply whichever document/member editor is currently visible to the app-owned capture. */
export function attachAppRecordingEditor(editor: Editor | null): void {
  appSessionEditor = editor
  if (appSessionToken) {
    switchRecordingEditor(appSessionToken, editor)
  } else {
    requestConfiguredAppSession(appSessionGeneration)
  }
}

function attachEditor(editor: Editor): void {
  if (unlistenStore) { unlistenStore(); unlistenStore = null }
  if (cameraInterval) { clearInterval(cameraInterval); cameraInterval = null }
  activeEditor = editor

  // Every local user change to a non-fleet document shape.
  // System/build reloads are excluded by source; fleet HUD shapes are excluded
  // because they are participant chrome rather than lecture content.
  unlistenStore = editor.store.listen((entry) => {
    if (paused) return // off the record — capture nothing
    const { added, updated, removed } = entry.changes
    const put: TLRecord[] = []
    const remove: string[] = []

    for (const rec of Object.values(added)) {
      if (isRecordable(rec)) {
        put.push(rec)
      }
    }
    for (const pair of Object.values(updated)) {
      const next = (pair as [TLRecord, TLRecord])[1]
      if (isRecordable(next)) put.push(next)
    }
    for (const rec of Object.values(removed)) {
      if (isRecordable(rec)) remove.push((rec as TLRecord).id as string)
    }

    if (put.length || remove.length) {
      events.push({ t: now(), kind: 'stroke', put, remove })
    }
  }, { source: 'user', scope: 'document' })

  // 3. Camera — sampled. Only emit when it actually moved.
  cameraInterval = setInterval(() => {
    if (!activeEditor || paused) return
    const c = activeEditor.getCamera()
    if (!lastCamera || c.x !== lastCamera.x || c.y !== lastCamera.y || c.z !== lastCamera.z) {
      events.push({ t: now(), kind: 'camera', x: c.x, y: c.y, z: c.z })
      lastCamera = { x: c.x, y: c.y, z: c.z }
    }
  }, CAMERA_SAMPLE_MS)

  // Seed the initial camera so playback opens where the lecture began.
  const c0 = editor.getCamera()
  events.push({ t: now(), kind: 'camera', x: c0.x, y: c0.y, z: c0.z })
  lastCamera = { x: c0.x, y: c0.y, z: c0.z }
}

export function switchRecordingEditor(token: string, editor: Editor | null): boolean {
  if (activeToken !== token || state.status !== 'recording') return false
  if (!editor) {
    if (unlistenStore) { unlistenStore(); unlistenStore = null }
    if (cameraInterval) { clearInterval(cameraInterval); cameraInterval = null }
    activeEditor = null
    return true
  }
  events.push({ t: now(), kind: 'base', snapshot: getSnapshot(editor.store) })
  attachEditor(editor)
  return true
}

/** Go off the record: pause audio + event capture, and stop the clock advancing. */
export function pauseRecording(): void {
  if (state.status !== 'recording' || paused || !mediaRecorder) return
  paused = true
  pauseStart = performance.now()
  if (mediaRecorder.state === 'recording') mediaRecorder.pause()
  setState({ paused: true })
  log.info('recording', 'paused')
}

/** Back on the record: resume audio + capture; the off-record stretch is excluded. */
export function resumeRecording(): void {
  if (state.status !== 'recording' || !paused || !mediaRecorder) return
  pausedAccum += performance.now() - pauseStart
  paused = false
  if (mediaRecorder.state === 'paused') mediaRecorder.resume()
  setState({ paused: false })
  log.info('recording', 'resumed')
}

/**
 * Stop recording, finalize the audio blob, and upload the bundle.
 * Returns the stored recording id, or null on failure.
 */
export async function stopRecording(token: string): Promise<string | null> {
  if (activeToken !== token) return null
  if (state.status === 'starting') {
    activeToken = null
    activeDoc = null
    activeEditor = null
    setState({ status: 'idle', startedAt: null, paused: false, doc: null })
    return null
  }
  if (state.status !== 'recording' || !mediaRecorder) return null
  setState({ status: 'saving' })

  // If stopped while off the record, settle the final paused stretch first so the
  // duration reflects only on-record time.
  if (paused) { pausedAccum += performance.now() - pauseStart; paused = false }

  const duration = now()

  // Detach listeners first so nothing lands after the clock is closed.
  if (unlistenStore) { unlistenStore(); unlistenStore = null }
  if (cameraInterval) { clearInterval(cameraInterval); cameraInterval = null }

  const audioMime = mediaRecorder.mimeType || 'audio/webm'
  const blob: Blob = await new Promise((resolve) => {
    mediaRecorder!.onstop = () => resolve(new Blob(audioChunks, { type: audioMime }))
    mediaRecorder!.stop()
  })

  // Release the mic.
  mediaStream?.getTracks().forEach((tr) => tr.stop())
  mediaStream = null
  mediaRecorder = null

  const doc = activeDoc!
  const id = activeRecordingId!
  const meta = recordingMeta(doc, id, audioMime, duration)

  try {
    await checkpointQueue
    await uploadRecording(doc, id, meta, blob)
    log.info('recording', 'saved', { doc, id, events: events.length, duration_ms: meta.duration_ms })

  } catch (e: any) {
    setState({ status: 'idle', error: `Save failed: ${e?.message ?? e}` })
    log.error('recording', 'save-failed', { error: String(e) })
    return null
  } finally {
    activeEditor = null
    activeDoc = null
    activeToken = null
    activeRecordingId = null
    events = []
    audioChunks = []
    paused = false
    pausedAccum = 0
  }

  setState({ status: 'idle', startedAt: null, paused: false, doc: null, error: null })
  return id
}

function pickAudioMime(): string | null {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ]
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return null
}

async function uploadRecording(doc: string, id: string, meta: RecordingMeta, audio: Blob): Promise<void> {
  await persistAndDeliverDraft(doc, id, meta, audio)
}
