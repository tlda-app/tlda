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
import { discardDraft, persistAndDeliverDraft, persistDraftCheckpoint, retryPendingDrafts } from './draftOutbox'

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
let unlistenPage: (() => void) | null = null
let lastPageId: string | null = null
let cameraInterval: ReturnType<typeof setInterval> | null = null
let activeEditor: Editor | null = null
let activeDoc: string | null = null
let activeToken: string | null = null
let activeRecordingId: string | null = null
let checkpointQueue: Promise<void> = Promise.resolve()
/** Set once the lecture is being delivered: queued checkpoints stop writing. */
let checkpointsClosed = false
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
/**
 * How finely a stroke's growth is kept. Within one window the newest record for
 * a shape replaces the older one, so a stroke replays in steps of this size
 * instead of one step per pointer move. Its finished form is unaffected.
 */
const STROKE_SAMPLE_MS = 100
/**
 * How long the final upload waits for an outstanding checkpoint write before
 * going ahead without it. Long enough that an ordinary slow write still settles
 * first; short enough that a hung one cannot hold the lecture hostage.
 */
const CHECKPOINT_SETTLE_MS = 2000

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
  checkpointsClosed = false
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
  lastPageId = null

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
    checkpointQueue = checkpointQueue
      // Once the lecture is being delivered, a checkpoint still sitting in this
      // queue must not run: it would write a SHORTER draft back under the same
      // key after delivery removed it, and the retry path would then re-POST it
      // over the finished recording — the server stores by id, so a stale
      // checkpoint overwrites a complete lecture with a partial one.
      .then(() => (checkpointsClosed ? undefined : persistDraftCheckpoint(doc, id, checkpointMeta, checkpointAudio)))
      .catch((error) => log.error('recording', 'checkpoint-failed', { error: String(error) }))
  }

  // If the microphone goes away mid-lecture — unplugged, permission revoked,
  // the device taken by something else — the track ends and MediaRecorder goes
  // quiet, but nothing here noticed: status stayed 'recording' for the rest of
  // the lab and the lecturer had no reason to doubt it. Finalize instead, so
  // what was captured is saved, and say so where the pill can show it.
  //
  // `track.stop()` does not fire 'ended', so stopping normally cannot come
  // through here.
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      captureLost(token, 'Recording stopped — the microphone became unavailable')
    })
  }
  mediaRecorder.onerror = (event) => {
    const reason = (event as unknown as { error?: { message?: string } })?.error?.message
    captureLost(token, `Recording stopped — ${reason ?? 'the recorder failed'}`)
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

/**
 * Capture has failed under us: finalize what exists and leave the reason on
 * screen.
 *
 * Deliberately not a reconnect. Choosing another device, or resuming onto a mic
 * that came back, is a product decision about whose audio ends up in the
 * lecture; this only stops pretending to record. `stopRecording` clears `error`
 * on its way to idle, so the reason is set after it settles rather than before.
 */
function captureLost(token: string, reason: string): void {
  if (activeToken !== token || state.status !== 'recording') return
  log.error('recording', 'capture-lost', { reason, doc: activeDoc })
  void stopRecording(token)
    .catch((error) => log.error('recording', 'capture-lost-save-failed', { error: String(error) }))
    .then(() => setState({ error: reason }))
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

/**
 * Append a stroke event, folding it into the previous one when it lands inside
 * the same sample window.
 *
 * The draw tool rewrites the whole shape on every pointer move — a full record
 * carrying the whole re-encoded path, ~60 times a second (tldraw's
 * `Drawing.ts`, `editor.updateShapes` per move). Stored one event per move, a
 * single stroke costs the sum of all its prefixes, so the event log grows
 * quadratically in stroke length and a normal annotated lab ran past the
 * server's body limit and became unuploadable.
 *
 * Replay only ever reads the LAST record for an id at or before t
 * (`playbackEngine.reconstructAt`), so two records for one id inside a sample
 * window are redundant: nothing can observe the one that is superseded. Folding
 * them keeps the newer record, which is why the finished shape is unchanged —
 * what thins out is the number of intermediate frames the stroke is drawn over,
 * exactly as the camera has always been sampled rather than captured per frame.
 *
 * A removal, or a base event from a document switch, closes the window: those
 * reorder what replay sees and must keep their own position in the log.
 *
 * The folded event REPLACES its predecessor rather than being edited in place:
 * `recordingMeta` copies the events array shallowly, so a checkpoint already
 * taken goes on holding the event as it stood when it was taken.
 */
function appendStroke(t: number, put: TLRecord[], remove: string[]): void {
  const last = events[events.length - 1]
  const canFold = !remove.length && last?.kind === 'stroke' && !last.remove.length
    && t - last.t < STROKE_SAMPLE_MS
  if (!canFold) {
    events.push({ t, kind: 'stroke', put, remove })
    return
  }
  const folded = [...last.put]
  for (const record of put) {
    const at = folded.findIndex((held) => held.id === record.id)
    if (at === -1) folded.push(record)
    else folded[at] = record
  }
  events[events.length - 1] = { ...last, put: folded }
}

/**
 * A base event for the page the reader just turned to.
 *
 * A multipage HTML document is one editor holding a TLDraw page per chapter
 * (`loaders/createShapes.ts`), so turning to another homework changes
 * `currentPageId` and nothing else — no remount, no new editor. That field
 * lives on the `instance` record, which is SESSION scope, so the store listener
 * that captures strokes (document scope) never sees it, and a camera event
 * carries x/y/z but no page. Without this the student would hear the whole lab
 * while looking at whichever page capture started on.
 *
 * It reuses the base event a document switch already emits rather than adding a
 * kind: `playbackSegmentAt` takes the last base at or before t, and loading its
 * snapshot restores `currentPageId` with it
 * (`loadSessionStateSnapshotIntoStore` takes the page from the snapshot), so
 * replay turns the page by the same route it changes document.
 */
function watchPageChanges(editor: Editor): void {
  lastPageId = editor.getCurrentPageId()
  unlistenPage = editor.store.listen(() => {
    if (paused) return // off the record — the page we return on is picked up by the next change
    if (activeEditor !== editor) return
    const pageId = editor.getCurrentPageId()
    if (pageId === lastPageId) return
    lastPageId = pageId
    events.push({ t: now(), kind: 'base', snapshot: getSnapshot(editor.store) })
  }, { source: 'user', scope: 'session' })
}

function attachEditor(editor: Editor): void {
  if (unlistenStore) { unlistenStore(); unlistenStore = null }
  if (unlistenPage) { unlistenPage(); unlistenPage = null }
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
      appendStroke(now(), put, remove)
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

  // 4. Page — turning to another chapter of a multipage document.
  watchPageChanges(editor)
}

export function switchRecordingEditor(token: string, editor: Editor | null): boolean {
  if (activeToken !== token || state.status !== 'recording') return false
  if (!editor) {
    if (unlistenStore) { unlistenStore(); unlistenStore = null }
    if (unlistenPage) { unlistenPage(); unlistenPage = null }
    if (cameraInterval) { clearInterval(cameraInterval); cameraInterval = null }
    activeEditor = null
    return true
  }
  // The document switch's own base. attachEditor then re-arms the page watch
  // against the incoming editor, so the next page turn inside it is captured
  // and this base is not duplicated by one.
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
  // Pages can be turned while off the record, and the watch stays quiet through
  // it, so come back on the record by stating which page we are on. Without
  // this the first stroke after resuming lands in the outgoing page's segment
  // and replays on the wrong homework.
  if (activeEditor && activeEditor.getCurrentPageId() !== lastPageId) {
    lastPageId = activeEditor.getCurrentPageId()
    events.push({ t: now(), kind: 'base', snapshot: getSnapshot(activeEditor.store) })
  }
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
  // From here the draft belongs to delivery: no queued checkpoint may write it
  // back underneath us.
  checkpointsClosed = true

  // If stopped while off the record, settle the final paused stretch first so the
  // duration reflects only on-record time.
  if (paused) { pausedAccum += performance.now() - pauseStart; paused = false }

  const duration = now()

  // Detach listeners first so nothing lands after the clock is closed.
  if (unlistenStore) { unlistenStore(); unlistenStore = null }
  if (unlistenPage) { unlistenPage(); unlistenPage = null }
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
    // Bounded, because a checkpoint can HANG rather than fail. `.catch()` on the
    // queue handles a rejected write; an IndexedDB transaction that never
    // settles — quota pressure, another tab, a slow disk — leaves this promise
    // permanently unresolved, and waiting on it unconditionally stranded the
    // whole lecture in 'saving' with nothing uploaded and nothing on screen.
    //
    // Waiting at all is about ordering: a checkpoint landing after delivery
    // would put the draft back. `checkpointsClosed` now stops queued writes, so
    // the remaining exposure is the single in-flight one, and the trade is
    // deliberate — a possible duplicate delivery is recoverable, a lost lecture
    // is not.
    await Promise.race([
      checkpointQueue,
      new Promise<void>((resolve) => setTimeout(resolve, CHECKPOINT_SETTLE_MS)),
    ])
    await uploadRecording(doc, id, meta, blob)
    // Bounding the wait above means a checkpoint can still be in flight now. If
    // it lands it puts an older, shorter envelope back under this key, and the
    // retry path would re-POST it over the lecture we just delivered. So once it
    // has settled — however long that takes, and never if it never does — clear
    // the draft again.
    void checkpointQueue
      .then(() => discardDraft(doc, id))
      .catch((error) => log.error('recording', 'draft-discard-failed', { error: String(error) }))
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
