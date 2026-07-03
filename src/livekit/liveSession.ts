/**
 * Live voice/video session store.
 *
 * The *document* is the shared room: joining voice/video is a facet of
 * co-presence on the paper, mirroring the "link cameras" affordance. This
 * module is the single source of truth that connects the entry-point UI
 * (the "Join voice/video" option in the TOC, next to "Link cameras") with the
 * headless `LiveRoomAudio` controller that owns the actual LiveKit room.
 *
 * - The UI sets *intents* (join/leave, mute, spatial).
 * - The controller publishes *runtime* (status, micOn, participant count).
 *
 * There is deliberately no always-on corner chrome: nothing is rendered until
 * the user joins, and mic status folds into the dictation speech HUD.
 */

export type LiveStatus = 'idle' | 'connecting' | 'connected' | 'error'

export interface LiveSessionState {
  /** null = not yet probed; false = server has no LiveKit creds (503). */
  configured: boolean | null
  /** User wants to be in the call. */
  intent: boolean
  /** User wants their mic muted. */
  muteIntent: boolean
  /** User wants spatial audio. */
  spatialIntent: boolean
  /** User wants their camera enabled. */
  cameraIntent: boolean
  status: LiveStatus
  /** Mic actually live in the room (controller-reported). */
  micOn: boolean
  /** Camera actually live in the room (controller-reported). */
  cameraOn: boolean
  /** Spatial audio actually engaged (controller-reported). */
  spatialEnabled: boolean
  participantCount: number
  error: string | null
}

let state: LiveSessionState = {
  configured: null,
  intent: false,
  muteIntent: false,
  spatialIntent: false,
  cameraIntent: false,
  status: 'idle',
  micOn: false,
  cameraOn: false,
  spatialEnabled: false,
  participantCount: 0,
  error: null,
}

const listeners = new Set<() => void>()

function emit() { for (const fn of listeners) fn() }

function set(patch: Partial<LiveSessionState>) {
  let changed = false
  for (const k of Object.keys(patch) as (keyof LiveSessionState)[]) {
    if (state[k] !== patch[k]) { changed = true; break }
  }
  if (!changed) return
  state = { ...state, ...patch }
  emit()
}

export function getLiveSession(): LiveSessionState { return state }

export function subscribeLiveSession(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// --- User intents (UI → store) ---

export function joinLiveSession() {
  if (state.configured === false) return
  set({ intent: true, muteIntent: false, error: null })
}

export function leaveLiveSession() {
  set({ intent: false })
}

export function toggleLiveSession() {
  if (state.intent) leaveLiveSession()
  else joinLiveSession()
}

export function toggleMute() {
  set({ muteIntent: !state.muteIntent })
}

export function toggleSpatial() {
  set({ spatialIntent: !state.spatialIntent })
}

export function toggleCamera() {
  set({ cameraIntent: !state.cameraIntent })
}

// --- Runtime (controller → store) ---

export function setLiveRuntime(
  patch: Partial<Pick<LiveSessionState, 'status' | 'micOn' | 'cameraOn' | 'participantCount' | 'spatialEnabled' | 'error'>>,
) {
  set(patch)
}

export function setLiveConfigured(configured: boolean) {
  set({ configured })
}

// --- Config probe: does the server actually have LiveKit creds? ---

let probed = false

export async function probeLiveSessionConfig(): Promise<void> {
  if (probed) return
  probed = true
  try {
    const resp = await fetch('/api/livekit/config')
    if (!resp.ok) { setLiveConfigured(false); return }
    const body = await resp.json().catch(() => ({}))
    setLiveConfigured(!!body.configured)
  } catch {
    setLiveConfigured(false)
  }
}
