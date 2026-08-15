/**
 * playbackController.ts — tiny store for which recording is currently open for
 * playback. The recordings list sets it; PlaybackOverlay renders when it's set.
 */

type Listener = (id: string | null) => void

let openId: string | null = null
const listeners = new Set<Listener>()

export function openPlayback(id: string): void {
  openId = id
  for (const cb of listeners) cb(openId)
}

export function closePlayback(): void {
  openId = null
  for (const cb of listeners) cb(openId)
}

export function getOpenPlayback(): string | null {
  return openId
}

export function subscribePlaybackOpen(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
